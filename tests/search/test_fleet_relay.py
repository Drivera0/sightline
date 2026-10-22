"""Drones relay for a cut-off ground team (simulated, Pulse's relay pattern): the drone near a team
with no signal carries its check-in to the mission, directly, through a neighbouring drone, or once
its own link is back; the team moves on the map and the feed says who carried it and how old it is."""

from __future__ import annotations

import re

from sightline.search.fleet import FleetSim, Scenario, relay_route, relay_summary
from tests.search import test_fleet as tf
from tests.search.test_fleet import HIDDEN, Pool, _leg_over_hidden, _scenario

world = tf.world  # the fleet tests' API fixture


def test_relay_route_direct_through_a_neighbour_or_carried() -> None:
    team = (0.0, 0.0)
    drones = {"D1": (500.0, 0.0), "D3": (100.0, 0.0)}
    assert relay_route(team, drones, {}, 300) == (["D3"], True)
    assert relay_route(team, drones, {"D3": "lost"}, 300) == (["D3", "D1"], True)  # 400 m apart
    assert relay_route(team, drones, {"D3": "lost"}, 300, mesh_radius_m=200) == (["D3"], False)
    assert relay_route(team, drones, {}, 50) is None
    # the nearest hearer that reaches the ground station in the fewest hops
    assert relay_route(team, {"D2": (50.0, 0.0), "D3": (100.0, 0.0)}, {"D2": "lost"}, 300) == (["D3"], True)  # fmt: skip


def _team_scenario(no_signal: bool = True) -> Scenario:
    one = _scenario()
    team = {"id": "T2", "callsign": "Team Two", "members": 3, "no_signal": no_signal,
            "position": HIDDEN.model_dump()}  # fmt: skip
    return Scenario(name="t", lkp=one.lkp, drones=one.drones, hidden=HIDDEN, positive={}, clue=None,
                    teams=(team,), relay_radius_m=100.0)  # fmt: skip


def test_a_drone_near_a_cut_off_team_relays_its_position(world) -> None:
    http, _, store, _, mid, _bodies, tmp = world
    lines: list[str] = []
    sim = FleetSim(http, mid, _team_scenario(), time_scale=10.0, pool=Pool(tmp), out=lines.append, links=())  # fmt: skip
    sim.register()
    t2 = next(t for t in store.state(mid)["teams"] if t.id == "T2")
    assert t2.callsign == "Team Two"  # the mission's own roster has T2; join_teams keeps it
    _leg_over_hidden(store, mid)
    for _ in range(40):
        sim.tick(1.0)
    assert sim.gcs.relays, lines
    r = sim.gcs.relays[0]
    assert r["via"] == ["D1"] and r["hops"] == 1 and r["team_id"] == "T2"
    notes = [e.summary for e in store.events(mid) if e.type == "mission.note"]
    assert any(
        re.fullmatch(r"Team Two heard via D1, \d+ s old \(simulated relay\)", n) for n in notes
    )
    assert any("T2 has no signal (simulated link model)" in n for n in notes)
    team = next(t for t in store.state(mid)["teams"] if t.id == "T2")
    assert team.position_at == sim.gcs.relays[-1]["heard_at"]
    links = http.get(f"/missions/{mid}/fleet/links").json()
    assert links["teams"]["T2"]["link"] == "no_signal"
    assert links["teams"]["T2"]["relay"]["via"] == ["D1"]


def test_a_check_in_heard_by_a_lost_drone_arrives_when_its_link_is_back(world) -> None:
    http, _, store, _, mid, _bodies, tmp = world
    sim = FleetSim(http, mid, _team_scenario(), time_scale=10.0, pool=Pool(tmp), out=lambda s: None, links=())  # fmt: skip
    sim.register()
    _leg_over_hidden(store, mid)
    sim.set_link("D1", "lost")
    for _ in range(40):
        sim.tick(1.0)
    assert sim.gcs.relays == [] and "T2" in sim.gcs._carried
    _drone, heard = sim.gcs._carried["T2"]
    sim.set_link("D1", "connected")
    sim.tick(1.0)
    r = sim.gcs.relays[0]
    assert r["via"] == ["D1"] and r["age_s"] >= sim.sim_s - heard - 1 > 0


def test_teams_with_signal_need_no_relay(world) -> None:
    http, _, store, _, mid, _bodies, tmp = world
    sim = FleetSim(http, mid, _team_scenario(no_signal=False), time_scale=10.0, pool=Pool(tmp), out=lambda s: None, links=())  # fmt: skip
    sim.register()
    _leg_over_hidden(store, mid)
    for _ in range(40):
        sim.tick(1.0)
    assert sim.gcs.relays == []


def test_relay_for_an_unknown_team_is_404(world) -> None:
    http, *_, mid, _bodies, _tmp = world
    body = {"team_id": "T9", "via": ["D1"], "hops": 1, "heard_at": "2026-10-24T21:00:00Z", "age_s": 40, "lat": 49.0, "lon": -122.0}  # fmt: skip
    assert http.post(f"/missions/{mid}/fleet/relay", json=body).status_code == 404


def test_relay_line() -> None:
    line = relay_summary({"team_id": "T2", "callsign": "Team Two", "via": ["D3"], "age_s": 40})
    assert line == "Team Two heard via D3, 40 s old (simulated relay)"
    line = relay_summary({"team_id": "T2", "via": ["D3", "D1"], "age_s": 200})
    assert line == "T2 heard via D3 then D1, 3 min old (simulated relay)"


def test_a_scenario_team_the_mission_lacks_joins_its_roster(world) -> None:
    http, _, store, _, mid, _bodies, tmp = world
    scn = _team_scenario()
    team = {**scn.teams[0], "id": "T7", "callsign": "Team Seven"}
    scn = Scenario(name="t", lkp=scn.lkp, drones=scn.drones, hidden=HIDDEN, positive={},
                   clue=None, teams=(team,))  # fmt: skip
    FleetSim(http, mid, scn, pool=Pool(tmp), out=lambda s: None, links=()).register()
    t7 = next(t for t in store.state(mid)["teams"] if t.id == "T7")
    assert t7.callsign == "Team Seven" and "simulated" in (t7.note or "")
