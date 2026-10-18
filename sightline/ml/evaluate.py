"""Scoring and evaluation (docs/LANE_A_ML.md §6.3).

Pure scoring functions take ``preds`` and ``truth`` keyed by image id, so the tests run on CPU
with hand-built boxes. ``choose_threshold`` / ``evaluate`` are the GPU wrappers around them.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterable, Sequence
from pathlib import Path
from typing import Literal

from sightline.ml.types import Box, LabeledImage, RawDetection

try:  # lane D's contract, once it exists
    from sightline.contract import Ablation, DetectorMetrics, SarScores, VocScores
except ImportError:  # pragma: no cover - until D lands contract.py
    from sightline.ml._contract_shim import Ablation, DetectorMetrics, SarScores, VocScores

__all__ = [
    "SAVE_THRESHOLD",
    "Ablation",
    "DetectorMetrics",
    "SarScores",
    "VocScores",
    "choose_threshold",
    "choose_threshold_from_preds",
    "evaluate",
    "f_beta",
    "iou",
    "score_sar",
    "score_voc",
    "write_detector_metrics",
]

Preds = dict[str, list[RawDetection]]
Truth = dict[str, list[Box]]
Mode = Literal["tiled", "resized"]

SAVE_THRESHOLD = 0.05  # lowest confidence kept anywhere (contract §7 save_threshold)
VOC_IOU = 0.5
SAR_IOU = 0.0025
ABLATION_NAMES = (
    "Stock model, no tiling",
    "Fine-tuned, no tiling",
    "Fine-tuned + tiling",
    "+ hard negatives",
)


# ---------------------------------------------------------------------------- geometry


def iou(a: Box, b: Box) -> float:
    inter = a.clipped(b.x1, b.y1, b.x2, b.y2)
    if inter is None:
        return 0.0
    return inter.area_px / (a.area_px + b.area_px - inter.area_px)


def f_beta(precision: float, recall: float, beta: float = 2.0) -> float:
    if precision == 0 and recall == 0:
        return 0.0
    b2 = beta * beta
    return (1 + b2) * precision * recall / (b2 * precision + recall)


# ---------------------------------------------------------------------------- matching


def _flatten(preds: Preds) -> list[tuple[float, str, Box]]:
    """All predictions, descending confidence; ties broken by image id and box for determinism."""
    flat = [(d.conf, img, d.box) for img, dets in preds.items() for d in dets]
    flat.sort(key=lambda t: (-t[0], t[1], t[2].x1, t[2].y1, t[2].x2, t[2].y2))
    return flat


def _voc_hits(
    preds: Preds, truth: Truth, iou_threshold: float = VOC_IOU
) -> list[tuple[float, bool]]:
    """Greedy one-to-one matching in descending confidence at IoU ≥ ``iou_threshold`` (0.5).

    Returns ``(conf, is_true_positive)`` per prediction in descending confidence. A
    prediction's outcome depends only on higher-confidence predictions, so slicing this
    list at any threshold gives exactly the matching you'd get by scoring that subset alone.
    """
    used: dict[str, set[int]] = {img: set() for img in truth}
    hits: list[tuple[float, bool]] = []
    for conf, img, box in _flatten(preds):
        best_iou, best_j = 0.0, -1
        for j, gt in enumerate(truth.get(img, [])):
            if j in used.setdefault(img, set()):
                continue
            v = iou(box, gt)
            if v > best_iou:
                best_iou, best_j = v, j
        if best_j >= 0 and best_iou >= iou_threshold:
            used[img].add(best_j)
            hits.append((conf, True))
        else:
            hits.append((conf, False))
    return hits


def _average_precision(tp_flags: Sequence[bool], n_truth: int) -> float:
    """All-point interpolated area under the precision/recall curve (VOC 2010+)."""
    if n_truth == 0 or not tp_flags:
        return 0.0
    tp = fp = 0
    recalls: list[float] = []
    precisions: list[float] = []
    for hit in tp_flags:
        tp += hit
        fp += not hit
        recalls.append(tp / n_truth)
        precisions.append(tp / (tp + fp))
    # precision envelope: p(r) = max precision at any recall ≥ r
    for i in range(len(precisions) - 2, -1, -1):
        precisions[i] = max(precisions[i], precisions[i + 1])
    ap = 0.0
    prev_r = 0.0
    for r, p in zip(recalls, precisions, strict=True):
        ap += (r - prev_r) * p
        prev_r = r
    return ap


def score_voc(preds: Preds, truth: Truth, threshold: float) -> VocScores:
    """Precision and recall at ``threshold``; AP50 over all confidences in ``preds``."""
    hits = _voc_hits(preds, truth)
    n_truth = sum(len(b) for b in truth.values())
    kept = [h for c, h in hits if c >= threshold]
    tp = sum(kept)
    precision = tp / len(kept) if kept else 0.0
    recall = tp / n_truth if n_truth else 0.0
    return VocScores(
        precision=precision, recall=recall, ap50=_average_precision([h for _, h in hits], n_truth)
    )


def _sar_pairs(preds: Preds, truth: Truth) -> list[tuple[float, bool, set[tuple[str, int]]]]:
    """Per prediction (descending conf): is it correct, and which true boxes it covers.

    SAR-style (approx. AIR): correct if IoU with any true box ≥ 0.0025; one prediction may
    cover several people.
    """
    out = []
    for conf, img, box in _flatten(preds):
        covered = {(img, j) for j, gt in enumerate(truth.get(img, [])) if iou(box, gt) >= SAR_IOU}
        out.append((conf, bool(covered), covered))
    return out


def score_sar(preds: Preds, truth: Truth, threshold: float) -> SarScores:
    """Precision = correct predictions / all predictions; recall = true boxes covered by at
    least one prediction; ``ap`` = all-point area under that curve over all confidences."""
    pairs = _sar_pairs(preds, truth)
    n_truth = sum(len(b) for b in truth.values())
    kept = [(ok, cov) for c, ok, cov in pairs if c >= threshold]
    n_correct = sum(ok for ok, _ in kept)
    covered: set[tuple[str, int]] = set().union(*[cov for _, cov in kept]) if kept else set()
    precision = n_correct / len(kept) if kept else 0.0
    recall = len(covered) / n_truth if n_truth else 0.0

    # PR curve over confidences with the loose criterion
    ap = 0.0
    if n_truth and pairs:
        seen: set[tuple[str, int]] = set()
        n_ok = 0
        rs: list[float] = []
        ps: list[float] = []
        for i, (_, ok, cov) in enumerate(pairs, 1):
            n_ok += ok
            seen |= cov
            rs.append(len(seen) / n_truth)
            ps.append(n_ok / i)
        for i in range(len(ps) - 2, -1, -1):
            ps[i] = max(ps[i], ps[i + 1])
        prev = 0.0
        for r, p in zip(rs, ps, strict=True):
            ap += (r - prev) * p
            prev = r
    return SarScores(precision=precision, recall=recall, ap=ap)


# ---------------------------------------------------------------------------- threshold


def choose_threshold_from_preds(
    preds: Preds, truth: Truth, candidates: Iterable[float] | None = None, beta: float = 2.0
) -> float:
    """Threshold maximising F-beta (default F2) under VOC scoring. Ties go to the higher threshold.

    Candidates default to 0.05 … 0.95 in steps of 0.01.
    """
    cands = (
        sorted(candidates)
        if candidates is not None
        else [round(0.05 + 0.01 * i, 2) for i in range(91)]
    )
    best_t, best_f = cands[0], -1.0
    hits = _voc_hits(preds, truth)
    n_truth = sum(len(b) for b in truth.values())
    for t in cands:
        kept = [h for c, h in hits if c >= t]
        tp = sum(kept)
        p = tp / len(kept) if kept else 0.0
        r = tp / n_truth if n_truth else 0.0
        f = f_beta(p, r, beta)
        if f >= best_f:
            best_t, best_f = t, f
    return best_t


def _run(
    detector: object, images: Sequence[LabeledImage], mode: Mode, conf: float
) -> tuple[Preds, Truth, float]:
    fn: Callable[..., list[RawDetection]] = getattr(
        detector, "detect_tiled" if mode == "tiled" else "detect_resized"
    )
    preds: Preds = {}
    truth: Truth = {}
    t0 = time.perf_counter()
    for im in images:
        preds[im.path.stem] = fn(im.path, conf=conf)
        truth[im.path.stem] = list(im.boxes)
    seconds = (time.perf_counter() - t0) / max(1, len(images))
    return preds, truth, seconds


def choose_threshold(detector: object, val: Sequence[LabeledImage], mode: Mode = "tiled") -> float:
    """F2-optimal threshold on the **validation** set, full images, tiled inference by default.
    This is ``candidate_threshold``. Never call this on the test split."""
    preds, truth, _ = _run(detector, val, mode, SAVE_THRESHOLD)
    return choose_threshold_from_preds(preds, truth)


def evaluate(
    detector: object, images: Sequence[LabeledImage], mode: Mode, threshold: float
) -> tuple[VocScores, SarScores, float]:
    """(voc, sar, seconds_per_image). Inference at ``SAVE_THRESHOLD`` so AP covers all confidences;
    precision/recall are reported at ``threshold``."""
    preds, truth, seconds = _run(detector, images, mode, SAVE_THRESHOLD)
    return score_voc(preds, truth, threshold), score_sar(preds, truth, threshold), seconds


# ---------------------------------------------------------------------------- output


def _round(obj: object, nd: int = 3) -> object:
    if isinstance(obj, float):
        return round(obj, nd)
    if isinstance(obj, dict):
        return {k: _round(v, nd) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_round(v, nd) for v in obj]
    return obj


def is_placeholder(voc: VocScores) -> bool:
    """All three scores exactly zero: what a stand-in row looks like, not a measurement."""
    return voc.precision == 0 and voc.recall == 0 and voc.ap50 == 0


def check_ablation_rows(ablations: Sequence[Ablation]) -> None:
    """Raise if a row is unknown, repeated, out of canonical order, or an all-zero stand-in."""
    names = [a.name for a in ablations]
    unknown = [n for n in names if n not in ABLATION_NAMES]
    if unknown:
        raise ValueError(f"unknown ablation rows {unknown}; allowed: {list(ABLATION_NAMES)}")
    if len(set(names)) != len(names) or names != [n for n in ABLATION_NAMES if n in names]:
        raise ValueError(f"ablation rows must be unique and in the order {list(ABLATION_NAMES)}")
    zeros = [a.name for a in ablations if is_placeholder(a.voc)]
    if zeros:
        raise ValueError(
            f"ablation rows {zeros} are all zeros: a variant that was not run must be omitted, "
            "not written as a placeholder"
        )


def write_detector_metrics(
    detector: DetectorMetrics,
    ablations: list[Ablation],
    out: Path = Path("data/work/detect/detector_metrics.json"),
) -> None:
    """``detector_metrics.json``: the contract ``DetectorMetrics`` block plus the ablation rows.
    D's ``map`` stage reads ``detector.recall``; the ``metrics`` stage copies the rest.

    Only rows that were actually measured go in. A variant not run yet is **omitted**, never
    written as zeros: contract §9 has no null for these fields, and an all-zero row would read as
    a real (terrible) result on the metrics screen. Rows keep the canonical order of
    ``ABLATION_NAMES``; the metrics screen shows any missing name as "Not yet measured".
    """
    check_ablation_rows(ablations)
    payload = {  # exactly lane D's DetectorMetricsFile: no extra keys
        "detector": _round(detector.model_dump()),
        "ablations": _round([a.model_dump() for a in ablations]),
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
