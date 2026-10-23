"""The second look: OpenCV 5 re-look tools, then a Nemotron VL verdict (LANE_A §4, §5.5; A-V2).

``verify`` takes one detection from the mission, picks re-look tools for the way it is likely to
be hard (``choose_tools``), runs them, and asks the VL model about up to three images: the
detector's crop and the tool outputs. The answer becomes a ``Verdict`` stored through
``MissionStore``; every tool call, model call and the verdict go into the trace, images by path.

The verdict is advice for the reviewer and evidence for proposals. It never removes a detection.
"""

from __future__ import annotations

import json
import logging
import re
import tempfile
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from sightline.agent import prompts
from sightline.agent.llm import MODEL_VISION, ChatClient, ChatResult, failure_text
from sightline.agent.relook import (
    ArrayDetector,
    draw_boxes,
    enhance_contrast,
    redetect_region,
    save,
    to_orig,
    zoom_native,
)
from sightline.agent.trace import now_iso, trace_call
from sightline.contract import Verdict

VERIFY_BAND = (0.15, 0.29)  # near-miss band below candidate_threshold (0.29)
MAX_TOOLS = 2  # with the crop, at most three images per model call

# Failure-mode heuristics (docs/DETECTOR_LIMITS.md §2), labelled as heuristics wherever shown.
SMALL_PX = 40  # long side of the box in frame pixels: a person this small is hard to read
LOW_CONTRAST_STD = 18.0  # grey-level standard deviation around the box: figure blends in
ELONGATED = 1.6  # long / short side of the box: someone lying down, or several people

VERDICT_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "person": {"type": "string", "enum": ["yes", "no", "unclear"]},
        "posture": {"type": "string", "enum": ["standing", "sitting", "lying", "unknown"]},
        "group_size": {"type": ["integer", "null"], "minimum": 1},
        "clothing": {"type": ["string", "null"]},
        "object": {
            "type": ["string", "null"],
            "enum": ["backpack", "fire ring", "shelter", "other", None],
        },
        "reason": {"type": "string"},
    },
    "required": ["person", "posture", "group_size", "clothing", "object", "reason"],
    "additionalProperties": False,
}
RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {"name": "verdict", "schema": VERDICT_SCHEMA, "strict": True},
}

log = logging.getLogger(__name__)

_CLEAR = re.compile(r"\bclear(s|ed|ing)?\b", re.IGNORECASE)
_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$")


def frame_meta(frame_bgr: np.ndarray, box_px: tuple[int, int, int, int]) -> dict[str, float]:
    """What ``choose_tools`` looks at: box size and shape in frame pixels, and the grey-level
    spread in a window twice the box's long side around it."""
    x1, y1, x2, y2 = box_px
    w, h = x2 - x1, y2 - y1
    long_side, short_side = max(w, h), max(1, min(w, h))
    cx, cy, half = (x1 + x2) // 2, (y1 + y2) // 2, long_side
    H, W = frame_bgr.shape[:2]
    window = frame_bgr[max(0, cy - half) : min(H, cy + half), max(0, cx - half) : min(W, cx + half)]
    grey = cv2.cvtColor(window, cv2.COLOR_BGR2GRAY) if window.size else np.zeros((1, 1), np.uint8)
    return {
        "long_px": float(long_side),
        "aspect": long_side / short_side,
        "contrast_std": float(grey.std()),
    }


def choose_tools(det: Any, meta: dict[str, float]) -> list[str]:
    """Re-look tools for this detection, most useful first, at most ``MAX_TOOLS``.

    Heuristic rules: low grey-level spread → ``enhance_contrast``; small → ``zoom_native``;
    elongated → ``redetect_region``. With no rule firing, ``zoom_native`` (a sharper view of the
    same spot always helps the model)."""
    tools = []
    if meta["contrast_std"] < LOW_CONTRAST_STD:
        tools.append("enhance_contrast")
    if meta["long_px"] < SMALL_PX:
        tools.append("zoom_native")
    if meta["aspect"] >= ELONGATED:
        tools.append("redetect_region")
    return tools[:MAX_TOOLS] or ["zoom_native"]


def parse_verdict(text: str) -> dict | None:
    """The model's JSON reply checked against ``VERDICT_SCHEMA``; ``None`` if it doesn't fit. A
    reply without ``object`` (prompts before verify-v3, recorded answers) reads as ``object`` null."""
    try:
        data = json.loads(_FENCE.sub("", text.strip()))
    except json.JSONDecodeError:
        return None
    if isinstance(data, dict) and "object" not in data:
        data = {**data, "object": None}
    if not isinstance(data, dict) or set(data) != set(VERDICT_SCHEMA["required"]):
        return None
    if data["object"] not in VERDICT_SCHEMA["properties"]["object"]["enum"]:
        return None
    props = VERDICT_SCHEMA["properties"]
    if data["person"] not in props["person"]["enum"]:
        return None
    if data["posture"] not in props["posture"]["enum"]:
        return None
    g = data["group_size"]
    if g is not None and (isinstance(g, bool) or not isinstance(g, int) or g < 1):
        return None
    if not isinstance(data["reason"], str) or not (
        data["clothing"] is None or isinstance(data["clothing"], str)
    ):
        return None
    return data


def _no_clear(text: str | None) -> str | None:
    """Contract §12.3-4: no text in a mission may say "clear"/"cleared"."""
    return None if text is None else _CLEAR.sub("distinct", text)


def _decode(data: bytes) -> np.ndarray:
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("could not decode image")
    return img


def _jpeg(img: np.ndarray) -> bytes:
    return cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])[1].tobytes()


def _original(store: Any, mission_id: str, frame: Any, frame_bgr: np.ndarray) -> np.ndarray:
    """The full-resolution photo D keeps at ``frames/orig/<id>.jpg`` (D-P1); demo frames are
    already native-scale cuts, so the frame itself stands in when there is none."""
    try:
        return _decode(store.read_file(mission_id, f"frames/orig/{frame.id}.jpg"))
    except (KeyError, FileNotFoundError, ValueError):
        return frame_bgr


def _crop_path(store: Any, mission_id: str, det: Any, frame_bgr: np.ndarray) -> str:
    """The review crop if there is one (conf >= 0.29), else D's near-miss crop, else one cut
    here from the frame the same way (128 px window, 256 px out)."""
    for rel in (det.crop, f"crops/nearmiss/{det.id}.jpg"):
        if rel:
            try:
                store.read_file(mission_id, rel)
                return rel
            except (KeyError, FileNotFoundError):
                pass
    x1, y1, x2, y2 = det.box_px
    side = 128 / max(1, max(x2 - x1, y2 - y1))
    img = zoom_native(frame_bgr, det.box_px, out_px=256, context=side)
    return save(store, mission_id, det.id, "crop", img)


def _ask(
    client: ChatClient, model: str, labels: list[str], image_files: list[Path], prompt: str
) -> tuple[list[ChatResult], dict | None]:
    """One model call, and one retry if the reply isn't valid JSON for the schema."""
    images_text = "\n".join(f"Image {i}: {label}." for i, label in enumerate(labels, 1))
    messages: list[dict] = [
        {"role": "system", "content": prompts.VERIFY_PROMPTS[prompt][0]},
        {"role": "user", "content": prompts.VERIFY_PROMPTS[prompt][1].format(images=images_text)},
    ]
    results = []
    for attempt in range(2):
        r = client.chat(
            messages,
            model=model,
            images=image_files,
            response_format=RESPONSE_FORMAT,
            temperature=0.0,
        )
        results.append(r)
        parsed = parse_verdict(r.text)
        if parsed is not None or attempt == 1:
            return results, parsed
        messages = [
            *messages,
            {"role": "assistant", "content": r.text},
            {"role": "user", "content": prompts.VERIFY_RETRY},
        ]
    return results, None  # pragma: no cover - the loop always returns


def verify(
    store: Any,
    mission_id: str,
    detection_id: str,
    client: ChatClient,
    detector: ArrayDetector,
    *,
    model: str = MODEL_VISION,
    prompt: str = prompts.VERIFY_VERSION,
) -> Verdict:
    """Second look at one detection; stores and returns the ``Verdict``.

    A model reply that is not valid JSON after one retry, or a failed model call, gives
    ``person="unclear"`` with the reason saying so: the reviewer sees that no second look
    happened rather than a guess."""
    start = time.perf_counter()
    det, frame = store.get_detection(mission_id, detection_id)
    frame_bgr = _decode(store.read_file(mission_id, frame.file))
    orig_bgr = _original(store, mission_id, frame, frame_bgr)
    orig_wh = (orig_bgr.shape[1], orig_bgr.shape[0])
    box_orig = to_orig(det.box_px, (frame.width_px, frame.height_px), orig_wh)
    meta = frame_meta(frame_bgr, det.box_px)
    tools = choose_tools(det, meta)

    paths = [_crop_path(store, mission_id, det, frame_bgr)]
    labels = [prompts.IMAGE_LABELS["crop"]]
    for tool in tools:
        t0 = time.perf_counter()
        extra: dict[str, Any] = {}
        if tool == "enhance_contrast":
            img = enhance_contrast(zoom_native(orig_bgr, box_orig))
        elif tool == "zoom_native":
            img = zoom_native(orig_bgr, box_orig)
        else:
            found = redetect_region(detector, orig_bgr, box_orig)
            extra["boxes"] = [
                {"box_px": [d.box.x1, d.box.y1, d.box.x2, d.box.y2], "conf": round(d.conf, 3)}
                for d in found
            ]
            img = draw_boxes(orig_bgr, box_orig, found)
        path = save(store, mission_id, detection_id, tool, img)
        paths.append(path)
        labels.append(prompts.IMAGE_LABELS[tool])
        trace_call(
            store,
            mission_id,
            actor="verifier",
            kind="tool_call",
            summary=f"{tool} on {detection_id}",
            input={"detection": detection_id, "box_px_orig": list(box_orig), "heuristics": meta},
            output={"image": path, "ms": round((time.perf_counter() - t0) * 1000), **extra},
            refs=[detection_id],
        )

    answer: dict | None = None
    used_model, failure, failure_detail = model, None, ""
    with tempfile.TemporaryDirectory() as tmp:
        files = []
        for i, rel in enumerate(paths):
            f = Path(tmp) / f"{i}.jpg"
            f.write_bytes(store.read_file(mission_id, rel))
            files.append(f)
        try:
            results, answer = _ask(client, model, labels, files, prompt)
        except Exception as e:  # timeouts, HTTP errors, LLMError: logged, never raised
            log.exception("verifier model call failed for %s", detection_id)
            results, failure, failure_detail = [], type(e).__name__, failure_text(e)
    for r in results:
        used_model = r.model
        trace_call(
            store,
            mission_id,
            actor="verifier",
            kind="model_call",
            summary=f"VL verdict for {detection_id}",
            input={"prompt": prompt, "images": paths, "tools": tools},
            result=r,
            refs=[detection_id],
        )

    if answer is None:
        why = (
            f"No second look: the model call failed ({failure})."
            if failure
            else "No second look: the model's reply was not valid JSON after one retry."
        )
        answer = {
            "person": "unclear",
            "posture": "unknown",
            "group_size": None,
            "clothing": None,
            "object": None,
            "reason": why,
        }
        if failure:
            trace_call(
                store,
                mission_id,
                actor="verifier",
                kind="note",
                summary=f"No second look: the model call failed ({failure_detail}).",
                output={"failure": failure_detail},
                refs=[detection_id],
            )

    verdict = Verdict(
        id=store.next_id(mission_id, "v"),
        detection_id=detection_id,
        tools=tools,
        relook_crops=paths[1:],
        person=answer["person"],
        posture=answer["posture"],
        group_size=answer["group_size"],
        clothing=_no_clear(answer["clothing"]),
        reason=_no_clear(answer["reason"]) or "",
        object=answer["object"],
        model=used_model,
        ms=round((time.perf_counter() - start) * 1000),
        at=now_iso(),
    )
    store.put_verdict(mission_id, verdict)
    trace_call(
        store,
        mission_id,
        actor="verifier",
        kind="verdict",
        summary=f"{detection_id}: person {verdict.person}"
        + (f", object: {verdict.object}" if verdict.object else ""),
        output=verdict.model_dump(),
        refs=[detection_id, verdict.id],
    )
    return verdict
