"""Bayesian map updates: "nobody found here" (contract section 8, LANE_C_SEARCH sections 3.4-3.5)
and, for live missions, "evidence points here" (``apply_reweight``, contract §12.2).

The TypeScript mirror (web/src/search/) must stay identical to apply_step.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence

import numpy as np

from sightline.contract import Grid, LatLon
from sightline.search.grid import cells_within_radius


# One look at some cells that found nobody.
def apply_step(
    p: np.ndarray, outside: float, cells: Sequence[tuple[int, float]]
) -> tuple[np.ndarray, float]:
    """Apply one step of [(idx, pod), ...] and return new (p, outside). Never mutates p.

    D = 1 - sum(p[idx] * pod); stepped cells get p * (1 - pod) / D, every other cell
    and the outside bucket get value / D. Each idx should appear at most once.
    """
    out = np.array(p, dtype=np.float64, copy=True)
    if len(cells) == 0:
        return out, float(outside)

    idx = np.fromiter((i for i, _ in cells), dtype=np.int64, count=len(cells))
    pod = np.fromiter((q for _, q in cells), dtype=np.float64, count=len(cells))
    if np.any((pod < 0.0) | (pod > 1.0)):
        raise ValueError("every pod must be in [0, 1]")

    denominator = 1.0 - float(np.sum(out[idx] * pod))
    if denominator <= 0.0:
        raise ValueError(f"update denominator must be > 0, got {denominator}")

    out[idx] *= 1.0 - pod
    out /= denominator
    return out, float(outside) / denominator


MAX_FACTOR = 20.0  # contract §12.3 invariant 2


# Evidence points here (a clue, a confirmed person, shelter): the other half of a live map.
def apply_reweight(
    p: np.ndarray, outside: float, cells: Sequence[tuple[int, float]]
) -> tuple[np.ndarray, float]:
    """Apply [(idx, factor), ...]: p_i *= factor_i, then renormalise p and outside to sum to 1.
    Never mutates p. Each factor must be in (0, MAX_FACTOR]; each idx should appear once."""
    out = np.array(p, dtype=np.float64, copy=True)
    if len(cells) == 0:
        return out, float(outside)
    idx = np.fromiter((i for i, _ in cells), dtype=np.int64, count=len(cells))
    factor = np.fromiter((f for _, f in cells), dtype=np.float64, count=len(cells))
    if np.any((factor <= 0.0) | (factor > MAX_FACTOR)):
        raise ValueError(f"every factor must be in (0, {MAX_FACTOR}]")
    out[idx] *= factor
    total = float(out.sum()) + float(outside)
    return out / total, float(outside) / total


# A searcher marked a detection "not a person".
def apply_review_not_person(
    p: np.ndarray,
    outside: float,
    grid: Grid,
    at: LatLon,
    radius_m: float,
    review_pod: float = 0.9,
    pod_cap: float = 0.95,
) -> tuple[np.ndarray, float]:
    """Cells within radius_m of the detection get pod = min(review_pod, pod_cap), then update."""
    pod = min(review_pod, pod_cap)
    cells = [(i, pod) for i in cells_within_radius(grid, at, radius_m)]
    return apply_step(p, outside, cells)


# Apply a list of steps in order (e.g. map.json steps on top of the prior).
def replay(
    prior_p: np.ndarray, outside: float, steps: Iterable[Sequence[tuple[int, float]]]
) -> tuple[np.ndarray, float]:
    """Apply each step in order starting from (prior_p, outside). Never mutates prior_p."""
    p = np.array(prior_p, dtype=np.float64, copy=True)
    for cells in steps:
        p, outside = apply_step(p, outside, cells)
    return p, float(outside)
