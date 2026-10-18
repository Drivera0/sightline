"""Test-time augmentation: box mapping for the 8 dihedral views, and weighted box fusion."""

from __future__ import annotations

import numpy as np
import pytest

from sightline.ml.tta import TRANSFORMS, boxes_back, transform_image, weighted_box_fusion


def _nonzero_box(a: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(a)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


@pytest.mark.parametrize("name", list(TRANSFORMS))
def test_boxes_map_back_to_the_original_position(name: str) -> None:
    w, h = 40, 25  # not square, so width/height swaps are exercised
    img = np.zeros((h, w), dtype=np.uint8)
    img[3:9, 30:37] = 1  # box x 30..37, y 3..9
    view = transform_image(img, name)
    if TRANSFORMS[name][0] % 2:
        assert view.shape == (w, h)
    bx = _nonzero_box(view)
    back = boxes_back([(*bx, 0.9)], name, w, h)
    assert back == [(30, 3, 37, 9, 0.9)]


def test_all_eight_views_are_distinct() -> None:
    img = np.arange(12).reshape(3, 4)
    views = {
        transform_image(img, n).tobytes() + bytes(transform_image(img, n).shape) for n in TRANSFORMS
    }
    assert len(views) == 8


def test_wbf_fuses_overlapping_boxes_and_averages_score_over_views() -> None:
    views = [
        [(0.0, 0.0, 10.0, 10.0, 0.8)],
        [(2.0, 0.0, 12.0, 10.0, 0.4)],
        [],
        [(100.0, 100.0, 110.0, 110.0, 0.6)],
    ]
    out = sorted(weighted_box_fusion(views, iou_threshold=0.55), key=lambda b: -b[4])
    assert len(out) == 2
    x1, _, x2, _, s = out[0]
    assert x1 == pytest.approx((0 * 0.8 + 2 * 0.4) / 1.2)
    assert x2 == pytest.approx((10 * 0.8 + 12 * 0.4) / 1.2)
    assert s == pytest.approx((0.8 + 0.4) / 4)
    assert out[1][4] == pytest.approx(0.6 / 4)


def test_wbf_keeps_separate_people_apart() -> None:
    views = [[(0.0, 0.0, 10.0, 10.0, 0.9), (20.0, 0.0, 30.0, 10.0, 0.9)]]
    assert len(weighted_box_fusion(views)) == 2
