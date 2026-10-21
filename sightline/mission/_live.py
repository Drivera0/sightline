"""A stand-in for lane C's ``LiveMap`` (contract §14) until C-L1 lands: enough to rebuild a
mission's map from ``map_base.json`` + ``map_updates.jsonl`` and read it.

It only **replays** updates (``apply``), it never makes them: ``frame_update``, ``review_update``,
``ground_update``, ``clue_update`` and ``conditions_update`` are C's math and raise here. Delete
this file when ``sightline.search.live.LiveMap`` exists; ``MissionStore`` picks C's class up on its
own (``live_factory``).
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np

from sightline.contract import MapBase, MapUpdate
from sightline.search.update import apply_step

MAX_FACTOR = 20.0  # contract §12.3 invariant 2 (C's apply_reweight uses the same bound)


def apply_reweight(
    p: np.ndarray, outside: float, cells: Sequence[tuple[int, float]]
) -> tuple[np.ndarray, float]:
    """Evidence points here: p_i *= factor_i for the listed cells, then p and outside are
    renormalised to sum to 1 (contract §12.2 MapUpdate). Never mutates p."""
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


def apply_update(p: np.ndarray, outside: float, u: MapUpdate) -> tuple[np.ndarray, float]:
    if u.kind == "step":
        return apply_step(p, outside, u.cells)
    return apply_reweight(p, outside, u.cells)


class ReplayLiveMap:
    """``base``, ``apply``, ``p`` and ``sector_poa`` of C's ``LiveMap``; replay only."""

    def __init__(self, base: MapBase) -> None:
        self.base = base
        self._p = np.asarray(base.prior.p, dtype=np.float64)
        self._outside = float(base.prior.outside)

    @classmethod
    def from_base(cls, base: MapBase) -> ReplayLiveMap:
        return cls(base)

    def apply(self, u: MapUpdate) -> None:
        self._p, self._outside = apply_update(self._p, self._outside, u)

    def p(self) -> tuple[np.ndarray, float]:
        return self._p, self._outside

    def sector_poa(self, layout) -> dict[str, float]:
        return {s.id: float(self._p[layout.cells_of(s.id)].sum()) for s in layout.sectors}

    def _c_only(self, *_a, **_k):
        raise NotImplementedError("C-L1 (sightline.search.live.LiveMap) makes map updates")

    frame_update = review_update = ground_update = clue_update = conditions_update = _c_only
