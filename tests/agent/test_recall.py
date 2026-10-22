"""The recall moment on the real store and API: gusts over the fleet's limit → the agent proposes a
recall for each flying drone → a person approves → the store cancels the drone's leg and approves
the home leg (the re-task path), and the feed says so. The agent is called directly (no runner
thread), so every step is deterministic."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sightline.agent import loop
from sightline.api.app import create_app
from sightline.api.missions import MissionContext
from sightline.contract import Conditions
from sightline.mission import MissionStore
from sightline.mission.queue import LocalQueue
from tests.fixtures.drone_photos import LKP

AT = "2026-10-24T20:05:00Z"
DRONE = {"id": "D2", "name": "Drone 2", "simulated": True, "position": {"lat": 49.3762, "lon": -122.9389},
         "altitude_m": 50.0, "speed_ms": 8.0, "battery_pct": 81.0, "max_wind_kmh": 43.2, "status": "idle",
         "leg_id": None}  # fmt: skip


@pytest.fixture(autouse=True)
def _fresh_agent_memory():
    loop._last_conditions.clear()
    loop._recalled.clear()


@pytest.fixture
def api(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # no first lookup in the background: it would race the conditions each test puts in
    monkeypatch.setattr("sightline.api.missions._first_conditions", lambda ctx, mid: None)
    store = MissionStore(tmp_path / "missions")
    ctx = MissionContext(store, queue=LocalQueue(), hooks=None)
    app = create_app(cache_root=tmp_path / "cache", data_root=tmp_path / "up", missions=ctx)
    with TestClient(app) as client:
        yield client, store


def _flying(client: TestClient, store: MissionStore) -> tuple[str, str]:
    """A mission whose drone D2 flies an approved leg; returns (mission, leg)."""
    mid = client.post("/missions", json={"name": "Seymour", "area_name": "Mount Seymour", "lkp": LKP}).json()["mission_id"]  # fmt: skip
    tele = {"drones": [DRONE], "leg_status": {}, "at": AT}
    assert client.put(f"/missions/{mid}/fleet", json=tele).status_code == 200
    (p,) = loop.handle("fleet_join", store, mid, mid, client=None)
    client.post(
        f"/missions/{mid}/proposals/{p.id}/decide", json={"decision": "approve", "by": "SM"}
    )
    moved = {**DRONE, "status": "flying", "position": {"lat": 49.377, "lon": -122.936}}
    client.put(
        f"/missions/{mid}/fleet",
        json={"drones": [moved], "leg_status": {p.leg.id: "flying"}, "at": AT},
    )
    return mid, p.leg.id


def _gusts(store: MissionStore, mid: str) -> Conditions:
    c = Conditions(
        fetched_at=AT, stale=False, area="Mount Seymour", sources=["https://weather.gc.ca/x"],
        wind_kmh=30.0, gust_kmh=50.0, wind_dir_deg=None, precip_mm_h=None, precip_prob=None,
        temp_c=None, visibility_km=None, sunset=None, civil_twilight_end=None, alerts=[],
        flyable=False, flyable_until=None,
        flyability_reason="gusts 50 km/h at or above the drones' limit of 43 km/h",
        visibility_factor=1.0, exposure_band=None, exposure_note="",
    )  # fmt: skip
    store.put_conditions(mid, c)
    return c


def test_approving_a_recall_cancels_the_leg_and_flies_home(api) -> None:
    client, store = api
    mid, leg = _flying(client, store)
    _gusts(store, mid)
    (p,) = loop.handle("conditions", store, mid, mid, client=None)
    assert p.kind == "retask_drone" and p.target["home"] == "recall" and p.status == "pending"
    assert "Gusts 50 km/h" in p.reason and "DJI Mavic 3E limit 43 km/h" in p.reason
    # the launch point: where the drone was when the fleet joined
    assert p.leg.waypoints[-1] == (DRONE["position"]["lon"], DRONE["position"]["lat"])
    r = client.post(
        f"/missions/{mid}/proposals/{p.id}/decide", json={"decision": "approve", "by": "SM"}
    )
    assert r.status_code == 200
    fleet = store.state(mid)["fleet"]
    status = {x.id: x.status for x in fleet.legs}
    assert status[leg] == "cancelled" and status[p.leg.id] == "approved"
    assert fleet.drones[0].leg_id == p.leg.id
    note = [
        e for e in store.events(mid) if e.type == "mission.note" and "recalled home" in e.summary
    ]
    assert note and note[0].summary.startswith(f"Drone 2 recalled home ({p.id}): Gusts 50 km/h")


def test_a_rejected_recall_needs_a_reason_and_leaves_the_leg(api) -> None:
    client, store = api
    mid, leg = _flying(client, store)
    _gusts(store, mid)
    (p,) = loop.handle("conditions", store, mid, mid, client=None)
    body = {"decision": "reject", "by": "SM"}
    assert client.post(f"/missions/{mid}/proposals/{p.id}/decide", json=body).status_code == 422
    body["reason"] = "the gusts are on the ridge, not over the creek"
    assert client.post(f"/missions/{mid}/proposals/{p.id}/decide", json=body).status_code == 200
    assert {x.id: x.status for x in store.state(mid)["fleet"].legs}[leg] == "flying"
