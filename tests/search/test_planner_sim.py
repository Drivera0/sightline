"""The simulated planner evaluation (C-P2): the plans, the trials and the summary."""

from __future__ import annotations

import numpy as np

from sightline.contract import LatLon
from sightline.search.grid import local_m_to_latlon, make_grid
from sightline.search.planner import PlannerConfig
from sightline.search.planner_sim import minutes_to_find, plan, scenario, summary, with_clue
from sightline.search.sectors import lattice_sectors

LKP = LatLon(lat=49.375, lon=-122.9375)
CFG = PlannerConfig()


def _scn():
    grid = make_grid(LKP, 400.0, 10.0)  # 40 × 40 cells, sectors of 100 m
    n = grid.rows * grid.cols
    return scenario(grid, LKP, [1.0 / n] * n, [None] * n, CFG)


def test_static_flies_the_sectors_in_serpentine_order() -> None:
    legs = [p.leg.sector_id for p in plan(_scn(), "static", CFG, horizon_min=60)]
    assert legs[:8] == ["A1", "A2", "A3", "A4", "B4", "B3", "B2", "B1"]


def test_the_planner_flies_to_a_clue_first_and_static_does_not() -> None:
    base = _scn()
    layout = lattice_sectors(base.grid)
    r = next(s.rect for s in layout.sectors if s.id == "D1")
    clue = local_m_to_latlon(
        base.grid, (r["east_min"] + r["east_max"]) / 2, (r["south_min"] + r["south_max"]) / 2
    )
    scn = with_clue(base, clue, 30.0)
    assert plan(scn, "planner", CFG, 30)[0].leg.sector_id == "D1"
    assert plan(scn, "static", CFG, 30)[0].leg.sector_id == "A1"
    assert abs(scn.prior.sum() - 1) < 1e-12


def test_finds_happen_only_where_the_drone_passed_and_are_reproducible() -> None:
    scn = _scn()
    passes = plan(scn, "static", CFG, horizon_min=30)
    a = minutes_to_find(scn, passes, CFG, 500, 0.15, seed=1)
    assert np.array_equal(a, minutes_to_find(scn, passes, CFG, 500, 0.15, seed=1))
    seen = {c for p in passes for c in p.cell_time}
    assert np.isinf(a).any() and np.isfinite(a).any()
    assert (
        0 < np.isfinite(a).mean() < len(seen) / scn.prior.size + 0.05
    )  # can't find more than it covered


def test_summary_counts_only_finds_within_the_horizon() -> None:
    s = summary(np.array([10.0, 20.0, 125.0, np.inf]), within=15, horizon=120)
    assert s["found_within_30_min"] == 0.25 and s["found_within_horizon"] == 0.5
    assert s["median_min"] is None  # half found is not "median found"
    assert summary(np.array([5.0, 6.0, 7.0]))["median_min"] == 6.0


def test_fleet_strategies_share_or_split_the_sectors() -> None:
    from sightline.search.planner_sim import plan_fleet

    first = lambda s: [p.leg.sector_id for p in plan_fleet(_scn(), s, CFG, 3, 30)[:3]]
    assert len(set(first("coordinated"))) == 3  # one shared map: three different sectors
    assert len(set(first("independent"))) == 1  # each alone picks the same best sector
    split = plan_fleet(_scn(), "split", CFG, 3, 30)
    assert {p.leg.sector_id for p in split} == {s.id for s in lattice_sectors(_scn().grid).sectors}
    assert {p.leg.drone_id for p in split} == {"D1", "D2", "D3"}


def test_three_coordinated_drones_find_sooner_than_one() -> None:
    from sightline.search.planner_sim import plan_fleet

    scn = _scn()
    one = summary(
        minutes_to_find(scn, plan(scn, "planner", CFG, 60), CFG, 1000, 0.15, 1), horizon=60
    )
    three = summary(
        minutes_to_find(scn, plan_fleet(scn, "coordinated", CFG, 3, 60), CFG, 1000, 0.15, 1),
        horizon=60,
    )
    assert three["found_within_30_min"] > one["found_within_30_min"]
