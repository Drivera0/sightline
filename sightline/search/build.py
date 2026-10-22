"""Build the search map from the survey frames (contract section 8, LANE_C_SEARCH section 6.3).

Everything is computed in float64. The written values follow contract section 2: step pods,
canopy and top_cells.p are rounded to 4 decimals, top-cell lat/lon to 6, and prior and
final are unrounded. final is the replay of the rounded pods on the unrounded prior, so a
replay of the file reproduces it exactly.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np

from sightline.contract import (
    CONTRACT_VERSION,
    Distribution,
    Grid,
    LatLon,
    MapFile,
    Params,
    Step,
    TopCell,
)
from sightline.search.grid import cell_center
from sightline.search.pod import MIN_STEP_POD, FrameInput, frame_recall, frame_step
from sightline.search.update import replay

FrameCells = dict[int, tuple[float, float]]  # idx -> (canopy, overlap) for one frame

POD_DECIMALS = 4
CANOPY_DECIMALS = 4
TOP_P_DECIMALS = 4
LATLON_DECIMALS = 6
N_TOP_CELLS = 5
PRIOR_SUM_TOL = 1e-6


# The whole map: one step per frame, canopy, final and top cells.
def build_map(
    grid: Grid,
    lkp: LatLon,
    prior: tuple[np.ndarray, float],
    frames: Sequence[FrameInput],
    recall: float,
    recall_source: str,
    pod_cap: float = 0.95,
    review_pod: float = 0.90,
    *,
    prior_source: str | None = None,
    **canopy_thr: float,
) -> tuple[MapFile, list[FrameCells]]:
    """MapFile (contract) + one {idx: (canopy, overlap)} per frame in flight order.

    - frames must be in flight order. Each frame gives one step, even when it covers no
      cell. Step cells are (idx, pod rounded to 4 decimals), sorted by idx, with rounded
      pods below 0.001 omitted.
    - Held for review ("fix A"): every candidate (position, radius_m) of the whole survey
      is held in every frame, not only in the frame that detected it. In this simulation
      frames that overlap are unrelated photos, so one frame must not say "nobody here"
      where another frame detected someone. The searcher's answer decides those cells.
    - canopy per cell = overlap-weighted mean of the frames' canopy over every frame that
      covered it, rounded to 4 decimals; None where no frame covered it.
    - final = replay of the rounded pods on the unrounded prior (written unrounded).
    - top_cells = the 5 cells with the largest final p, descending (ties: lower idx).
    - The returned per-frame cells are unrounded; simulate() needs them.

    prior_source (contract 1.1) is written to params.prior_source: the citation of the
    lost-person statistics the prior came from, or None. The pipeline sets "placeholder"
    itself when it gave the placeholder prior.
    canopy_thr passes exg_thr, std_thr and shadow_thr to the canopy classifier.
    Raises ValueError if the prior has the wrong length or does not sum to 1 with outside.
    """
    prior_p = np.asarray(prior[0], dtype=np.float64)
    prior_outside = float(prior[1])
    n_cells = grid.rows * grid.cols
    if prior_p.shape != (n_cells,):
        raise ValueError(f"prior has shape {prior_p.shape}, expected rows*cols = ({n_cells},)")
    total = math.fsum(prior_p.tolist()) + prior_outside
    if abs(total - 1.0) > PRIOR_SUM_TOL:
        raise ValueError(f"prior sum(p) + outside = {total}, expected 1 within {PRIOR_SUM_TOL}")

    held = [c for f in frames for c in f.candidates]

    steps: list[Step] = []
    per_frame: list[FrameCells] = []
    weighted_canopy = np.zeros(n_cells, dtype=np.float64)
    weight = np.zeros(n_cells, dtype=np.float64)
    for f in frames:
        pods, cells = frame_step(grid, f, frame_recall(f, recall), pod_cap, held=held, **canopy_thr)
        rounded = [(idx, r) for idx, pod in pods if (r := round(pod, POD_DECIMALS)) >= MIN_STEP_POD]
        steps.append(Step(frame_id=f.frame_id, cells=sorted(rounded)))
        per_frame.append(cells)
        for idx, (canopy, overlap) in cells.items():
            weighted_canopy[idx] += canopy * overlap
            weight[idx] += overlap

    canopy_out: list[float | None] = [
        round(float(weighted_canopy[i] / weight[i]), CANOPY_DECIMALS) if weight[i] > 0 else None
        for i in range(n_cells)
    ]

    final_p, final_outside = replay(prior_p, prior_outside, [s.cells for s in steps])

    top_cells: list[TopCell] = []
    order = np.lexsort((np.arange(n_cells), -final_p))[:N_TOP_CELLS]
    for idx in order.tolist():
        centre = cell_center(grid, idx)
        top_cells.append(
            TopCell(
                idx=idx,
                lat=round(centre.lat, LATLON_DECIMALS),
                lon=round(centre.lon, LATLON_DECIMALS),
                p=round(float(final_p[idx]), TOP_P_DECIMALS),
                canopy=canopy_out[idx],
            )
        )

    map_file = MapFile(
        contract_version=CONTRACT_VERSION,
        grid=grid,
        lkp=lkp,
        params=Params(
            recall=recall,
            recall_source=recall_source,
            pod_cap=pod_cap,
            review_pod=review_pod,
            prior_source=prior_source,
        ),
        prior=Distribution(p=prior_p.tolist(), outside=prior_outside),
        canopy=canopy_out,
        steps=steps,
        final=Distribution(p=final_p.tolist(), outside=final_outside),
        top_cells=top_cells,
    )
    return map_file, per_frame
