"""The demo's second look, from the demo's own flight (#192): one near-miss detection of the demo
cache, run through the real agent with the live VL model, saved as a fixture.

    bash web/scripts/fetch-caches.sh                                   # once: the demo cache
    uv run --env-file .env python scripts/make_second_look_fixture.py --candidates   # the table
    uv run --env-file .env python scripts/make_second_look_fixture.py f0273-d02      # the live run
    uv run python scripts/make_command_fixtures.py                     # then: the demo mission
    uv run python scripts/make_fleet_fixture.py                        # then: the fleet

``--candidates`` lists the demo's near misses (detector 0.12 to 0.28, under the 0.29 review threshold)
with their box size and whether a HERIDAL label lies under them (``--labels``, the test split's YOLO
labels; the 500 demo frames are 1000 x 750 cuts of test photos), then the labelled people in the 500
frames and their scores. No model is called.

With a detection id it builds a mission holding that frame and its detection the way the pipeline
stores them, writes the pipeline's near-miss note, and calls ``loop.handle("detection")``: the
verifier's OpenCV re-look tools on the frame (a native-resolution cut of the photo), then the VL
model on Token Factory (``NEBIUS_API_KEY`` from the environment only; never written anywhere). No
decision is made: the promotion, if the model's answer gives one, stays pending for the person at
the review. Writes ``web/src/command/__fixtures__/second_look/``: ``trace.jsonl`` (the note, the
tool calls, the model call, the verdict, the proposal), ``verdict.json`` (the verdict as stored, and
the detection's place) and the images the trace names (each JPEG at most 150 KB).
``make_command_fixtures.py`` replays this answer, word for word, for the same detection in the demo
mission (traced as ``recorded/<model>``), so the mission's own trace and its review card carry it.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

CACHE = ROOT / "web/public/cache/demo"
OUT = ROOT / "web/src/command/__fixtures__/second_look"
LABELS = ROOT / "data/heridal/yolo_full/test"
BAND = (0.12, 0.29)  # the verifier's near-miss band as #192 asks for it: 0.12 to under 0.29
MIN_BOX_PX = 30
MAX_JPEG = 150_000


def _iou(a: list[float], b: list[float]) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union else 0.0


def labelled_boxes(frame: dict, labels: Path) -> list[list[float]]:
    """The HERIDAL people under one demo frame, in frame pixels (the frame is a native-scale cut
    of its test photo at ``source.x0, source.y0``)."""
    from PIL import Image

    src = frame["source"]["image"]
    path = labels / "labels" / f"{Path(src).stem}.txt"
    if not path.is_file():
        return []
    width, height = Image.open(labels / "images" / src).size
    x0, y0 = frame["source"]["x0"], frame["source"]["y0"]
    out = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        _, cx, cy, w, h = map(float, line.split())
        b = [(cx - w / 2) * width - x0, (cy - h / 2) * height - y0,
             (cx + w / 2) * width - x0, (cy + h / 2) * height - y0]  # fmt: skip
        if b[2] > 0 and b[3] > 0 and b[0] < frame["width_px"] and b[1] < frame["height_px"]:
            out.append(b)
    return out


def candidates(labels: Path) -> int:
    survey = json.loads((CACHE / "survey.json").read_text())
    dets = json.loads((CACHE / "detections.json").read_text())["frames"]
    frames = {f["id"]: f for f in survey["frames"]}
    labelled = {fid: labelled_boxes(f, labels) for fid, f in frames.items()}
    print(f"labelled people in the {len(frames)} demo frames: {sum(map(len, labelled.values()))}")
    for fid, boxes in labelled.items():
        for b in boxes:
            best = max(dets.get(fid, []), key=lambda d: _iou(d["box_px"], b), default=None)
            hit = (
                f"{best['id']} detector {best['conf']:.3f}"
                if best and _iou(best["box_px"], b) > 0.1
                else "no detection"
            )
            print(
                f"  {fid} ({frames[fid]['source']['image']}) label {[round(v) for v in b]}: {hit}"
            )
    print(f"\nnear misses, detector {BAND[0]} to under {BAND[1]}:")
    print("| detection | detector | box px | short side >= 30 | HERIDAL label under it |")
    print("|---|---|---|---|---|")
    rows = [d for ds in dets.values() for d in ds if BAND[0] <= d["conf"] < BAND[1]]
    for d in sorted(rows, key=lambda d: -d["conf"]):
        x1, y1, x2, y2 = d["box_px"]
        lab = max((_iou(d["box_px"], b) for b in labelled[d["id"][:5]]), default=0.0)
        print(f"| {d['id']} | {d['conf']:.3f} | {x2 - x1} x {y2 - y1} | "
              f"{'yes' if min(x2 - x1, y2 - y1) >= MIN_BOX_PX else 'no'} | "
              f"{f'yes (IoU {lab:.2f})' if lab > 0.1 else 'no'} |")  # fmt: skip
    return 0


def mission_of(detection_id: str, root: Path):
    """A mission (the real ``MissionStore`` under ``root``) on the demo cache's map, holding the
    flight's frames (1000 x 750 cuts, native scale) and the detection's frame's detections, as the pipeline stores
    them. Returns ``(store, mission_id, det)``."""
    from sightline.contract import (
        CONTRACT_VERSION,
        Detection,
        Frame,
        LatLon,
        MapBase,
        MapFile,
    )
    from sightline.mission import MissionStore

    survey = json.loads((CACHE / "survey.json").read_text())
    dets = json.loads((CACHE / "detections.json").read_text())["frames"]
    m = MapFile.model_validate_json((CACHE / "map.json").read_text())
    fid = detection_id.split("-")[0]
    det = next(Detection.model_validate(d) for d in dets[fid] if d["id"] == detection_id)
    store = MissionStore(root / "missions")
    lkp = LatLon.model_validate(survey["area"]["lkp"])
    mid = store.create("Mount Seymour (demo): second look", "Mount Seymour", lkp, "demo").mission_id
    store.put_map_base(mid, MapBase(contract_version=CONTRACT_VERSION, grid=m.grid, lkp=m.lkp,
                                    params=m.params, prior=m.prior, canopy=m.canopy))  # fmt: skip
    frames = [Frame.model_validate(f) for f in survey["frames"]]  # in flight order, as flown
    for k, f in enumerate(frames):
        store.append_frame(mid, f.model_copy(update={"rank": k + 1}), (CACHE / f.file).read_bytes())
    store.set_frames(mid, frames)
    ds = [Detection.model_validate(d) for d in dets[fid]]  # the frame's detections, ids in order
    store.append_detections(
        mid, fid, ds, {d.crop: (CACHE / d.crop).read_bytes() for d in ds if d.crop}
    )
    return store, mid, det


def run(detection_id: str, onnx: Path | None) -> int:
    from sightline.agent import loop
    from sightline.agent.llm import NO_THINKING, token_factory_client
    from sightline.agent.loop import CANDIDATE_THRESHOLD
    from sightline.agent.trace import trace_call
    from sightline.ml.backend import make_detector

    tmp = Path(tempfile.mkdtemp(prefix="second-look-"))
    store, mid, det = mission_of(detection_id, tmp)
    if not BAND[0] <= det.conf < CANDIDATE_THRESHOLD:
        print(f"{detection_id}: detector {det.conf} is not a near miss")
        return 1
    trace_call(
        store,
        mid,
        actor="pipeline",
        kind="note",
        summary=(
            f"detection {det.id} in survey photo {det.id[:5]}: confidence {det.conf:.3f}, below the "
            f"{CANDIDATE_THRESHOLD} review threshold, so it is not in the review queue (near-miss)"
        ),
        input={"photo": det.id[:5], "box_px": list(det.box_px)},
        refs=[det.id],
    )
    proposals = loop.handle(
        "detection",
        store,
        mid,
        det.id,
        client=token_factory_client(extra_body=NO_THINKING),
        detector=make_detector(backend="cv2", onnx=onnx),
    )
    state = store.state(mid)
    verdict = next(v for v in state["verdicts"] if v.detection_id == det.id)
    if OUT.exists():
        for f in OUT.iterdir():
            f.unlink()
    OUT.mkdir(parents=True, exist_ok=True)
    entries = store.trace_entries(mid)
    trace = "".join(e.model_dump_json() + "\n" for e in entries).replace(mid, "demo")
    (OUT / "trace.jsonl").write_text(trace, encoding="utf-8")
    model_call = next(e for e in entries if e.kind == "model_call")
    doc = {
        "note": "Written by scripts/make_second_look_fixture.py: the real second look on a near-miss "
        "detection of the demo's own flight, with the live VL model; the answer is kept word for word.",
        "detection": det.model_dump(mode="json"),
        "verdict": verdict.model_dump(mode="json"),
        "answer": model_call.output["text"] if model_call.output else None,
        "model_call": {
            k: getattr(model_call, k) for k in ("model", "ms", "tokens_in", "tokens_out")
        },
        "proposals": [p.model_dump(mode="json") for p in proposals],
    }
    (OUT / "verdict.json").write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
    for rel in [*verdict.relook_crops, f"relook/{det.id}-crop.jpg"]:
        data = store.read_file(mid, rel)
        if len(data) > MAX_JPEG:
            raise SystemExit(f"{rel} is {len(data)} bytes, over {MAX_JPEG}")
        (OUT / Path(rel).name).write_bytes(data)
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"{det.id} (detector {det.conf:.3f}): person {verdict.person}; {verdict.reason}")
    print(f"answer, as the model gave it:\n{doc['answer']}")
    for p in proposals:
        print(f"proposal {p.id} {p.kind} {p.status}: {p.summary}")
    print(f"wrote {OUT.relative_to(ROOT)}: {sorted(f.name for f in OUT.iterdir())}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("detection", nargs="?", help="a near-miss detection of the demo cache")
    ap.add_argument("--candidates", action="store_true", help="list the near misses; no model")
    ap.add_argument("--labels", type=Path, default=LABELS, help="HERIDAL test labels (YOLO)")
    ap.add_argument("--onnx", type=Path, default=None, help="the detector for redetect_region")
    args = ap.parse_args(argv)
    if not (CACHE / "detections.json").is_file():
        print(f"no {CACHE}/detections.json: run `bash web/scripts/fetch-caches.sh` first")
        return 1
    if args.candidates or not args.detection:
        return candidates(args.labels)
    return run(args.detection, args.onnx)


if __name__ == "__main__":
    raise SystemExit(main())
