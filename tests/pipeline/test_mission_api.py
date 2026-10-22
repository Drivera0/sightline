"""The mission API, per-photo pipeline and decision effects (contract §13, LANE_D §6 tests 4–6;
D-A1, D-P1). Photos are made here with GPS in EXIF and a DJI pose in XMP; the detector is a fake."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sightline.api.app import create_app
from sightline.api.missions import MissionContext
from sightline.api.sse import event_stream, format_event
from sightline.contract import LatLon, Proposal
from sightline.mission import MissionStore, validate_mission
from sightline.mission.queue import LocalQueue
from sightline.ml.types import Box, RawDetection
from tests.fixtures.drone_photos import LKP, drone_photo
from tests.fixtures.mission import committed_turn


class FakeDetector:
    """Boxes in original pixels: one candidate (0.8), one near miss (0.2), one low (0.06)."""

    def detect_tiled(self, path, conf: float = 0.05):
        return [
            RawDetection(Box(100, 100, 130, 160), 0.2),
            RawDetection(Box(400, 300, 440, 360), 0.8),
            RawDetection(Box(600, 400, 620, 420), 0.06),
        ]


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
    ctx = MissionContext(store, queue=LocalQueue(), detector_factory=FakeDetector, hooks=hooks)
    ctx.start()
    app = create_app(cache_root=tmp_path / "cache", data_root=tmp_path / "up", missions=ctx)
    with TestClient(app) as client:
        yield client, ctx, hooks
    ctx.queue.stop()


def _mission(client: TestClient) -> str:
    r = client.post("/missions", json={"name": "Seymour", "area_name": "Mount Seymour", "lkp": LKP})
    assert r.status_code == 201, r.text
    return r.json()["mission_id"]


def _upload(client: TestClient, mid: str, *photos: tuple[str, bytes]):
    files = [("files", (name, data, "image/jpeg")) for name, data in photos]
    return client.post(f"/missions/{mid}/photos", files=files)


# --- missions and health ------------------------------------------------------------------


def test_health_names_the_contract_and_backend(api) -> None:
    client, ctx, _ = api
    assert client.get("/health").json() == {
        "status": "ok",
        "contract_version": "1.2",
        "backend": "cv2",
        "detector": None,  # nothing loaded yet: the first photo loads it
        "radio": False,  # not started with --radio
    }
    _upload(client, _mission(client), ("a.jpg", drone_photo()))
    ctx.queue.join()
    assert client.get("/health").json()["detector"] == "fake"  # what actually ran, by class


def test_health_shows_a_fallback_by_the_detector_class() -> None:
    from sightline.api.app import detector_name

    Detector = type("Detector", (), {})  # the torch class name: a missing ONNX falls back to it
    assert detector_name(Detector()) == "torch"


def test_a_new_mission_has_a_map_and_four_teams_on_standby(api) -> None:
    client, _ctx, _ = api
    mid = _mission(client)
    state = client.get(f"/missions/{mid}/state").json()
    assert state["mission"]["name"] == "Seymour" and state["mission"]["mode"] == "live"
    assert [(t["id"], t["status"]) for t in state["teams"]] == [
        (f"T{i}", "standby") for i in range(1, 5)
    ]
    base = client.get(f"/missions/{mid}/map_base").json()
    assert base["params"]["prior_source"] == "placeholder" and base["grid"]["cell_m"] == 5.0
    assert [m["mission_id"] for m in client.get("/missions").json()] == [mid]
    assert client.get("/missions/deadbeef/state").status_code == 404


# --- test 4: photos -----------------------------------------------------------------------


def test_photos_without_gps_or_not_jpeg_are_rejected_with_a_reason(api) -> None:
    client, ctx, _ = api
    mid = _mission(client)
    good = drone_photo()
    r = _upload(
        client,
        mid,
        ("DJI_0001.JPG", good),
        ("phone.jpg", drone_photo(gps=False)),
        ("notes.jpg", b"hello"),
    )
    assert r.status_code == 202
    assert r.json()["accepted"] == ["f0001"]
    reasons = {x["name"]: x["reason"] for x in r.json()["rejected"]}
    assert "GPS" in reasons["phone.jpg"] and "JPEG" in reasons["notes.jpg"]
    assert ctx.store.read_file(mid, "frames/orig/f0001.jpg") == good  # the original, untouched


def test_each_photo_becomes_a_frame_with_detections_in_upload_order(api) -> None:
    client, ctx, hooks = api
    mid = _mission(client)
    photos = [(f"DJI_{k:04d}.JPG", drone_photo(49.375 + k * 1e-4)) for k in range(3)]
    assert _upload(client, mid, *photos).json()["accepted"] == ["f0001", "f0002", "f0003"]
    ctx.queue.join()

    survey = client.get(f"/missions/{mid}/survey").json()
    assert [(f["id"], f["source"]["image"]) for f in survey["frames"]] == [
        ("f0001", "DJI_0000.JPG"),
        ("f0002", "DJI_0001.JPG"),
        ("f0003", "DJI_0002.JPG"),
    ]
    assert sorted(f["rank"] for f in survey["frames"]) == [1, 2, 3]
    f1 = survey["frames"][0]
    assert (f1["width_px"], f1["height_px"]) == (1000, 750) and len(f1["footprint"]) == 4
    dets = client.get(f"/missions/{mid}/detections").json()["frames"]["f0001"]
    assert [(d["id"], d["conf"], d["crop"]) for d in dets] == [
        ("f0001-d01", 0.8, "crops/f0001-d01.jpg"),
        ("f0001-d02", 0.2, None),
        ("f0001-d03", 0.06, None),
    ]
    assert dets[0]["box_px"] == [500, 375, 550, 450]  # 800×600 → 1000×750
    assert abs(dets[0]["lat"] - 49.375) < 0.01 and abs(dets[0]["lon"] + 122.9375) < 0.01
    assert client.get(f"/missions/{mid}/files/crops/f0001-d01.jpg").status_code == 200
    assert ctx.store.read_file(mid, "crops/nearmiss/f0001-d02.jpg")  # for A's verifier

    events = ctx.store.events(mid)
    processed = [e for e in events if e.type == "photo.processed"]
    assert [e.ref for e in processed] == ["f0001", "f0002", "f0003"]
    assert [e.data["map"] for e in processed] == ["updated"] * 3  # lane C's LiveMap (C-L1)
    steps = ctx.store.map_updates(mid)
    assert [(u.seq, u.kind, u.source, u.ref) for u in steps] == [
        (1, "step", "frame", "f0001"),
        (2, "step", "frame", "f0002"),
        (3, "step", "frame", "f0003"),
    ]
    assert steps[0].cells and steps[0].canopy  # it looked somewhere, and recorded the canopy
    assert sum(e.type == "detection.new" for e in events) == 3
    assert [c for c in hooks.calls if c[0] == "on_detection"][:2] == [
        ("on_detection", "f0001-d01"),
        ("on_detection", "f0001-d02"),
    ]
    assert validate_mission(ctx.store.root, mid) == []


def test_files_stay_inside_the_mission(api) -> None:
    client, _, _ = api
    mid = _mission(client)
    for bad in ("../../etc/passwd", "mission.json", "%2e%2e/x"):
        assert client.get(f"/missions/{mid}/files/{bad}").status_code == 404


# --- test 5: decisions and field reports ----------------------------------------------------


def _propose(ctx: MissionContext, mid: str, **over) -> str:
    fields = {
        "id": "",
        "kind": "assign_sector",
        "summary": "Assign sector B3 to Team Two",
        "reason": "r",
        "briefing": "New assignment.",
        "target": {"team": "T2", "sector": "B3"},
        "evidence": [],
        "status": "pending",
        "created_by": "agent",
        "created_at": "2026-10-24T21:40:00Z",
        "decided_at": None,
        "decided_by": None,
        "decision_reason": None,
        "edits": None,
    }
    return ctx.store.add_proposal(mid, Proposal(**{**fields, **over})).id


def test_approving_an_assignment_assigns_the_team_and_a_rejection_needs_a_reason(api) -> None:
    client, ctx, _ = api
    mid = _mission(client)
    pid = _propose(ctx, mid)
    url = f"/missions/{mid}/proposals/{pid}/decide"
    assert client.post(url, json={"decision": "reject", "by": "SM"}).status_code == 422
    r = client.post(url, json={"decision": "approve", "by": "SM", "edits": {"briefing": "Edited."}})
    assert r.status_code == 200 and r.json()["briefing"] == "Edited."
    teams = {t["id"]: t["status"] for t in client.get(f"/missions/{mid}/state").json()["teams"]}
    assert teams["T2"] == "assigned"
    assert client.post(url, json={"decision": "approve", "by": "SM"}).status_code == 409


def test_an_approved_promotion_puts_the_detection_in_the_review_queue(api) -> None:
    client, ctx, _ = api
    mid = _mission(client)
    _upload(client, mid, ("a.jpg", drone_photo()))
    ctx.queue.join()
    pid = _propose(ctx, mid, kind="promote_detection", target={"detection": "f0001-d02"})
    client.post(f"/missions/{mid}/proposals/{pid}/decide", json={"decision": "approve", "by": "SM"})
    promoted = [
        e for e in ctx.store.events(mid) if e.type == "detection.new" and e.ref == "f0001-d02"
    ]
    assert promoted and promoted[0].data["promoted_by"] == pid


def test_clues(api) -> None:
    client, ctx, hooks = api
    mid = _mission(client)
    url = f"/missions/{mid}/clues"
    radio = {
        "kind": "object",
        "text": "blue backpack",
        "lat": None,
        "lon": None,
        "at_team_position": True,
        "reported_by": "T2",
        "source": "radio",
    }
    assert client.post(url, json=radio).status_code == 422  # no readback
    assert (
        client.post(url, json={**radio, "confirmed_by_turn": "r0003"}).status_code == 422
    )  # T2 has no position
    client.patch(f"/missions/{mid}/teams/T2", json={"position": {"lat": 49.376, "lon": -122.938}})
    assert (
        client.post(url, json={**radio, "confirmed_by_turn": "r0003"}).status_code == 422
    )  # no such turn
    ctx.store.trace(mid, committed_turn("r0003"))
    r = client.post(url, json={**radio, "confirmed_by_turn": "r0003"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert (
        body["id"] == "c001"
        and body["confirmed"]
        and body["lat"] == 49.376
        and body["radius_m"] == 30.0  # lane B default for an object
    )
    assert body["map"]["kind"] == "reweight" and body["map"]["source"] == "clue"  # C-L1
    assert ("on_clue", "c001") in hooks.calls


def test_a_review_tells_the_agent(api) -> None:
    client, ctx, hooks = api
    mid = _mission(client)
    _upload(client, mid, ("a.jpg", drone_photo()))
    ctx.queue.join()
    r = client.post(
        f"/missions/{mid}/reviews", json={"detection_id": "f0001-d01", "answer": "not_person"}
    )
    assert r.status_code == 200 and ("on_review", "f0001-d01", "not_person") in hooks.calls
    assert (
        client.post(
            f"/missions/{mid}/reviews", json={"detection_id": "f0009-d01", "answer": "person"}
        ).status_code
        == 404
    )


def test_tasks_need_a_pod_exactly_when_searched(api) -> None:
    client, _, _ = api
    mid = _mission(client)
    url = f"/missions/{mid}/tasks/B3"
    assert client.post(url, json={"state": "searched"}).status_code == 422
    assert client.post(url, json={"state": "assigned", "pod": 0.5}).status_code == 422
    assert client.post(url, json={"state": "searched", "pod": 0.95}).status_code == 422
    assert client.post(url, json={"state": "assigned", "team_id": "T2"}).status_code == 200


def _search(client: TestClient, mid: str, sector: str, pod: float) -> None:
    """Assign, start and mark searched, as the command view does."""
    url = f"/missions/{mid}/tasks/{sector}"
    for body in ({"state": "assigned", "team_id": "T2"}, {"state": "in_progress", "team_id": "T2"},
                 {"state": "searched", "team_id": "T2", "pod": pod}):  # fmt: skip
        assert client.post(url, json=body).status_code == 200, body


def test_tasks_move_only_as_the_command_view_moves_them(api) -> None:
    """LANE_E §7.2 / §9 test 2: proposed → assigned → in progress → searched, unassign, reopen."""
    client, _, _ = api
    mid = _mission(client)
    url = f"/missions/{mid}/tasks/B3"
    r = client.post(url, json={"state": "searched", "pod": 0.6})
    assert r.status_code == 422 and "can't go from proposed to searched" in r.text
    assert client.post(url, json={"state": "in_progress", "team_id": "T2"}).status_code == 422
    assert client.post(url, json={"state": "assigned", "team_id": "T2"}).status_code == 200
    assert (
        client.post(url, json={"state": "assigned", "team_id": "T3"}).status_code == 200
    )  # reassign
    assert client.post(url, json={"state": "proposed"}).status_code == 200  # unassign
    _search(client, mid, "B3", 0.5)
    assert client.post(url, json={"state": "in_progress", "team_id": "T2"}).status_code == 422
    assert client.post(url, json={"state": "proposed"}).status_code == 200  # reopen
    _search(client, mid, "C2", 0.9)
    r = client.post(f"/missions/{mid}/tasks/A1", json={"state": "assigned", "team_id": "T1"})
    client.post(f"/missions/{mid}/tasks/A1", json={"state": "in_progress", "team_id": "T1"})
    r = client.post(f"/missions/{mid}/tasks/A1", json={"state": "searched", "pod": 0.0})
    assert r.status_code == 422 and "above 0" in r.text


def test_conditions_and_what_other_lanes_still_owe(api) -> None:
    client, _, _ = api
    mid = _mission(client)
    c = client.post(f"/missions/{mid}/conditions/refresh").json()  # lane B's, with the fake Tavily
    assert (
        c["sunset"] and c["civil_twilight_end"] and c["sources"]
    )  # sun times are computed locally
    assert c["wind_kmh"] is None  # no model in tests: nothing is filled without a quote
    assert (
        client.get(f"/missions/{mid}/cards/B3").json()["sector_label"] == "Bravo Three"
    )  # lane B's cards
    assert client.get(f"/missions/{mid}/debrief.md").text.startswith(
        "# Debrief"
    )  # lane C's debrief
    tele = {"drones": [], "leg_status": {}, "at": "2026-10-24T21:40:00Z"}
    assert client.put(f"/missions/{mid}/fleet", json=tele).status_code == 409  # no fleet yet


# --- test 6: SSE ------------------------------------------------------------------------------


def test_sse_resumes_after_last_event_id_and_sends_heartbeats(tmp_path: Path) -> None:
    store = MissionStore(tmp_path)
    mid = store.create("m", "a", LatLon(**LKP), "live").mission_id
    for k in range(3):
        store.emit(mid, "mission.note", f"note {k}")

    async def run() -> list[str]:
        out: list[str] = []
        stream = event_stream(store.subscribe(mid, "e00001"), heartbeat_s=0.05)
        async for chunk in stream:
            out.append(chunk)
            if chunk.startswith(": heartbeat"):
                break
        await stream.aclose()
        return out

    chunks = asyncio.run(asyncio.wait_for(run(), 5))
    assert [c.split("\n")[1] for c in chunks[:2]] == ["id: e00002", "id: e00003"]  # resumed
    assert chunks[0].startswith("event: mission.note\n") and chunks[0].endswith("\n\n")
    assert chunks[-1] == ": heartbeat\n\n"
    assert format_event(store.events(mid)[0]).startswith("event: mission.note\nid: e00001\ndata: {")


def test_reassigning_a_searched_sector_clears_its_pod(api) -> None:
    """Found by the smoke test: the task kept POD 0.6 while "assigned"."""
    client, ctx, _ = api
    mid = _mission(client)
    _search(client, mid, "B3", 0.6)
    pid = _propose(ctx, mid)
    assert (
        client.post(
            f"/missions/{mid}/proposals/{pid}/decide", json={"decision": "approve", "by": "SM"}
        ).status_code
        == 200
    )
    task = next(
        t for t in client.get(f"/missions/{mid}/state").json()["tasks"] if t["sector_id"] == "B3"
    )
    assert (task["state"], task["team_id"], task["pod"]) == ("assigned", "T2", None)
    assert validate_mission(ctx.store.root, mid) == []


def test_a_photo_delivered_twice_is_processed_once(api) -> None:
    """SQS delivers at least once."""
    from sightline.mission.pipeline import PhotoJob, ingest_photo

    client, ctx, _ = api
    mid = _mission(client)
    _upload(client, mid, ("a.jpg", drone_photo()))
    ctx.queue.join()
    again = ingest_photo(
        ctx.store, PhotoJob(mid, "f0001", "frames/orig/f0001.jpg", "now"), detector=FakeDetector()
    )
    assert again["skipped"] == "already processed"
    assert len(ctx.store.survey(mid).frames) == 1


def test_a_photo_outside_the_search_area_says_so(api) -> None:
    """A mistyped last known position looks like this: the photo's footprint misses the grid."""
    client, ctx, _ = api
    r = client.post(
        "/missions", json={"name": "Far", "area_name": "x", "lkp": {"lat": 43.5, "lon": 16.4}}
    )
    mid = r.json()["mission_id"]
    _upload(client, mid, ("a.jpg", drone_photo()))  # taken at Mount Seymour
    ctx.queue.join()
    done = next(e for e in ctx.store.events(mid) if e.type == "photo.processed")
    assert done.data["map"].startswith("photo outside the search area")


def test_sectors_report_live_poa_and_drone_coverage(api) -> None:
    client, ctx, _ = api
    mid = _mission(client)
    before = {s["sector_id"]: s for s in client.get(f"/missions/{mid}/sectors").json()}
    assert (
        len(before) == 16
        and before["B3"]["label"] == "Bravo Three"
        and before["B3"]["drone_coverage"] == 0
    )
    _upload(client, mid, ("a.jpg", drone_photo()))
    ctx.queue.join()
    after = client.get(f"/missions/{mid}/sectors").json()
    looked = [s for s in after if s["drone_coverage"] > 0]
    assert looked and all(
        s["poa"] < before[s["sector_id"]]["poa"] for s in looked
    )  # a look lowers POA
