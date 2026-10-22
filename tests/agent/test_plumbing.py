"""LANE_A §6 tests 4 (the parts that apply before verify.py exists), 6 and 7, plus the fake
store other lanes test against."""

from __future__ import annotations

import asyncio
import re
import time
from pathlib import Path

import pytest

from sightline.agent import hooks
from sightline.agent.llm import MODEL_VISION, FakeChatClient, with_images
from sightline.agent.runner import Runner
from sightline.agent.trace import trace_call
from sightline.contract import LatLon, Leg, Proposal
from tests.agent.fake_store import FakeMissionStore

KEY = "nb-test-key-0123456789abcdef"
CLEAR = re.compile(r"\bclear(ed)?\b", re.IGNORECASE)


@pytest.fixture
def store() -> FakeMissionStore:
    return FakeMissionStore()


@pytest.fixture
def mission_id(store: FakeMissionStore) -> str:
    return store.create(
        "Seymour test", "Seymour", LatLon(lat=49.39, lon=-122.94), "demo"
    ).mission_id


def _call_every_hook(store: FakeMissionStore, mission_id: str) -> None:
    hooks.on_detection(store, mission_id, "f0001-d01")
    hooks.on_review(store, mission_id, "f0001-d01", "unsure")
    hooks.on_clue(store, mission_id, "c001")
    hooks.on_conditions(store, mission_id)
    hooks.on_leg_done(store, mission_id, "L001")


# --- test 6: hooks return in < 5 ms (they only enqueue) -----------------------------------------


@pytest.fixture(autouse=True)
def runner():
    """A model-free runner for every test here, so no hook builds a real client."""
    r = Runner(client_factory=lambda: None, detector_factory=lambda: None)
    hooks.configure(r)
    yield r
    r.stop()
    hooks.configure(None)


def test_hooks_return_fast_and_enqueue(store, mission_id, runner) -> None:
    _call_every_hook(store, mission_id)  # warm up: starts the agent thread
    runner.drain()
    for name, args in [
        ("on_detection", ("f0001-d01",)),
        ("on_review", ("f0001-d01", "person")),
        ("on_clue", ("c001",)),
        ("on_conditions", ()),
        ("on_leg_done", ("L001",)),
        ("on_task_searched", ("B2",)),
        ("on_team_position", ("T1",)),
        ("on_tick", ()),
    ]:
        start = time.perf_counter()
        getattr(hooks, name)(store, mission_id, *args)
        assert time.perf_counter() - start < 0.005, name
    runner.drain()


def test_a_failing_job_is_logged_never_raised(caplog, runner) -> None:
    class Broken:
        def get_detection(self, *_):
            raise OSError("disk full")

        def trace(self, *_):
            raise OSError("disk full")

    hooks.on_detection(Broken(), "m", "f0001-d01")  # returns normally
    runner.drain()
    assert "agent detection f0001-d01 failed" in caplog.text


# --- test 7: no secrets in the trace ----------------------------------------------------------


def test_api_key_never_reaches_the_trace(store, mission_id, monkeypatch) -> None:
    monkeypatch.setenv("NEBIUS_API_KEY", KEY)
    trace_call(
        store,
        mission_id,
        actor="verifier",
        kind="model_call",
        summary=f"called with {KEY}",
        input={"api_key": KEY, "headers": {"Authorization": f"Bearer {KEY}"}, "note": KEY},
        output={"echo": f"key={KEY}"},
    )
    _call_every_hook(store, mission_id)
    text = store.trace_jsonl(mission_id)
    assert KEY not in text
    assert "[redacted]" in text


# --- test 4 (what applies today): one model call, image paths only ------------------------------


def test_model_call_trace_has_image_paths_never_base64(store, mission_id, tmp_path) -> None:
    crop = tmp_path / "crops" / "f0001-d01.jpg"
    crop.parent.mkdir()
    crop.write_bytes(b"\xff\xd8" + bytes(range(256)) * 8)
    client = FakeChatClient({"crop": ["{not json", '{"person": "unclear"}']})
    messages = [{"role": "user", "content": "Is there a person in this crop?"}]

    first = client.chat(messages, model=MODEL_VISION, images=[crop], temperature=0)
    second = client.chat(messages, model=MODEL_VISION, images=[crop], temperature=0)
    assert first.text == "{not json" and second.text == '{"person": "unclear"}'

    sent = with_images(messages, [crop])  # what the real client sends: a base64 data URI
    trace_call(
        store,
        mission_id,
        actor="verifier",
        kind="model_call",
        summary="VL verdict for f0001-d01",
        input={"messages": sent, "images": [Path("crops/f0001-d01.jpg")]},
        result=second,
        refs=["f0001-d01"],
    )
    entries = store.trace_entries(mission_id)
    assert [e.kind for e in entries] == ["model_call"]
    text = store.trace_jsonl(mission_id)
    assert "base64," not in text
    assert "crops/f0001-d01.jpg" in text
    assert entries[0].model == MODEL_VISION


# --- the fake store itself --------------------------------------------------------------------


def _proposal(**kw) -> Proposal:
    base = {
        "id": "",
        "kind": "drone_leg",
        "summary": "Send Drone 1 to sector B2",
        "reason": "1.8x the expected gain of continuing the grid",
        "briefing": None,
        "target": {"drone": "D1"},
        "leg": None,
        "evidence": [],
        "status": "pending",
        "created_by": "agent",
        "created_at": "2026-10-21T17:00:00.000Z",
        "decided_at": None,
        "decided_by": None,
        "decision_reason": None,
        "edits": None,
    }
    return Proposal(**{**base, **kw})


def test_ids_follow_the_contract_widths(store, mission_id) -> None:
    assert [store.next_id(mission_id, k) for k in ("p", "v", "L", "c")] == [
        "p001",
        "v0001",
        "L001",
        "c001",
    ]
    assert len(store.get(mission_id).mission_id) == 8


def test_proposals_are_added_decided_and_superseded(store, mission_id) -> None:
    leg = Leg(
        id="L001",
        drone_id="D1",
        sector_id="B2",
        waypoints=[(-122.9, 49.4)],
        altitude_m=60,
        est_minutes=8,
        expected_clearance=0.1,
        score_per_min=0.01,
        reason="r",
        status="proposed",
    )
    a = store.add_proposal(mission_id, _proposal(leg=leg))
    b = store.add_proposal(mission_id, _proposal())
    assert (a.id, b.id) == ("p001", "p002")
    assert store.set_proposal_status(mission_id, a.id, "superseded", "agent").status == "superseded"
    d = store.decide_proposal(mission_id, b.id, "approve", "command", reason="ok")
    assert d.status == "approved" and d.decided_by == "command" and d.decided_at
    with pytest.raises(ValueError):
        store.decide_proposal(mission_id, b.id, "reject", "command")
    types = [e.type for e in store.events(mission_id)]
    assert types == ["proposal.new", "proposal.new", "proposal.decided", "proposal.decided"]


def test_subscribe_resumes_after_an_event(store, mission_id) -> None:
    for i in range(3):
        store.emit(mission_id, "mission.note", f"n{i}")

    async def collect(after: str | None) -> list[str]:
        return [e.summary async for e in store.subscribe(mission_id, after)]

    assert asyncio.run(collect(None)) == ["n0", "n1", "n2"]
    assert asyncio.run(collect("e00001")) == ["n1", "n2"]


def test_live_needs_a_map_until_c_lands(store, mission_id) -> None:
    with pytest.raises(NotImplementedError):
        store.live(mission_id)
    store.live_maps[mission_id] = sentinel = object()
    assert store.live(mission_id) is sentinel


def test_no_committed_trace_carries_a_secret() -> None:
    """§6 test 7, on the real thing: every trace committed to the repo (the report's evidence) has no
    API key, bearer token or key-shaped string."""
    import re
    import subprocess
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    files = subprocess.run(
        ["git", "ls-files", "*.jsonl"], cwd=root, capture_output=True, text=True, check=True
    ).stdout.split()
    assert files, "no committed traces found"
    secret = re.compile(
        r"Bearer\s+[A-Za-z0-9._-]{12,}|tvly-[A-Za-z0-9]{8,}|nvapi-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|\"api_key\":\s*\"[^\"\[]"
    )
    for f in files:
        text = (root / f).read_text(encoding="utf-8")
        assert not secret.search(text), f
