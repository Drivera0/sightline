"""``validate_mission()``: contract §12.3 invariants on a mission folder (LANE_D §4, D-M0).

Returns a list of problems, ``[]`` when the mission is valid. Reads files only (never writes), so
it can run on a live mission, in tests after each scenario, and in the smoke test.

Done by lane A for lane D (issue #51); lane D owns this file.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import numpy as np
from pydantic import BaseModel, ValidationError

from sightline.contract import (
    Clue,
    Conditions,
    Detections,
    FleetState,
    MapBase,
    MapUpdate,
    Mission,
    MissionEvent,
    Proposal,
    SectorTask,
    Survey,
    Team,
    TraceEntry,
    Verdict,
)
from sightline.mission._live import MAX_FACTOR, apply_update

GROUND_POD_MAX = 0.9
SUM_TOLERANCE = 1e-9
_CLEAR = re.compile(r"\bclear(ed)?\b", re.IGNORECASE)
_TEXT_KEYS = {"summary", "reason", "briefing", "note", "decision_reason"}  # invariant 4
# Ground truth must never reach a mission file (contract §2): person boxes, which photos hold a person.
_TRUTH_KEY = re.compile(r"truth|^gt_|_gt$|has_person|hidden_person|person_box", re.IGNORECASE)

_JSON_FILES: dict[str, type[BaseModel] | tuple[type[BaseModel]]] = {
    "mission.json": Mission,
    "survey.json": Survey,
    "detections.json": Detections,
    "map_base.json": MapBase,
    "fleet.json": FleetState,
    "conditions.json": Conditions,
    "tasks.json": (SectorTask,),
    "teams.json": (Team,),
    "clues.json": (Clue,),
    "proposals.json": (Proposal,),
    "verdicts.json": (Verdict,),
}
_JSONL_FILES: dict[str, type[BaseModel]] = {
    "map_updates.jsonl": MapUpdate,
    "events.jsonl": MissionEvent,
    "trace.jsonl": TraceEntry,
}


def _why(e: Exception) -> str:
    """One line: the first field that failed and why."""
    if isinstance(e, ValidationError) and e.errors():
        err = e.errors()[0]
        return f"{'.'.join(str(x) for x in err['loc'])}: {err['msg']}"
    return str(e).splitlines()[0]


def _walk(node: Any, path: str = ""):
    """(path, key, value) for every dict entry, recursively."""
    if isinstance(node, dict):
        for k, v in node.items():
            yield f"{path}.{k}", k, v
            yield from _walk(v, f"{path}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _walk(v, f"{path}[{i}]")


def validate_mission(root: Path, mission_id: str) -> list[str]:
    d = Path(root) / mission_id
    if not (d / "mission.json").is_file():
        return [f"{d}: no mission.json"]
    problems: list[str] = []
    raw: dict[str, Any] = {}
    parsed: dict[str, Any] = {}

    # Every file parses with the contract models.
    for name, model in _JSON_FILES.items():
        if not (d / name).is_file():
            continue
        try:
            raw[name] = json.loads((d / name).read_text(encoding="utf-8"))
            if isinstance(model, tuple):
                parsed[name] = [model[0].model_validate(x) for x in raw[name]]
            else:
                parsed[name] = model.model_validate(raw[name])
        except (ValueError, ValidationError) as e:
            problems.append(f"{name}: does not parse: {_why(e)}")
    for name, model in _JSONL_FILES.items():
        rows, objs = [], []
        if (d / name).is_file():
            for n, line in enumerate((d / name).read_text(encoding="utf-8").splitlines(), 1):
                if not line.strip():
                    continue
                try:
                    rows.append(json.loads(line))
                    objs.append(model.model_validate(rows[-1]))
                except (ValueError, ValidationError) as e:
                    problems.append(f"{name} line {n}: does not parse: {_why(e)}")
        raw[name], parsed[name] = rows, objs

    updates: list[MapUpdate] = parsed["map_updates.jsonl"]
    base: MapBase | None = parsed.get("map_base.json")
    tasks: list[SectorTask] = parsed.get("tasks.json", [])
    proposals: list[Proposal] = parsed.get("proposals.json", [])
    clues: list[Clue] = parsed.get("clues.json", [])
    trace: list[TraceEntry] = parsed["trace.jsonl"]
    fleet: FleetState | None = parsed.get("fleet.json")

    # 1. seq 1..n, no gaps; replaying every update on the prior keeps the total at 1.
    seqs = [u.seq for u in updates]
    if seqs != list(range(1, len(seqs) + 1)):
        problems.append(f"map_updates: seq must be 1..{len(seqs)} with no gaps, got {seqs[:20]}")
    if updates and base is None:
        problems.append("map_updates without map_base.json")

    # 2. step pods ≤ pod_cap; reweight factors in (0, 20].
    if base is not None:
        cap = base.params.pod_cap
        n_cells = len(base.prior.p)
        for u in updates:
            for idx, v in u.cells:
                if not 0 <= idx < n_cells:
                    problems.append(f"map update {u.seq}: cell {idx} outside the grid")
                elif u.kind == "step" and not 0 <= v <= cap:
                    problems.append(f"map update {u.seq}: pod {v} on cell {idx} > pod_cap {cap}")
                elif u.kind == "reweight" and not 0 < v <= MAX_FACTOR:
                    problems.append(f"map update {u.seq}: factor {v} on cell {idx} not in (0, 20]")
        if not any("map update" in p for p in problems):
            p, outside = np.asarray(base.prior.p, dtype=np.float64), float(base.prior.outside)
            for u in updates:
                try:
                    p, outside = apply_update(p, outside, u)
                except ValueError as e:
                    problems.append(f"map update {u.seq}: {e}")
                    break
            total = float(p.sum()) + outside
            if abs(total - 1.0) > SUM_TOLERANCE:
                problems.append(f"map: replayed sum(p) + outside = {total!r}, not 1")

    # 3. A task's POD is set iff it is searched, and ≤ 0.9 (ground search never rules out all).
    for t in tasks:
        if (t.pod is not None) != (t.state == "searched"):
            problems.append(f"task {t.sector_id}: pod must be set exactly when state is searched")
        if t.pod is not None and t.pod > GROUND_POD_MAX:
            problems.append(f"task {t.sector_id}: pod {t.pod} > {GROUND_POD_MAX}")

    # 4. Nothing says an area is "clear"/"cleared"; 7. no ground truth.
    for name, data in raw.items():
        for path, key, value in _walk(data, name):
            if key in _TEXT_KEYS and isinstance(value, str) and _CLEAR.search(value):
                problems.append(f'{path}: says "clear"/"cleared": {value[:80]!r}')
            if _TRUTH_KEY.search(str(key)):
                problems.append(f"{path}: ground truth must never be in a mission file")

    # 5. Decided proposals say when and by whom; pending ones don't; only approved briefings
    # are transmitted.
    by_id = {p.id: p for p in proposals}
    for p in proposals:
        decided = p.decided_at is not None and p.decided_by is not None
        if p.status != "pending" and not decided:
            problems.append(f"proposal {p.id}: {p.status} without decided_at and decided_by")
        if p.status == "pending" and (p.decided_at or p.decided_by):
            problems.append(f"proposal {p.id}: pending but has decided_at/decided_by")
    radio_turns = [e.output or {} for e in trace if e.kind == "radio_turn"]
    for turn in radio_turns:
        if turn.get("direction") != "out":
            continue
        for action in turn.get("actions", []):
            m = re.match(r"transmit (\S+)", action)
            if m and getattr(by_id.get(m.group(1)), "status", None) != "approved":
                problems.append(
                    f"radio turn {turn.get('id')}: transmitted {m.group(1)}, not approved"
                )

    # 6. Radio clues are confirmed by a committed readback turn.
    committed = {t.get("id") for t in radio_turns if t.get("state") == "committed"}
    for c in clues:
        if c.source == "radio" and not (c.confirmed and c.confirmed_by_turn in committed):
            problems.append(f"clue {c.id}: radio clue without a committed readback turn")

    # 8. A leg is approved (or cancelled) only by a decision: every leg past "proposed" belongs
    # to an approved leg proposal.
    if fleet is not None:
        approved_legs = {
            (p.leg.id if p.leg else p.target.get("leg"))
            for p in proposals
            if p.status == "approved" and p.kind in ("drone_leg", "retask_drone")
        }
        for leg in fleet.legs:
            if leg.status != "proposed" and leg.id not in approved_legs:
                problems.append(f"leg {leg.id}: {leg.status} without an approved proposal")

    return problems
