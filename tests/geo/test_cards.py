"""Assignment cards (LANE_B §6 test 6, B-K1), and the API and radio using them on a live mission."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sightline.api.app import create_app
from sightline.api.missions import MissionContext
from sightline.contract import LatLon, SectorTask, Verdict
from sightline.geo.cards import assignment_card, bearing_distance, sector_label, to_gpx, to_kml
from sightline.mission import MissionStore
from sightline.mission.queue import LocalQueue
from sightline.radio.mount import StoreMissionApi
from sightline.radio.tools import RadioTools
from sightline.search.grid import latlon_to_local_m
from sightline.search.sectors import lattice_sectors
from tests.fixtures.drone_photos import LKP, drone_photo

AT = "2026-10-24T22:00:00Z"


def test_bearing_and_distance_on_known_points() -> None:
    b, d = bearing_distance(LatLon(lat=0, lon=0), LatLon(lat=0, lon=1))
    assert b == pytest.approx(90, abs=0.5) and d == pytest.approx(111_195, abs=1)
    b, d = bearing_distance(LatLon(lat=49.37, lon=-122.945), LatLon(lat=49.38, lon=-122.945))
    assert b == pytest.approx(0, abs=0.5) and d == pytest.approx(1_112, abs=1)
    assert sector_label("B3") == "Bravo Three" and sector_label("Z9") == "Z9"


@pytest.fixture
def mission(tmp_path: Path):
    store = MissionStore(tmp_path / "missions")
    ctx = MissionContext(store, queue=LocalQueue(), detector_factory=lambda: _Det(), hooks=None)
    ctx.start()
    app = create_app(cache_root=tmp_path / "c", data_root=tmp_path / "u", missions=ctx)
    with TestClient(app) as client:
        mid = client.post(
            "/missions",
            json={
                "name": "Cards",
                "area_name": "Mount Seymour",
                "lkp": LKP,
                "subject": "adult, red jacket",
            },
        ).json()["mission_id"]
        yield client, ctx, store, mid
    ctx.queue.stop()


class _Det:
    def detect_tiled(self, path, conf: float = 0.05):
        from sightline.ml.types import Box, RawDetection

        return [RawDetection(Box(400, 300, 440, 360), 0.8)]


def _assign_b3(client, store, mid, team_pos: LatLon | None):
    client.patch(
        f"/missions/{mid}/teams/T2",
        json={"position": team_pos.model_dump() if team_pos else None, "status": "assigned"},
    )
    store.upsert_task(
        mid,
        SectorTask(
            sector_id="B3", state="assigned", team_id="T2", poa=0.06, note=None, updated_at=AT
        ),
    )


def test_a_card_for_an_assigned_sector(mission) -> None:
    client, _ctx, store, mid = mission
    layout = lattice_sectors(store.live(mid).base.grid)
    team_at = LatLon(
        lat=LKP["lat"] + 0.004, lon=LKP["lon"] - 0.004
    )  # north-west of the grid centre
    _assign_b3(client, store, mid, team_at)
    card = assignment_card(mid, "B3", store, layout, now=AT)
    assert (card.sector_label, card.team_callsign, card.area_m2) == (
        "Bravo Three",
        "Team Two",
        62500.0,
    )
    rect = next(s.rect for s in layout.sectors if s.id == "B3")
    e, s = latlon_to_local_m(
        store.live(mid).base.grid, LatLon(lat=card.entry.lat, lon=card.entry.lon)
    )
    on_edge = min(
        abs(e - rect["east_min"]),
        abs(e - rect["east_max"]),
        abs(s - rect["south_min"]),
        abs(s - rect["south_max"]),
    )
    assert on_edge < 0.5 and card.entry.note == "entry" and "north" in card.entry.name
    b, d = bearing_distance(team_at, LatLon(lat=card.entry.lat, lon=card.entry.lon))
    assert card.bearing_deg_from_team == round(b) and card.distance_m_from_team == round(d)
    assert (
        len(card.waypoints) <= 40 and sum(w.note == "sweep" for w in card.waypoints) == 20
    )  # 250 m / 25 m = 10 lines
    assert card.look_for == ["adult, red jacket"] and card.radio.startswith("Channel 2")
    assert card.polygon[0] == card.polygon[-1] and len(card.polygon) == 5


def test_gpx_and_kml_parse_and_hold_every_waypoint(mission) -> None:
    client, _, store, mid = mission
    _assign_b3(client, store, mid, None)
    card = assignment_card(mid, "B3", store, lattice_sectors(store.live(mid).base.grid), now=AT)
    gpx = ET.fromstring(to_gpx(card))
    ns = {"g": "http://www.topografix.com/GPX/1/1"}
    assert [w.findtext("g:name", namespaces=ns) for w in gpx.findall("g:wpt", ns)] == [
        w.name for w in card.waypoints
    ]
    assert (
        len(gpx.findall("g:trk/g:trkseg/g:trkpt", ns)) == 5
        and len(gpx.findall("g:rte/g:rtept", ns)) == 20
    )
    kml = ET.fromstring(to_kml(card))
    k = {"k": "http://www.opengis.net/kml/2.2"}
    names = [p.findtext("k:name", namespaces=k) for p in kml.findall("k:Document/k:Placemark", k)]
    assert (
        all(w.name in names for w in card.waypoints)
        and len(kml.findall(".//k:LineString", k)) == 10
    )
    assert card.entry.name in names and card.bearing_deg_from_team is None  # no team position


def test_look_for_takes_what_the_second_look_saw_in_the_sector(mission) -> None:
    client, ctx, store, mid = mission
    client.post(
        f"/missions/{mid}/photos", files=[("files", ("a.jpg", drone_photo(), "image/jpeg"))]
    )
    ctx.queue.join()
    det, _ = store.get_detection(mid, "f0001-d01")
    layout = lattice_sectors(store.live(mid).base.grid)
    from sightline.search.grid import cell_containing

    r, c = cell_containing(store.live(mid).base.grid, LatLon(lat=det.lat, lon=det.lon))
    sector = layout.sectors[int(layout.cell_sector[r * store.live(mid).base.grid.cols + c])].id
    store.put_verdict(
        mid,
        Verdict(
            id="v0001",
            detection_id=det.id,
            tools=["zoom_native"],
            relook_crops=[],
            person="yes",
            posture="lying",
            group_size=1,
            clothing="red jacket",
            reason="r",
            model="m",
            ms=1,
            at=AT,
        ),
    )
    card = assignment_card(mid, sector, store, layout, now=AT)
    assert card.look_for[1] == "person seen in a photo: red jacket, lying (f0001-d01)"
    assert card.evidence_crops == [det.crop]
    assert card.drone_coverage > 0  # the photo looked at part of this sector


def test_the_api_serves_the_card_as_json_gpx_and_kml(mission) -> None:
    client, _, store, mid = mission
    _assign_b3(client, store, mid, None)
    assert client.get(f"/missions/{mid}/cards/B3").json()["sector_label"] == "Bravo Three"
    gpx = client.get(f"/missions/{mid}/cards/B3.gpx")
    assert gpx.status_code == 200 and gpx.headers["content-type"].startswith("application/gpx+xml")
    assert client.get(f"/missions/{mid}/cards/B3.kml").text.startswith("<?xml")
    assert client.get(f"/missions/{mid}/cards/Z9").status_code == 404


def test_the_radio_reads_the_boundary_from_the_live_card(mission) -> None:
    """Before the cards, a team asking "say again the sector boundary" on a live mission got nothing."""
    client, _, store, mid = mission
    _assign_b3(client, store, mid, LatLon(lat=LKP["lat"] + 0.004, lon=LKP["lon"] - 0.004))
    tools = RadioTools(StoreMissionApi(store), mid, drafts={})
    b = tools.call("get_sector_boundary", {"sector_id": "Bravo Three", "from_team": "T2"})
    assert b["sector"] == "Bravo Three" and b["size"] == "about 250 metres across"
    assert (
        "entry" in b and isinstance(b["bearing_deg"], int) and "landmarks" not in b
    )  # no sweep points read out
    assert tools.call("get_assignment", {"team_id": "T2"})["sector"] == "Bravo Three"
