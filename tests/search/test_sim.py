"""Simulated evaluation tests (LANE_C_SEARCH sections 6.4 and 7, item 9)."""

from __future__ import annotations

import time

import numpy as np
import pytest

from sightline.contract import (
    Distribution,
    LatLon,
    MapFile,
    Params,
    SearchSim,
    Step,
)
from sightline.search.grid import make_grid
from sightline.search.sim import simulate
from sightline.search.update import replay

DEMO_LKP = LatLon(lat=49.37, lon=-122.945)
NAMES = ["Prior only", "Naive: photographed = cleared", "Sightline: canopy-aware"]

FrameCells = dict[int, tuple[float, float]]


# A contract MapFile whose steps use the section 3.3 pod and whose final is their replay.
def _make_map(
    size_cells: int,
    frame_cells: list[FrameCells],
    recall: float = 0.8,
    pod_cap: float = 0.95,
    outside: float = 0.0,
) -> MapFile:
    grid = make_grid(DEMO_LKP, size_m=20.0 * size_cells, cell_m=20.0)
    n = grid.rows * grid.cols
    prior = np.full(n, (1.0 - outside) / n)
    steps = []
    for cells in frame_cells:
        pods = [(i, round(min(pod_cap, recall * (1.0 - c) * a), 4)) for i, (c, a) in cells.items()]
        steps.append([(i, q) for i, q in pods if q >= 0.001])
    final_p, final_out = replay(prior, outside, steps)
    return MapFile(
        contract_version="1.0",
        grid=grid,
        lkp=DEMO_LKP,
        params=Params(recall=recall, recall_source="placeholder", pod_cap=pod_cap, review_pod=0.9),
        prior=Distribution(p=prior.tolist(), outside=outside),
        canopy=[None] * n,
        steps=[Step(frame_id=f"f{k + 1:04d}", cells=s) for k, s in enumerate(steps)],
        final=Distribution(p=final_p.tolist(), outside=final_out),
        top_cells=[],
    )


# 10 x 10 grid: the north half is photographed twice, checkerboard forest (0.9) and open (0.1).
def _half_forest() -> tuple[MapFile, list[FrameCells]]:
    frames: list[FrameCells] = []
    for _ in range(2):
        for idx in range(50):
            row, col = divmod(idx, 10)
            canopy = 0.9 if (row + col) % 2 == 0 else 0.1
            frames.append({idx: (canopy, 0.75)})
    return _make_map(10, frames), frames


def test_same_seed_same_result_and_different_seed_differs() -> None:
    map_file, frames = _half_forest()
    a = simulate(map_file, frames, trials=500, seed=7)
    b = simulate(map_file, frames, trials=500, seed=7)
    c = simulate(map_file, frames, trials=500, seed=8)
    assert a == b
    assert a != c


def test_canopy_aware_beats_naive_on_half_forest() -> None:
    map_file, frames = _half_forest()
    sim = simulate(map_file, frames, trials=1000, seed=7)
    by_name = {m.name: m for m in sim.methods}
    assert by_name[NAMES[2]].median_cells <= by_name[NAMES[1]].median_cells
    assert by_name[NAMES[2]].p90_cells <= by_name[NAMES[1]].p90_cells


def test_returns_contract_search_sim_with_names_in_order() -> None:
    map_file, frames = _half_forest()
    sim = simulate(map_file, frames, trials=200, seed=3)
    assert isinstance(sim, SearchSim)
    SearchSim.model_validate(sim.model_dump())
    assert [m.name for m in sim.methods] == NAMES
    assert sim.simulated is True
    assert sim.trials == 200
    assert sim.seed == 3
    for m in sim.methods:
        assert float(m.median_cells).is_integer() and float(m.p90_cells).is_integer()
        assert 1 <= m.median_cells <= m.p90_cells <= 100


def test_zero_recall_finds_nobody() -> None:
    frames: list[FrameCells] = [{i: (0.0, 0.75) for i in range(25)}]
    map_file = _make_map(5, frames, recall=0.0)
    sim = simulate(map_file, frames, trials=300, seed=7)
    assert sim.found_by_drone_rate == 0.0
    # Every trial is not found, so ranks exist for all three methods.
    assert all(m.median_cells >= 1 for m in sim.methods)


def test_open_fully_covered_grid_finds_people() -> None:
    frames: list[FrameCells] = [{i: (0.0, 0.75) for i in range(25)} for _ in range(3)]
    map_file = _make_map(5, frames, recall=0.8)
    sim = simulate(map_file, frames, trials=500, seed=7)
    assert sim.found_by_drone_rate > 0.5
    assert sim.found_by_drone_rate == round(sim.found_by_drone_rate, 3)


def test_all_found_gives_zero_cells() -> None:
    frames: list[FrameCells] = [{0: (0.0, 1.0)}]
    map_file = _make_map(1, frames, recall=1.0)
    sim = simulate(map_file, frames, trials=50, seed=7, vis_noise=0.0)
    assert sim.found_by_drone_rate == 1.0
    assert all(m.median_cells == 0 and m.p90_cells == 0 for m in sim.methods)


def test_length_mismatch_raises() -> None:
    map_file, frames = _half_forest()
    with pytest.raises(ValueError, match="frame_cells"):
        simulate(map_file, frames[:-1])


def test_unknown_canopy_as_zero_is_accepted() -> None:
    # The pipeline passes unknown canopy as 0.0; some frames cover nothing at all.
    frames: list[FrameCells] = [{3: (0.0, 0.5), 4: (0.0, 0.2)}, {}, {3: (0.0, 0.75)}]
    map_file = _make_map(5, frames, outside=0.3)
    sim = simulate(map_file, frames, trials=100, seed=7)
    assert [m.name for m in sim.methods] == NAMES


def test_fast_enough_on_full_size_grid() -> None:
    rng = np.random.default_rng(1)
    frames: list[FrameCells] = []
    for _ in range(500):
        start = int(rng.integers(0, 2500 - 60))
        frames.append({start + j: (float(rng.random()), 0.5) for j in range(0, 60, 10)})
    map_file = _make_map(50, frames, outside=0.4)
    t0 = time.perf_counter()
    simulate(map_file, frames, trials=1000, seed=7)
    assert time.perf_counter() - t0 < 5.0
