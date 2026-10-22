"""The information-gain planner (LANE_C §5.3, C-P1)."""

from __future__ import annotations

import numpy as np
import pytest

from sightline.contract import Clue, Conditions, Drone, FleetState, LatLon, SectorTask, Team
from sightline.search.grid import cell_center, latlon_to_local_m
from sightline.search.live import LiveMap
from sightline.search.planner import (
    PlannerConfig,
    candidate_legs,
    expected_clearance,
    propose_assignments,
    propose_legs,
)
from sightline.search.sectors import lattice_sectors

LKP = LatLon(lat=49.375, lon=-122.9375)
NOW = "2026-10-24T21:40:00Z"
CFG = PlannerConfig()


def _drone(i: str = "D1", battery: float = 95, status: str = "idle") -> Drone:
    return Drone(
        id=i,
        name=f"Drone {i[1:]}",
        simulated=True,
        position=None,
        altitude_m=50,
        speed_ms=8,
        battery_pct=battery,
        max_wind_kmh=38,
        status=status,
        leg_id=None,
    )


def _fleet(*drones: Drone) -> FleetState:
    return FleetState(simulated=True, drones=list(drones), legs=[], updated_at=NOW)


def _conditions(**over) -> Conditions:
    base = {
        "fetched_at": NOW,
        "stale": False,
        "area": "a",
        "sources": [],
        "wind_kmh": 10,
        "gust_kmh": 20,
        "wind_dir_deg": None,
        "precip_mm_h": 0,
        "precip_prob": None,
        "temp_c": None,
        "visibility_km": None,
        "sunset": None,
        "civil_twilight_end": "2026-10-25T01:12:00Z",
        "alerts": [],
        "flyable": True,
        "flyable_until": None,
        "flyability_reason": "gusts below the limit",
        "visibility_factor": 1.0,
        "exposure_band": "low",
        "exposure_note": "",
    }
    return Conditions(**{**base, **over})


def _map_with(mass: dict[str, float]) -> tuple[LiveMap, object]:
    """A 400 m map (sectors of 100 m) with the given probability in the given sectors."""
    m = LiveMap.start(LKP, size_m=400.0)
    layout = lattice_sectors(m.base.grid)
    p = np.zeros(m.base.grid.rows * m.base.grid.cols)
    for sid, w in mass.items():
        cells = layout.cells_of(sid)
        p[cells] = w / len(cells)
    m._p, m._outside = p, 1.0 - sum(mass.values())
    return m, layout


def test_one_lawnmower_leg_per_sector_and_transit_counts() -> None:
    m, layout = _map_with({"B2": 0.5})
    legs = candidate_legs(_drone(), layout, m.base.grid, CFG, LKP)
    assert [leg.sector_id for leg in legs] == [s.id for s in layout.sectors]
    b2 = next(leg for leg in legs if leg.sector_id == "B2")
    assert len(b2.waypoints) == 10  # 100 m sector / 20 m spacing = 5 lines, 2 ends each
    near = next(leg for leg in legs if leg.sector_id == "B2").est_minutes
    far = next(leg for leg in legs if leg.sector_id == "D4").est_minutes
    assert far > near  # same sector size, longer flight there


def test_value_is_probability_times_pod_and_tree_cover_lowers_it() -> None:
    m, layout = _map_with({"B2": 0.5})
    leg = next(
        leg
        for leg in candidate_legs(_drone(), layout, m.base.grid, CFG, LKP)
        if leg.sector_id == "B2"
    )
    # no photo yet: canopy unknown → 0.5, so POD = 0.864 × 0.5
    assert expected_clearance(leg, m, layout, 1.0, CFG) == pytest.approx(0.5 * 0.864 * 0.5)
    assert expected_clearance(leg, m, layout, 0.5, CFG) == pytest.approx(0.5 * 0.864 * 0.5 * 0.5)


def test_two_drones_spread_over_the_two_likely_sectors() -> None:
    m, layout = _map_with({"B2": 0.3, "C3": 0.2})
    legs = propose_legs(m, layout, _fleet(_drone("D1"), _drone("D2")), _conditions(), NOW)
    assert sorted(leg.sector_id for leg in legs) == ["B2", "C3"]
    assert len({leg.drone_id for leg in legs}) == 2
    best = legs[0]
    assert best.sector_id == "B2" and best.expected_clearance == pytest.approx(
        0.3 * 0.432, abs=1e-4
    )
    assert (
        "expected to lower the remaining probability by 13.0%" in best.reason
        and "%/min" in best.reason
    )
    assert "battery (95%)" in best.reason and "before civil twilight" in best.reason


def test_after_a_clue_the_plan_moves() -> None:
    m, layout = _map_with({"B2": 0.3, "C3": 0.25})
    assert propose_legs(m, layout, _fleet(_drone()), None, NOW)[0].sector_id == "B2"
    centre = cell_center(m.base.grid, int(layout.cells_of("C3")[len(layout.cells_of("C3")) // 2]))
    clue = Clue(
        id="c001",
        kind="object",
        text="backpack",
        lat=centre.lat,
        lon=centre.lon,
        radius_m=40,
        reliability="high",
        reported_by="T2",
        source="form",
        at=NOW,
        confirmed=True,
    )
    m.apply(m.clue_update(clue))
    assert propose_legs(m, layout, _fleet(_drone()), None, NOW)[0].sector_id == "C3"


def test_limits() -> None:
    m, layout = _map_with({"B2": 0.5})
    assert propose_legs(m, layout, _fleet(_drone()), _conditions(flyable=False), NOW) == []
    assert propose_legs(m, layout, _fleet(_drone(battery=3)), None, NOW) == []  # not enough battery
    dusk = _conditions(civil_twilight_end="2026-10-24T21:42:00Z")  # 2 min of light left
    assert propose_legs(m, layout, _fleet(_drone()), dusk, NOW) == []
    windy_soon = _conditions(flyable_until="2026-10-24T21:42:00Z")  # gusts over the limit in 2 min
    assert propose_legs(m, layout, _fleet(_drone()), windy_soon, NOW) == []
    calm_for_hours = _conditions(flyable_until="2026-10-25T03:00:00Z")
    assert propose_legs(m, layout, _fleet(_drone()), calm_for_hours, NOW)  # the same leg fits
    taken = _fleet(_drone("D1"), _drone("D2", status="charging"))
    assert [leg.drone_id for leg in propose_legs(m, layout, taken, None, NOW)] == ["D1"]


def test_ground_teams_go_where_tree_cover_hides_people() -> None:
    m, layout = _map_with({"B2": 0.2, "C3": 0.2})
    for i in layout.cells_of("C3"):  # C3 is forest, B2 open ground (as photos would have measured)
        m._canopy_w[i], m._canopy_sum[i] = 1.0, 0.9
    for i in layout.cells_of("B2"):
        m._canopy_w[i], m._canopy_sum[i] = 1.0, 0.0
    c3 = cell_center(m.base.grid, int(layout.cells_of("C3")[0]))
    teams = [
        Team(
            id="T1",
            callsign="Team One",
            members=3,
            status="standby",
            position=None,
            position_at=None,
            note=None,
        ),
        Team(
            id="T2",
            callsign="Team Two",
            members=3,
            status="standby",
            position=c3,
            position_at=NOW,
            note=None,
        ),
        Team(
            id="T3",
            callsign="Team Three",
            members=3,
            status="searching",
            position=None,
            position_at=None,
            note=None,
        ),
    ]
    out = propose_assignments(m, layout, [], teams)
    assert (
        out[0][:2] == ("T2", "C3")
        and "90% of it under tree cover" in out[0][2]
        and "Team Two is nearest" in out[0][2]
    )
    assert out[1][:2] == ("T1", "B2") and len(out) == 2  # Team Three is busy
    busy = [
        SectorTask(
            sector_id="C3",
            state="searched",
            team_id="T2",
            poa=0.2,
            pod=0.6,
            note=None,
            updated_at=NOW,
        )
    ]
    assert propose_assignments(m, layout, busy, teams)[0][1] == "B2"
    assert latlon_to_local_m(m.base.grid, c3)  # (positions are in the grid)


def _task(sector: str, state: str) -> SectorTask:
    return SectorTask(
        sector_id=sector,
        state=state,
        team_id="T1" if state != "proposed" else None,
        poa=0.0,
        pod=0.6 if state == "searched" else None,
        note=None,
        updated_at=NOW,
    )


def test_drones_plan_around_a_ground_teams_sector() -> None:
    m, layout = _map_with({"B2": 0.3, "C3": 0.2})
    assert propose_legs(m, layout, _fleet(_drone()), None, NOW, k=1)[0].sector_id == "B2"
    for state in ("assigned", "in_progress"):  # 0.3 × 0.5 < 0.2: the drone goes elsewhere
        tasks = [_task("B2", state)]
        assert (
            propose_legs(m, layout, _fleet(_drone()), None, NOW, 1, tasks=tasks)[0].sector_id
            == "C3"
        )
    # searched (the map already has the team's step) and proposed tasks don't discount
    for state in ("searched", "proposed"):
        tasks = [_task("B2", state)]
        assert (
            propose_legs(m, layout, _fleet(_drone()), None, NOW, 1, tasks=tasks)[0].sector_id
            == "B2"
        )
    excluded = PlannerConfig(team_discount=1.0)
    m, layout = _map_with({"B2": 0.9, "C3": 0.01})
    (leg,) = propose_legs(
        m, layout, _fleet(_drone()), None, NOW, 1, excluded, [_task("B2", "assigned")]
    )
    assert leg.sector_id == "C3"


def test_a_teams_sector_still_chosen_says_it_was_discounted() -> None:
    m, layout = _map_with({"B2": 0.5, "C3": 0.1})
    (leg,) = propose_legs(
        m, layout, _fleet(_drone()), None, NOW, 1, tasks=[_task("B2", "assigned")]
    )
    assert (
        leg.sector_id == "B2" and "counted at 50% as a ground team is assigned there" in leg.reason
    )
    # expected_clearance stays what the photos lower; the rate is the discounted one
    assert leg.expected_clearance == pytest.approx(
        2 * leg.score_per_min * leg.est_minutes, rel=1e-3
    )


def test_team_assignments_count_the_walk() -> None:
    m, layout = _map_with({"A1": 0.2, "D4": 0.21})  # D4 a little more likely, but 424 m away
    a1 = cell_center(m.base.grid, int(layout.cells_of("A1")[len(layout.cells_of("A1")) // 2]))
    team = Team(id="T1", callsign="Team One", members=3, status="standby", position=a1,
                position_at=NOW, note=None)  # fmt: skip
    ((tid, sector, reason),) = propose_assignments(m, layout, [], [team])
    assert (
        (tid, sector) == ("T1", "A1")
        and "min on foot" in reason
        and "Team One is nearest" in reason
    )
    old = PlannerConfig(walking_kmh=None)  # the old rule: best sector first
    assert propose_assignments(m, layout, [], [team], old)[0][1] == "D4"
    # 0.21 / (424 m at 3 km/h + 60 min) vs 0.2 / 60 min; a much likelier sector is worth the walk
    m, layout = _map_with({"A1": 0.2, "D4": 0.3})
    assert propose_assignments(m, layout, [], [team])[0][1] == "D4"
