"""Contract 15.7: the review answers "not_subject" (a person, not the one we look for) and "object" (a
thing the person may have left: a clue candidate, low reliability until a team confirms it), with
API, trace, timeline and map entries."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sightline.api.app import create_app
from sightline.api.missions import MissionContext
from sightline.mission import MissionStore, validate_mission
from sightline.mission.queue import LocalQueue
from sightline.mission.timeline import mission_timeline
from sightline.search.live import CLUE_FACTOR
from tests.fixtures.drone_photos import LKP, drone_photo
from tests.pipeline.test_mission_api import FakeDetector, Hooks


@pytest.fixture
def api(tmp_path: Path):
    store = MissionStore(tmp_path / "missions")
    hooks = Hooks()
    ctx = MissionContext(store, queue=LocalQueue(), detector_factory=FakeDetector, hooks=hooks)
    ctx.start()
    app = create_app(cache_root=tmp_path / "cache", data_root=tmp_path / "up", missions=ctx)
    with TestClient(app) as client:
        r = client.post("/missions", json={"name": "S", "area_name": "Mount Seymour", "lkp": LKP})
        mid = r.json()["mission_id"]
        client.post(
            f"/missions/{mid}/photos", files=[("files", ("a.jpg", drone_photo(), "image/jpeg"))]
        )
        ctx.queue.join()
        yield client, store, mid, hooks
    ctx.queue.stop()


def test_not_the_subject_counts_the_look_like_not_a_person(api) -> None:
    client, store, mid, hooks = api
    r = client.post(f"/missions/{mid}/reviews",
                    json={"detection_id": "f0001-d01", "answer": "not_subject", "by": "Reviewer A"})  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["kind"] == "step" and r.json()["source"] == "review"
    assert ("on_review", "f0001-d01", "not_subject") in hooks.calls
    assert not store.state(mid)["clues"]  # no clue for other hikers
    trace = [t for t in store.trace_entries(mid) if t.kind == "decision"]
    assert trace[-1].actor == "human" and trace[-1].output["answer"] == "not_subject"
    line = [x for x in mission_timeline(store, mid) if x.kind == "detection"][-1]
    assert "not the subject" in line.text and line.by == "Reviewer A" and "f0001-d01" in line.refs


def test_an_object_becomes_a_clue_candidate_at_low_reliability(api) -> None:
    client, store, mid, hooks = api
    r = client.post(f"/missions/{mid}/reviews",
                    json={"detection_id": "f0001-d01", "answer": "object", "object": "backpack"})  # fmt: skip
    assert r.status_code == 200, r.text
    clue = store.state(mid)["clues"][0]
    assert (clue.kind, clue.source, clue.confirmed, clue.detection_id) == (
        "object",
        "review",
        False,
        "f0001-d01",
    )
    assert clue.reliability == "low" and "backpack" in clue.text
    assert ("on_clue", clue.id) in hooks.calls
    ups = [u for u in store.map_updates(mid) if u.source == "clue" and u.ref == clue.id]
    assert ups and max(f for _, f in ups[0].cells) == CLUE_FACTOR["low"]
    texts = [x.text for x in mission_timeline(store, mid)]
    assert any("an object (backpack)" in t and clue.id in t for t in texts)
    assert any(t.startswith("object: backpack") for t in texts)  # the clue line
    assert validate_mission(store.root, mid) == []


def test_a_team_confirms_the_candidate_and_the_map_moves_to_its_reliability(api) -> None:
    client, store, mid, _ = api
    client.post(f"/missions/{mid}/reviews",
                json={"detection_id": "f0001-d01", "answer": "object", "object": "fire ring"})  # fmt: skip
    cid = store.state(mid)["clues"][0].id
    r = client.post(f"/missions/{mid}/clues/{cid}/confirm",
                    json={"reliability": "high", "by": "Search manager", "team": "T2"})  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["confirmed"] and r.json()["reliability"] == "high"
    up = r.json()["map"]
    assert up["kind"] == "reweight" and up["ref"] == cid
    assert max(f for _, f in up["cells"]) == pytest.approx(CLUE_FACTOR["high"] / CLUE_FACTOR["low"])
    assert client.post(f"/missions/{mid}/clues/{cid}/confirm", json={"by": "x"}).status_code == 409
    assert client.post(f"/missions/{mid}/clues/c999/confirm", json={"by": "x"}).status_code == 404
    assert any(
        t.output and t.output.get("action") == "confirm_clue" for t in store.trace_entries(mid)
    )


def test_an_object_answer_needs_its_type_and_only_known_types(api) -> None:
    client, _, mid, _ = api
    url = f"/missions/{mid}/reviews"
    assert (
        client.post(url, json={"detection_id": "f0001-d01", "answer": "object"}).status_code == 422
    )
    bad = {"detection_id": "f0001-d01", "answer": "object", "object": "car"}
    assert client.post(url, json=bad).status_code == 422
    odd = {"detection_id": "f0001-d01", "answer": "not_person", "object": "backpack"}
    assert client.post(url, json=odd).status_code == 422
