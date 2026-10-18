"""The error-analysis script must count hits and false alarms exactly like the official scorer."""

import importlib.util
import random
import sys
from pathlib import Path

from sightline.ml.evaluate import score_voc
from sightline.ml.types import Box, RawDetection

_PATH = Path(__file__).resolve().parents[2] / "scripts" / "analysis" / "detector_errors.py"
_spec = importlib.util.spec_from_file_location("detector_errors", _PATH)
assert _spec and _spec.loader
errors = importlib.util.module_from_spec(_spec)
sys.modules["detector_errors"] = errors  # dataclasses look their module up here
_spec.loader.exec_module(errors)


def _box(rng: random.Random) -> Box:
    x, y = rng.randint(0, 900), rng.randint(0, 900)
    return Box(x, y, x + rng.randint(20, 80), y + rng.randint(20, 80))


def _jitter(rng: random.Random, b: Box) -> Box:
    dx, dy = rng.randint(-15, 15), rng.randint(-15, 15)
    return Box(max(0, b.x1 + dx), max(0, b.y1 + dy), b.x2 + dx + 1, b.y2 + dy + 1)


def test_found_and_alarms_agree_with_score_voc() -> None:
    rng = random.Random(7)
    truth = {f"img{i}": [_box(rng) for _ in range(rng.randint(0, 5))] for i in range(30)}
    preds = {}
    for img, boxes in truth.items():
        dets = [
            RawDetection(box=_jitter(rng, b), conf=rng.random())
            for b in boxes
            if rng.random() < 0.8
        ]
        dets += [RawDetection(box=_box(rng), conf=rng.random()) for _ in range(rng.randint(0, 3))]
        preds[img] = dets
    n_truth = sum(len(v) for v in truth.values())
    for threshold in (0.1, 0.29, 0.5, 0.9):
        official = score_voc(preds, truth, threshold)
        found = errors.found_at(preds, truth, threshold)
        _, alarms = errors.match(preds, truth, threshold)
        tp = sum(len(v) for v in found.values())
        kept = sum(1 for dets in preds.values() for d in dets if d.conf >= threshold)
        assert tp / n_truth == official.recall
        assert len(alarms) == kept - tp
        if kept:
            assert tp / kept == official.precision


def test_site_and_size_bins() -> None:
    assert errors.site_of("test_BRS_0006") == "BRS"
    assert errors.size_bin(39.9) == "0-40"
    assert errors.size_bin(60) == "60-90"
    assert errors.size_bin(500) == "90+"
