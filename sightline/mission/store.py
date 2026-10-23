"""``MissionStore``: the only writer of mission files (contract §12, §14; LANE_D §5.2, D-M0).

Layout under ``root/<mission_id>/`` is contract §12.1. JSON files are rewritten atomically (temp
file + ``os.replace``) and ``*.jsonl`` files appended, both under a per-mission lock that holds
across threads (``threading.RLock``) and processes (``fcntl``/``msvcrt`` on ``.lock``), so the API
and a worker process can share a mission folder. Every write is validated with the contract
models first. Id counters live in ``counters.json``.

``emit()`` appends to ``events.jsonl`` and hands the event to every in-process ``subscribe()``r
(one ``asyncio.Queue`` each, filled thread-safely from any thread). ``live()`` rebuilds the
mission's ``LiveMap`` by applying ``map_updates.jsonl`` to ``map_base.json`` once, then keeps it
in memory; ``append_map_update`` applies each new update to it. **LiveMap methods compute an
update; the store applies it** (on append), so a map is never stepped twice.

Done by lane A for lane D (issue #51); lane D owns this file.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import threading
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any, Literal, TypeVar

from pydantic import BaseModel

from sightline.contract import (
    CONTRACT_VERSION,
    Area,
    BaseCamp,
    Clue,
    Conditions,
    Detection,
    Detections,
    EventType,
    FleetState,
    FleetTelemetry,
    Frame,
    LatLon,
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

ID_WIDTH = {"p": 3, "c": 3, "v": 4, "L": 3, "e": 5, "t": 6, "f": 4}  # "p014", "v0021", "f0007"
MISSION_ID = re.compile(r"^[0-9a-f]{8}$")
RECENT_EVENTS = 200
SUBSCRIBE_POLL_S = 1.0  # how often an idle SSE stream checks for events written by another process  # GET /state returns the last 200 (contract §13)
CANDIDATE_THRESHOLD = 0.29  # frozen detector threshold (contract §7, LANE_D §5.3)
SAVE_THRESHOLD = 0.05

M = TypeVar("M", bound=BaseModel)


def now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def default_base_camp(lkp: LatLon) -> BaseCamp:
    """A mission's base camp when none is given: the last known point (where a search starts)."""
    return BaseCamp(lat=lkp.lat, lon=lkp.lon, name="Base camp (last known point)")


def _default_live_factory(base: MapBase) -> Any:
    """Lane C's ``LiveMap`` (``sightline/search/live.py``), rebuilt from its stored base."""
    from sightline.search.live import LiveMap

    return LiveMap.from_base(base)


@contextmanager
def _file_lock(path: Path) -> Iterator[None]:
    """Exclusive lock on ``path`` across processes (no-op where neither API exists)."""
    with open(path, "a+b") as f:
        try:
            import fcntl

            fcntl.flock(f, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)
        except ImportError:  # Windows
            import msvcrt

            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)


class _MissionLock:
    def __init__(self) -> None:
        self.rlock = threading.RLock()
        self.depth = 0  # changed only while rlock is held


class MissionStore:
    def __init__(
        self,
        root: Path = Path("missions"),
        *,
        live_factory: Callable[[MapBase], Any] | None = None,
        detector_model: str = "unknown",
        on_trace: Callable[[TraceEntry], None] | None = None,
    ) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.live_factory = live_factory or _default_live_factory
        self.detector_model = detector_model
        self.on_trace = on_trace  # e.g. CloudWatch AgentModelCalls
        self._locks: dict[str, _MissionLock] = {}
        self._locks_guard = threading.Lock()
        self._live: dict[str, Any] = {}
        self._subscribers: dict[str, list[tuple[asyncio.AbstractEventLoop, asyncio.Queue]]] = {}

    # --- files and locking ----------------------------------------------------------------

    def _dir(self, mission_id: str) -> Path:
        if not MISSION_ID.match(mission_id):
            raise KeyError(f"no mission {mission_id}")
        d = self.root / mission_id
        if not (d / "mission.json").is_file():
            raise KeyError(f"no mission {mission_id}")
        return d

    @contextmanager
    def _lock(self, mission_id: str) -> Iterator[Path]:
        d = self._dir(mission_id)
        with self._locks_guard:
            lock = self._locks.setdefault(mission_id, _MissionLock())
        with lock.rlock:  # threads of this process; re-entrant
            lock.depth += 1
            try:
                if lock.depth > 1:  # this thread already holds the file lock
                    yield d
                else:
                    with _file_lock(d / ".lock"):  # other processes
                        yield d
            finally:
                lock.depth -= 1

    @staticmethod
    def _write_json(path: Path, data: Any) -> None:
        tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps(data, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        os.replace(tmp, path)

    @staticmethod
    def _read_json(path: Path, default: Any = None) -> Any:
        if not path.is_file():
            return default
        return json.loads(path.read_text(encoding="utf-8"))

    @staticmethod
    def _append_jsonl(path: Path, model: BaseModel) -> None:
        with open(path, "a", encoding="utf-8") as f:
            f.write(model.model_dump_json() + "\n")

    @staticmethod
    def _read_jsonl(path: Path, model: type[M]) -> list[M]:
        if not path.is_file():
            return []
        lines = path.read_text(encoding="utf-8").splitlines()
        return [model.model_validate_json(line) for line in lines if line.strip()]

    def _save(self, d: Path, name: str, model: BaseModel) -> None:
        self._write_json(
            d / name, type(model).model_validate(model.model_dump()).model_dump(mode="json")
        )

    def _save_list(self, d: Path, name: str, items: list[BaseModel]) -> None:
        self._write_json(
            d / name,
            [type(x).model_validate(x.model_dump()).model_dump(mode="json") for x in items],
        )

    def _load_list(self, d: Path, name: str, model: type[M]) -> list[M]:
        return [model.model_validate(x) for x in self._read_json(d / name, [])]

    @staticmethod
    def _safe_rel(rel_path: str) -> str:
        """A path inside the mission folder: relative, no '..', not a mission data file."""
        p = PurePosixPath(rel_path)
        if p.is_absolute() or ".." in p.parts or not p.parts or "\\" in rel_path:
            raise ValueError(f"bad file path {rel_path!r}")
        if len(p.parts) == 1 and (p.suffix in (".json", ".jsonl") or p.name.startswith(".")):
            raise ValueError(f"{rel_path!r} is a mission data file; use the store's methods")
        return str(p)

    # --- §14 ------------------------------------------------------------------------------

    def create(
        self,
        name: str,
        area_name: str,
        lkp: LatLon,
        mode: str,
        last_seen_at: str | None = None,
        subject: str | None = None,
        base_camp: BaseCamp | None = None,
    ) -> Mission:
        """``base_camp`` (1.3): where teams stage and drones launch; default the last known point."""
        area = Area(name=area_name, lkp=lkp)
        while True:
            mission_id = secrets.token_hex(4)
            d = self.root / mission_id
            try:
                d.mkdir()
                break
            except FileExistsError:
                continue
        mission = Mission(
            contract_version=CONTRACT_VERSION,
            mission_id=mission_id,
            name=name,
            area=area,
            created_at=now_iso(),
            mode=mode,  # type: ignore[arg-type]
            last_seen_at=last_seen_at,
            subject=subject,
            base_camp=base_camp or default_base_camp(lkp),
        )
        survey = Survey(
            contract_version=CONTRACT_VERSION,
            survey_id=mission_id,
            simulated_path=mode == "replay",
            area=area,
            frames=[],
        )
        detections = Detections(
            contract_version=CONTRACT_VERSION,
            model=self.detector_model,
            save_threshold=SAVE_THRESHOLD,
            candidate_threshold=CANDIDATE_THRESHOLD,
            frames={},
        )
        self._save(d, "survey.json", survey)
        self._save(d, "detections.json", detections)
        self._write_json(d / "counters.json", {})
        self._save(d, "mission.json", mission)  # last: the mission exists once this is written
        return mission

    def put_map_base(self, mission_id: str, base: MapBase) -> None:
        with self._lock(mission_id) as d:
            self._save(d, "map_base.json", base)
            self._live.pop(mission_id, None)

    def live(self, mission_id: str) -> Any:
        with self._lock(mission_id) as d:
            if mission_id not in self._live:
                base = self._read_json(d / "map_base.json")
                if base is None:
                    raise ValueError(f"mission {mission_id} has no map_base yet")
                live = self.live_factory(MapBase.model_validate(base))
                for u in self._read_jsonl(d / "map_updates.jsonl", MapUpdate):
                    live.apply(u)
                self._live[mission_id] = live
            return self._live[mission_id]

    def update_mission(self, mission_id: str, **fields: Any) -> Mission:
        """Rewrite ``mission.json`` with ``fields`` changed (1.3: status, found). Validated first."""
        with self._lock(mission_id) as d:
            m = Mission.model_validate({**self.get(mission_id).model_dump(), **fields})
            self._save(d, "mission.json", m)
            return m

    def next_id(self, mission_id: str, kind: str) -> str:
        with self._lock(mission_id) as d:
            counters = self._read_json(d / "counters.json", {})
            counters[kind] = counters.get(kind, 0) + 1
            self._write_json(d / "counters.json", counters)
            return f"{kind}{counters[kind]:0{ID_WIDTH.get(kind, 3)}d}"

    def get(self, mission_id: str) -> Mission:
        return Mission.model_validate(self._read_json(self._dir(mission_id) / "mission.json"))

    def list_missions(self) -> list[Mission]:
        """Every mission under ``root``, newest first (not in §14; for ``GET /missions``)."""
        out = []
        for d in self.root.iterdir():
            if MISSION_ID.match(d.name) and (d / "mission.json").is_file():
                out.append(self.get(d.name))
        return sorted(out, key=lambda m: m.created_at, reverse=True)

    def state(self, mission_id: str) -> dict:
        with self._lock(mission_id) as d:
            fleet = self._read_json(d / "fleet.json")
            conditions = self._read_json(d / "conditions.json")
            return {
                "mission": self.get(mission_id),
                "tasks": self._load_list(d, "tasks.json", SectorTask),
                "teams": self._load_list(d, "teams.json", Team),
                "clues": self._load_list(d, "clues.json", Clue),
                "proposals": self._load_list(d, "proposals.json", Proposal),
                "verdicts": self._load_list(d, "verdicts.json", Verdict),
                "fleet": None if fleet is None else FleetState.model_validate(fleet),
                "conditions": None if conditions is None else Conditions.model_validate(conditions),
                "events": self.events(mission_id)[-RECENT_EVENTS:],
            }

    def append_frame(self, mission_id: str, frame: Frame, image_bytes: bytes) -> None:
        """Adds the frame (``flight_index`` = frames so far, ``rank`` = their count + 1 until
        ``set_frames`` re-ranks) and writes its display image at ``frame.file``."""
        with self._lock(mission_id) as d:
            survey = self.survey(mission_id)
            new = Survey.model_validate(
                {
                    **survey.model_dump(),
                    "frames": [*survey.model_dump()["frames"], frame.model_dump()],
                }
            )
            self._write_file(d, frame.file, image_bytes)
            self._save(d, "survey.json", new)

    def set_frames(self, mission_id: str, frames: list[Frame]) -> None:
        with self._lock(mission_id) as d:
            survey = self.survey(mission_id)
            self._save(
                d,
                "survey.json",
                Survey.model_validate(
                    {**survey.model_dump(), "frames": [f.model_dump() for f in frames]}
                ),
            )

    def survey(self, mission_id: str) -> Survey:
        return Survey.model_validate(self._read_json(self._dir(mission_id) / "survey.json"))

    def detections(self, mission_id: str) -> Detections:
        return Detections.model_validate(self._read_json(self._dir(mission_id) / "detections.json"))

    def get_detection(self, mission_id: str, detection_id: str) -> tuple[Detection, Frame]:
        frame_id = detection_id.split("-")[0]
        try:
            det = next(
                d
                for d in self.detections(mission_id).frames.get(frame_id, [])
                if d.id == detection_id
            )
            frame = next(f for f in self.survey(mission_id).frames if f.id == frame_id)
        except StopIteration:
            raise KeyError(f"no detection {detection_id}") from None
        return det, frame

    def map_updates(self, mission_id: str, after_seq: int = 0) -> list[MapUpdate]:
        updates = self._read_jsonl(self._dir(mission_id) / "map_updates.jsonl", MapUpdate)
        return [u for u in updates if u.seq > after_seq]

    def read_file(self, mission_id: str, rel_path: str) -> bytes:
        path = self._dir(mission_id) / self._safe_rel(rel_path)
        if not path.is_file():
            raise KeyError(f"no file {rel_path}")
        return path.read_bytes()

    def append_detections(
        self, mission_id: str, frame_id: str, dets: list[Detection], crops: dict[str, bytes]
    ) -> None:
        """Adds a frame's detections and writes their crops (rel path → JPEG bytes). Emits
        ``detection.new`` for each candidate (``crop`` set), so the pipeline doesn't."""
        with self._lock(mission_id) as d:
            current = self.detections(mission_id)
            data = current.model_dump()
            data["frames"][frame_id] = [
                *data["frames"].get(frame_id, []),
                *(x.model_dump() for x in dets),
            ]
            new = Detections.model_validate(data)
            for rel, blob in crops.items():
                self._write_file(d, rel, blob)
            self._save(d, "detections.json", new)
            for det in dets:
                if det.crop is not None:
                    self.emit(
                        mission_id,
                        "detection.new",
                        f"candidate {det.id} ({det.conf:.2f})",
                        ref=det.id,
                        data=det.model_dump(),
                    )

    def append_map_update(self, mission_id: str, update: MapUpdate) -> MapUpdate:
        """Assigns ``seq``, appends the update, applies it to the live map, emits ``map.updated``."""
        with self._lock(mission_id) as d:
            last = self.map_updates(mission_id)
            u = MapUpdate.model_validate({**update.model_dump(), "seq": len(last) + 1})
            if mission_id in self._live:
                self._live[mission_id].apply(u)
            self._append_jsonl(d / "map_updates.jsonl", u)
            self.emit(
                mission_id,
                "map.updated",
                f"map update {u.seq} ({u.source})",
                ref=u.ref,
                data=u.model_dump(mode="json"),
            )
            return u

    def put_verdict(self, mission_id: str, v: Verdict) -> None:
        with self._lock(mission_id) as d:
            verdicts = {x.id: x for x in self._load_list(d, "verdicts.json", Verdict)}
            verdicts[v.id] = v
            self._save_list(d, "verdicts.json", list(verdicts.values()))
            self.emit(
                mission_id,
                "verdict",
                f"second look on {v.detection_id}: {v.person}",
                ref=v.detection_id,
                data=v.model_dump(),
            )

    def add_proposal(self, mission_id: str, p: Proposal) -> Proposal:
        with self._lock(mission_id) as d:
            p = Proposal.model_validate({**p.model_dump(), "id": self.next_id(mission_id, "p")})
            self._save_list(
                d, "proposals.json", [*self._load_list(d, "proposals.json", Proposal), p]
            )
            self.emit(mission_id, "proposal.new", p.summary, ref=p.id, data=p.model_dump())
            return p

    def _replace_proposal(self, d: Path, p: Proposal) -> None:
        ps = self._load_list(d, "proposals.json", Proposal)
        self._save_list(d, "proposals.json", [p if x.id == p.id else x for x in ps])

    def _proposal(self, d: Path, pid: str) -> Proposal:
        p = next((x for x in self._load_list(d, "proposals.json", Proposal) if x.id == pid), None)
        if p is None:
            raise KeyError(f"no proposal {pid}")
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
        """Approve or reject a pending proposal. Edits (``briefing``, ``team``) are applied
        first, so only the edited text is ever transmitted. An approved leg proposal puts its leg
        in the fleet as ``approved`` (a re-task cancels the drone's current leg): the only place
        a leg becomes approved or cancelled (contract §12.3 invariant 8). Other effects of a
        decision (tasks, teams, the review queue) are ``effects.py``'s."""
        if decision not in ("approve", "reject"):
            raise ValueError(f"decision must be approve or reject, got {decision}")
        with self._lock(mission_id) as d:
            p = self._proposal(d, pid)
            if p.status != "pending":
                raise ValueError(f"{pid} is {p.status}, not pending")
            status = "approved" if decision == "approve" else "rejected"
            update: dict[str, Any] = {
                "status": status,
                "decided_at": now_iso(),
                "decided_by": by,
                "decision_reason": reason,
                "edits": edits,
            }
            if status == "approved" and edits:
                if "briefing" in edits:
                    update["briefing"] = edits["briefing"]
                if "team" in edits and "team" in p.target:
                    update["target"] = {**p.target, "team": edits["team"]}
            p = Proposal.model_validate({**p.model_dump(), **update})
            if status == "approved" and p.leg is not None:
                self._approve_leg(d, p)
            self._replace_proposal(d, p)
            self.emit(
                mission_id,
                "proposal.decided",
                f"{pid} {status} by {by}",
                ref=pid,
                data=p.model_dump(),
            )
            return p

    def _approve_leg(self, d: Path, p: Proposal) -> None:
        raw = self._read_json(d / "fleet.json")
        if raw is None:
            raise ValueError("no fleet: a leg can't be approved")
        fleet = FleetState.model_validate(raw)
        leg = p.leg.model_copy(update={"status": "approved"})  # type: ignore[union-attr]
        drone = next((x for x in fleet.drones if x.id == leg.drone_id), None)
        if drone is None:
            raise ValueError(f"no drone {leg.drone_id}")
        legs = [
            x.model_copy(update={"status": "cancelled"})
            if x.id == drone.leg_id and x.status in ("approved", "flying")
            else x
            for x in fleet.legs
            if x.id != leg.id
        ]
        drones = [
            x.model_copy(update={"leg_id": leg.id}) if x.id == drone.id else x for x in fleet.drones
        ]
        new = FleetState(
            simulated=fleet.simulated, drones=drones, legs=[*legs, leg], updated_at=now_iso()
        )
        self._save(d, "fleet.json", new)
        self.emit(
            d.name,
            "fleet.updated",
            f"{leg.id} approved for {drone.name}",
            ref=leg.id,
            data=new.model_dump(),
        )

    def set_proposal_status(
        self, mission_id: str, pid: str, status: Literal["superseded", "expired"], by: str
    ) -> Proposal:
        with self._lock(mission_id) as d:
            p = self._proposal(d, pid)
            if p.status != "pending":
                raise ValueError(f"{pid} is {p.status}, not pending")
            p = Proposal.model_validate(
                {**p.model_dump(), "status": status, "decided_at": now_iso(), "decided_by": by}
            )
            self._replace_proposal(d, p)
            self.emit(
                mission_id, "proposal.decided", f"{pid} {status}", ref=pid, data=p.model_dump()
            )
            return p

    def upsert_task(self, mission_id: str, task: SectorTask) -> None:
        """Saves the task; POD is set exactly when the sector is searched (invariant 3)."""
        if (task.pod is not None) != (task.state == "searched"):
            raise ValueError("a task's pod is set exactly when its state is searched")
        with self._lock(mission_id) as d:
            tasks = {t.sector_id: t for t in self._load_list(d, "tasks.json", SectorTask)}
            tasks[task.sector_id] = task
            self._save_list(d, "tasks.json", list(tasks.values()))
            self.emit(
                mission_id,
                "task.updated",
                f"sector {task.sector_id}: {task.state}",
                ref=task.sector_id,
                data=task.model_dump(),
            )

    def upsert_team(self, mission_id: str, team: Team) -> None:
        with self._lock(mission_id) as d:
            teams = {t.id: t for t in self._load_list(d, "teams.json", Team)}
            teams[team.id] = team
            self._save_list(d, "teams.json", list(teams.values()))
            self.emit(
                mission_id,
                "team.updated",
                f"{team.callsign}: {team.status}",
                ref=team.id,
                data=team.model_dump(),
            )

    def add_clue(self, mission_id: str, clue: Clue) -> Clue:
        """Assigns the id and sets ``confirmed``: a form clue is confirmed; a radio clue only with
        ``confirmed_by_turn`` (the readback's "affirmative"), else ValueError (the API's 422)."""
        if clue.source == "radio" and not clue.confirmed_by_turn:
            raise ValueError("a radio clue needs confirmed_by_turn (readback, then affirmative)")
        with self._lock(mission_id) as d:
            clue = Clue.model_validate(
                {**clue.model_dump(), "id": self.next_id(mission_id, "c"), "confirmed": True}
            )
            self._save_list(d, "clues.json", [*self._load_list(d, "clues.json", Clue), clue])
            self.emit(
                mission_id,
                "clue.added",
                f"{clue.kind}: {clue.text}",
                ref=clue.id,
                data=clue.model_dump(),
            )
            return clue

    def put_fleet(self, mission_id: str, fleet: FleetState) -> None:
        with self._lock(mission_id) as d:
            self._save(d, "fleet.json", fleet)
            self.emit(mission_id, "fleet.updated", "fleet updated", data=fleet.model_dump())

    def merge_telemetry(self, mission_id: str, t: FleetTelemetry) -> tuple[FleetState, list[str]]:
        """Drone positions, battery and status from the sim; legs move only approved → flying →
        done (``leg_id`` stays the store's). Returns the fleet and the legs newly done."""
        with self._lock(mission_id) as d:
            raw = self._read_json(d / "fleet.json")
            if raw is None:
                raise ValueError("no fleet to merge telemetry into")
            fleet = FleetState.model_validate(raw)
            by_id = {x.id: x for x in fleet.drones}
            drones = [
                x.model_copy(
                    update={
                        "leg_id": by_id[x.id].leg_id if x.id in by_id else None,
                        "home": x.home or (by_id[x.id].home if x.id in by_id else None),
                    }
                )
                for x in t.drones
            ]
            allowed = {"approved": {"flying", "done"}, "flying": {"done"}}
            done, legs = [], []
            for leg in fleet.legs:
                new = t.leg_status.get(leg.id)
                if new and new in allowed.get(leg.status, set()):
                    if new == "done":
                        done.append(leg.id)
                    leg = leg.model_copy(update={"status": new})
                legs.append(leg)
            fleet = FleetState(simulated=fleet.simulated, drones=drones, legs=legs, updated_at=t.at)
            self._save(d, "fleet.json", fleet)
            self.emit(mission_id, "fleet.updated", "telemetry", data=fleet.model_dump())
            return fleet, done

    def put_conditions(self, mission_id: str, c: Conditions) -> None:
        with self._lock(mission_id) as d:
            self._save(d, "conditions.json", c)
            self.emit(
                mission_id, "conditions.updated", f"conditions for {c.area}", data=c.model_dump()
            )

    def trace(self, mission_id: str, entry: TraceEntry) -> TraceEntry:
        with self._lock(mission_id) as d:
            entry = TraceEntry.model_validate(
                {**entry.model_dump(), "id": self.next_id(mission_id, "t")}
            )
            self._append_jsonl(d / "trace.jsonl", entry)
        if self.on_trace is not None:
            self.on_trace(entry)
        return entry

    def emit(
        self,
        mission_id: str,
        type: EventType,
        summary: str,
        ref: str | None = None,
        data: dict | None = None,
    ) -> MissionEvent:
        with self._lock(mission_id) as d:
            ev = MissionEvent(
                id=self.next_id(mission_id, "e"),
                type=type,
                at=now_iso(),
                summary=summary,
                ref=ref,
                data=json.loads(json.dumps(data, default=str)) if data is not None else None,
            )
            self._append_jsonl(d / "events.jsonl", ev)
        for loop, q in list(self._subscribers.get(mission_id, [])):
            try:
                loop.call_soon_threadsafe(q.put_nowait, ev)
            except RuntimeError:  # that subscriber's loop is closed
                pass
        return ev

    async def subscribe(
        self, mission_id: str, after_event_id: str | None = None, poll_s: float = SUBSCRIBE_POLL_S
    ) -> AsyncIterator[MissionEvent]:
        """Every event after ``after_event_id`` (SSE ``Last-Event-ID``), then new ones as they are
        emitted, forever (the caller stops iterating when the client goes away). Events another
        process appends (the AWS worker container) are read from ``events.jsonl`` when nothing has
        arrived in-process for ``poll_s``."""
        d = self._dir(mission_id)
        q: asyncio.Queue[MissionEvent] = asyncio.Queue()
        sub = (asyncio.get_running_loop(), q)
        self._subscribers.setdefault(mission_id, []).append(sub)
        path = d / "events.jsonl"
        try:
            last = _event_no(after_event_id) if after_event_id else 0
            offset = 0
            while True:
                fresh, offset = _read_new_events(path, offset)  # registered first: nothing is lost
                for ev in fresh:
                    if _event_no(ev.id) > last:
                        last = _event_no(ev.id)
                        yield ev
                try:
                    ev = await asyncio.wait_for(q.get(), poll_s)
                except TimeoutError:
                    continue
                if _event_no(ev.id) > last:
                    last = _event_no(ev.id)
                    yield ev
        finally:
            self._subscribers[mission_id].remove(sub)

    def put_file(self, mission_id: str, rel_path: str, data: bytes) -> str:
        with self._lock(mission_id) as d:
            return self._write_file(d, rel_path, data)

    def _write_file(self, d: Path, rel_path: str, data: bytes) -> str:
        rel = self._safe_rel(rel_path)
        path = d / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.tmp")
        tmp.write_bytes(data)
        os.replace(tmp, path)
        return rel

    # --- reading helpers (not in §14; the agent, debrief and tests use them) ----------------

    def events(self, mission_id: str) -> list[MissionEvent]:
        return self._read_jsonl(self._dir(mission_id) / "events.jsonl", MissionEvent)

    def trace_entries(self, mission_id: str) -> list[TraceEntry]:
        return self._read_jsonl(self._dir(mission_id) / "trace.jsonl", TraceEntry)


def _read_new_events(path: Path, offset: int) -> tuple[list[MissionEvent], int]:
    """Whole lines appended to ``path`` since byte ``offset``, and the new offset."""
    if not path.is_file():
        return [], offset
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read()
    end = data.rfind(b"\n") + 1  # a line still being written waits for the next read
    events = [
        MissionEvent.model_validate_json(line) for line in data[:end].splitlines() if line.strip()
    ]
    return events, offset + end


def _event_no(event_id: str) -> int:
    return int(event_id.lstrip("e") or 0)
