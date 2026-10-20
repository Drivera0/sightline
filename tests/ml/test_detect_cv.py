"""OpenCV 5 detector path (sightline/ml/detect_cv.py): the pure parts, no model needed."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest

from sightline.ml import detect_cv
from sightline.ml.detect_cv import (
    CvDetector,
    Letterbox,
    decode_slice,
    int_box,
    iou,
    letterbox,
    letterboxed,
    merge_slices,
    nms,
    nms_inclusive,
    offset,
    slice_boxes,
)
from sightline.ml.tiling import tile_grid
from sightline.ml.types import Box, RawDetection


def test_slices_of_a_4000x3000_photo() -> None:
    # SAHI steps by slice - int(0.2 * 1024) = 820 px; the training grid (tiling.py) rounds to 819.
    # Same 20 windows, last row/column snapped to the edge, so both cover the photo identically.
    slices = slice_boxes(4000, 3000)
    assert len(slices) == len(tile_grid(4000, 3000)) == 20
    assert slices[0] == (0, 0, 1024, 1024)
    assert slices[1] == (820, 0, 1844, 1024)
    assert slices[-1] == (2976, 1976, 4000, 3000)
    assert all(x2 - x1 == 1024 and y2 - y1 == 1024 for x1, y1, x2, y2 in slices)


def test_slices_match_sahi_when_installed() -> None:
    slicing = pytest.importorskip("sahi.slicing")
    for w, h in [(4000, 3000), (1000, 750), (1920, 1080), (2048, 1024)]:
        expected = slicing.get_slice_bboxes(
            h, w, 1024, 1024, overlap_height_ratio=0.2, overlap_width_ratio=0.2
        )
        assert slice_boxes(w, h) == [tuple(b) for b in expected]


def test_small_image_is_one_slice() -> None:
    assert slice_boxes(1000, 750) == [(0, 0, 1000, 750)]


def test_letterbox_full_slice_is_identity() -> None:
    assert letterbox(1024, 1024) == Letterbox(1.0, 0, 0, 1024, 1024)


def test_letterbox_frame_scales_up_and_pads_height() -> None:
    lb = letterbox(1000, 750)
    assert lb.scale == pytest.approx(1.024)
    assert (lb.width, lb.height) == (1024, 768)
    assert (lb.pad_x, lb.pad_y) == (0, 128)
    canvas = letterboxed(np.zeros((750, 1000, 3), np.uint8), lb)
    assert canvas.shape == (1024, 1024, 3)
    assert canvas[0, 0, 0] == 114 and canvas[512, 512, 0] == 0


def test_merge_suppresses_at_the_threshold() -> None:
    a = ((0.0, 0.0, 10.0, 10.0), 0.9)
    b = ((0.0, 0.0, 10.0, 10.0 / 1.5), 0.8)  # IoU exactly 2/3
    assert nms_inclusive([a, b], 2 / 3) == [a]
    assert nms_inclusive([a, b], 0.7) == [a, b]


def test_decode_slice_maps_back_through_the_letterbox() -> None:
    lb = letterbox(1000, 750)  # scale 1.024, pad_y 128
    out = np.zeros((5, 3), np.float32)
    # anchor 0: a 20x40 box centred at (512, 512) in input pixels, score 0.9
    out[:, 0] = [512, 512, 20, 40, 0.9]
    # anchor 1: almost the same box, lower score: removed by per-slice NMS
    out[:, 1] = [513, 512, 20, 40, 0.5]
    # anchor 2: below conf
    out[:, 2] = [100, 300, 20, 40, 0.01]
    dets = decode_slice(out, lb, 1000, 750, conf=0.05)
    assert len(dets) == 1
    (x1, y1, x2, y2), c = dets[0]
    assert c == pytest.approx(0.9)
    assert x1 == pytest.approx((502) / 1.024)
    assert y1 == pytest.approx((492 - 128) / 1.024)
    assert x2 == pytest.approx((522) / 1.024)
    assert y2 == pytest.approx((532 - 128) / 1.024)


def test_int_box_rounds_clips_and_drops_degenerate() -> None:
    assert int_box((-3.2, 1.6, 10.4, 2000.0), 100, 50) == Box(0, 2, 10, 50)
    assert int_box((5.0, 5.0, 5.2, 9.0), 100, 50) is None


# --- the rest of web/src/detect/tiling.test.ts ----------------------------------------------------


def test_first_row_of_slices_matches_tiling_ts() -> None:
    assert slice_boxes(4000, 3000)[:5] == [
        (0, 0, 1024, 1024),
        (820, 0, 1844, 1024),
        (1640, 0, 2664, 1024),
        (2460, 0, 3484, 1024),
        (2976, 0, 4000, 1024),
    ]


def test_slices_cover_every_pixel() -> None:
    s = slice_boxes(2500, 1700)
    for x, y in [(0, 0), (2499, 1699), (1250, 850)]:
        assert any(x1 <= x < x2 and y1 <= y < y2 for x1, y1, x2, y2 in s)


def test_nms_keeps_the_most_confident_of_overlapping_boxes() -> None:
    assert iou((0, 0, 10, 10), (5, 0, 15, 10)) == pytest.approx(1 / 3)
    kept = nms([((0, 0, 10, 10), 0.5), ((1, 0, 11, 10), 0.9), ((50, 50, 60, 60), 0.3)], 0.5)
    assert [c for _, c in kept] == [0.9, 0.3]


def test_nms_suppresses_at_exactly_the_threshold_only_when_inclusive() -> None:
    a, b = ((0, 0, 10, 10), 0.9), ((0, 0, 10, 5), 0.8)  # IoU 0.5
    assert len(nms([a, b], 0.5)) == 2
    assert len(nms([a, b], 0.5, inclusive=True)) == 1
    assert nms([a, ((50, 50, 60, 60), 0.1)], 0.5, max_det=1) == [a]


def test_decode_slice_matches_tiling_ts_case() -> None:
    out = np.array(
        [
            [100, 500, 300],  # cx
            [228, 600, 400],  # cy (input pixels, 128 px top padding)
            [20, 10, 40],  # w
            [40, 10, 20],  # h
            [0.9, 0.01, 0.4],  # score
        ],
        np.float32,
    )
    dets = decode_slice(out, letterbox(1000, 750), 1000, 750, conf=0.05)
    assert [c for _, c in dets] == pytest.approx([0.9, 0.4])
    x1, y1, x2, y2 = dets[0][0]
    assert (x1, y1, x2, y2) == pytest.approx(
        (90 / 1.024, (208 - 128) / 1.024, 110 / 1.024, (248 - 128) / 1.024)
    )


def test_merge_joins_a_person_seen_by_two_overlapping_slices() -> None:
    a = offset([((900, 100, 960, 160), 0.8)], (0, 0, 1024, 1024))
    b = offset([((81, 101, 141, 161), 0.7)], (820, 0, 1844, 1024))
    assert merge_slices([a, b], 4000, 3000) == [RawDetection(Box(900, 100, 960, 160), 0.8)]


def test_merge_drops_degenerate_boxes() -> None:
    assert merge_slices([[((10.2, 10, 10.4, 20), 0.9)]], 100, 100) == []


def test_cv2_nmsboxes_matches_the_tiling_ts_nms() -> None:
    """decode_slice uses cv2.dnn.NMSBoxes; it must keep the same boxes as tiling.ts's nms."""
    rng = np.random.default_rng(3)
    n = 400
    cx, cy = rng.uniform(100, 300, n), rng.uniform(100, 300, n)  # crowded: many overlaps
    w, h = rng.uniform(10, 60, n), rng.uniform(10, 60, n)
    score = rng.permutation(np.linspace(0.06, 0.99, n))  # distinct, so no tie-order ambiguity
    out = np.stack([cx, cy, w, h, score]).astype(np.float32)
    got = decode_slice(out, letterbox(1024, 1024), 1024, 1024, conf=0.05)
    raw = [
        ((float(x - ww / 2), float(y - hh / 2), float(x + ww / 2), float(y + hh / 2)), float(s))
        for x, y, ww, hh, s in out.T
    ]
    want = nms(raw, detect_cv.SLICE_NMS_IOU, detect_cv.MAX_DET)
    assert len(got) == len(want) > 10
    for (gb, gc), (wb, wc) in zip(got, want, strict=True):
        assert gc == pytest.approx(wc) and gb == pytest.approx(wb, abs=1e-3)


# --- CvDetector with a fake network -------------------------------------------------------------


class _FakeNet:
    """One 20x40 box at the centre of every input, score 0.9; records the blobs."""

    def __init__(self) -> None:
        self.blobs: list[np.ndarray] = []

    def setInput(self, blob: np.ndarray) -> None:
        self.blobs.append(blob)

    def forward(self) -> np.ndarray:
        out = np.zeros((1, 5, 2), np.float32)
        out[0, :, 0] = [512, 512, 20, 40, 0.9]
        return out


@pytest.fixture
def fake_detector(monkeypatch, tmp_path) -> tuple[CvDetector, _FakeNet, list[int]]:
    net, threads = _FakeNet(), []
    monkeypatch.setattr(cv2.dnn, "readNetFromONNX", lambda _: net)
    monkeypatch.setattr(cv2, "setNumThreads", threads.append)
    onnx = tmp_path / "m.onnx"
    onnx.write_bytes(b"")
    det = CvDetector(onnx, threads=2)
    net.blobs.clear()  # drop the one-time dynamic-input check
    return det, net, threads


def test_threads_are_set(fake_detector) -> None:
    assert fake_detector[2] == [2]


def test_detect_frame_is_one_letterboxed_pass(fake_detector, tmp_path: Path) -> None:
    det, net, _ = fake_detector
    frame = tmp_path / "f.png"
    cv2.imwrite(str(frame), np.zeros((750, 1000, 3), np.uint8))
    assert det.detect_frame(frame) == [RawDetection(Box(490, 355, 510, 395), pytest.approx(0.9))]
    assert len(net.blobs) == 1 and net.blobs[0].shape == (1, 3, 1024, 1024)
    assert net.blobs[0][0, 0, 0, 0] == pytest.approx(114 / 255)  # grey padding on top
    with pytest.raises(FileNotFoundError):
        det.detect_frame(tmp_path / "missing.jpg")


def test_detect_array_slices_a_2x_upscaled_window(fake_detector) -> None:
    det, net, _ = fake_detector
    dets = det.detect_array(np.zeros((1024, 2048, 3), np.uint8))
    assert len(net.blobs) == len(slice_boxes(2048, 1024)) == 3
    assert sorted(d.box.x1 for d in dets) == [502, 1322, 1526]  # slices at x 0, 820, 1024


# --- rect letterbox (dynamic ONNX), as YOLO.predict pads a .pt model ----------------------------


def test_rect_letterbox_pads_only_to_a_multiple_of_32() -> None:
    assert letterbox(1000, 750, stride=32) == Letterbox(1.024, 0, 0, 1024, 768, 1024, 768)
    assert letterbox(1024, 1024, stride=32) == letterbox(1024, 1024)
    lb = letterbox(600, 1000, stride=32)  # 614 px wide: 26 px to the next multiple of 32
    assert (lb.width, lb.pad_x, lb.canvas_w, lb.canvas_h) == (614, 13, 640, 1024)


def test_rect_letterbox_matches_ultralytics_when_installed() -> None:
    augment = pytest.importorskip("ultralytics.data.augment")
    for w, h in [(1000, 750), (600, 1000), (1024, 1024), (333, 517)]:
        img = np.zeros((h, w, 3), np.uint8)
        want = augment.LetterBox((1024, 1024), auto=True, stride=32)(image=img)
        lb = letterbox(w, h, stride=32)
        assert (lb.canvas_h, lb.canvas_w) == want.shape[:2]


class _DynamicNet(_FakeNet):
    """Accepts any input size: one anchor per cell of strides 8/16/32, box at the input centre."""

    def forward(self) -> np.ndarray:
        h, w = self.blobs[-1].shape[2:]
        n = sum((w // s) * (h // s) for s in (8, 16, 32))
        out = np.zeros((1, 5, n), np.float32)
        out[0, :, 0] = [w / 2, h / 2, 20, 40, 0.9]
        return out


def test_dynamic_onnx_is_detected_and_runs_frames_unpadded(monkeypatch, tmp_path: Path) -> None:
    net = _DynamicNet()
    monkeypatch.setattr(cv2.dnn, "readNetFromONNX", lambda _: net)
    onnx = tmp_path / "m.onnx"
    onnx.write_bytes(b"")
    det = CvDetector(onnx)
    assert det.rect
    frame = tmp_path / "f.png"
    cv2.imwrite(str(frame), np.zeros((750, 1000, 3), np.uint8))
    dets = det.detect_frame(frame)
    assert net.blobs[-1].shape == (1, 3, 768, 1024)  # no grey bands
    assert dets == [RawDetection(Box(490, 355, 510, 395), pytest.approx(0.9))]


def test_fixed_size_onnx_keeps_square_padding(fake_detector) -> None:
    assert not fake_detector[0].rect
