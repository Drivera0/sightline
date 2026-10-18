"""Validation-only tuning helpers: operating points and paired bootstrap comparisons.

Everything here is pure and CPU-only. It is meant for the **validation** split: choosing a
setting on the test split is never allowed (docs/LANE_A_ML.md §11). ``scripts/tune_on_val.py``
is the GPU driver that produces the predictions.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

import numpy as np

from sightline.ml.evaluate import VOC_IOU, Preds, Truth, _voc_hits, f_beta

DEFAULT_CANDIDATES = tuple(round(0.05 + 0.01 * i, 2) for i in range(91))


@dataclass(frozen=True)
class PointScores:
    threshold: float
    precision: float
    recall: float
    f2: float
    tp: int
    n_pred: int
    n_truth: int


def per_image_counts(
    preds: Preds, truth: Truth, threshold: float, iou_threshold: float = VOC_IOU
) -> dict[str, tuple[int, int, int]]:
    """``{image: (true positives, predictions kept, true boxes)}`` at ``threshold``.

    Greedy matching is per image, so these counts add up to exactly what ``score_voc`` gives
    for any subset (or resample) of images.
    """
    out: dict[str, tuple[int, int, int]] = {}
    for img in sorted(set(truth) | set(preds)):
        sub_p = {img: [d for d in preds.get(img, []) if d.conf >= threshold]}
        sub_t = {img: truth.get(img, [])}
        hits = _voc_hits(sub_p, sub_t, iou_threshold)
        out[img] = (sum(h for _, h in hits), len(hits), len(sub_t[img]))
    return out


def scores_at(
    preds: Preds, truth: Truth, threshold: float, iou_threshold: float = VOC_IOU
) -> PointScores:
    """Precision, recall and F2 at one threshold (one-to-one matching at ``iou_threshold``)."""
    counts = per_image_counts(preds, truth, threshold, iou_threshold)
    tp = sum(c[0] for c in counts.values())
    n_pred = sum(c[1] for c in counts.values())
    n_truth = sum(c[2] for c in counts.values())
    p = tp / n_pred if n_pred else 0.0
    r = tp / n_truth if n_truth else 0.0
    return PointScores(threshold, p, r, f_beta(p, r, 2.0), tp, n_pred, n_truth)


def threshold_curve(
    preds: Preds, truth: Truth, candidates: Iterable[float] = DEFAULT_CANDIDATES
) -> list[PointScores]:
    """VOC precision/recall/F2 at every candidate threshold, ascending."""
    hits = _voc_hits(preds, truth)
    n_truth = sum(len(b) for b in truth.values())
    out = []
    for t in sorted(candidates):
        kept = [h for c, h in hits if c >= t]
        tp = sum(kept)
        p = tp / len(kept) if kept else 0.0
        r = tp / n_truth if n_truth else 0.0
        out.append(PointScores(t, p, r, f_beta(p, r, 2.0), tp, len(kept), n_truth))
    return out


def threshold_for_recall(
    preds: Preds,
    truth: Truth,
    target_recall: float,
    candidates: Iterable[float] = DEFAULT_CANDIDATES,
) -> float:
    """The **highest** candidate threshold whose VOC recall is at least ``target_recall``.

    The highest such threshold keeps the fewest false alarms for that recall. If no candidate
    reaches the target, the lowest candidate is returned (the most recall available).
    """
    curve = threshold_curve(preds, truth, candidates)
    ok = [s.threshold for s in curve if s.recall >= target_recall]
    return max(ok) if ok else curve[0].threshold


@dataclass(frozen=True)
class BootstrapResult:
    """Paired bootstrap of ``metric(B) - metric(A)`` over resampled images."""

    delta: float  # on the full set
    ci_low: float  # 2.5th percentile
    ci_high: float  # 97.5th percentile
    p_b_better: float  # share of resamples where B > A
    n_resamples: int

    @property
    def clearly_better(self) -> bool:
        """B beats A in at least 97.5 % of resamples (95 % interval above zero)."""
        return self.ci_low > 0


def _f2_from_sums(tp: np.ndarray, n_pred: np.ndarray, n_truth: np.ndarray) -> np.ndarray:
    p = np.divide(tp, n_pred, out=np.zeros_like(tp, dtype=float), where=n_pred > 0)
    r = np.divide(tp, n_truth, out=np.zeros_like(tp, dtype=float), where=n_truth > 0)
    den = 4 * p + r
    return np.divide(5 * p * r, den, out=np.zeros_like(p), where=den > 0)


def paired_bootstrap_f2(
    preds_a: Preds,
    threshold_a: float,
    preds_b: Preds,
    threshold_b: float,
    truth: Truth,
    n_resamples: int = 2000,
    seed: int = 7,
) -> BootstrapResult:
    """Paired bootstrap over images of F2(B) - F2(A), each at its own fixed threshold.

    Both configurations see the same resampled images in every round, so per-image
    difficulty cancels out. Deterministic for a given ``seed``.
    """
    images = sorted(truth)
    ca = per_image_counts(preds_a, truth, threshold_a)
    cb = per_image_counts(preds_b, truth, threshold_b)
    a = np.array([ca[i] for i in images], dtype=float)  # (n, 3)
    b = np.array([cb[i] for i in images], dtype=float)
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(images), size=(n_resamples, len(images)))
    sa = a[idx].sum(axis=1)  # (n_resamples, 3)
    sb = b[idx].sum(axis=1)
    fa = _f2_from_sums(sa[:, 0], sa[:, 1], sa[:, 2])
    fb = _f2_from_sums(sb[:, 0], sb[:, 1], sb[:, 2])
    d = fb - fa
    full_a = _f2_from_sums(
        a[:, 0].sum(keepdims=True), a[:, 1].sum(keepdims=True), a[:, 2].sum(keepdims=True)
    )
    full_b = _f2_from_sums(
        b[:, 0].sum(keepdims=True), b[:, 1].sum(keepdims=True), b[:, 2].sum(keepdims=True)
    )
    return BootstrapResult(
        delta=float(full_b[0] - full_a[0]),
        ci_low=float(np.percentile(d, 2.5)),
        ci_high=float(np.percentile(d, 97.5)),
        p_b_better=float((d > 0).mean()),
        n_resamples=n_resamples,
    )
