"""LANE_A §6 test 3: the OpenCV re-look tools (sightline/agent/relook.py), on synthetic images."""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from sightline.agent.relook import (
    TOOLS_FOR,
    draw_boxes,
    enhance_contrast,
    redetect_region,
    save,
    square_window,
    to_orig,
    zoom_native,
    zoom_window,
)
from sightline.contract import LatLon
from sightline.ml.types import Box, RawDetection
from tests.agent.fake_store import FakeMissionStore


def _local_contrast(img_bgr: np.ndarray) -> float:
    """Mean standard deviation of grey levels in 8 px neighbourhoods."""
    g = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    mean = cv2.blur(g, (8, 8))
    sq = cv2.blur(g * g, (8, 8))
    return float(np.sqrt(np.maximum(sq - mean * mean, 0)).mean())


def _low_contrast_crop() -> np.ndarray:
    """A pale figure on pale rock: grey levels 150-162 only, with a faint texture."""
    rng = np.random.default_rng(0)
    img = np.full((128, 128, 3), 152, np.uint8)
    img += rng.integers(0, 4, img.shape, dtype=np.uint8)
    img[40:90, 55:70] += 6  # the figure: barely brighter
    return img


def test_enhance_contrast_keeps_shape_and_dtype_and_raises_local_contrast() -> None:
    crop = _low_contrast_crop()
    out = enhance_contrast(crop)
    assert out.shape == crop.shape and out.dtype == crop.dtype
    assert _local_contrast(out) > 1.5 * _local_contrast(crop)


def test_to_orig_undoes_a_4x_downscale_and_a_cut_offset() -> None:
    assert to_orig((250, 150, 260, 170), (1000, 750), (4000, 3000)) == (1000, 600, 1040, 680)
    assert to_orig((10, 20, 30, 40), (1000, 750), (1000, 750), origin=(1500, 900)) == (
        1510,
        920,
        1530,
        940,
    )


def test_zoom_native_reads_the_right_original_pixels_for_a_4x_downscaled_frame() -> None:
    orig = np.zeros((3000, 4000, 3), np.uint8)
    orig[600:680, 1000:1040] = (0, 0, 255)  # a red 40x80 person in the original
    frame = cv2.resize(orig, (1000, 750), interpolation=cv2.INTER_AREA)
    frame_box = (250, 150, 260, 170)  # where the detector saw it in the frame
    assert frame[160, 255].tolist() == [0, 0, 255]

    box = to_orig(frame_box, (1000, 750), (4000, 3000))
    out = zoom_native(orig, box, out_px=384, context=2.5)
    assert out.shape == (384, 384, 3)
    assert out[192, 192].tolist() == [0, 0, 255]  # the person is in the middle
    # 80 px tall in a 200 px window → about 154 of 384 px: drawn from native pixels, not the frame
    red_rows = np.flatnonzero((out[:, 192, 2] > 200) & (out[:, 192, 0] < 50))
    assert 140 <= len(red_rows) <= 165


def test_zoom_native_near_an_edge_moves_the_window_inside() -> None:
    orig = np.zeros((750, 1000, 3), np.uint8)
    assert square_window((0, 0, 10, 20), 50, 1000, 750) == (0, 0, 50, 50)
    assert zoom_native(orig, (990, 740, 1000, 750), out_px=128).shape == (128, 128, 3)


class _CentreDetector:
    """Finds one 20x40 'person' at the centre of every array it is given; records the shapes."""

    def __init__(self) -> None:
        self.shapes: list[tuple[int, ...]] = []

    def detect_array(self, img_bgr: np.ndarray, conf: float = 0.05) -> list[RawDetection]:
        self.shapes.append(img_bgr.shape)
        h, w = img_bgr.shape[:2]
        return [RawDetection(Box(w // 2 - 10, h // 2 - 20, w // 2 + 10, h // 2 + 20), 0.6)]


def test_redetect_region_runs_a_native_and_an_upscaled_pass_in_original_pixels() -> None:
    det = _CentreDetector()
    orig = np.zeros((3000, 4000, 3), np.uint8)
    out = redetect_region(det, orig, (1990, 1480, 2010, 1520))
    assert det.shapes == [(1024, 1024, 3), (1024, 1024, 3)]  # native window; 512 px upscaled 2x
    # native pass: 20x40 at the centre; upscaled pass: the same spot at half size, 10x20
    assert sorted((d.box.width_px, d.box.height_px) for d in out) == [(10, 20), (20, 40)]
    for d in out:
        assert d.box.center == pytest.approx((2000, 1500), abs=1)


def test_redetect_region_on_a_demo_frame_smaller_than_the_window() -> None:
    det = _CentreDetector()
    out = redetect_region(det, np.zeros((750, 1000, 3), np.uint8), (490, 355, 510, 395))
    assert det.shapes == [(750, 1000, 3), (1024, 1024, 3)]
    assert all(0 <= d.box.x1 and d.box.x2 <= 1000 and d.box.y2 <= 750 for d in out)


def test_zoom_of_a_big_box_in_a_short_frame_stays_square() -> None:
    """A 400 px box in a 750 px tall frame: the window is cut square (750), not 1000x750
    stretched to a square, so draw_boxes' outline lands on the box."""
    orig = np.zeros((750, 1000, 3), np.uint8)
    box = (300, 175, 700, 575)
    x1, y1, x2, y2 = zoom_window(box, 1000, 750)
    assert x2 - x1 == y2 - y1 == 750
    img = draw_boxes(orig, box, [RawDetection(Box(*box), 0.6)])
    scale = 384 / 750
    assert img[round((175 - y1) * scale), round((500 - x1) * scale)].any()  # top edge, centre


def test_draw_boxes_outlines_detections_on_the_zoom_only() -> None:
    orig = np.zeros((750, 1000, 3), np.uint8)
    img = draw_boxes(orig, (490, 355, 510, 395), [RawDetection(Box(490, 355, 510, 395), 0.6)])
    assert img.shape == (384, 384, 3) and img.any()
    assert not orig.any()  # the photo itself is untouched


def test_save_stores_a_jpeg_under_relook(tmp_path) -> None:
    store = FakeMissionStore()
    mid = store.create("m", "a", LatLon(lat=0, lon=0), "demo").mission_id
    path = save(store, mid, "f0001-d01", "zoom_native", np.zeros((64, 64, 3), np.uint8))
    assert path == "relook/f0001-d01-zoom_native.jpg"
    assert store.read_file(mid, path)[:2] == b"\xff\xd8"


def test_tools_cover_the_three_failure_modes() -> None:
    assert TOOLS_FOR == {
        "low_contrast": ["enhance_contrast"],
        "small": ["zoom_native"],
        "group_or_lying": ["redetect_region"],
    }
