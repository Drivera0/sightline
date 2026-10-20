"""In-memory ``MissionStore`` with the contract §14 signatures, for tests (LANE_A §3, §5.4).

Lanes A, B, C and E test against this until D's ``sightline.mission.store.MissionStore``
(D-M0) lands. It validates with the same models and assigns ids the same way, but writes no
files. ``live()`` returns whatever ``LiveMap`` the test put in ``live_maps`` (C-L1 not landed).

Extra helpers for tests: ``trace_entries``, ``trace_jsonl``, ``events``, ``files``.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from sightline.agent._contract_v12 import (
    Clue,
    Conditions,
    EventType,
    FleetState,
    FleetTelemetry,
    MapBase,
    MapUpdate,
    Mission,
    MissionEvent,
    Proposal,
    SectorTask,
    Team,
    TraceEntry,
    Verdict,
)
from sightline.contract import Area, Detection, Detections, Frame, LatLon, Survey

ID_WIDTH = {"p": 3, "c": 3, "v": 4, "L": 3, "e": 5, "t": 6}  # "p014", "v0021", "e00412", ...


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class _Mission:
    def __init__(self, mission: Mission) -> None:
        self.mission = mission
        self.counters: dict[str, int] = {}
        self.frames: list[Frame] = []
        self.detections: dict[str, list[Detection]] = {}
        self.map_base: MapBase | None = None
        self.map_updates: list[MapUpdate] = []
        self.verdicts: dict[str, Verdict] = {}
        self.proposals: dict[str, Proposal] = {}
        self.tasks: dict[str, SectorTask] = {}
        self.teams: dict[str, Team] = {}
        self.clues: dict[str, Clue] = {}
        self.fleet: FleetState | None = None
        self.conditions: Conditions | None = None
        self.events: list[MissionEvent] = []
        self.trace: list[TraceEntry] = []
        self.files: dict[str, bytes] = {}


class FakeMissionStore:
    def __init__(self, root: Path = Path("missions")) -> None:
        self.root = root
        self._m: dict[str, _Mission] = {}
        self.live_maps: dict[str, Any] = {}

    # --- helpers --------------------------------------------------------------------------

    def _get(self, mission_id: str) -> _Mission:
        try:
            return self._m[mission_id]
        except KeyError:
            raise KeyError(f"no mission {mission_id}") from None

    def trace_entries(self, mission_id: str) -> list[TraceEntry]:
        return list(self._get(mission_id).trace)

    def trace_jsonl(self, mission_id: str) -> str:
        return "\n".join(e.model_dump_json() for e in self._get(mission_id).trace)

    def events(self, mission_id: str) -> list[MissionEvent]:
        return list(self._get(mission_id).events)

    def files(self, mission_id: str) -> dict[str, bytes]:
        return dict(self._get(mission_id).files)

    # --- §14 ------------------------------------------------------------------------------

    def create(
        self,
        name: str,
        area_name: str,
        lkp: LatLon,
        mode: str,
        last_seen_at: str | None = None,
        subject: str | None = None,
    ) -> Mission:
        mission = Mission(
            contract_version="1.2",
            mission_id=f"{len(self._m) + 1:08x}",
            name=name,
            area=Area(name=area_name, lkp=lkp),
            created_at=_now(),
            mode=mode,  # type: ignore[arg-type]
            last_seen_at=last_seen_at,
            subject=subject,
        )
        self._m[mission.mission_id] = _Mission(mission)
        return mission

    def put_map_base(self, mission_id: str, base: MapBase) -> None:
        self._get(mission_id).map_base = MapBase.model_validate(base.model_dump())

    def live(self, mission_id: str) -> Any:
        self._get(mission_id)
        if mission_id not in self.live_maps:
            raise NotImplementedError("set store.live_maps[mission_id] (C-L1 LiveMap not landed)")
        return self.live_maps[mission_id]

    def next_id(self, mission_id: str, kind: str) -> str:
        m = self._get(mission_id)
        m.counters[kind] = m.counters.get(kind, 0) + 1
        return f"{kind}{m.counters[kind]:0{ID_WIDTH.get(kind, 3)}d}"

    def get(self, mission_id: str) -> Mission:
        return self._get(mission_id).mission

    def state(self, mission_id: str) -> dict:
        m = self._get(mission_id)
        return {
            "mission": m.mission,
            "tasks": list(m.tasks.values()),
            "teams": list(m.teams.values()),
            "clues": list(m.clues.values()),
            "proposals": list(m.proposals.values()),
            "verdicts": list(m.verdicts.values()),
            "fleet": m.fleet,
            "conditions": m.conditions,
            "events": m.events[-200:],
        }

    def append_frame(self, mission_id: str, frame: Frame, image_bytes: bytes) -> None:
        m = self._get(mission_id)
        m.frames.append(frame)
        m.files[frame.file] = image_bytes

    def set_frames(self, mission_id: str, frames: list[Frame]) -> None:
        self._get(mission_id).frames = list(frames)

    def survey(self, mission_id: str) -> Survey:
        m = self._get(mission_id)
        return Survey(
            contract_version="1.1",
            survey_id=mission_id,
            simulated_path=False,
            area=m.mission.area,
            frames=m.frames,
        )

    def detections(self, mission_id: str) -> Detections:
        return Detections(
            contract_version="1.1",
            model="fake",
            save_threshold=0.05,
            candidate_threshold=0.29,
            frames=self._get(mission_id).detections,
        )

    def get_detection(self, mission_id: str, detection_id: str) -> tuple[Detection, Frame]:
        m = self._get(mission_id)
        frame_id = detection_id.split("-")[0]
        det = next(d for d in m.detections.get(frame_id, []) if d.id == detection_id)
        frame = next(f for f in m.frames if f.id == frame_id)
        return det, frame

    def map_updates(self, mission_id: str, after_seq: int = 0) -> list[MapUpdate]:
        return [u for u in self._get(mission_id).map_updates if u.seq > after_seq]

    def read_file(self, mission_id: str, rel_path: str) -> bytes:
        return self._get(mission_id).files[rel_path]

    def append_detections(
        self, mission_id: str, frame_id: str, dets: list[Detection], crops: dict[str, bytes]
    ) -> None:
        m = self._get(mission_id)
        m.detections.setdefault(frame_id, []).extend(dets)
        m.files.update(crops)
        for d in dets:
            self.emit(mission_id, "detection.new", f"detection {d.id}", ref=d.id)

    def append_map_update(self, mission_id: str, update: MapUpdate) -> None:
        m = self._get(mission_id)
        u = update.model_copy(update={"seq": len(m.map_updates) + 1})
        m.map_updates.append(MapUpdate.model_validate(u.model_dump()))
        self.emit(mission_id, "map.updated", f"map update {u.seq}", ref=u.ref)

    def put_verdict(self, mission_id: str, v: Verdict) -> None:
        self._get(mission_id).verdicts[v.id] = Verdict.model_validate(v.model_dump())
        self.emit(mission_id, "verdict", f"verdict {v.id}", ref=v.detection_id)

    def add_proposal(self, mission_id: str, p: Proposal) -> Proposal:
        p = Proposal.model_validate({**p.model_dump(), "id": self.next_id(mission_id, "p")})
        self._get(mission_id).proposals[p.id] = p
        self.emit(mission_id, "proposal.new", p.summary, ref=p.id, data=p.model_dump())
        return p

    def decide_proposal(
        self,
        mission_id: str,
        pid: str,
        decision: str,
        by: str,
        reason: str | None = None,
        edits: dict | None = None,
    ) -> Proposal:
        m = self._get(mission_id)
        if decision not in ("approve", "reject"):
            raise ValueError(f"decision must be approve or reject, got {decision}")
        p = m.proposals[pid]
        if p.status != "pending":
            raise ValueError(f"{pid} is {p.status}, not pending")
        status = "approved" if decision == "approve" else "rejected"
        p = Proposal.model_validate(
            {
                **p.model_dump(),
                "status": status,
                "decided_at": _now(),
                "decided_by": by,
                "decision_reason": reason,
                "edits": edits,
            }
        )
        m.proposals[pid] = p
        if status == "approved" and p.leg is not None and m.fleet is not None:
            leg = p.leg.model_copy(update={"status": "approved"})
            m.fleet = m.fleet.model_copy(update={"legs": [*m.fleet.legs, leg]})
        self.emit(mission_id, "proposal.decided", f"{pid} {status}", ref=pid, data=p.model_dump())
        return p

    def set_proposal_status(
        self, mission_id: str, pid: str, status: Literal["superseded", "expired"], by: str
    ) -> Proposal:
        m = self._get(mission_id)
        p = m.proposals[pid].model_copy(
            update={"status": status, "decided_at": _now(), "decided_by": by}
        )
        m.proposals[pid] = p
        self.emit(mission_id, "proposal.decided", f"{pid} {status}", ref=pid, data=p.model_dump())
        return p

    def upsert_task(self, mission_id: str, task: SectorTask) -> None:
        self._get(mission_id).tasks[task.sector_id] = task
        self.emit(mission_id, "task.updated", f"sector {task.sector_id}", ref=task.sector_id)

    def upsert_team(self, mission_id: str, team: Team) -> None:
        self._get(mission_id).teams[team.id] = team
        self.emit(mission_id, "team.updated", f"team {team.id}", ref=team.id)

    def add_clue(self, mission_id: str, clue: Clue) -> Clue:
        clue = Clue.model_validate({**clue.model_dump(), "id": self.next_id(mission_id, "c")})
        self._get(mission_id).clues[clue.id] = clue
        self.emit(mission_id, "clue.added", clue.text, ref=clue.id, data=clue.model_dump())
        return clue

    def put_fleet(self, mission_id: str, fleet: FleetState) -> None:
        self._get(mission_id).fleet = fleet
        self.emit(mission_id, "fleet.updated", "fleet updated")

    def merge_telemetry(self, mission_id: str, t: FleetTelemetry) -> tuple[FleetState, list[str]]:
        m = self._get(mission_id)
        if m.fleet is None:
            raise ValueError("no fleet to merge telemetry into")
        by_id = {d.id: d for d in m.fleet.drones}
        drones = [
            d.model_copy(update={"leg_id": by_id[d.id].leg_id if d.id in by_id else None})
            for d in t.drones
        ]
        done: list[str] = []
        legs = []
        allowed = {"approved": {"flying", "done"}, "flying": {"done"}}
        for leg in m.fleet.legs:
            new = t.leg_status.get(leg.id)
            if new and new in allowed.get(leg.status, set()):
                if new == "done":
                    done.append(leg.id)
                leg = leg.model_copy(update={"status": new})
            legs.append(leg)
        m.fleet = FleetState(simulated=m.fleet.simulated, drones=drones, legs=legs, updated_at=t.at)
        self.emit(mission_id, "fleet.updated", "telemetry merged")
        return m.fleet, done

    def put_conditions(self, mission_id: str, c: Conditions) -> None:
        self._get(mission_id).conditions = c
        self.emit(mission_id, "conditions.updated", f"conditions for {c.area}")

    def trace(self, mission_id: str, entry: TraceEntry) -> TraceEntry:
        data = {**entry.model_dump(), "id": self.next_id(mission_id, "t")}
        entry = TraceEntry.model_validate(data)
        self._get(mission_id).trace.append(entry)
        return entry

    def emit(
        self,
        mission_id: str,
        type: EventType,
        summary: str,
        ref: str | None = None,
        data: dict | None = None,
    ) -> MissionEvent:
        ev = MissionEvent(
            id=self.next_id(mission_id, "e"),
            type=type,
            at=_now(),
            summary=summary,
            ref=ref,
            data=data,
        )
        self._get(mission_id).events.append(ev)
        return ev

    async def subscribe(
        self, mission_id: str, after_event_id: str | None = None
    ) -> AsyncIterator[MissionEvent]:
        """Replays the events after ``after_event_id`` and stops (no waiting for new ones)."""
        events = self._get(mission_id).events
        start = 0
        if after_event_id is not None:
            start = next(i + 1 for i, e in enumerate(events) if e.id == after_event_id)
        for ev in events[start:]:
            yield ev

    def put_file(self, mission_id: str, rel_path: str, data: bytes) -> str:
        self._get(mission_id).files[rel_path] = data
        return rel_path
