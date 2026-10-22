"""The simulated fleet (LANE_C §6 test 7, C-F1) against the real mission API: it joins over HTTP,
flies an approved leg, its photos carry poses lane B's ``read_pose`` reads back, and the hidden
person's position never appears in a request."""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from sightline.api.app import create_app
from sightline.api.missions import MissionContext
from sightline.contract import Drone, FleetState, LatLon, Leg
from sightline.geo.pose import read_pose
from sightline.mission import MissionStore
from sightline.mission.queue import LocalQueue
from sightline.search.fleet import Crop, FleetSim, Scenario, _to_ll, covers, stamp
from tests.fixtures.drone_photos import LKP

GSD = 0.02
HIDDEN = LatLon(lat=LKP["lat"] - 0.0003, lon=LKP["lon"] + 0.0004)


class _Det:
    def detect_tiled(self, path, conf: float = 0.05):
        return []


class Hooks:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def __getattr__(self, name):
        return lambda *a, **k: self.calls.append((name, *a[2:]))


def _crop(tmp: Path, name: str, colour: tuple[int, int, int]) -> Crop:
    p = tmp / name
    Image.new("RGB", (1200, 900), colour).save(p, "JPEG")
    return Crop(p, (0, 0, 1000, 750), GSD)  # 20 m wide on the ground


class Pool:
    def __init__(self, tmp: Path) -> None:
        self.positive = _crop(tmp, "pos.jpg", (200, 30, 30))
        self.negatives = [_crop(tmp, f"neg{i}.jpg", (40, 90, 40)) for i in range(3)]


def _scenario() -> Scenario:
    d = Drone(id="D1", name="Drone 1", simulated=True, position=LatLon(**LKP), altitude_m=50,
              speed_ms=8, battery_pct=100, max_wind_kmh=38, status="idle", leg_id=None)  # fmt: skip
    return Scenario(name="t", lkp=LatLon(**LKP), drones=[d], hidden=HIDDEN, positive={}, clue=None)


@pytest.fixture
def world(tmp_path: Path):
    store = MissionStore(tmp_path / "missions")
    hooks = Hooks()
    ctx = MissionContext(store, queue=LocalQueue(), detector_factory=lambda: _Det(), hooks=hooks)
    ctx.start()
    app = create_app(cache_root=tmp_path / "c", data_root=tmp_path / "u", missions=ctx)
    with TestClient(app) as http:
        mid = http.post(
            "/missions", json={"name": "Fleet", "area_name": "Mount Seymour", "lkp": LKP}
        ).json()["mission_id"]
        bodies: list[bytes] = []
        http.event_hooks = {"request": [lambda r: bodies.append(r.read())], "response": []}
        yield http, ctx, store, hooks, mid, bodies, tmp_path
    ctx.queue.stop()


def _leg_over_hidden(store: MissionStore, mid: str) -> None:
    """An approved leg: one 60 m line east-west, 6 m north of the hidden person (inside a photo's
    20 m width, but no drone position ever has the hidden latitude)."""
    fleet = store.state(mid)["fleet"]
    o = LatLon(**LKP)
    from sightline.search.fleet import _to_m

    e, n = _to_m(o, HIDDEN.lon, HIDDEN.lat)
    wps = [_to_ll(o, e - 31, n + 6), _to_ll(o, e + 29, n + 6)]
    leg = Leg(id="L1", drone_id="D1", sector_id="C3", waypoints=wps, altitude_m=50, est_minutes=1,
              expected_clearance=0.1, score_per_min=0.1, reason="r", status="approved")  # fmt: skip
    store.put_fleet(
        mid,
        FleetState(simulated=True, drones=fleet.drones, legs=[leg], updated_at=fleet.updated_at),
    )


def test_the_sim_flies_an_approved_leg_through_the_api(world) -> None:
    http, ctx, store, hooks, mid, _bodies, tmp = world
    lines: list[str] = []
    sim = FleetSim(
        http, mid, _scenario(), time_scale=1.0, photo_every_m=15, pool=Pool(tmp), out=lines.append
    )
    sim.register()
    fleet = store.state(mid)["fleet"]
    assert fleet.simulated and [d.id for d in fleet.drones] == ["D1"] and fleet.legs == []
    sim.tick(1.0)
    assert sim.photos == 0  # no approved leg yet
    _leg_over_hidden(store, mid)
    for _ in range(40):  # 8 m/s, about 300 m in all
        sim.tick(1.0)
    ctx.queue.join()
    assert ("on_leg_done", "L1") in hooks.calls
    assert store.state(mid)["fleet"].legs[0].status == "done"
    frames = store.survey(mid).frames
    assert len(frames) == sim.photos == 5  # 60 m line, a photo every 15 m, the first at its start
    assert all(f.source.image.startswith("SIM_D1_") for f in frames)
    reds = sum(
        Image.open(io.BytesIO(store.read_file(mid, f.file))).getpixel((10, 10))[0] > 150
        for f in frames
    )
    assert (
        1 <= reds < 5
    )  # the photos over the hidden person got the positive crop, the rest did not
    assert store.state(mid)["fleet"].drones[0].battery_pct < 100
    assert any("L1 done" in x for x in lines)


def test_photos_carry_a_pose_read_pose_reads_back(tmp_path: Path) -> None:
    crop = Pool(tmp_path).negatives[0]
    p = tmp_path / "s.jpg"
    p.write_bytes(stamp(crop, 49.3741, -122.9372, 50.0, 270.0))
    info = read_pose(p)
    assert info is not None and info.nadir
    assert (round(info.pose.lat, 4), round(info.pose.lon, 4), info.pose.alt_agl_m) == (
        49.3741,
        -122.9372,
        50.0,
    )
    assert info.pose.heading_deg == pytest.approx(270.0) and info.pose.gsd_m == pytest.approx(
        GSD, rel=0.03
    )
    assert covers(info.pose, 1000, 750, LatLon(lat=49.3741, lon=-122.9372))


def test_the_truth_never_reaches_the_api(world) -> None:
    http, _, store, _, mid, bodies, tmp = world
    sim = FleetSim(http, mid, _scenario(), time_scale=1.0, pool=Pool(tmp), out=lambda s: None)
    sim.register()
    _leg_over_hidden(store, mid)
    for _ in range(40):
        sim.tick(1.0)
    sent = b"".join(bodies)
    for digits in (5, 6):
        assert f"{HIDDEN.lat:.{digits}f}".encode() not in sent
    assert b"hidden" not in sent and b"truth" not in sent


def test_no_fleet_and_no_drones_is_still_409(world) -> None:
    http, *_, mid, _bodies, _tmp = world
    r = http.put(
        f"/missions/{mid}/fleet",
        json={"drones": [], "leg_status": {}, "at": "2026-10-24T22:00:00Z"},
    )
    assert r.status_code == 409


def test_a_retask_cancels_the_leg_being_flown(world) -> None:
    http, _, store, _, mid, _bodies, tmp = world
    lines: list[str] = []
    sim = FleetSim(http, mid, _scenario(), time_scale=1.0, pool=Pool(tmp), out=lines.append)
    sim.register()
    _leg_over_hidden(store, mid)
    sim.tick(1.0)
    fleet = store.state(mid)["fleet"]
    new = fleet.legs[0].model_copy(
        update={
            "id": "L2",
            "waypoints": list(reversed(fleet.legs[0].waypoints)),
            "status": "approved",
        }
    )
    old = fleet.legs[0].model_copy(update={"status": "cancelled"})
    store.put_fleet(mid, fleet.model_copy(update={"legs": [old, new]}))
    sim.tick(1.0)
    assert "Drone 1: L1 cancelled" in lines and sim.drones[0].leg.id == "L2"
    assert store.state(mid)["fleet"].legs[1].status == "flying"


def test_the_feed_reads_fleet_updates_from_the_event_stream(world) -> None:
    """With ``run``, legs come from the mission's events (fleet.updated), not a GET /state per tick."""
    from sightline.api.sse import format_event
    from sightline.search.fleet import FleetFeed, sse_events

    http, _, store, _, mid, _bodies, tmp = world
    sim = FleetSim(http, mid, _scenario(), time_scale=1.0, pool=Pool(tmp), out=lambda s: None)
    sim.register()
    _leg_over_hidden(store, mid)
    text = "".join(format_event(e) for e in store.events(mid)) + ": heartbeat\n\n"
    lines = text.split("\n")
    assert [t for t, _, _ in sse_events(lines)][-1] == "fleet.updated"

    feed = FleetFeed(http, mid)
    feed.follow(lines)
    assert list(feed.legs) == ["L1"] and feed.last_id == store.events(mid)[-1].id
    sim.feed = feed
    calls: list[str] = []
    http.event_hooks = {
        "request": [lambda r: calls.append(f"{r.method} {r.url.path}")],
        "response": [],
    }
    sim.tick(1.0)
    assert f"GET /missions/{mid}/state" not in calls  # the feed's legs were used
    assert sim.drones[0].leg is not None and sim.drones[0].leg.id == "L1"


def test_the_creek_scenario_lists_its_frames() -> None:
    """Every image a photo can get is named in the scenario file (no truth beyond which crop)."""
    scn = Scenario.load("creek")
    assert len(scn.drones) == 3 and all(d.simulated for d in scn.drones)
    assert scn.positive["image"].endswith(".jpg") and len(scn.negatives) == 12
    assert all(len(n["box"]) == 4 and n["image"] != scn.positive["image"] for n in scn.negatives)
