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


# --- direct actions -----------------------------------------------------------------------------


def _task(store, mid, sid):
    return next(t for t in store.state(mid)["tasks"] if t.sector_id == sid)


def _decisions(store, mid):
    return [
        e.output for e in store.trace_entries(mid) if e.kind == "decision" and e.actor == "human"
    ]


def test_direct_actions_need_the_write_token(api) -> None:
    client, _, _ = api
    mid = mission(client)
    for path, body in (("teams/T1/assign", {"sector": "B2"}), ("teams/T1/call", {"text": "radio check"}),
                       ("teams/T1/recall", {}), ("sectors/B2/searched", {"pod": 0.5}),
                       ("sectors/B2/recheck", {})):  # fmt: skip
        assert client.post(f"/missions/{mid}/{path}", json=body).status_code == 401


def test_assign_without_the_agent_supersedes_its_pending_proposal_and_logs_a_decision(api) -> None:
    from sightline.agent import loop

    client, store, _ = api
    mid = mission(client)
    (p, *_) = loop.handle("tick", store, mid, mid, client=None)  # the agent's assignment proposals
    team = p.target["team"]
    r = client.post(f"/missions/{mid}/teams/{team}/assign", headers=AUTH,
                    json={"sector": "A1", "reason": "the trail fork", "by": "Dana"})  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["action"] == "assign" and p.id in r.json()["superseded"]
    assert _task(store, mid, "A1").state == "assigned" and _task(store, mid, "A1").team_id == team
    t = next(t for t in store.state(mid)["teams"] if t.id == team)
    assert t.status == "assigned" and t.eta_min is not None
    assert next(x for x in store.state(mid)["proposals"] if x.id == p.id).status == "superseded"
    assert _decisions(store, mid)[-1] == {**r.json()}
    ev = [e for e in store.events(mid) if (e.data or {}).get("decision")][-1]
    assert ev.summary == f"{t.callsign} assigned to sector A1 (by Dana)"
    # a second assignment moves the team: A1 goes back on the board, with why
    client.post(f"/missions/{mid}/teams/{team}/assign", headers=AUTH, json={"sector": "B1"})
    assert (
        _task(store, mid, "A1").state == "proposed"
        and "reassigned to B1" in _task(store, mid, "A1").note
    )
    assert (
        client.post(
            f"/missions/{mid}/teams/T9/assign", headers=AUTH, json={"sector": "B1"}
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/missions/{mid}/teams/T1/assign", headers=AUTH, json={"sector": "Z9"}
        ).status_code
        == 404
    )


def test_searched_lowers_the_map_by_the_pod_and_recheck_puts_it_back_on_the_board(api) -> None:
    client, store, hooks = api
    mid = mission(client)
    from sightline.mission.effects import _layout

    client.post(f"/missions/{mid}/teams/T2/assign", headers=AUTH, json={"sector": "B3"})
    before = store.live(mid).sector_poa(_layout(store, mid))["B3"]
    r = client.post(
        f"/missions/{mid}/sectors/B3/searched",
        headers=AUTH,
        json={"pod": 0.6, "note": "dense salal"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["map"]["source"] == "ground"
    after = store.live(mid).sector_poa(_layout(store, mid))["B3"]
    assert 0 < after < before  # lowered, never removed
    task = _task(store, mid, "B3")
    assert task.state == "searched" and task.pod == 0.6 and task.team_id == "T2"
    assert next(t for t in store.state(mid)["teams"] if t.id == "T2").status == "standby"
    assert ("on_task_searched", "B3") in hooks.calls
    assert _decisions(store, mid)[-1]["action"] == "searched"
    again = client.post(f"/missions/{mid}/sectors/B3/searched", headers=AUTH, json={"pod": 0.5})
    assert again.status_code == 409
    assert (
        client.post(
            f"/missions/{mid}/sectors/B3/searched", headers=AUTH, json={"pod": 0.95}
        ).status_code
        == 422
    )
    r = client.post(
        f"/missions/{mid}/sectors/B3/recheck", headers=AUTH, json={"reason": "new clue"}
    )
    assert r.status_code == 200 and _task(store, mid, "B3").state == "proposed"
    assert (
        client.post(f"/missions/{mid}/sectors/B3/recheck", headers=AUTH, json={}).status_code == 409
    )
    # a sector nobody was assigned to can be marked searched directly
    assert (
        client.post(
            f"/missions/{mid}/sectors/A4/searched", headers=AUTH, json={"pod": 0.3}
        ).status_code
        == 200
    )


def test_recall_brings_the_team_back_with_the_eta_to_base_camp(api) -> None:
    client, store, _ = api
    mid = mission(client)
    client.post(f"/missions/{mid}/teams/T3/assign", headers=AUTH, json={"sector": "D4"})
    client.patch(
        f"/missions/{mid}/teams/T3",
        headers=AUTH,
        json={"position": {"lat": 49.3665, "lon": -122.94}},
    )
    r = client.post(f"/missions/{mid}/teams/T3/recall", headers=AUTH, json={"reason": "dusk"})
    assert r.status_code == 200
    t = next(t for t in store.state(mid)["teams"] if t.id == "T3")
    assert t.status == "returning" and t.eta_min > 0 and r.json()["eta_min"] == t.eta_min
    assert _task(store, mid, "D4").state == "proposed"


def test_call_speaks_through_the_desk_and_returns_the_turn_id(api, tmp_path) -> None:
    client, store, _ = api
    mid = mission(client)
    r = client.post(f"/missions/{mid}/teams/T2/call", headers=AUTH,
                    json={"text": "Team Two, Sightline. Report your position, over.", "by": "Dana"})  # fmt: skip
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["reply"] == "Team Two, Sightline. Report your position, over."  # no double call-up
    (ev,) = [e for e in store.events(mid) if e.type == "radio.turn"]
    assert (
        ev.ref == body["turn_id"] and ev.data["direction"] == "out" and ev.data["callsign"] == "T2"
    )
    assert _decisions(store, mid)[-1]["turn_id"] == body["turn_id"]
    assert (
        client.post(f"/missions/{mid}/teams/T9/call", headers=AUTH, json={"text": "x"}).status_code
        == 404
    )


def test_call_with_the_radio_desk_mounted_returns_audio(tmp_path) -> None:
    store = MissionStore(tmp_path / "missions")
    ctx = MissionContext(store, queue=LocalQueue(), detector_factory=lambda: None, hooks=None)
    ctx.start()
    app = create_app(cache_root=tmp_path / "c", data_root=tmp_path / "u", missions=ctx, radio="text",
                     rate_limit=None)  # fmt: skip
    with TestClient(app) as client:
        mid = client.post("/missions", json={"name": "S", "area_name": "A", "lkp": LKP}).json()[
            "mission_id"
        ]
        r = client.post(
            f"/missions/{mid}/teams/T1/call", json={"text": "radio check", "reply_to": "r0003"}
        )
        assert r.status_code == 200, r.text
        assert r.json()["audio_chunks"] and r.json()["turn_id"].startswith("r")
        app.state.radio.wait()
    ctx.queue.stop()


def test_direct_actions_are_in_the_ics_214_beside_the_approvals(api) -> None:
    client, _store, _ = api
    mid = mission(client)
    client.post(
        f"/missions/{mid}/teams/T2/assign", headers=AUTH, json={"sector": "B3", "by": "Dana"}
    )
    client.post(
        f"/missions/{mid}/sectors/B3/searched", headers=AUTH, json={"pod": 0.5, "by": "Dana"}
    )
    md = client.get(f"/missions/{mid}/ics214.md").text
    assert "Direct action: Team Two assigned to sector B3" in md
    assert "Direct action: Sector B3 searched at POD 50%" in md


# --- one timeline -------------------------------------------------------------------------------

DRONE = {"id": "D1", "name": "Drone 1", "simulated": True, "position": LKP, "altitude_m": 50,
         "speed_ms": 8, "battery_pct": 60, "max_wind_kmh": 43.2, "status": "idle", "leg_id": None}  # fmt: skip


def _busy_mission(client: TestClient, store: MissionStore) -> str:
    """A mission with one of everything the timeline shows."""
    from sightline.contract import Leg, Proposal, RadioTurn
    from sightline.radio.mount import StoreMissionApi

    mid = mission(client)
    StoreMissionApi(store).record_turn(mid, RadioTurn(
        id="r0001", direction="in", callsign="T2", transcript="Sightline, Team Two, at the creek, over.",
        reply="Team Two, Sightline. Copy, over.", audio=None, state="answered", actions=[], asr_ms=None,
        llm_ms=None, tts_ms=None, at="2026-10-24T21:00:00Z"))  # fmt: skip
    client.post(f"/missions/{mid}/clues", headers=AUTH, json={
        "kind": "object", "text": "blue water bottle", "lat": LKP["lat"] - 0.001, "lon": LKP["lon"],
        "reported_by": "T2", "source": "form"})  # fmt: skip
    client.post(
        f"/missions/{mid}/teams/T1/assign", headers=AUTH, json={"sector": "C2", "by": "Dana"}
    )
    client.post(
        f"/missions/{mid}/teams/T1/call", headers=AUTH, json={"text": "start C2 from the east"}
    )
    client.patch(
        f"/missions/{mid}/teams/T1",
        headers=AUTH,
        json={"position": {"lat": 49.371, "lon": -122.943}},
    )
    client.put(
        f"/missions/{mid}/fleet",
        headers=AUTH,
        json={"drones": [DRONE], "leg_status": {}, "at": "x"},
    )
    leg = Leg(id="L001", drone_id="D1", sector_id="B2", waypoints=[(-122.946, 49.371), (-122.947, 49.371)],
              altitude_m=50, est_minutes=5, expected_clearance=0.02, score_per_min=0.004, reason="r",
              status="proposed")  # fmt: skip
    p = store.add_proposal(mid, Proposal(
        id="", kind="drone_leg", summary="Send Drone 1 to sector B2", reason="r", briefing=None,
        target={"drone": "D1", "leg": "L001"}, leg=leg, evidence=[], status="pending", created_by="planner",
        created_at="t", decided_at=None, decided_by=None, decision_reason=None, edits=None))  # fmt: skip
    client.post(
        f"/missions/{mid}/proposals/{p.id}/decide",
        headers=AUTH,
        json={"decision": "approve", "by": "Dana"},
    )
    flying = {**DRONE, "status": "flying", "battery_pct": 45}
    client.put(
        f"/missions/{mid}/fleet",
        headers=AUTH,
        json={"drones": [flying], "leg_status": {"L001": "flying"}, "at": "y"},
    )
    client.put(
        f"/missions/{mid}/fleet",
        headers=AUTH,
        json={"drones": [flying], "leg_status": {"L001": "done"}, "at": "z"},
    )
    client.post(
        f"/missions/{mid}/fleet/link",
        headers=AUTH,
        json={"target": "D1", "link": "lost", "report": True},
    )
    client.post(f"/missions/{mid}/fleet/relay", headers=AUTH, json={
        "team_id": "T3", "via": ["D1"], "hops": 1, "heard_at": "2026-10-24T21:10:00Z", "age_s": 30,
        "lat": 49.369, "lon": -122.944})  # fmt: skip
    client.post(
        f"/missions/{mid}/found", headers=AUTH, json={"team": "T1", "sector": "C2", "by": "Dana"}
    )
    return mid


def test_the_timeline_has_every_kind_with_its_team_drone_and_sector(api) -> None:
    client, store, _ = api
    mid = _busy_mission(client, store)
    lines = client.get(f"/missions/{mid}/events?format=json").json()
    kinds = {"radio", "clue", "decision", "checkin", "drone", "found"}  # detections: the next test
    assert {x["kind"] for x in lines} == kinds
    radio = [x for x in lines if x["kind"] == "radio"]
    assert [(x["direction"], x["team"]) for x in radio] == [
        ("in", "T2"),
        ("out", "T2"),
        ("out", "T1"),
    ]
    assert radio[0]["turn_id"] == "r0001" and radio[1]["id"].endswith("-reply")
    (clue,) = [x for x in lines if x["kind"] == "clue"]
    assert (
        clue["team"] == "T2"
        and clue["sector"] is not None
        and clue["text"] == "object: blue water bottle"
    )
    decisions = [x for x in lines if x["kind"] == "decision"]
    assert (
        decisions[0]["text"] == "Team One assigned to sector C2 (by Dana)"
        and decisions[0]["by"] == "Dana"
    )
    assert any(
        x["text"].startswith("Dana approved planner p") and x["drone"] == "D1" for x in decisions
    )
    drone = [x["text"] for x in lines if x["kind"] == "drone"]
    assert any("leg L001 (sector B2) started" in t for t in drone) and any(
        "battery 45 %" in t for t in drone
    )
    assert any("link lost" in t for t in drone) and any("approved for Drone 1" in t for t in drone)
    checkins = [x for x in lines if x["kind"] == "checkin"]
    assert {x["team"] for x in checkins} == {"T1", "T3"}
    assert next(x for x in checkins if x["team"] == "T3")["drone"] == "D1"
    (found,) = [x for x in lines if x["kind"] == "found"]
    assert found["team"] == "T1" and found["sector"] == "C2" and found["by"] == "Dana"
    # Accept: application/json gets the same list; after= keeps the newer lines only
    assert (
        client.get(f"/missions/{mid}/events", headers={"Accept": "application/json"}).json()
        == lines
    )
    last = lines[-2]["id"].split("-")[0]
    assert client.get(f"/missions/{mid}/events?format=json&after={last}").json() == [lines[-1]]


def test_detections_and_second_looks_are_timeline_lines(api) -> None:
    from sightline.contract import MissionEvent
    from sightline.mission.timeline import entries

    ev = MissionEvent(id="e00009", type="detection.new", at="t", summary="candidate f0001-d01 (0.80)",
                      ref="f0001-d01", data={"lat": 49.37, "lon": -122.945})  # fmt: skip
    (x,) = entries(ev, [], lambda lat, lon: "C2")
    assert x.kind == "detection" and x.sector == "C2" and x.refs == ["f0001-d01"]
    v = MissionEvent(id="e00010", type="verdict", at="t", summary="second look on f0001-d01: yes",
                     ref="f0001-d01", data={"id": "v0001"})  # fmt: skip
    assert entries(v)[0].kind == "detection"
    assert (
        entries(MissionEvent(id="e1", type="map.updated", at="t", summary="m", ref=None, data={}))
        == []
    )


def test_the_event_stream_sends_each_events_timeline_lines_after_it() -> None:
    import asyncio

    from sightline.api.sse import event_stream
    from sightline.contract import MissionEvent
    from sightline.mission.timeline import entries

    evs = [MissionEvent(id="e00001", type="clue.added", at="t", summary="s", ref="c001",
                        data={"kind": "object", "text": "glove", "reported_by": "T1"}),
           MissionEvent(id="e00002", type="map.updated", at="t", summary="m", ref=None, data=None)]  # fmt: skip

    async def gen():
        for e in evs:
            yield e

    async def collect():
        return [x async for x in event_stream(gen(), timeline=lambda ev: entries(ev))]

    out = asyncio.run(collect())
    assert [x.split("\n")[0] for x in out] == [
        "event: clue.added",
        "event: timeline",
        "event: map.updated",
    ]
    assert out[1].split("\n")[1] == "id: e00001" and '"kind":"clue"' in out[1]
