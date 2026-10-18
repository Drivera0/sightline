"""Validation tuning helpers: per-image counts, operating points, paired bootstrap."""

from __future__ import annotations

import pytest

from sightline.ml.evaluate import score_voc
from sightline.ml.tuning import (
    paired_bootstrap_f2,
    per_image_counts,
    scores_at,
    threshold_for_recall,
)
from sightline.ml.types import Box, RawDetection


def det(x1: int, y1: int, x2: int, y2: int, conf: float) -> RawDetection:
    return RawDetection(Box(x1, y1, x2, y2), conf)


TRUTH = {
    "a": [Box(0, 0, 10, 10), Box(100, 100, 110, 110)],
    "b": [Box(0, 0, 10, 10)],
}
PREDS = {
    "a": [det(0, 0, 10, 10, 0.9), det(100, 100, 110, 110, 0.3), det(50, 50, 60, 60, 0.6)],
    "b": [det(0, 0, 10, 10, 0.2), det(200, 200, 210, 210, 0.95)],
}


def test_per_image_counts_add_up_to_score_voc() -> None:
    for t in (0.1, 0.25, 0.5, 0.92):
        counts = per_image_counts(PREDS, TRUTH, t)
        tp = sum(c[0] for c in counts.values())
        n_pred = sum(c[1] for c in counts.values())
        voc = score_voc(PREDS, TRUTH, t)
        assert voc.recall == pytest.approx(tp / 3)
        assert voc.precision == pytest.approx(tp / n_pred if n_pred else 0.0)


def test_scores_at_loose_iou_counts_sloppy_box() -> None:
    truth = {"a": [Box(0, 0, 10, 10)]}
    preds = {"a": [det(0, 0, 10, 30, 0.9)]}  # IoU 1/3
    assert scores_at(preds, truth, 0.5).recall == 0.0
    assert scores_at(preds, truth, 0.5, iou_threshold=0.1).recall == 1.0


def test_threshold_for_recall_picks_highest_threshold_reaching_target() -> None:
    # recall 1/3 above 0.9, 2/3 down to 0.3, 1.0 at 0.2 and below
    assert threshold_for_recall(PREDS, TRUTH, 0.6) == pytest.approx(0.3)
    assert threshold_for_recall(PREDS, TRUTH, 1.0) == pytest.approx(0.2)
    # unreachable target -> lowest candidate
    assert threshold_for_recall({"a": [], "b": []}, TRUTH, 0.5) == pytest.approx(0.05)


def test_bootstrap_identical_configs_have_zero_delta() -> None:
    r = paired_bootstrap_f2(PREDS, 0.25, PREDS, 0.25, TRUTH, n_resamples=200, seed=1)
    assert r.delta == 0.0 and r.ci_low == 0.0 and r.ci_high == 0.0
    assert not r.clearly_better


def test_bootstrap_detects_a_clearly_better_config_and_is_seeded() -> None:
    truth = {f"i{k}": [Box(0, 0, 10, 10)] for k in range(40)}
    good = {k: [det(0, 0, 10, 10, 0.9)] for k in truth}
    bad = {k: ([det(0, 0, 10, 10, 0.9)] if n % 2 else []) for n, k in enumerate(truth)}
    r = paired_bootstrap_f2(bad, 0.5, good, 0.5, truth, n_resamples=500, seed=7)
    assert r.delta > 0 and r.clearly_better and r.p_b_better == 1.0
    again = paired_bootstrap_f2(bad, 0.5, good, 0.5, truth, n_resamples=500, seed=7)
    assert again == r
