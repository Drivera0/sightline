"""LANE_A §6 test 4: the verifier (sightline/agent/verify.py) with FakeChatClient and the fake
store. No network, no keys, no model files."""

from __future__ import annotations

import json
import re

import cv2
import numpy as np
import pytest

from sightline.agent.llm import ChatResult, FakeChatClient
from sightline.agent.verify import choose_tools, frame_meta, parse_verdict, verify
from sightline.contract import Detection, Frame, LatLon, Pose, Source, Verdict
from sightline.ml.types import Box, RawDetection
from tests.agent.fake_store import FakeMissionStore

YES = {
    "person": "yes",
    "posture": "lying",
    "group_size": 1,
    "clothing": "red jacket",
    "reason": "A person lying on the rocks, red jacket visible.",
}


class _CentreDetector:
    def detect_array(self, img_bgr: np.ndarray, conf: float = 0.05) -> list[RawDetection]:
        h, w = img_bgr.shape[:2]
        return [RawDetection(Box(w // 2 - 10, h // 2 - 20, w // 2 + 10, h // 2 + 20), 0.6)]


def _frame() -> Frame:
    corners = ((-122.95, 49.37), (-122.94, 49.37), (-122.94, 49.36), (-122.95, 49.36))
    return Frame(
        id="f0001",
        file="frames/f0001.jpg",
        width_px=1000,
        height_px=750,
        flight_index=0,
        source=Source(image="x.jpg", x0=0, y0=0),
        pose=Pose(lat=49.37, lon=-122.94, alt_agl_m=50, heading_deg=0, gsd_m=0.02),
        footprint=corners,
        score=0.5,
        rank=1,
        n_candidates=1,
    )


def _mission(conf: float = 0.21, box=(480, 340, 510, 400)) -> tuple[FakeMissionStore, str]:
    """One textured frame with one detection; near-miss by default (no review crop)."""
    store = FakeMissionStore()
    mid = store.create("m", "Seymour", LatLon(lat=49.37, lon=-122.94), "demo").mission_id
    rng = np.random.default_rng(0)
    img = rng.integers(0, 255, (750, 1000, 3), dtype=np.uint8)
    store.append_frame(mid, _frame(), cv2.imencode(".jpg", img)[1].tobytes())
    det = Detection(
        id="f0001-d01", box_px=box, conf=conf, crop=None, lat=49.37, lon=-122.94, radius_m=10
    )
    store.append_detections(mid, "f0001", [det], {})
    return store, mid


def _trace_text(store: FakeMissionStore, mid: str) -> str:
    return store.trace_jsonl(mid)


def test_a_valid_reply_becomes_a_stored_verdict_with_one_model_call() -> None:
    store, mid = _mission()
    client = FakeChatClient(default=json.dumps(YES))
    v = verify(store, mid, "f0001-d01", client, _CentreDetector())

    assert Verdict.model_validate(v.model_dump()) == v
    assert (v.person, v.posture, v.group_size, v.clothing) == ("yes", "lying", 1, "red jacket")
    assert v.id == "v0001" and store.state(mid)["verdicts"] == [v]
    assert all(p.startswith("relook/f0001-d01-") for p in v.relook_crops)

    kinds = [e.kind for e in store.trace_entries(mid)]
    assert kinds.count("model_call") == 1 and kinds[-1] == "verdict"
    assert kinds.count("tool_call") == len(v.tools)
    text = _trace_text(store, mid)
    assert "base64" not in text and "data:image" not in text
    call = next(e for e in store.trace_entries(mid) if e.kind == "model_call")
    assert call.input["images"][0] == "relook/f0001-d01-crop.jpg"  # near-miss: crop cut here
    assert call.input["images"][1:] == v.relook_crops

    sent = client.calls[0]
    assert len(sent["images"]) == 1 + len(v.tools) <= 3
    assert sent["temperature"] == 0 and sent["response_format"]["type"] == "json_schema"


def test_invalid_json_is_retried_once_then_unclear() -> None:
    store, mid = _mission()
    client = FakeChatClient(default="I think it's a person")
    v = verify(store, mid, "f0001-d01", client, _CentreDetector())
    assert v.person == "unclear" and "not valid JSON" in v.reason
    assert len(client.calls) == 2
    retry = client.calls[1]["messages"]
    assert retry[-2] == {"role": "assistant", "content": "I think it's a person"}
    assert [e.kind for e in store.trace_entries(mid)].count("model_call") == 2


def test_retry_that_succeeds_is_used() -> None:
    store, mid = _mission()
    client = FakeChatClient(
        {"Is there a person": ["nope", json.dumps(YES)]}, default=json.dumps(YES)
    )
    assert verify(store, mid, "f0001-d01", client, _CentreDetector()).person == "yes"


def test_a_failed_model_call_is_logged_and_says_so() -> None:
    store, mid = _mission()
    client = FakeChatClient(default=TimeoutError("slow"))
    v = verify(store, mid, "f0001-d01", client, _CentreDetector())
    assert v.person == "unclear" and "TimeoutError" in v.reason
    assert v.model  # still names the model that was asked
    assert any(e.kind == "note" for e in store.trace_entries(mid))


def test_review_crop_is_used_when_there_is_one() -> None:
    store, mid = _mission(conf=0.6)
    det = store.get_detection(mid, "f0001-d01")[0]
    store.put_file(mid, "crops/f0001-d01.jpg", store.read_file(mid, "frames/f0001.jpg"))
    det_with_crop = det.model_copy(update={"crop": "crops/f0001-d01.jpg"})
    store._get(mid).detections["f0001"] = [det_with_crop]
    client = FakeChatClient(default=json.dumps(YES))
    verify(store, mid, "f0001-d01", client, _CentreDetector())
    call = next(e for e in store.trace_entries(mid) if e.kind == "model_call")
    assert call.input["images"][0] == "crops/f0001-d01.jpg"


def test_the_word_clear_never_reaches_the_mission() -> None:
    store, mid = _mission()
    reply = dict(YES, reason="The ground nearby is clear; a person is lying there.")
    v = verify(
        store, mid, "f0001-d01", FakeChatClient(default=json.dumps(reply)), _CentreDetector()
    )
    assert not re.search(r"\bclear(s|ed|ing)?\b", v.reason, re.IGNORECASE)


def test_model_name_comes_from_the_result() -> None:
    store, mid = _mission()
    result = ChatResult(json.dumps(YES), [], "nvidia/some-vl", 900, 1200, 40)
    v = verify(store, mid, "f0001-d01", FakeChatClient(default=result), _CentreDetector())
    assert v.model == "nvidia/some-vl"


# --- tool choice and parsing ------------------------------------------------------------------


def test_choose_tools_by_failure_mode() -> None:
    flat = np.full((750, 1000, 3), 120, np.uint8)
    busy = np.random.default_rng(1).integers(0, 255, (750, 1000, 3), dtype=np.uint8)
    small, lying = (500, 500, 520, 530), (500, 500, 580, 530)
    assert choose_tools(None, frame_meta(busy, small)) == ["zoom_native"]
    assert choose_tools(None, frame_meta(flat, small)) == ["enhance_contrast", "zoom_native"]
    assert choose_tools(None, frame_meta(busy, lying)) == ["redetect_region"]
    big_square = (400, 300, 480, 380)
    assert choose_tools(None, frame_meta(busy, big_square)) == ["zoom_native"]  # default
    assert len(choose_tools(None, frame_meta(flat, (500, 500, 530, 510)))) == 2  # capped


@pytest.mark.parametrize(
    "text,ok",
    [
        (json.dumps(YES), True),
        ("```json\n" + json.dumps(YES) + "\n```", True),
        (json.dumps(dict(YES, person="maybe")), False),
        (json.dumps(dict(YES, group_size=0)), False),
        (json.dumps(dict(YES, group_size=True)), False),
        (json.dumps({k: v for k, v in YES.items() if k != "reason"}), False),
        (json.dumps(dict(YES, extra=1)), False),
        ("[1, 2]", False),
    ],
)
def test_parse_verdict(text: str, ok: bool) -> None:
    assert (parse_verdict(text) is not None) == ok
