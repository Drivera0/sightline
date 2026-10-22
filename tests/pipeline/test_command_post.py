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
