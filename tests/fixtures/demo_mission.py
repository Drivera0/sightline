"""The command view's demo mission (``web/src/command/__fixtures__/demo_mission.json``, made by
``scripts/make_command_fixtures.py``) loaded into a ``MissionStore``: its mission, teams, tasks,
clues, proposals, fleet and conditions, and a ``decision`` trace entry for every decided proposal
(as ``POST /proposals/{pid}/decide`` writes it). The map is a fresh ``start_map_base`` on the same
LKP; the mission keeps the fixture's name and times."""

from __future__ import annotations

import json
from pathlib import Path

from sightline.contract import (
    Clue,
    Conditions,
    FleetState,
    Mission,
    Proposal,
    SectorTask,
    Team,
    TraceEntry,
)
from sightline.mission import MissionStore
from sightline.mission.pipeline import start_map_base

FIXTURE = Path(__file__).resolve().parents[2] / "web/src/command/__fixtures__/demo_mission.json"
NOW = "2026-10-24T22:00:00Z"  # the fixture's "now"


def seed_demo(store: MissionStore) -> str:
    d = json.loads(FIXTURE.read_text())
    m = Mission.model_validate(d["mission"])
    mid = store.create(
        m.name, m.area.name, m.area.lkp, m.mode, m.last_seen_at, m.subject
    ).mission_id
    store._save(store._dir(mid), "mission.json", m.model_copy(update={"mission_id": mid}))
    store.put_map_base(mid, start_map_base(m.area.lkp, subject=m.subject))
    for t in d["teams"]:
        store.upsert_team(mid, Team.model_validate(t))
    for t in d["tasks"]:
        store.upsert_task(mid, SectorTask.model_validate(t))
    for c in d["clues"]:
        store.add_clue(mid, Clue.model_validate(c))
    for p in d["proposals"]:
        p = store.add_proposal(mid, Proposal.model_validate(p))
        if p.decided_at:
            store.trace(mid, TraceEntry(
                id="", at=p.decided_at, actor="human", kind="decision",
                summary=f"{p.id} {p.status} by {p.decided_by}", input=None,
                output={"proposal": p.id, "status": p.status, "by": p.decided_by},
                model=None, ms=None, tokens_in=None, tokens_out=None, refs=[p.id],
            ))  # fmt: skip
    store.put_fleet(mid, FleetState.model_validate(d["fleet"]))
    store.put_conditions(mid, Conditions.model_validate(d["conditions"]))
    return mid
