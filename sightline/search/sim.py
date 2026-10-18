"""Simulated evaluation of the search map (LANE_C_SEARCH section 6.4, contract section 9).

The result is a simulation, not a field test: label it "Simulated" everywhere it is shown.

Why `in_survey` exists (contract 1.1): with a flat prior most simulated lost persons stand
outside the photographed area. No frame looked at those cells, so the naive and the
canopy-aware maps change them in the same way and rank them the same. The overall median
over all not-found trials is then mostly those cells, and it hides the difference between
the two methods.

`in_survey` is "cells checked inside the surveyed area before reaching the person". It uses
only the not-found trials whose true cell was photographed, and it ranks the true cell only
among the photographed cells. This is the same rule as the "Search next" panel on the map,
which ranks only photographed cells. The reason: inside a 1 km grid a hiker prior is flat
(hiker distances are larger than the grid). Every update lowers p in photographed cells, so
every photographed cell falls below every unphotographed cell. A whole-grid rank of a person
in the survey is then about the number of unphotographed cells for every update method, and
it says nothing about which cell inside the survey a team checks first.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

import numpy as np

from sightline.contract import InSurvey, MapFile, SearchMethod, SearchSim
from sightline.search.update import replay

# Method names exactly as in contract section 9, in this order.
METHOD_PRIOR = "Prior only"
METHOD_NAIVE = "Naive: photographed = cleared"
METHOD_SIGHTLINE = "Sightline: canopy-aware"

# Steps omit cells with a pod below this (contract section 8).
MIN_POD = 0.001


# 1-based rank of every cell when cells are sorted by descending p (ties: lower idx first).
def _rank_of_cell(p: np.ndarray) -> np.ndarray:
    order = np.lexsort((np.arange(p.size), -p))
    ranks = np.empty(p.size, dtype=np.int64)
    ranks[order] = np.arange(1, p.size + 1)
    return ranks


# Median and 90th percentile of a list of ranks, as whole cells.
def _summary(ranks: np.ndarray) -> tuple[int, int]:
    if ranks.size == 0:
        return 0, 0
    median, p90 = np.percentile(ranks, [50.0, 90.0])
    return int(np.rint(median)), int(np.rint(p90))


# Run the simulated evaluation of the three search methods.
def simulate(
    map_file: MapFile,
    frame_cells: Sequence[Mapping[int, tuple[float, float]]],
    trials: int = 1000,
    seed: int = 7,
    vis_noise: float = 0.15,
) -> SearchSim:
    """Simulate `trials` lost persons and count the cells a ground team checks per method.

    frame_cells has one {idx: (canopy, overlap)} per frame, in flight order (the same order
    as map_file.steps). Unknown canopy may be given as 0.0.

    Before the trials (they do not depend on the trial):
    - each cell's mean canopy c_i = sum_k a_ik c_ik / sum_k a_ik over the frames k that
      cover it (a = overlap, c = canopy);
    - the final map of each method: "Prior only" = prior.p; "Naive: photographed = cleared"
      = replay with pod = min(pod_cap, pod_cap * a) per frame (pods < 0.001 omitted, like
      the contract); "Sightline: canopy-aware" = replay of map_file.steps as written.
      Cells are ranked by descending final p, ties broken by lower idx.

    Each trial:
    1. Draw the true cell from prior.p renormalised over the grid.
    2. Draw the person's true visibility v = clip((1 - c_true) + N(0, vis_noise), 0, 1).
       This is drawn ONCE per trial and used for every look at the true cell (a deliberate
       change from drawing it per frame): a person stands in one place, so how well trees
       hide them does not change between photos. In this simulated survey the frames that
       overlap a cell are unrelated photos with different canopy, so the per-cell mean
       canopy is the best single estimate of that place.
    3. Fly the frames in order. Each frame that covers the true cell finds the person with
       probability recall * v * min(a, 1) (one uniform draw per covering frame). Found ->
       the trial counts toward found_by_drone_rate and stops.
    4. Not found -> record the true cell's 1-based rank under each method.

    in_survey (contract 1.1) has the same three methods, names and order. It counts the cells
    checked inside the surveyed area before reaching the person, the same rule as the "Search
    next" panel. A cell is photographed when at least one frame in frame_cells covers it with
    overlap > 0. Its median and p90 use only the not-found trials whose true cell was
    photographed, and the rank is the true cell's 1-based rank among the photographed cells
    only (same order: descending final p, ties to lower idx), so it is 1..n_photographed.
    With a flat prior the whole-grid rank would put every photographed cell below every
    unphotographed one, so it would measure the size of the unsurveyed area, not the order
    inside the survey. in_survey.trials is the number of those trials.
    If there are none, in_survey is None: a median over zero trials has no meaning, and 0
    would read as "found at once". (The contract model would accept trials = 0, so this is
    our choice, not a model rule.)

    median_cells and p90_cells use np.percentile (linear interpolation) over the not-found
    trials, then round to the nearest whole number (halves to even), because they are cell
    counts; in_survey uses the same rule. If every trial is found there are no ranks to
    report, and both are 0 for every method. found_by_drone_rate = found / trials, rounded to 3 decimals (contract section 2).
    """
    if len(frame_cells) != len(map_file.steps):
        raise ValueError(
            f"frame_cells has {len(frame_cells)} frames but map_file has "
            f"{len(map_file.steps)} steps; they must match one to one in flight order"
        )
    if trials < 0:
        raise ValueError(f"trials must be >= 0, got {trials}")
    if vis_noise < 0:
        raise ValueError(f"vis_noise must be >= 0, got {vis_noise}")

    recall = float(map_file.params.recall)
    pod_cap = float(map_file.params.pod_cap)
    prior_p = np.asarray(map_file.prior.p, dtype=np.float64)
    n = prior_p.size

    # Per cell: overlaps in flight order, and the overlap-weighted mean canopy.
    overlaps: list[list[float]] = [[] for _ in range(n)]
    weighted_canopy = np.zeros(n, dtype=np.float64)
    overlap_sum = np.zeros(n, dtype=np.float64)
    naive_steps: list[list[tuple[int, float]]] = []
    for cells in frame_cells:
        naive: list[tuple[int, float]] = []
        for idx, (canopy, overlap) in sorted(cells.items()):
            if not 0 <= idx < n:
                raise IndexError(f"cell index {idx} outside grid of {n} cells")
            if overlap < 0:
                raise ValueError(f"overlap must be >= 0, got {overlap} for cell {idx}")
            canopy = min(max(float(canopy), 0.0), 1.0)
            overlaps[idx].append(float(overlap))
            weighted_canopy[idx] += overlap * canopy
            overlap_sum[idx] += overlap
            pod = min(pod_cap, pod_cap * float(overlap))
            if pod >= MIN_POD:
                naive.append((idx, pod))
        naive_steps.append(naive)
    mean_canopy = np.divide(
        weighted_canopy, overlap_sum, out=np.zeros(n, dtype=np.float64), where=overlap_sum > 0
    )
    cover = [np.minimum(np.asarray(a, dtype=np.float64), 1.0) for a in overlaps]

    # Final map of each method, then each cell's rank under it.
    outside = float(map_file.prior.outside)
    naive_p, _ = replay(prior_p, outside, naive_steps)
    sightline_p, _ = replay(prior_p, outside, ([tuple(c) for c in s.cells] for s in map_file.steps))
    names = (METHOD_PRIOR, METHOD_NAIVE, METHOD_SIGHTLINE)
    ranks_by_method = np.stack([_rank_of_cell(m) for m in (prior_p, naive_p, sightline_p)])

    # Trials: true cells and visibilities all at once, then the looks per trial.
    total = float(prior_p.sum())
    if total <= 0.0:
        raise ValueError("prior.p must have positive mass inside the grid")
    rng = np.random.default_rng(seed)
    true_cells = rng.choice(n, size=trials, p=prior_p / total)
    visibility = np.clip(
        (1.0 - mean_canopy[true_cells]) + rng.normal(0.0, vis_noise, size=trials), 0.0, 1.0
    )
    found = np.zeros(trials, dtype=bool)
    for t in range(trials):
        a = cover[true_cells[t]]
        if a.size == 0:
            continue
        # Frames in flight order; the first success stops the trial. Only whether any look
        # succeeds matters for the result, so all looks are drawn together.
        found[t] = bool(np.any(rng.random(a.size) < recall * visibility[t] * a))

    not_found = true_cells[~found]
    methods = _methods(names, ranks_by_method, not_found)
    # Not-found trials whose true cell was photographed (overlap > 0 in some frame).
    photographed = overlap_sum > 0
    in_survey_cells = not_found[photographed[not_found]]
    in_survey = None
    if in_survey_cells.size > 0:
        # Rank among photographed cells only, once per method; unphotographed cells get 0
        # (never read, because every in_survey true cell is photographed).
        photo_idx = np.flatnonzero(photographed)
        survey_ranks = np.zeros_like(ranks_by_method)
        for m, final_p in enumerate((prior_p, naive_p, sightline_p)):
            survey_ranks[m, photo_idx] = _rank_of_cell(final_p[photo_idx])
        in_survey = InSurvey(
            trials=int(in_survey_cells.size),
            methods=_methods(names, survey_ranks, in_survey_cells),
        )
    rate = round(float(found.sum()) / trials, 3) if trials > 0 else 0.0
    return SearchSim(
        simulated=True,
        trials=trials,
        seed=seed,
        found_by_drone_rate=rate,
        methods=methods,
        in_survey=in_survey,
    )


# One SearchMethod per method: median and p90 of the true cells' ranks under it.
def _methods(
    names: Sequence[str], ranks_by_method: np.ndarray, true_cells: np.ndarray
) -> list[SearchMethod]:
    methods = []
    for name, ranks in zip(names, ranks_by_method, strict=True):
        median, p90 = _summary(ranks[true_cells])
        methods.append(SearchMethod(name=name, median_cells=median, p90_cells=p90))
    return methods
