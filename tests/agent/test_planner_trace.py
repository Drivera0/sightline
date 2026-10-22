"""The planner in the trace (agent.md, "The planner as a tool call"): on the real store and API, a
re-plan and a team assignment each start with a planner ``tool_call`` (map version, drones or teams,
sectors considered in; ranked sectors with scores and evidence lines out), then the briefing's
``model_call``, the proposal and the decision, in one chain; ``GET /missions/{id}/trace`` returns
it. Each reason names what moved its sector since the last plan, from the map log."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sightline.agent import loop
from sightline.agent.llm import FakeChatClient
from sightline.api.app import create_app
from sightline.api.missions import MissionContext
from sightline.mission import MissionStore
from sightline.mission.queue import LocalQueue
from sightline.search.planner import REASON_WORDS
from tests.fixtures.drone_photos import LKP

AT = "2026-10-24T20:05:00Z"
DRONE = {"id": "D1", "name": "Drone 1", "simulated": True, "position": LKP, "altitude_m": 50.0,
         "speed_ms": 8.0, "battery_pct": 90.0, "max_wind_kmh": 43.2, "status": "idle",
         "leg_id": None}  # fmt: skip
NEVER = re.compile(r"\bclear(s|ed|ing)?\b|\brul(e|es|ed|ing) out\b", re.IGNORECASE)
BRIEFING = "Team One, Sightline. Search the sector named in the facts and report what you find."


def _one_team(store: MissionStore, mid: str) -> None:
    """Team One on standby, the mission's other teams off duty."""
    for t in store.state(mid)["teams"]:
        status = "standby" if t.id == "T1" else "off_duty"
        store.upsert_team(mid, t.model_copy(update={"status": status, "position": None}))


class NoHooks:
    def __getattr__(self, name: str):
        return lambda *a: None


@pytest.fixture(autouse=True)
def _fresh_agent_memory():
    loop._last_conditions.clear()
    loop._recalled.clear()


@pytest.fixture
def api(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr("sightline.api.missions._first_conditions", lambda ctx, mid: None)
    store = MissionStore(tmp_path / "missions")
    ctx = MissionContext(store, queue=LocalQueue(), hooks=NoHooks())
    app = create_app(cache_root=tmp_path / "cache", data_root=tmp_path / "up", missions=ctx)
    with TestClient(app) as client:
        mid = client.post("/missions", json={"name": "Seymour", "area_name": "Mount Seymour",
                                             "lkp": LKP}).json()["mission_id"]  # fmt: skip
        yield client, store, mid


def _planner_calls(client: TestClient, mid: str, plan: str) -> list[dict]:
    trace = client.get(f"/missions/{mid}/trace").json()
    return [e for e in trace if e["actor"] == "planner" and e["kind"] == "tool_call"
            and e["output"]["plan"] == plan]  # fmt: skip


def _clue(client: TestClient, mid: str, text: str) -> dict:
    body = {"kind": "object", "text": text, "lat": LKP["lat"] + 0.001, "lon": LKP["lon"] + 0.001,
            "reliability": "high", "reported_by": "T1", "source": "form"}  # fmt: skip
    r = client.post(f"/missions/{mid}/clues", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_a_clue_replan_is_traced_as_a_planner_call_and_its_reason_names_the_clue(api) -> None:
    client, store, mid = api
    client.put(f"/missions/{mid}/fleet", json={"drones": [DRONE], "leg_status": {}, "at": AT})
    (opening,) = loop.handle("fleet_join", store, mid, mid, client=None)
    assert "no new evidence" in opening.reason  # nothing in the map log yet
    clue = _clue(client, mid, "red jacket snagged on a branch by the creek")
    (p,) = loop.handle("clue", store, mid, clue["id"], client=None)
    assert p.reason.startswith(f"After clue {clue['id']} in sector {p.leg.sector_id}. ")
    assert f"{clue['id']} (red jacket snagged on a…) raised it" in p.reason
    assert "expected to lower the remaining probability by" in p.reason
    assert len(p.reason.split()) <= REASON_WORDS and not NEVER.search(p.reason)

    first, second = _planner_calls(client, mid, "legs")
    assert first["input"]["map_seq"] == 0 and second["input"]["since_map_seq"] == 0
    assert second["input"]["map_seq"] == second["output"]["map_seq"] == 1  # the clue's reweight
    assert (
        second["input"]["drones"][0]["id"] == "D1"
        and len(second["input"]["sectors_considered"]) == 16
    )
    top = second["output"]["ranked"][0]
    assert set(top) >= {"sector", "score_per_min", "poa", "evidence"}
    assert top["evidence"].startswith(f"{top['sector']} · ")
    assert second["output"]["chosen"][0]["reason"] in p.reason
    assert {"D1", p.leg.sector_id, clue["id"]} <= set(second["refs"])

    # the next plan starts from the clue's map version: nothing new since, so nothing named
    (again,) = loop._replan(store, mid, "Leg L001 is done.", drone_id="D1")
    assert ": no new evidence" in again.reason and clue["id"] not in again.reason
    assert _planner_calls(client, mid, "legs")[-1]["input"]["since_map_seq"] == 1


def test_an_assignment_chain_reads_tool_call_model_call_proposal_decision(api) -> None:
    client, store, mid = api
    clue = _clue(client, mid, "boot prints heading east off the trail")
    _one_team(store, mid)
    briefer = FakeChatClient({"Facts:": BRIEFING})
    (p,) = loop.handle("tick", store, mid, mid, client=briefer)
    assert p.kind == "assign_sector" and len(p.reason.split()) <= REASON_WORDS
    assert not NEVER.search(p.reason)
    r = client.post(f"/missions/{mid}/proposals/{p.id}/decide",
                    json={"decision": "approve", "by": "SM"})  # fmt: skip
    assert r.status_code == 200, r.text

    trace = client.get(f"/missions/{mid}/trace").json()
    chain = [e for e in trace if {"T1", p.id} & set(e["refs"])]
    assert [e["kind"] for e in chain] == ["tool_call", "model_call", "proposal", "decision"]
    call = chain[0]
    assert call["actor"] == "planner" and call["summary"].startswith("propose_assignments: T1 → ")
    assert call["input"]["map_seq"] == 1 and call["input"]["since_map_seq"] == 0
    assert call["input"]["teams"] == [{"id": "T1", "callsign": "Team One", "status": "standby",
                                       "position": None}]  # fmt: skip
    ranked = call["output"]["ranked"]
    assert ranked and all({"sector", "score", "poa", "evidence"} <= set(r) for r in ranked)
    assert [r["score"] for r in ranked] == sorted((r["score"] for r in ranked), reverse=True)
    assert call["output"]["chosen"] == [{"team": "T1", "sector": p.target["sector"],
                                         "reason": p.reason}]  # fmt: skip
    assert chain[1]["input"]["facts"]["why"] == p.reason  # the briefing quotes the reason whole
    # the clue raised the sectors around it; a sector it moved names it
    moved = [r for r in ranked if clue["id"] in r["evidence"]]
    assert moved and all(
        "raised it" in r["evidence"] or "lowered it" in r["evidence"] for r in moved
    )


def test_a_tick_that_proposes_nothing_leaves_no_planner_entry(api) -> None:
    client, store, mid = api
    _one_team(store, mid)
    assert len(loop.handle("tick", store, mid, mid, client=None)) == 1
    assert loop.handle("tick", store, mid, mid, client=None) == []  # T1 has a pending assignment
    assert len(_planner_calls(client, mid, "assignments")) == 1
