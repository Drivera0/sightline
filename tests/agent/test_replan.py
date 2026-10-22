"""Re-planning on team evidence and the opening legs (sightline/agent/loop.py, effects.py): a
sector searched at a POD, a team's new position and the fleet joining each re-plan, one proposal
per drone. Against the fake store and the fixtures of test_loop. No network, no keys."""

from __future__ import annotations

import numpy as np
import pytest

from sightline.agent import loop
from sightline.contract import Distribution, FleetState, FleetTelemetry, LatLon, Leg, SectorTask
from sightline.mission import effects
from sightline.search.live import LiveMap
from sightline.search.sectors import lattice_sectors
from tests.agent.fake_store import FakeMissionStore
from tests.agent.test_loop import LKP, NOW, _conditions, _drone, _handle, _team


class Hooks:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def __getattr__(self, name: str):
        if not name.startswith("on_"):
            raise AttributeError(name)
        return lambda store, mid, *args: self.calls.append((name, *args))


@pytest.fixture(autouse=True)
def _fresh_conditions_memory():
    loop._last_conditions.clear()


@pytest.fixture
def spread():
    """Probability over four central sectors (B2 most), canopy unknown, four idle drones and one
    flying (D5 over A1), two standby teams, a task per sector."""
    store = FakeMissionStore()
    mid = store.create("Seymour", "Seymour", LKP, "live", subject="adult").mission_id
    base = LiveMap.start(LKP, size_m=1000, cell_m=20).base
    layout = lattice_sectors(base.grid)
    p = np.zeros(base.grid.rows * base.grid.cols)
    for sid, w in {"B2": 0.4, "B3": 0.3, "C2": 0.2, "C3": 0.1}.items():
        p[layout.cells_of(sid)] = w / len(layout.cells_of(sid))
    store.live_maps[mid] = LiveMap(
        base.model_copy(update={"prior": Distribution(p=p.tolist(), outside=0.0)})
    )
    store.put_conditions(mid, _conditions())
    store.upsert_team(mid, _team("T1", "Team One", "standby", None))
    store.upsert_team(mid, _team("T2", "Team Two", "standby", None))
    for s in layout.sectors:
        store.upsert_task(
            mid,
            SectorTask(
                sector_id=s.id,
                state="proposed",
                team_id=None,
                poa=0.0,
                pod=None,
                note=None,
                updated_at=NOW,
            ),
        )
    return store, mid, layout


def _fleet(store, mid, *drones) -> None:
    store.put_fleet(mid, FleetState(simulated=True, drones=list(drones), legs=[], updated_at=NOW))


def _legs(ps) -> list[tuple[str, str]]:
    return [(p.target["drone"], p.leg.sector_id) for p in ps]


def test_a_clue_now_plans_every_idle_drone_one_proposal_each(spread) -> None:
    store, mid, _ = spread
    _fleet(store, mid, _drone("D1"), _drone("D2"), _drone("D3"))
    out = loop._replan(store, mid, "After a clue.")
    assert {p.kind for p in out} == {"drone_leg"} and {p.status for p in out} == {"pending"}
    assert sorted(d for d, _ in _legs(out)) == ["D1", "D2", "D3"]  # one per drone, capped
    assert len({s for _, s in _legs(out)}) == 3  # sequential greedy: no shared sector
    assert _legs(out)[0][1] == "B2"  # the best leg first
    again = loop._replan(store, mid, "Another clue.")
    assert len(again) == 3  # each drone's older proposal is superseded, never stacked
    pending = [p for p in store.state(mid)["proposals"] if p.status == "pending"]
    assert sorted(p.target["drone"] for p in pending) == ["D1", "D2", "D3"]


def test_flying_drones_other_than_the_best_are_not_retasked(spread) -> None:
    store, mid, _ = spread
    _fleet(store, mid, _drone("D1"), _drone("D2", "flying", "L900"), _drone("D3", "flying", "L901"))
    out = loop._replan(store, mid, "After a clue.")
    retasks = [p for p in out if p.kind == "retask_drone"]
    assert len(retasks) <= 1 and "D1" in [d for d, _ in _legs(out)]  # the idle one always
    assert len(out) <= 2


def _leg(id_: str, drone: str, sector: str, status: str = "flying") -> Leg:
    return Leg(id=id_, drone_id=drone, sector_id=sector, waypoints=[], altitude_m=50,
               est_minutes=8, expected_clearance=0.1, score_per_min=0.01, reason="r",
               status=status)  # fmt: skip


def test_a_drone_over_the_best_sector_is_not_retasked_away(spread) -> None:
    store, mid, _ = spread
    store.put_fleet(
        mid,
        FleetState(
            simulated=True,
            drones=[_drone("D1", "flying", "L900")],
            legs=[_leg("L900", "D1", "B2")],
            updated_at=NOW,
        ),
    )
    assert loop._replan(store, mid, "After a clue in B2.") == []  # B2 is taken, and the best


def test_legs_done_one_after_another_get_different_sectors(spread) -> None:
    store, mid, _ = spread
    legs = [_leg(f"L90{i}", f"D{i}", s, "done") for i, s in ((1, "A1"), (2, "A2"), (3, "A3"))]
    _fleet(store, mid, _drone("D1"), _drone("D2"), _drone("D3"))
    store.put_fleet(mid, store.state(mid)["fleet"].model_copy(update={"legs": legs}))
    out = [p for leg in legs for p in _handle(store, mid, "leg_done", leg.id)]
    assert len({p.leg.sector_id for p in out}) == 3  # each pending proposal counts as taken


def test_a_sector_searched_at_a_pod_steps_the_map_and_replans(spread) -> None:
    store, mid, layout = spread
    _fleet(store, mid, _drone("D1"), _drone("D2"))
    hooks = Hooks()
    task = SectorTask(sector_id="B2", state="assigned", team_id="T1", poa=0.4, pod=None,
                      note=None, updated_at=NOW)  # fmt: skip
    effects.on_task_update(store, mid, task, hooks)
    assert hooks.calls == []  # assigned: no evidence yet
    for state in ("in_progress", "searched"):
        task = task.model_copy(update={"state": state, "pod": 0.8 if state == "searched" else None})
        effects.on_task_update(store, mid, task, hooks)
    assert hooks.calls == [("on_task_searched", "B2")]
    live = store.live(mid)  # the fake store logs map updates without applying them
    live.apply(live.ground_update([int(i) for i in layout.cells_of("B2")], 0.8, "B2"))
    out = _handle(store, mid, "task_searched", "B2")
    assert len(out) == 2 and "Team One searched sector B2 at POD 80%" in out[0].reason
    assert "clear" not in " ".join(p.reason for p in out).lower()
    # B2 held 0.4 before; after the team's step at POD 0.8 B3 is the better first leg
    assert out[0].leg.sector_id == "B3"


def test_a_sector_a_team_is_on_is_discounted_for_drones(spread) -> None:
    store, mid, _ = spread
    _fleet(store, mid, _drone("D1"))
    store.upsert_task(
        mid,
        SectorTask(
            sector_id="B2",
            state="in_progress",
            team_id="T1",
            poa=0.4,
            pod=None,
            note=None,
            updated_at=NOW,
        ),
    )
    (p,) = loop._replan(store, mid, "x")
    assert p.leg.sector_id == "B3"  # 0.4 × 0.5 < 0.3


def test_a_team_position_assigns_that_team_and_fills_idle_drones_once(spread) -> None:
    store, mid, _ = spread
    _fleet(store, mid, _drone("D1"), _drone("D2", "flying", "L900"))
    hooks = Hooks()
    t1 = store.state(mid)["teams"][0]
    effects.on_team_update(store, mid, t1.model_copy(update={"note": "radio check"}), hooks)
    assert hooks.calls == []  # no position: nothing to re-plan
    moved = t1.model_copy(update={"position": LatLon(lat=LKP.lat - 0.001, lon=LKP.lon)})
    effects.on_team_update(store, mid, moved, hooks)
    effects.on_team_update(store, mid, moved, hooks)  # same position again: no second hook
    assert hooks.calls == [("on_team_position", "T1")]
    out = _handle(store, mid, "team_position", "T1")
    assert [p.kind for p in out] == ["assign_sector", "drone_leg"]
    assert out[0].target["team"] == "T1" and out[1].target["drone"] == "D1"  # D2 is flying
    assert _handle(store, mid, "team_position", "T1") == []  # both already pending


def test_the_fleet_joining_gets_opening_legs(spread) -> None:
    store, mid, _ = spread
    hooks = Hooks()
    t = FleetTelemetry(drones=[_drone("D1"), _drone("D2"), _drone("D3")], leg_status={}, at=NOW)
    effects.on_fleet(store, mid, t, hooks)
    assert hooks.calls == [("on_fleet_join",)]
    out = _handle(store, mid, "fleet_join", mid)
    assert [p.kind for p in out] == ["drone_leg"] * 3
    assert len({p.leg.sector_id for p in out}) == 3 and out[0].created_by == "planner"
    assert "opening legs" in out[0].reason
    effects.on_fleet(store, mid, t, hooks)  # telemetry after the join: no second opening
    assert hooks.calls == [("on_fleet_join",)]
    assert _handle(store, mid, "fleet_join", mid) == []  # already pending: nothing new


def test_no_opening_legs_when_it_is_not_flyable(spread) -> None:
    store, mid, _ = spread
    store.put_conditions(mid, _conditions(flyable=False))
    _fleet(store, mid, _drone("D1"))
    assert _handle(store, mid, "fleet_join", mid) == []
