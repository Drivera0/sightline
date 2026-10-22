"""Standard SAR outputs (``docs/EXPORTS.md``): ICS 204, ICS 214 and CalTopo GeoJSON, on the demo
fixture mission and on an empty one, through the functions and the API.

The ICS 204 Markdown for Team One on the demo mission is a golden file
(``tests/geo/golden/ics204_T1.md``); to accept a deliberate change, rerun with
``SIGHTLINE_UPDATE_GOLDEN=1`` and read the diff."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sightline.api.app import create_app
from sightline.api.missions import MissionContext
from sightline.contract import Proposal, SectorTask
from sightline.geo.cards import assignment_card
from sightline.geo.exports import (
    caltopo_geojson,
    ics204,
    ics204_markdown,
    ics214,
    ics214_markdown,
    ics_time,
)
from sightline.mission import MissionStore, effects
from sightline.mission.queue import LocalQueue
from tests.fixtures.demo_mission import NOW, seed_demo
from tests.fixtures.drone_photos import LKP

GOLDEN = Path(__file__).parent / "golden" / "ics204_T1.md"
NEVER = re.compile(r"\bclear(s|ed|ing)?\b", re.IGNORECASE)
CALTOPO_STYLE = {"title", "description", "class"}


@pytest.fixture
def api(tmp_path: Path):
    store = MissionStore(tmp_path / "missions")
    ctx = MissionContext(store, queue=LocalQueue(), detector_factory=lambda: None, hooks=None)
    ctx.start()
    app = create_app(cache_root=tmp_path / "c", data_root=tmp_path / "u", missions=ctx,
                     api_token="secret-token")  # fmt: skip
    with TestClient(app) as client:
        yield client, store
    ctx.queue.stop()


def _empty(client: TestClient) -> str:
    r = client.post("/missions", json={"name": "Empty", "area_name": "Mount Seymour", "lkp": LKP},
                    headers={"Authorization": "Bearer secret-token"})  # fmt: skip
    assert r.status_code == 201, r.text
    return r.json()["mission_id"]


def _demo_204(store: MissionStore, mid: str, team: str) -> dict:
    state = store.state(mid)
    task = next(t for t in state["tasks"] if t.team_id == team and t.state != "searched")
    layout = effects._layout(store, mid)
    card = assignment_card(mid, task.sector_id, store, layout, now=NOW)
    return ics204(state, store.trace_entries(mid), team, card, NOW)


# --- ICS 204 -----------------------------------------------------------------------------


def test_ics204_markdown_matches_the_golden_file(tmp_path: Path) -> None:
    store = MissionStore(tmp_path / "m")
    mid = seed_demo(store)
    md = ics204_markdown(_demo_204(store, mid, "T1"))
    if os.environ.get("SIGHTLINE_UPDATE_GOLDEN") == "1":
        GOLDEN.parent.mkdir(exist_ok=True)
        GOLDEN.write_text(md)
    assert md == GOLDEN.read_text()


def test_ics204_fills_every_block_from_the_card_and_trace(tmp_path: Path) -> None:
    store = MissionStore(tmp_path / "m")
    mid = seed_demo(store)
    f = _demo_204(store, mid, "T1")
    assert f["incident_name"] == "Mount Seymour (demo)"
    assert f["operational_period"] == {"from": "2026-10-24T20:30:00Z", "to": NOW}
    assert (
        f["division"] == "Sector C2 (Charlie Two)"
    )  # the planner's sector on the map with the clues
    assert f["resources_assigned"][0]["resource_identifier"] == "T1 Team One"
    assert f["resources_assigned"][0]["persons"] == 3
    assert "Target POD 0.6" in f["work_assignments"]
    assert "Enter at the" in f["work_assignments"] and "adult, red jacket" in f["work_assignments"]
    special = " ".join(f["special_instructions"])
    assert (
        "wind 8 km/h" in special
        and "gusts 15 km/h" in special
        and "Daylight: 3 h 36 min" in special
    )
    assert "No-fly" not in special  # the demo's conditions are flyable
    assert f["communications"][0]["primary_contact"].startswith("radio Channel 2")
    trace = {e.id: e for e in store.trace_entries(mid)}
    assert f["prepared_by"]["name"] == "Search manager (scripted for the demo fixture)"
    assert trace[f["prepared_by"]["trace_entry"]].output["proposal"] == "p003"
    md = ics204_markdown(f)
    for block in ("1. Incident Name", "2. Operational Period", "3. Branch", "4. Operations Personnel",
                  "5. Resources Assigned", "6. Work Assignments", "7. Special Instructions",
                  "8. Communications", "9. Prepared by"):  # fmt: skip
        assert block in md, block
    assert "10/24/2026 20:30 UTC" in md and not NEVER.search(md)


def test_ics204_lists_the_drone_on_the_sector_and_a_no_fly(tmp_path: Path) -> None:
    store = MissionStore(tmp_path / "m")
    mid = seed_demo(store)
    store.upsert_task(mid, SectorTask(sector_id="C3", state="assigned", team_id="T4", poa=0.03,
                                      note=None, updated_at=NOW))  # fmt: skip
    c = store.state(mid)["conditions"]
    store.put_conditions(mid, c.model_copy(update={"flyable": False,
                                                   "flyability_reason": "gusts 45 km/h over the limit"}))  # fmt: skip
    f = _demo_204(store, mid, "T4")
    drone = f["resources_assigned"][1]
    assert drone["resource_identifier"] == "D1 Drone 1 (simulated)" and "L004" in drone["remarks"]
    assert "Drone 1 (simulated) flies leg L004 over sector C3" in f["work_assignments"]
    assert "No-fly for drones: gusts 45 km/h over the limit." in f["special_instructions"]
    assert f["prepared_by"]["name"] is None  # no approval for T4: left blank, never invented


def test_ics204_api_md_json_and_errors(api) -> None:
    client, store = api
    mid = seed_demo(store)
    r = client.get(f"/missions/{mid}/ics204/T1.md")  # a read: no token needed
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/markdown")
    assert r.text.startswith("# Assignment List (ICS 204)") and "Sector C2 (Charlie Two)" in r.text
    j = client.get(f"/missions/{mid}/ics204/t1.json?pod_target=0.7").json()
    assert j["form"] == "ICS 204" and "Target POD 0.7" in j["work_assignments"]
    assert client.get(f"/missions/{mid}/ics204/T9.md").status_code == 404
    assert client.get(f"/missions/{mid}/ics204/T1.md?pod_target=0.95").status_code == 422
    assert client.get("/missions/00000000/ics204/T1.md").status_code == 404


def test_ics204_on_an_empty_mission_says_no_assignment(api) -> None:
    client, _ = api
    mid = _empty(client)
    j = client.get(f"/missions/{mid}/ics204/T1.json").json()
    assert j["division"] is None and j["work_assignments"].startswith("No sector is assigned")
    assert j["resources_assigned"][0]["persons"] == 3
    md = client.get(f"/missions/{mid}/ics204/T1.md").text
    assert "9. Prepared by" in md and not NEVER.search(md)


# --- ICS 214 -----------------------------------------------------------------------------


def test_ics214_logs_decisions_clues_and_searched_sectors(tmp_path: Path) -> None:
    store = MissionStore(tmp_path / "m")
    mid = seed_demo(store)
    f = ics214(store.state(mid), store.trace_entries(mid), store.events(mid), NOW)
    what = [r["what"] for r in f["activity_log"]]
    assert "Assignment approved: Assign sector C2 to Team One (p003)" in what
    assert any(w.startswith("Promotion to the review queue approved") for w in what)
    assert sum(w.startswith("Clue logged") for w in what) == 4
    assert (
        "Sector B4 searched at POD 0.6: trail and both ditches, thick salal on the east side"
        in what
    )
    assert not any("p002" in w for w in what)  # pending: not an activity yet
    times = [r["at"] for r in f["activity_log"]]
    assert times == sorted(times)  # oldest first (all whole-second UTC here)
    who = {r["what"]: r["who"] for r in f["activity_log"]}
    assert (
        who["Assignment approved: Assign sector C2 to Team One (p003)"]
        == "Search manager (scripted for the demo fixture)"
    )
    md = ics214_markdown(f)
    assert (
        "7. Activity Log" in md
        and "| 10/24/2026 21:43 UTC | Search manager (scripted for the demo fixture) |" in md
    )
    assert not NEVER.search(md)


def test_ics214_api_includes_a_recall_decided_through_the_api(api) -> None:
    client, store = api
    mid = seed_demo(store)
    p = store.add_proposal(mid, Proposal(
        id="", kind="retask_drone", summary="Recall Drone 2 home", reason="gusts over the limit",
        briefing=None, target={"drone": "D2", "home": "base"}, evidence=[], status="pending",
        created_by="agent", created_at=NOW, decided_at=None, decided_by=None,
        decision_reason=None, edits=None))  # fmt: skip
    r = client.post(f"/missions/{mid}/proposals/{p.id}/decide",
                    json={"decision": "approve", "by": "Ops chief"},
                    headers={"Authorization": "Bearer secret-token"})  # fmt: skip
    assert r.status_code == 200, r.text
    traced = [e for e in store.trace_entries(mid) if e.kind == "decision" and p.id in e.refs]
    assert traced and traced[-1].output["by"] == "Ops chief" and traced[-1].actor == "human"
    md = client.get(f"/missions/{mid}/ics214.md")
    assert md.status_code == 200 and md.headers["content-type"].startswith("text/markdown")
    assert f"| Ops chief | Drone recall approved: Recall Drone 2 home ({p.id}) |" in md.text


def test_ics214_on_an_empty_mission(api) -> None:
    client, _ = api
    md = client.get(f"/missions/{_empty(client)}/ics214.md").text
    assert "No notable activities logged yet." in md and "Team One (T1)" in md


# --- CalTopo -----------------------------------------------------------------------------


def _check_caltopo(fc: dict) -> None:
    assert fc["type"] == "FeatureCollection"
    for feat in fc["features"]:
        props = feat["properties"]
        assert CALTOPO_STYLE <= set(props) or props["class"] == "Folder", props
        if props["class"] == "Shape":
            assert {"stroke", "stroke-opacity", "stroke-width"} <= set(props)
            if feat["geometry"]["type"] == "Polygon":
                assert {"fill", "fill-opacity"} <= set(props)
                ring = feat["geometry"]["coordinates"][0]
                assert ring[0] == ring[-1] and len(ring) >= 4
        if props["class"] == "Marker":
            assert re.fullmatch(r"[0-9A-F]{6}", props["marker-color"]) and props["marker-symbol"]
            assert feat["geometry"]["type"] == "Point"
        assert not NEVER.search(json.dumps(props))


def test_caltopo_geojson_on_the_demo_mission(tmp_path: Path) -> None:
    store = MissionStore(tmp_path / "m")
    mid = seed_demo(store)
    fc = caltopo_geojson(store.state(mid), effects.sector_overview(store, mid))
    _check_caltopo(fc)
    by_title = {f["properties"]["title"]: f for f in fc["features"]}
    assert len([t for t in by_title if t.startswith("Sector ")]) == 16
    searched = by_title["B4 searched at POD 0.6"]["properties"]
    assert (
        searched["description"].startswith("searched at POD 0.6")
        and searched["folderId"] == "sightline-searched"
    )
    assert "C4 searched at POD 0.4" in by_title
    legs = [f for f in fc["features"] if f["properties"].get("folderId") == "sightline-legs"]
    assert {f["properties"]["title"].split()[0] for f in legs} == {
        "L002",
        "L003",
        "L004",
    }  # not the cancelled one
    assert all(f["geometry"]["type"] == "LineString" for f in legs)
    assert {"Team One (T1)", "Team Two (T2)", "Team Three (T3)", "Team Four (T4)"} <= set(by_title)
    clue = by_title["Clue c003: object"]["properties"]
    assert clue["marker-symbol"] == "clue" and "blue water bottle" in clue["description"]
    assert by_title["LKP"]["geometry"]["coordinates"] == [-122.945, 49.37]


def test_caltopo_api_on_an_empty_mission(api) -> None:
    client, _ = api
    r = client.get(f"/missions/{_empty(client)}/caltopo.geojson")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/geo+json")
    assert "attachment" in r.headers["content-disposition"]
    fc = r.json()
    _check_caltopo(fc)
    classes = [f["properties"]["class"] for f in fc["features"]]
    # the LKP and the four teams staged at the base camp (1.3)
    assert classes.count("Folder") == 5 and classes.count("Marker") == 5
    assert classes.count("Shape") == 16  # the sector outlines


def test_the_routes_are_in_the_openapi_docs_under_exports(api) -> None:
    client, _ = api
    spec = client.get("/openapi.json").json()
    assert any(t["name"] == "exports" for t in spec["tags"])
    for path in ("/missions/{mission_id}/ics204/{team}.md", "/missions/{mission_id}/ics204/{team}.json",
                 "/missions/{mission_id}/ics214.md", "/missions/{mission_id}/caltopo.geojson"):  # fmt: skip
        assert spec["paths"][path]["get"]["tags"] == ["exports"], path


def test_ics_time() -> None:
    assert ics_time("2026-10-24T20:30:00Z") == "10/24/2026 20:30 UTC"
    assert ics_time("2026-10-21T00:33:23.627Z") == "10/21/2026 00:33 UTC"
    assert ics_time(None) == "—"
