"""The mission debrief (LANE_C §6 test 8, C-D1) and D-R5's endpoint serving it."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sightline.agent.llm import FakeChatClient
from sightline.api.app import create_app
from sightline.api.missions import MissionContext
from sightline.contract import Conditions, Proposal, SectorTask, Verdict
from sightline.mission.queue import LocalQueue
from sightline.mission.store import MissionStore
from sightline.search.debrief import _NUMBER, check_narrative, debrief
from tests.fixtures.drone_photos import LKP, drone_photo

AT = "2026-10-24T22:00:00Z"
FIX = Path(__file__).parents[1] / "geo" / "fixtures"


class _Det:
    def detect_tiled(self, path, conf: float = 0.05):
        from sightline.ml.types import Box, RawDetection

        return [RawDetection(Box(400, 300, 440, 360), 0.8)]


@pytest.fixture
def mission(tmp_path: Path):
    store = MissionStore(tmp_path / "missions")
    ctx = MissionContext(store, queue=LocalQueue(), detector_factory=lambda: _Det(), hooks=None)
    ctx.start()
    app = create_app(cache_root=tmp_path / "c", data_root=tmp_path / "u", missions=ctx)
    with TestClient(app) as client:
        mid = client.post(
            "/missions",
            json={"name": "Debrief", "area_name": "Mount Seymour", "lkp": LKP, "subject": "adult, red jacket"},
        ).json()["mission_id"]  # fmt: skip
        _log_a_search(client, ctx, store, mid)
        yield client, ctx, store, mid
    ctx.queue.stop()


def _log_a_search(client, ctx, store: MissionStore, mid: str) -> None:
    """A photo with a candidate, its second look and review, a decided proposal, a clue whose text
    says "clear", a searched sector and conditions."""
    client.post(
        f"/missions/{mid}/photos", files=[("files", ("a.jpg", drone_photo(), "image/jpeg"))]
    )
    ctx.queue.join()
    store.put_verdict(
        mid,
        Verdict(
            id="v0001", detection_id="f0001-d01", tools=["zoom_native"], relook_crops=[],
            person="yes", posture="sitting", group_size=1, clothing="red jacket",
            reason="a seated figure", model="m", ms=1, at=AT,
        ),
    )  # fmt: skip
    client.post(f"/missions/{mid}/reviews", json={"detection_id": "f0001-d01", "answer": "person"})
    pid = store.add_proposal(
        mid,
        Proposal(
            id="", kind="assign_sector", summary="Assign sector B3 to Team Two", reason="POA 6 %",
            briefing=None, target={"team": "T2", "sector": "B3"}, evidence=[], status="pending",
            created_by="planner", created_at=AT, decided_at=None, decided_by=None,
            decision_reason=None, edits=None,
        ),
    ).id  # fmt: skip
    client.post(f"/missions/{mid}/proposals/{pid}/decide", json={"decision": "approve", "by": "SM"})
    client.post(
        f"/missions/{mid}/clues",
        json={"kind": "track", "text": "boot prints, trail clear of snow", "lat": LKP["lat"],
              "lon": LKP["lon"], "reported_by": "T2", "source": "form"},
    )  # fmt: skip
    store.upsert_task(
        mid,
        SectorTask(sector_id="B3", state="searched", team_id="T2", poa=0.06, pod=0.5, note=None, updated_at=AT),
    )  # fmt: skip
    c = json.loads((FIX / "conditions_windy.json").read_text())["conditions"]
    store.put_conditions(mid, Conditions.model_validate(c))


def _md(store: MissionStore, mid: str, client=None) -> str:
    from sightline.mission.effects import sector_overview

    return debrief(
        store.state(mid), store.trace_entries(mid), store.events(mid), client,
        sectors=sector_overview(store, mid), now=AT,
    )  # fmt: skip


def test_the_tables_hold_the_log_and_never_say_clear(mission) -> None:
    _, _, store, mid = mission
    md = _md(store, mid)
    for heading in (
        "Timeline",
        "Sightings",
        "Proposals and decisions",
        "Sectors",
        "Conditions over time",
        "Clues",
    ):
        assert f"## {heading}" in md
    assert "| f0001-d01 | yes | red jacket, sitting | a seated figure | person |" in md
    assert "approved by SM" in md
    assert "searched by Team Two at POD 50 %" in md
    assert "gusts 55" in md and "boot prints" in md
    assert not __import__("re").search(r"\bclear(s|ed|ing)?\b", md, __import__("re").I)
    unsearched = md.split("## Not yet searched by a team, by POA")[1].split("##")[0]
    assert "| B3 |" not in unsearched and unsearched.count("\n| ") == 16  # 15 sectors + header
    assert "## Summary" not in md  # no client, no narrative


def test_a_narrative_uses_only_numbers_from_the_tables(mission) -> None:
    _, _, store, mid = mission
    good = "Team Two searched sector B3 at POD 50 %. The second look on f0001-d01 saw a person."
    bad = "Team Two searched 97 % of the area and it is clear."
    client = FakeChatClient(replies={"Tables": bad, "Rewrite": good})
    md = _md(store, mid, client)
    assert "## Summary" in md and good in md and len(client.calls) == 2
    retry = client.calls[1]["messages"][-1]["content"]
    assert "97" in retry and "clear" in retry  # told what was wrong
    tables = md.split("## Timeline")[1]
    assert all(n in _NUMBER.findall(tables) for n in _NUMBER.findall(good))


def test_two_bad_narratives_leave_only_the_tables(mission) -> None:
    _, _, store, mid = mission
    md = _md(store, mid, FakeChatClient(default="Sector B3 was cleared."))
    assert "## Summary" not in md and "cleared" not in md
    assert check_narrative("POD 12 %", "POD 50 %") == ["numbers not in the tables: ['12']"]


def test_the_api_serves_it(mission) -> None:
    client, ctx, _, mid = mission
    r = client.get(f"/missions/{mid}/debrief.md")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/markdown")
    assert r.text.startswith("# Debrief: Debrief") and "## Summary" not in r.text
    ctx.chat_factory = lambda: FakeChatClient(default="Team Two searched sector B3 at POD 50 %.")
    assert "## Summary" in client.get(f"/missions/{mid}/debrief.md?narrative=true").text
    assert client.get("/missions/nope/debrief.md").status_code == 404
