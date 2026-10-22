"""The radio desk on a live mission (D-R4): radio_router in the mission API app, over the store."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sightline.agent.llm import ChatResult, FakeChatClient
from sightline.api.app import create_app
from sightline.api.missions import MissionContext
from sightline.contract import Proposal
from sightline.mission import MissionStore, validate_mission
from sightline.mission.queue import LocalQueue
from tests.fixtures.drone_photos import LKP

CLUE = {
    "team_id": "T2",
    "kind": "object",
    "text": "blue backpack by the creek",
    "at_team_position": True,
}
REPORT = "Sightline, Team Two. Found a blue backpack by the creek, our position, over."


@pytest.fixture
def radio(tmp_path: Path):
    store = MissionStore(tmp_path / "missions")
    ctx = MissionContext(store, queue=LocalQueue(), detector_factory=object, hooks=None)
    app = create_app(
        cache_root=tmp_path / "c", data_root=tmp_path / "u", missions=ctx, radio="text"
    )
    llm = FakeChatClient(
        {
            "backpack": [
                ChatResult(
                    "", [{"id": "c1", "name": "draft_clue", "arguments": CLUE}], "m", 1, 1, 1
                ),
                "unused",
            ]
        }
    )
    app.state.radio.llm = llm
    with TestClient(app) as client:
        r = client.post("/missions", json={"name": "Radio", "area_name": "Seymour", "lkp": LKP})
        mid = r.json()["mission_id"]
        client.patch(
            f"/missions/{mid}/teams/T2", json={"position": {"lat": 49.3745, "lon": -122.9358}}
        )
        yield client, store, mid
    app.state.radio.wait()


def _say(client: TestClient, mid: str, text: str) -> dict:
    r = client.post(f"/missions/{mid}/radio/turn", data={"text": text, "callsign_hint": "T2"})
    assert r.status_code == 200, r.text
    return r.json()


def test_a_voice_clue_becomes_a_real_clue_after_the_readback(radio) -> None:
    client, store, mid = radio
    first = _say(client, mid, REPORT)
    assert first["state"] == "awaiting_confirm" and store.state(mid)["clues"] == []
    second = _say(client, mid, "Affirmative, over.")
    assert second["state"] == "committed" and second["clue"]["id"] == "c001"
    clue = store.state(mid)["clues"][0]
    assert clue.source == "radio" and clue.confirmed and clue.confirmed_by_turn == second["id"]
    assert (clue.lat, clue.lon) == (49.3745, -122.9358)  # the team's position
    turns = [e for e in store.trace_entries(mid) if e.kind == "radio_turn"]
    assert [t.output["state"] for t in turns] == ["awaiting_confirm", "committed"]  # each once
    assert sum(e.type == "radio.turn" for e in store.events(mid)) == 2
    assert validate_mission(store.root, mid) == []
    assert list((store.root / mid / "radio").glob("*.wav"))  # audio inside the mission folder


def test_only_approved_briefings_go_out(radio) -> None:
    client, store, mid = radio
    p = store.add_proposal(
        mid,
        Proposal(
            id="",
            kind="assign_sector",
            summary="Assign sector B3 to Team Two",
            reason="r",
            briefing="New assignment, sector Bravo Three.",
            target={"team": "T2", "sector": "B3"},
            evidence=[],
            status="pending",
            created_by="agent",
            created_at="2026-10-24T21:40:00Z",
            decided_at=None,
            decided_by=None,
            decision_reason=None,
            edits=None,
        ),
    )
    assert client.get(f"/missions/{mid}/radio/outbound").json() == []
    client.post(
        f"/missions/{mid}/proposals/{p.id}/decide",
        json={
            "decision": "approve",
            "by": "SM",
            "edits": {"briefing": "New assignment, sector Bravo Three, east ridge."},
        },
    )
    out = client.get(f"/missions/{mid}/radio/outbound").json()
    assert [o["id"] for o in out] == [p.id]
    sent = client.post(f"/missions/{mid}/radio/outbound/{p.id}/transmit").json()
    assert (
        sent["reply"]
        == "Team Two, Sightline. New assignment, sector Bravo Three, east ridge, over."
    )  # the edited text
    assert validate_mission(store.root, mid) == []


def test_a_turn_reusing_an_earlier_id_is_still_recorded(radio) -> None:
    """Found by the smoke test: ids restart at r0001 each radio session, and a transmitted r0001
    was dropped as already recorded."""
    from tests.fixtures.mission import committed_turn

    client, store, mid = radio
    store.trace(mid, committed_turn("r0001"))  # an earlier session's r0001
    p = store.add_proposal(
        mid,
        Proposal(
            id="",
            kind="alert",
            summary="Alert all teams",
            reason="r",
            briefing="Weather alert.",
            target={"team": "all"},
            evidence=[],
            status="pending",
            created_by="agent",
            created_at="2026-10-24T21:40:00Z",
            decided_at=None,
            decided_by=None,
            decision_reason=None,
            edits=None,
        ),
    )
    client.post(
        f"/missions/{mid}/proposals/{p.id}/decide", json={"decision": "approve", "by": "SM"}
    )
    sent = client.post(f"/missions/{mid}/radio/outbound/{p.id}/transmit").json()
    assert sent["id"] == "r0001"
    turns = [e.output for e in store.trace_entries(mid) if e.kind == "radio_turn"]
    assert [(t["id"], t["state"]) for t in turns] == [
        ("r0001", "committed"),
        ("r0001", "transmitted"),
    ]
