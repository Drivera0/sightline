"""VOC and SAR scoring on hand-built cases (docs/LANE_A_ML.md §6.3, §7)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sightline.ml.evaluate import (
    Ablation,
    DetectorMetrics,
    SarScores,
    VocScores,
    check_ablation_rows,
    choose_threshold_from_preds,
    f_beta,
    iou,
    score_sar,
    score_voc,
    write_detector_metrics,
)
from sightline.ml.types import Box, RawDetection


def det(x1: int, y1: int, x2: int, y2: int, conf: float) -> RawDetection:
    return RawDetection(Box(x1, y1, x2, y2), conf)


def test_iou() -> None:
    assert iou(Box(0, 0, 10, 10), Box(0, 0, 10, 10)) == 1.0
    assert iou(Box(0, 0, 10, 10), Box(10, 0, 20, 10)) == 0.0
    assert iou(Box(0, 0, 10, 10), Box(5, 0, 15, 10)) == pytest.approx(50 / 150)


def test_f2_weights_recall() -> None:
    assert f_beta(1.0, 1.0) == 1.0
    assert f_beta(0.0, 0.0) == 0.0
    assert f_beta(0.5, 1.0) > f_beta(1.0, 0.5)


def test_perfect_match() -> None:
    truth = {"a": [Box(100, 100, 160, 160)], "b": [Box(0, 0, 50, 60)]}
    preds = {"a": [det(100, 100, 160, 160, 0.9)], "b": [det(1, 1, 50, 60, 0.8)]}
    v = score_voc(preds, truth, threshold=0.5)
    assert (v.precision, v.recall, v.ap50) == (1.0, 1.0, 1.0)
    s = score_sar(preds, truth, threshold=0.5)
    assert (s.precision, s.recall, s.ap) == (1.0, 1.0, 1.0)


def test_one_miss() -> None:
    truth = {"a": [Box(100, 100, 160, 160), Box(500, 500, 560, 560)]}
    preds = {"a": [det(100, 100, 160, 160, 0.9)]}
    v = score_voc(preds, truth, threshold=0.5)
    assert v.precision == 1.0
    assert v.recall == 0.5
    assert v.ap50 == 0.5


def test_one_false_positive() -> None:
    truth = {"a": [Box(100, 100, 160, 160)]}
    preds = {"a": [det(100, 100, 160, 160, 0.9), det(800, 800, 860, 860, 0.7)]}
    v = score_voc(preds, truth, threshold=0.5)
    assert v.precision == 0.5
    assert v.recall == 1.0
    assert v.ap50 == 1.0  # the FP comes after the only TP, so the envelope is still 1 at r=1
    # a lower-confidence FP doesn't hurt once the threshold is above it
    assert score_voc(preds, truth, threshold=0.8).precision == 1.0


def test_false_positive_before_true_positive_lowers_ap() -> None:
    truth = {"a": [Box(100, 100, 160, 160)]}
    preds = {"a": [det(800, 800, 860, 860, 0.9), det(100, 100, 160, 160, 0.7)]}
    assert score_voc(preds, truth, threshold=0.5).ap50 == 0.5


def test_voc_is_one_to_one() -> None:
    """Two predictions on the same person: one TP, one FP, even if both overlap well."""
    truth = {"a": [Box(100, 100, 160, 160)]}
    preds = {"a": [det(100, 100, 160, 160, 0.9), det(102, 102, 162, 162, 0.8)]}
    v = score_voc(preds, truth, threshold=0.5)
    assert v.precision == 0.5 and v.recall == 1.0


def test_voc_iou_below_half_is_a_miss() -> None:
    truth = {"a": [Box(100, 100, 160, 160)]}
    preds = {"a": [det(130, 130, 190, 190, 0.9)]}  # IoU = 900/6300
    v = score_voc(preds, truth, threshold=0.5)
    assert v.recall == 0.0 and v.precision == 0.0


def test_sar_large_box_covering_two_people_recalls_both() -> None:
    truth = {"a": [Box(100, 100, 160, 160), Box(300, 300, 360, 360)]}
    preds = {"a": [det(80, 80, 380, 380, 0.9)]}
    s = score_sar(preds, truth, threshold=0.5)
    assert s.recall == 1.0
    assert s.precision == 1.0
    v = score_voc(preds, truth, threshold=0.5)
    assert v.recall == 0.0  # strict IoU rejects the big box


def test_sar_tiny_overlap_counts() -> None:
    # IoU of 60x60 truth with a 60x60 box shifted so they overlap 4x4 px: 16 / (7200 - 16) ≈ 0.0022 < 0.0025
    truth = {"a": [Box(100, 100, 160, 160)]}
    assert score_sar({"a": [det(156, 156, 216, 216, 0.9)]}, truth, 0.5).recall == 0.0
    # 5x5 overlap: 25 / 7175 ≈ 0.0035 ≥ 0.0025
    assert score_sar({"a": [det(155, 155, 215, 215, 0.9)]}, truth, 0.5).recall == 1.0


def test_images_with_no_predictions_still_count_their_truth() -> None:
    truth = {"a": [Box(0, 0, 10, 10)], "b": [Box(0, 0, 10, 10)]}
    preds = {"a": [det(0, 0, 10, 10, 0.9)], "b": []}
    assert score_voc(preds, truth, 0.5).recall == 0.5


def test_empty_inputs() -> None:
    assert score_voc({}, {}, 0.5) == VocScores(precision=0.0, recall=0.0, ap50=0.0)
    assert score_sar({"a": []}, {"a": [Box(0, 0, 1, 1)]}, 0.5) == SarScores(
        precision=0.0, recall=0.0, ap=0.0
    )


def test_choose_threshold_maximises_f2() -> None:
    # Two TPs at 0.9/0.6, three FPs at 0.3/0.2/0.1, one missed person.
    truth = {"a": [Box(0, 0, 60, 60), Box(200, 200, 260, 260), Box(400, 400, 460, 460)]}
    preds = {
        "a": [
            det(0, 0, 60, 60, 0.9),
            det(200, 200, 260, 260, 0.6),
            det(700, 700, 760, 760, 0.3),
            det(800, 800, 860, 860, 0.2),
            det(900, 900, 960, 960, 0.1),
        ]
    }
    t = choose_threshold_from_preds(preds, truth)
    assert 0.3 < t <= 0.6  # keep both TPs, drop all FPs; ties resolve to the highest such threshold
    assert t == 0.6
    # With an explicit candidate list the choice is restricted to it.
    assert choose_threshold_from_preds(preds, truth, candidates=[0.25, 0.5]) == 0.5


def test_write_detector_metrics_shape(tmp_path: Path) -> None:
    voc = VocScores(precision=0.81234, recall=0.7, ap50=0.75)
    sar = SarScores(precision=0.9, recall=0.8, ap=0.85)
    d = DetectorMetrics(
        model="yolo11s-heridal-tiled",
        test_images=101,
        tiled=True,
        threshold=0.31,
        voc=voc,
        sar=sar,
        recall=0.7,
        seconds_per_image=1.2346,
    )
    rows = [
        Ablation(name=n, voc=voc)
        for n in (
            "Stock model, no tiling",
            "Fine-tuned, no tiling",
            "Fine-tuned + tiling",
            "+ hard negatives",
        )
    ]
    out = tmp_path / "m.json"
    write_detector_metrics(d, rows, out)
    data = json.loads(out.read_text())
    assert set(data) == {"detector", "ablations"}
    assert data["detector"]["voc"]["precision"] == 0.812
    assert data["detector"]["seconds_per_image"] == 1.235
    assert [r["name"] for r in data["ablations"]] == [r.name for r in rows]
    # A variant that wasn't run is omitted: three measured rows are fine.
    write_detector_metrics(d, rows[:3], out)
    assert [r["name"] for r in json.loads(out.read_text())["ablations"]] == [
        r.name for r in rows[:3]
    ]
    # Wrong order or unknown names are rejected.
    with pytest.raises(ValueError):
        write_detector_metrics(d, [rows[1], rows[0]], out)
    with pytest.raises(ValueError):
        write_detector_metrics(d, [Ablation(name="Mystery row", voc=voc)], out)


def test_all_zero_ablation_row_is_refused_as_a_placeholder(tmp_path: Path) -> None:
    """An all-zero row reads as a real result on the metrics screen. It must be omitted instead."""
    voc = VocScores(precision=0.7, recall=0.7, ap50=0.7)
    zero = VocScores(precision=0.0, recall=0.0, ap50=0.0)
    d = DetectorMetrics(
        model="m",
        test_images=101,
        tiled=True,
        threshold=0.2,
        voc=voc,
        sar=SarScores(precision=0.8, recall=0.8, ap=0.8),
        recall=0.7,
        seconds_per_image=0.25,
    )
    rows = [
        Ablation(name="Stock model, no tiling", voc=voc),
        Ablation(name="Fine-tuned, no tiling", voc=voc),
        Ablation(name="Fine-tuned + tiling", voc=voc),
        Ablation(name="+ hard negatives", voc=zero),
    ]
    with pytest.raises(ValueError, match="all zeros"):
        write_detector_metrics(d, rows, tmp_path / "m.json")
    assert not (tmp_path / "m.json").exists()


def test_published_detector_metrics_has_no_placeholder_rows() -> None:
    """Guards the real file on this machine (skipped elsewhere, where data/ doesn't exist)."""
    path = Path("data/work/detect/detector_metrics.json")
    if not path.exists():
        pytest.skip("no detector_metrics.json on this machine")
    data = json.loads(path.read_text(encoding="utf-8"))
    rows = [Ablation(**r) for r in data["ablations"]]
    check_ablation_rows(rows)
