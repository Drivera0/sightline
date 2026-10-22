"""The command post's contract additions (docs/01_CONTRACT.md §15, v1.3): base camp, the found state,
last heard and overdue teams, direct actions, the one timeline, ICS 309 and the D4H log push. Fakes
only: no model, no network."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sightline.api.app import create_app
from sightline.api.missions import MissionContext
from sightline.mission import MissionStore
from sightline.mission.queue import LocalQueue
from tests.fixtures.drone_photos import LKP

TOKEN = "secret-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
CAMP = {"lat": 49.3731, "lon": -122.9493, "name": "Trailhead lot"}


class Hooks:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def __getattr__(self, name: str):
        if not name.startswith("on_"):
            raise AttributeError(name)
        return lambda store, mid, *args: self.calls.append((name, *args))


@pytest.fixture
def api(tmp_path: Path):
    store = MissionStore(tmp_path / "missions")
    hooks = Hooks()
    ctx = MissionContext(store, queue=LocalQueue(), detector_factory=lambda: None, hooks=hooks)
    ctx.start()
    app = create_app(cache_root=tmp_path / "c", data_root=tmp_path / "u", missions=ctx,
                     api_token=TOKEN, rate_limit=None)  # fmt: skip
    with TestClient(app) as client:
        yield client, store, hooks
    ctx.queue.stop()


def mission(client: TestClient, **extra) -> str:
    body = {"name": "Seymour", "area_name": "Mount Seymour", "lkp": LKP, **extra}
    r = client.post("/missions", json=body, headers=AUTH)
    assert r.status_code == 201, r.text
    return r.json()["mission_id"]


# --- base camp ---------------------------------------------------------------------------------


def test_base_camp_is_set_on_create_and_teams_stage_there(api) -> None:
    client, _store, _ = api
    mid = mission(client, base_camp=CAMP)
    m = client.get(f"/missions/{mid}/state").json()
    assert m["mission"]["base_camp"] == CAMP
    assert m["mission"]["contract_version"] == "1.3"
    assert {(t["position"]["lat"], t["position"]["lon"]) for t in m["teams"]} == {
        (CAMP["lat"], CAMP["lon"])
    }
    assert all(t.get("last_heard_at") is None for t in m["teams"])  # staged, not heard


def test_base_camp_defaults_to_the_last_known_point(api) -> None:
    client, _, _ = api
    mid = mission(client)
    camp = client.get(f"/missions/{mid}/state").json()["mission"]["base_camp"]
    assert (camp["lat"], camp["lon"]) == (LKP["lat"], LKP["lon"])
    assert "last known point" in camp["name"]


def test_drones_get_the_base_camp_as_home_when_they_join(api) -> None:
    client, store, _ = api
    mid = mission(client, base_camp=CAMP)
    drone = {"id": "D1", "name": "Drone 1", "simulated": True, "position": LKP, "altitude_m": 50,
             "speed_ms": 8, "battery_pct": 100, "max_wind_kmh": 43.2, "status": "idle", "leg_id": None}  # fmt: skip
    r = client.put(f"/missions/{mid}/fleet", json={"drones": [drone], "leg_status": {}, "at": "2026-10-24T21:00:00Z"},
                   headers=AUTH)  # fmt: skip
    assert r.status_code == 200, r.text
    home = store.state(mid)["fleet"].drones[0].home
    assert (home.lat, home.lon) == (CAMP["lat"], CAMP["lon"])
    # telemetry without a home keeps the one the mission gave it
    client.put(f"/missions/{mid}/fleet", json={"drones": [drone], "leg_status": {}, "at": "2026-10-24T21:00:10Z"},
               headers=AUTH)  # fmt: skip
    assert store.state(mid)["fleet"].drones[0].home == home

    from sightline.agent.loop import _launch_point

    assert _launch_point(store, mid, "D1") == home


def test_a_simulated_drone_flies_home_to_its_home_not_where_it_started() -> None:
    from sightline.contract import Drone, LatLon
    from sightline.search.fleet import DroneSim, Scenario, _to_m

    lkp = LatLon(lat=49.37, lon=-122.945)
    camp = LatLon(lat=49.373, lon=-122.949)
    d = Drone(id="D1", name="Drone 1", simulated=True, position=lkp, altitude_m=50, speed_ms=8,
              battery_pct=100, max_wind_kmh=43.2, status="idle", leg_id=None, home=camp)  # fmt: skip
    scn = Scenario(name="t", lkp=lkp, drones=[d], hidden=lkp, positive={}, clue=None)
    sim = DroneSim(d, None, "m", scn, pool=None)  # type: ignore[arg-type]
    assert sim.home == _to_m(lkp, camp.lon, camp.lat)
    scn2 = Scenario(
        name="t", lkp=lkp, drones=[d], hidden=lkp, positive={}, clue=None, base_camp=camp
    )
    sim2 = DroneSim(d.model_copy(update={"home": None}), None, "m", scn2, pool=None)  # type: ignore[arg-type]
    assert sim2.home == _to_m(lkp, camp.lon, camp.lat)


# --- found -------------------------------------------------------------------------------------


def test_found_sets_the_status_at_the_sectors_likeliest_cell_and_freezes_proposals(api) -> None:
    client, store, _ = api
    mid = mission(client)
    assert (
        client.post(f"/missions/{mid}/found", json={"team": "T1", "sector": "C2"}).status_code
        == 401
    )
    r = client.post(f"/missions/{mid}/found", json={"team": "T1", "sector": "C2", "by": "Dana"},
                    headers=AUTH)  # fmt: skip
    assert r.status_code == 200, r.text
    m = r.json()
    assert m["status"] == "found" and m["found"]["team"] == "T1" and m["found"]["sector"] == "C2"
    from sightline.mission.command import likeliest_cell, sector_of

    cell = likeliest_cell(store, mid, "C2")
    assert (m["found"]["lat"], m["found"]["lon"]) == (round(cell.lat, 6), round(cell.lon, 6))
    assert sector_of(store, mid, cell.lat, cell.lon) == "C2"
    (e,) = [e for e in store.trace_entries(mid) if e.kind == "decision"]
    assert e.actor == "human" and e.output["action"] == "found" and e.output["by"] == "Dana"
    (ev,) = [e for e in store.events(mid) if e.data and e.data.get("found")]
    assert ev.data["found"]["team"] == "T1"
    # the agent proposes nothing new once found, and says so in the trace
    from sightline.agent import loop

    assert loop.handle("tick", store, mid, mid, client=None) == []
    assert "Mission found: no new proposals" in store.trace_entries(mid)[-1].summary
    again = client.post(f"/missions/{mid}/found", json={"team": "T1", "sector": "C2"}, headers=AUTH)
    assert again.status_code == 409


def test_found_with_a_position_finds_its_sector_and_refuses_unknown_teams(api) -> None:
    client, store, _ = api
    mid = mission(client)
    from sightline.mission.command import likeliest_cell

    p = likeliest_cell(store, mid, "B3")
    assert client.post(f"/missions/{mid}/found", json={"team": "T9", "sector": "B3"},
                       headers=AUTH).status_code == 404  # fmt: skip
    r = client.post(f"/missions/{mid}/found", json={"team": "T2", "lat": p.lat, "lon": p.lon},
                    headers=AUTH)  # fmt: skip
    assert r.json()["found"]["sector"] == "B3"


# --- last heard, ETA, overdue --------------------------------------------------------------------


def _team(store, mid, tid):
    return next(t for t in store.state(mid)["teams"] if t.id == tid)


def test_last_heard_moves_with_a_position_report_a_clue_a_radio_turn_and_a_relay(api) -> None:
    from sightline.contract import RadioTurn
    from sightline.radio.mount import StoreMissionApi

    client, store, _ = api
    mid = mission(client)
    r = client.patch(f"/missions/{mid}/teams/T2", headers=AUTH, json={
        "position": {"lat": 49.371, "lon": -122.946}, "position_at": "2026-10-24T21:00:00Z"})  # fmt: skip
    assert r.status_code == 200
    assert _team(store, mid, "T2").last_heard_at == "2026-10-24T21:00:00Z"
    checkins = [e for e in store.events(mid) if (e.data or {}).get("checkin")]
    assert checkins[-1].data["checkin"]["how"] == "position report"

    clue = {"kind": "object", "text": "glove", "lat": 49.371, "lon": -122.946,
            "reported_by": "T3", "source": "form"}  # fmt: skip
    assert client.post(f"/missions/{mid}/clues", json=clue, headers=AUTH).status_code == 201
    assert _team(store, mid, "T3").last_heard_at is not None

    turn = RadioTurn(id="r0001", direction="in", callsign="Team Four", transcript="Sightline, Team Four, radio check",
                     reply="Team Four, Sightline. Loud and clear.", audio=None, state="answered", actions=[],
                     asr_ms=None, llm_ms=None, tts_ms=None, at="2026-10-24T21:05:00Z")  # fmt: skip
    StoreMissionApi(store).record_turn(mid, turn)
    assert _team(store, mid, "T4").last_heard_at == "2026-10-24T21:05:00Z"

    relay = {"team_id": "T1", "via": ["D3"], "hops": 1, "heard_at": "2026-10-24T21:06:00Z",
             "age_s": 40, "lat": 49.372, "lon": -122.944}  # fmt: skip
    assert client.post(f"/missions/{mid}/fleet/relay", json=relay, headers=AUTH).status_code == 200
    assert _team(store, mid, "T1").last_heard_at == "2026-10-24T21:06:00Z"
    # an older report never moves it back
    from sightline.mission.command import heard

    heard(store, mid, "T1", "2026-10-24T20:00:00Z", None)
    assert _team(store, mid, "T1").last_heard_at == "2026-10-24T21:06:00Z"


def test_an_approved_assignment_carries_the_walking_eta(api) -> None:
    from sightline.contract import Proposal
    from sightline.mission import effects
    from sightline.mission.command import eta_to

    client, store, _ = api
    mid = mission(client)
    p = store.add_proposal(mid, Proposal(
        id="", kind="assign_sector", summary="Assign sector C2 to Team One", reason="r", briefing=None,
        target={"team": "T1", "sector": "C2"}, evidence=[], status="pending", created_by="agent",
        created_at="2026-10-24T21:00:00Z", decided_at=None, decided_by=None, decision_reason=None,
        edits=None))  # fmt: skip
    p = store.decide_proposal(mid, p.id, "approve", "Dana")
    effects.on_decision(store, mid, p)
    t = _team(store, mid, "T1")
    assert t.status == "assigned" and t.eta_min == eta_to(store, mid, t, "C2") and t.eta_min > 0
    assert eta_to(store, mid, t, None) == 0  # staged at the base camp: no walk back


def test_a_team_out_of_contact_past_the_check_in_interval_goes_overdue_and_comes_back(api) -> None:
    from sightline.mission.command import check_overdue, heard

    client, store, hooks = api
    mid = mission(client)
    t = _team(store, mid, "T3")
    store.upsert_team(
        mid, t.model_copy(update={"status": "searching", "last_heard_at": "2026-10-24T21:00:00Z"})
    )
    assert check_overdue(store, mid, "2026-10-24T21:30:00Z", hooks) == []  # 30 min: not yet
    assert check_overdue(store, mid, "2026-10-24T21:32:00Z", hooks) == ["T3"]
    assert _team(store, mid, "T3").status == "overdue"
    assert ("on_team_overdue", "T3") in hooks.calls
    note = [e for e in store.events(mid) if (e.data or {}).get("checkin", {}).get("overdue")][-1]
    assert note.summary == "Team Three not heard for 32 min (check-in every 30 min)"
    assert check_overdue(store, mid, "2026-10-24T21:40:00Z", hooks) == []  # once
    heard(store, mid, "T3", "2026-10-24T21:41:00Z", None)
    t = _team(store, mid, "T3")
    assert t.status == "searching" and t.last_heard_at == "2026-10-24T21:41:00Z"
    # standby teams at base are never overdue; the interval is the mission's
    store.update_mission(mid, check_in_min=60)
    store.upsert_team(mid, t.model_copy(update={"last_heard_at": "2026-10-24T21:00:00Z"}))
    assert check_overdue(store, mid, "2026-10-24T21:45:00Z", hooks) == []


def test_the_scheduler_checks_for_overdue_teams(api) -> None:
    from sightline.mission.scheduler import Scheduler

    client, store, hooks = api
    mid = mission(client)
    t = _team(store, mid, "T2")
    store.upsert_team(
        mid, t.model_copy(update={"status": "assigned", "last_heard_at": "2000-01-01T00:00:00Z"})
    )
    s = Scheduler(hooks)
    s.store = store
    s.mission_active(mid)
    s.run_once()
    assert _team(store, mid, "T2").status == "overdue"
