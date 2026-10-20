"""The parity script's box matching (scripts/parity_table.py): no models needed."""

import importlib.util
import sys
from pathlib import Path

import pytest

from sightline.ml.types import Box, RawDetection

_PATH = Path(__file__).resolve().parents[2] / "scripts" / "parity_table.py"
_spec = importlib.util.spec_from_file_location("parity_table", _PATH)
assert _spec and _spec.loader
parity = importlib.util.module_from_spec(_spec)
sys.modules["parity_table"] = parity
_spec.loader.exec_module(parity)


def _d(x1: int, y1: int, x2: int, y2: int, conf: float) -> RawDetection:
    return RawDetection(Box(x1, y1, x2, y2), conf)


def test_match_is_one_to_one_highest_iou_first() -> None:
    a = [_d(0, 0, 100, 100, 0.9), _d(200, 200, 260, 260, 0.5)]
    b = [_d(0, 0, 100, 101, 0.88), _d(1, 0, 101, 100, 0.7)]  # both overlap a[0]; a[1] has none
    pairs = parity.match(a, b)
    assert len(pairs) == 1
    v, diff = pairs[0]
    assert v == pytest.approx(100 / 101) and diff == pytest.approx(0.02)


def test_agreement_counts_matches_and_threshold() -> None:
    torch = {"p1": [_d(0, 0, 100, 100, 0.9), _d(300, 300, 340, 380, 0.2)]}
    cv = {"p1": [_d(0, 0, 100, 100, 0.8995), _d(500, 500, 540, 580, 0.3)]}
    every = parity.agreement(torch, cv, 0.05)
    assert (every["boxes_torch"], every["boxes_cv2"], every["matched_iou_095"]) == (2, 2, 1)
    assert every["share_of_torch"] == 0.5 and every["max_conf_diff"] == pytest.approx(0.0005)
    at_thr = parity.agreement(torch, cv, 0.29)
    assert (at_thr["boxes_torch"], at_thr["boxes_cv2"], at_thr["matched_iou_095"]) == (1, 2, 1)
    assert at_thr["share_of_torch"] == 1.0 and at_thr["share_of_cv2"] == 0.5
