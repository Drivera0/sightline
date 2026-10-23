"""Contract 15.7: a clue a team reports on the radio waits for the search manager (a turn
``awaiting_confirm`` with its ``draft``) and becomes a clue only by the manager's action; a sound a
team heard is a bearing from the team's position (an arc on the map); the after-action report has
every sector's final POD and every drone leg."""

from __future__ import annotations

import math
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sightline.api.app import create_app
from sightline.api.missions import MissionContext
from sightline.contract import Clue, LatLon, RadioTurn
from sightline.mission import MissionStore, validate_mission
from sightline.mission.effects import bearing_point
from sightline.mission.queue import LocalQueue
from sightline.mission.report import after_action_markdown, build
from sightline.radio.mount import StoreMissionApi
from tests.fixtures.drone_photos import LKP, drone_photo
from tests.pipeline.test_mission_api import FakeDetector, Hooks


@pytest.fixture
def api(tmp_path: Path):
    store = MissionStore(tmp_path / "missions")
    ctx = MissionContext(store, queue=LocalQueue(), detector_factory=FakeDetector, hooks=Hooks())
    ctx.start()
    app = create_app(cache_root=tmp_path / "cache", data_root=tmp_path / "up", missions=ctx)
    with TestClient(app) as client:
        mid = client.post(
            "/missions", json={"name": "S", "area_name": "Mount Seymour", "lkp": LKP}
        ).json()["mission_id"]
        client.post(
            f"/missions/{mid}/photos", files=[("files", ("a.jpg", drone_photo(), "image/jpeg"))]
        )
        ctx.queue.join()
        yield client, store, mid
    ctx.queue.stop()


def _report(store: MissionStore, mid: str, draft: dict, rid: str = "r0007") -> None:
    StoreMissionApi(store).record_turn(mid, RadioTurn(
        id=rid, direction="in", callsign="T1", transcript="Sightline, Team One. Possible whistle, over.",
        reply="Team One, Sightline. Copy. Holding it for the search manager to confirm, over.", audio=None,
        state="awaiting_confirm", actions=["draft clue"], asr_ms=None, llm_ms=None, tts_ms=None,
        at="2026-10-24T21:40:00Z", draft=draft))  # fmt: skip


def test_a_reported_clue_is_not_a_clue_until_the_manager_confirms_it(api) -> None:
    client, store, mid = api
    _report(store, mid, {"kind": "object", "text": "blue water bottle", "lat": LKP["lat"], "lon": LKP["lon"],
                         "reported_by": "T1", "source": "radio"})  # fmt: skip
    assert store.state(mid)["clues"] == []  # heard, not a clue
    r = client.post(f"/missions/{mid}/turns/r0007/confirm_clue", json={"by": "Search manager"})
    assert r.status_code == 201, r.text
    clue = store.state(mid)["clues"][0]
    assert clue.confirmed and clue.source == "radio" and clue.confirmed_by_turn == "r0007"
    act = [t for t in store.trace_entries(mid) if t.kind == "radio_turn"][-1]
    assert act.actor == "human" and act.output["state"] == "committed"
    assert "confirmed by Search manager" in act.output["actions"]
    note = [e for e in store.events(mid) if (e.data or {}).get("decision")][-1]
    assert note.data["decision"]["action"] == "confirm_radio_clue"
    assert validate_mission(store.root, mid) == []  # invariant 6: a committed turn behind it
    again = client.post(f"/missions/{mid}/turns/r0007/confirm_clue", json={"by": "Search manager"})
    assert again.status_code == 409
    assert (
        client.post(f"/missions/{mid}/turns/r0099/confirm_clue", json={"by": "x"}).status_code
        == 404
    )


def test_a_sound_is_a_bearing_and_the_map_raises_its_arc(api) -> None:
    client, store, mid = api
    origin = LatLon(lat=LKP["lat"], lon=LKP["lon"])
    lat, lon = bearing_point(origin, 225.0, 300.0)
    _report(store, mid, {"kind": "sound", "text": "whistle, three blasts", "lat": lat, "lon": lon,
                         "reported_by": "T1", "source": "radio", "reliability": "low",
                         "origin": origin.model_dump(), "bearing_deg": 225.0, "bearing_spread_deg": 20.0,
                         "range_m": 300.0})  # fmt: skip
    r = client.post(f"/missions/{mid}/turns/r0007/confirm_clue", json={"by": "Search manager"})
    assert r.status_code == 201, r.text
    clue = Clue.model_validate({k: v for k, v in r.json().items() if k != "map"})
    assert (clue.bearing_deg, clue.range_m, clue.origin) == (225.0, 300.0, origin)
    cells = [i for i, _ in r.json()["map"]["cells"]]
    grid = store.live(mid).base.grid
    from sightline.search.grid import cell_center

    for i in cells:  # every raised cell is in the south-west arc, 300 m out give or take the radius
        c = cell_center(grid, i)
        dn = (c.lat - origin.lat) * 110_540.0
        de = (c.lon - origin.lon) * 111_320.0 * math.cos(math.radians(origin.lat))
        off = (math.degrees(math.atan2(de, dn)) - 225.0 + 180.0) % 360.0 - 180.0
        assert (
            abs(off) <= 20.0 + 1e-6
            and abs(math.hypot(de, dn) - 300.0) <= clue.radius_m + grid.cell_m
        )

    assert len(cells) > 50


def test_the_report_has_last_seen_every_sector_and_the_legs(api) -> None:
    _client, store, mid = api
    store.update_mission(mid, last_seen_at="2026-10-24T17:30:00Z")
    r = build(store, mid, "2026-10-24T22:00:00Z")
    assert r["subject"]["last_seen_at"] == "2026-10-24T17:30:00Z"
    assert len(r["sectors"]) == 16 and all(s["pod"] is not None for s in r["sectors"])
    assert any(s["pod"] > 0 for s in r["sectors"])  # the photo's look counts where it fell
    assert r["legs"] == []  # no fleet in this mission
    md = after_action_markdown(r)
    assert "Last seen: **" in md and "## Every sector at the end" in md and "## Drone legs" in md
