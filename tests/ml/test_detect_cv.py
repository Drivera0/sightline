"""OpenCV 5 detector path (sightline/ml/detect_cv.py): the pure parts, no model needed."""

from __future__ import annotations

import numpy as np
import pytest

from sightline.ml.detect_cv import (
    Letterbox,
    decode_slice,
    int_box,
    letterbox,
    letterboxed,
    nms_inclusive,
    slice_boxes,
)
from sightline.ml.tiling import tile_grid
from sightline.ml.types import Box


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
