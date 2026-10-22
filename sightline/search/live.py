"""The live map (contract §14, LANE_C §5.2, C-L1): one mission's probability map, changed by every
photo, review, searched sector, clue and change in conditions. Pure math, no I/O.

Each ``*_update`` method **computes** a ``MapUpdate`` and does not apply it; ``MissionStore``
numbers it, saves it to ``map_updates.jsonl`` and calls ``apply`` (issue #54). So a map rebuilt
from ``map_base.json`` + the log (``from_base`` + ``apply`` in order) is the same map.

| Method | Update | Math |
|---|---|---|
| ``frame_update`` | step / frame | ``pod.frame_step`` with recall × ``visibility_factor`` (before the cap), 4 decimals, < 0.001 dropped; every candidate held (pod 0); ``canopy`` = (idx, canopy, overlap) per covered cell |
| ``review_update`` not_person | step / review | cells within the radius: pod = min(review_pod, pod_cap) |
| ``review_update`` person | reweight / review | undo that frame's look on the cells within the radius: factor 1 / (1 − pod) |
| ``ground_update`` | step / ground | every cell of the sector: pod = min(team POD, 0.9): searched never means cleared |
| ``clue_update`` | reweight / clue | within the radius × ``CLUE_FACTOR[reliability]``; within 2 × radius × its square root |
| ``conditions_update`` | reweight / conditions | exposure rising to high/severe (once per level): cells with canopy ≥ 0.5 × ``SHELTER_FACTOR`` |

The clue and shelter factors are heuristics, labelled as such in every update's ``ref``-side
reason (``NOTES``); the prior is the labelled placeholder (no invented ring numbers).

Built by lane A for lane C (issue #64); lane C owns this file.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import Literal

import numpy as np

from sightline.contract import (
    CONTRACT_VERSION,
    Clue,
    Conditions,
    Distribution,
    LatLon,
    MapBase,
    MapUpdate,
    Params,
)
from sightline.search.grid import cell_center, cells_within_radius, make_grid
from sightline.search.pod import FrameInput, frame_step
from sightline.search.prior import placeholder_prior
from sightline.search.sectors import SectorLayout
from sightline.search.update import MAX_FACTOR, apply_reweight, apply_step

RECALL = 0.864  # detector recall on HERIDAL test (VOC, threshold 0.29), OpenCV report §7.1
RECALL_SOURCE = "HERIDAL test, VOC recall at the frozen threshold 0.29 (OpenCV report §7.1)"
POD_CAP = 0.95
REVIEW_POD = 0.9
GROUND_POD_MAX = 0.9
POD_DECIMALS = 4
MIN_STEP_POD = 0.001
# Heuristics (labelled): how much a clue or worsening exposure moves the probability.
CLUE_FACTOR = {"low": 1.5, "medium": 3.0, "high": 6.0}
SHELTER_FACTOR = {"high": 1.5, "severe": 2.0}
SHELTER_CANOPY = 0.5
_BANDS = ["low", "moderate", "high", "severe"]


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _update(
    kind: Literal["step", "reweight"], source: str, ref: str | None, cells, canopy=None
) -> MapUpdate:
    return MapUpdate(
        seq=1, kind=kind, source=source, ref=ref, cells=sorted(cells), canopy=canopy, at=_now()
    )


class LiveMap:
    def __init__(self, base: MapBase) -> None:
        self.base = base
        n = base.grid.rows * base.grid.cols
        self._p = np.asarray(base.prior.p, dtype=np.float64)
        self._outside = float(base.prior.outside)
        # Overlap-weighted canopy, rebuilt from the frame steps' canopy lists.
        self._canopy_w = np.zeros(n)
        self._canopy_sum = np.zeros(n)
        for i, c in enumerate(base.canopy):
            if c is not None:
                self._canopy_w[i], self._canopy_sum[i] = 1.0, c
        self._frame_pods: dict[str, dict[int, float]] = {}  # frame id → {cell: pod}, for "person"
        self._band = 0  # highest exposure band already sheltered for

    # --- construction ------------------------------------------------------------------------

    @classmethod
    def start(
        cls,
        lkp: LatLon,
        *,
        cell_m: float = 5.0,
        size_m: float = 1000.0,
        prior: Literal["placeholder"] = "placeholder",
    ) -> LiveMap:
        """A new mission's map around the last known position, with the labelled placeholder
        prior (uniform, half the probability outside the grid)."""
        grid = make_grid(lkp, size_m=size_m, cell_m=cell_m)
        p, outside = placeholder_prior(grid)
        base = MapBase(
            contract_version=CONTRACT_VERSION,
            grid=grid,
            lkp=lkp,
            params=Params(
                recall=RECALL,
                recall_source=RECALL_SOURCE,
                pod_cap=POD_CAP,
                review_pod=REVIEW_POD,
                prior_source=prior,
            ),
            prior=Distribution(p=[float(x) for x in p], outside=float(outside)),
            canopy=[None] * (grid.rows * grid.cols),
        )
        return cls(base)

    @classmethod
    def from_base(cls, base: MapBase) -> LiveMap:
        """The map as stored (``map_base.json``); then ``apply`` each update of the log."""
        return cls(base)

    # --- reading ---------------------------------------------------------------------------------

    def p(self) -> tuple[np.ndarray, float]:
        return self._p, self._outside

    def sector_poa(self, layout: SectorLayout) -> dict[str, float]:
        return {s.id: float(self._p[layout.cells_of(s.id)].sum()) for s in layout.sectors}

    def canopy(self) -> list[float | None]:
        """Per cell: the overlap-weighted canopy of every photo that covered it, else None."""
        return [
            round(float(self._canopy_sum[i] / w), 4) if w > 0 else None
            for i, w in enumerate(self._canopy_w)
        ]

    # --- the updates (computed, not applied) -----------------------------------------------------

    def frame_update(
        self,
        frame: FrameInput,
        recall: float,
        held: list[tuple[LatLon, float]],
        visibility_factor: float = 1.0,
        rgb: np.ndarray | None = None,
    ) -> MapUpdate:
        """One photo looked at its footprint and the detector found nobody there. ``held`` is
        (position, radius_m) of every candidate so far: those cells wait for the reviewer."""
        pods, cells = frame_step(
            self.base.grid,
            frame,
            recall * visibility_factor,
            self.base.params.pod_cap,
            held=held,
            rgb=rgb,
        )
        steps = [(i, r) for i, pod in pods if (r := round(pod, POD_DECIMALS)) >= MIN_STEP_POD]
        canopy = [(i, round(c, 4), round(a, 4)) for i, (c, a) in sorted(cells.items())]
        return _update("step", "frame", frame.frame_id, steps, canopy)

    def review_update(
        self, detection_id: str, frame_id: str, at: LatLon, radius_m: float, answer: str
    ) -> MapUpdate | None:
        """A reviewer's answer. "not_person": the area around it was looked at; "person": that
        photo's look around it didn't count; "unsure": nothing changes."""
        if answer == "unsure":
            return None
        cells = cells_within_radius(self.base.grid, at, radius_m)
        if answer == "not_person":
            pod = min(self.base.params.review_pod, self.base.params.pod_cap)
            return _update("step", "review", detection_id, [(i, pod) for i in cells])
        if answer != "person":
            raise ValueError("answer must be person, not_person or unsure")
        looked = self._frame_pods.get(frame_id, {})
        undo = [
            (i, round(1.0 / (1.0 - looked[i]), POD_DECIMALS)) for i in cells if looked.get(i, 0) > 0
        ]
        return _update("reweight", "review", detection_id, undo) if undo else None

    def ground_update(self, sector_cells: list[int], pod: float, sector_id: str) -> MapUpdate:
        """A team searched the sector at this POD (capped at 0.9: never "cleared")."""
        q = round(min(float(pod), GROUND_POD_MAX), POD_DECIMALS)
        return _update("step", "ground", sector_id, [(int(i), q) for i in sector_cells])

    def clue_update(self, clue: Clue) -> MapUpdate:
        """A confirmed clue raises the probability around it (heuristic factors)."""
        f = CLUE_FACTOR[clue.reliability]
        near = set(
            cells_within_radius(self.base.grid, LatLon(lat=clue.lat, lon=clue.lon), clue.radius_m)
        )
        ring = (
            set(
                cells_within_radius(
                    self.base.grid, LatLon(lat=clue.lat, lon=clue.lon), 2 * clue.radius_m
                )
            )
            - near
        )
        cells = [(i, f) for i in near] + [(i, round(math.sqrt(f), POD_DECIMALS)) for i in ring]
        return _update("reweight", "clue", clue.id, cells)

    def conditions_update(self, c: Conditions) -> MapUpdate | None:
        """Exposure rising to high or severe: people shelter, so tree-covered cells gain (once
        per level; unknown canopy unchanged)."""
        if c.exposure_band not in SHELTER_FACTOR or _BANDS.index(c.exposure_band) <= self._band:
            return None
        canopy = self.canopy()
        f = SHELTER_FACTOR[c.exposure_band]
        cells = [(i, f) for i, v in enumerate(canopy) if v is not None and v >= SHELTER_CANOPY]
        return _update("reweight", "conditions", c.exposure_band, cells)

    # --- applying (MissionStore calls this) ------------------------------------------------------

    def apply(self, u: MapUpdate) -> None:
        if u.kind == "step":
            self._p, self._outside = apply_step(self._p, self._outside, u.cells)
        else:
            if any(not 0 < f <= MAX_FACTOR for _, f in u.cells):
                raise ValueError(f"map update {u.seq}: factor outside (0, {MAX_FACTOR}]")
            self._p, self._outside = apply_reweight(self._p, self._outside, u.cells)
        if u.source == "frame" and u.ref:
            self._frame_pods[u.ref] = dict(u.cells)
            for i, c, a in u.canopy or []:
                self._canopy_w[i] += a
                self._canopy_sum[i] += c * a
        if u.source == "conditions" and u.ref in _BANDS:
            self._band = max(self._band, _BANDS.index(u.ref))

    def top_cells(self, k: int = 5) -> list[tuple[int, LatLon, float]]:
        order = np.lexsort((np.arange(self._p.size), -self._p))[:k]
        return [(int(i), cell_center(self.base.grid, int(i)), float(self._p[i])) for i in order]
