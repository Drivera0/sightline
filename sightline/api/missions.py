"""The mission API (contract §13, LANE_D §5.3, D-A1): one ``APIRouter`` that ``create_app`` mounts
with a ``MissionContext`` on ``app.state.missions``.

Lane B's ``fetch_conditions`` / ``assignment_card`` and lane C's ``debrief`` / ``LiveMap`` are
called when they exist; until then those endpoints answer 503 naming what they wait for, and map
updates are skipped (the response or event says so). E's ``radio_router`` is mounted separately
(D-R4, ``sightline/radio/README.md``).

Done by lane A for lane D (issue #51); lane D owns this file.
"""

from __future__ import annotations

import io
import logging
import os
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, File, Header, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import StreamingResponse
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel

from sightline.api.limits import MAX_PHOTO_BYTES, photo_type_problem, safe_filename
from sightline.api.sse import event_stream
from sightline.contract import (
    ClueDraft,
    FleetTelemetry,
    LatLon,
    SectorTask,
    Team,
)
from sightline.mission import effects
from sightline.mission.pipeline import (
    PhotoJob,
    PhotoRejected,
    ingest_photo,
    read_photo_pose,
    start_map_base,
)
from sightline.mission.queue import LocalQueue
from sightline.mission.scheduler import Scheduler
from sightline.mission.store import MissionStore, now_iso

MAX_FILES = 50
MAX_PIXELS = 100_000_000
DEFAULT_TEAMS = [("T1", "Team One"), ("T2", "Team Two"), ("T3", "Team Three"), ("T4", "Team Four")]
TEAM_MEMBERS = 3  # placeholder until the search manager edits the roster


def _default_hooks() -> Any:
    from sightline.agent import hooks

    return hooks


def _fetch_conditions() -> Callable | None:
    try:
        from sightline.geo.conditions import fetch_conditions  # type: ignore[import-not-found]
    except ImportError:
        return None
    return fetch_conditions


def _first_conditions(ctx: MissionContext, mission_id: str) -> None:
    try:
        ctx.refresh_conditions(mission_id)
    except Exception:  # conditions never block or break a new mission
        logging.getLogger(__name__).exception("first conditions for %s failed", mission_id)


def _default_detector() -> Any:
    from sightline.ml.backend import make_detector

    return make_detector()


def _default_chat() -> Any:
    from sightline.radio.mount import chat_client

    return chat_client()


@dataclass
class MissionContext:
    store: MissionStore
    queue: Any = field(default_factory=LocalQueue)
    detector_factory: Callable[[], Any] = _default_detector
    hooks: Any = field(default_factory=_default_hooks)  # None: no agent
    scheduler: Scheduler | None = None  # default: on_tick + conditions for active missions
    metrics: Any = None  # CloudWatchMetrics on AWS
    run_worker: bool = True  # False: this process only enqueues (the API on AWS; the worker runs)
    chat_factory: Callable[[], Any] = _default_chat  # the debrief narrative's ChatClient
    _detector: Any = None

    def __post_init__(self) -> None:
        if self.scheduler is None:
            refresh = self.refresh_conditions if _fetch_conditions() is not None else None
            self.scheduler = Scheduler(self.hooks, refresh_conditions=refresh)

    def refresh_conditions(self, mission_id: str) -> Any:
        """Lane B's conditions for the mission, stored and passed on (map, agent)."""
        fetch = _fetch_conditions()
        if fetch is None:
            raise LookupError("conditions wait for lane B (B-W1 fetch_conditions)")
        m = self.store.get(mission_id)
        fleet = self.store.state(mission_id)["fleet"]
        max_wind = min((d.max_wind_kmh for d in fleet.drones), default=None) if fleet else None
        c = fetch(
            m.area,
            fleet_max_wind_kmh=max_wind,
            last_seen_at=m.last_seen_at,
            cache_dir=self.store.root / mission_id / "conditions_cache",
            store=self.store,
            mission_id=mission_id,
        )
        effects.on_conditions(self.store, mission_id, c, self.hooks)
        return c

    def detector(self) -> Any:
        if self._detector is None:
            self._detector = self.detector_factory()
        return self._detector

    def handle(self, job: PhotoJob) -> None:
        conditions = self.store.state(job.mission_id)["conditions"]
        summary = ingest_photo(
            self.store, job, detector=self.detector(), conditions=conditions, hooks=self.hooks
        )
        if self.metrics is not None:
            self.metrics.photo(summary)
        self.scheduler.photo_processed(job.mission_id)

    def start(self) -> None:
        """Start the photo worker (local queue: a thread in this process) and the scheduler."""
        if self.run_worker:
            self.queue.run_worker(self.handle)
        self.scheduler.start(self.store)


missions_router = APIRouter(tags=["missions"])


def _ctx(request: Request) -> MissionContext:
    ctx = getattr(request.app.state, "missions", None)
    if ctx is None:
        raise HTTPException(503, "mission API not configured")
    return ctx


def _store(request: Request, mission_id: str) -> MissionStore:
    store = _ctx(request).store
    try:
        store.get(mission_id)
    except KeyError:
        raise HTTPException(404, "no such mission") from None
    return store


def _dump(x: Any) -> Any:
    if isinstance(x, BaseModel):
        return x.model_dump(mode="json")
    if isinstance(x, list):
        return [_dump(v) for v in x]
    if isinstance(x, dict):
        return {k: _dump(v) for k, v in x.items()}
    return x


def _map_result(r: Any) -> Any:
    """A MapUpdate, null, or {"map_update": null, "note": "..."} while C's math is missing."""
    if isinstance(r, str):
        return {"map_update": None, "note": r}
    return _dump(r)


# --- missions -----------------------------------------------------------------------------


class NewMission(BaseModel):
    name: str
    area_name: str
    lkp: LatLon
    last_seen_at: str | None = None
    subject: str | None = None
    mode: Literal["live", "demo", "replay"] = "live"


@missions_router.post("/missions", status_code=201)
def create_mission(body: NewMission, request: Request) -> dict:
    """A mission with its map (placeholder prior until C-L1), teams T1–T4 on standby, and the
    sector tasks once C's lattice sectors exist."""
    store = _ctx(request).store
    m = store.create(
        body.name, body.area_name, body.lkp, body.mode, body.last_seen_at, body.subject
    )
    store.put_map_base(m.mission_id, start_map_base(body.lkp, subject=body.subject))
    for tid, callsign in DEFAULT_TEAMS:
        store.upsert_team(
            m.mission_id,
            Team(
                id=tid,
                callsign=callsign,
                members=TEAM_MEMBERS,
                status="standby",
                position=None,
                position_at=None,
                note=None,
            ),
        )
    layout = effects._layout(store, m.mission_id)
    if layout is not None:
        poa = store.live(m.mission_id).sector_poa(layout)
        for s in layout.sectors:
            store.upsert_task(
                m.mission_id,
                SectorTask(
                    sector_id=s.id,
                    state="proposed",
                    team_id=None,
                    poa=min(1.0, poa.get(s.id, 0.0)),
                    note=None,
                    updated_at=now_iso(),
                ),
            )
    store.emit(m.mission_id, "mission.note", f"mission created: {m.name}", data=_dump(m))
    ctx = _ctx(request)
    ctx.scheduler.mission_active(m.mission_id)
    # The first conditions (lane B), in the background: Tavily + the model take ~30 s and the
    # browser shouldn't wait for them; they arrive as a conditions.updated event.
    if _fetch_conditions() is not None:
        import threading

        threading.Thread(target=_first_conditions, args=(ctx, m.mission_id), daemon=True).start()
    return _dump(m)


@missions_router.get("/missions")
def list_missions(request: Request) -> list[dict]:
    return _dump(_ctx(request).store.list_missions())


@missions_router.get("/missions/{mission_id}/state")
def get_state(mission_id: str, request: Request) -> dict:
    return _dump(_store(request, mission_id).state(mission_id))


@missions_router.get("/missions/{mission_id}/events")
async def get_events(
    mission_id: str,
    request: Request,
    last_event_id: Annotated[str | None, Header()] = None,
    after: Annotated[str | None, Query()] = None,  # EventSource can't set headers on first connect
) -> StreamingResponse:
    store = _store(request, mission_id)
    return StreamingResponse(
        event_stream(store.subscribe(mission_id, last_event_id or after)),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --- photos -------------------------------------------------------------------------------


def _check_photo(name: str, data: bytes) -> None:
    if len(data) > MAX_PHOTO_BYTES:
        raise PhotoRejected(f"larger than {MAX_PHOTO_BYTES / 1_000_000:g} MB")
    try:
        with Image.open(io.BytesIO(data)) as im:
            # DJI photos are MPO (a JPEG with a second, preview picture), seen on HERIDAL photos.
            if im.format not in ("JPEG", "MPO"):
                raise PhotoRejected("not a JPEG")
            if im.width * im.height > MAX_PIXELS:
                raise PhotoRejected("too many pixels")
            im.load()  # decode it all: a truncated file fails here
    except Image.DecompressionBombError as e:
        raise PhotoRejected("too many pixels") from e
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as e:
        if isinstance(e, PhotoRejected):
            raise
        raise PhotoRejected("not a valid JPEG") from e


@missions_router.post("/missions/{mission_id}/photos", status_code=202)
async def post_photos(
    mission_id: str, request: Request, files: Annotated[list[UploadFile], File()]
) -> dict:
    """1–50 JPEGs. Each is decoded, needs GPS + DJI pose in EXIF/XMP, is kept as the original
    (A's native zoom needs those pixels) and queued; frame ids are given out in upload order."""
    ctx = _ctx(request)
    store = _store(request, mission_id)
    if not 1 <= len(files) <= MAX_FILES:
        raise HTTPException(422, f"send 1 to {MAX_FILES} photos")
    for (
        f
    ) in files:  # the whole batch is refused if one file is not a photo (sightline/api/limits.py)
        problem = photo_type_problem(f.filename or "photo.jpg", f.content_type)
        if problem:
            raise HTTPException(415, problem)
    accepted, rejected = [], []
    for f in files:
        name = f.filename or "photo.jpg"
        if not safe_filename(name):  # a label only, never a path; refused rather than trimmed
            rejected.append({"name": os.path.basename(name), "reason": "unsafe file name"})
            continue
        data = await f.read(MAX_PHOTO_BYTES + 1)
        try:
            _check_photo(name, data)
            with tempfile.NamedTemporaryFile(suffix=".jpg") as tmp:
                tmp.write(data)
                tmp.flush()
                read_photo_pose(Path(tmp.name))
        except PhotoRejected as e:
            rejected.append({"name": name, "reason": str(e)})
            continue
        frame_id = store.next_id(mission_id, "f")
        rel = store.put_file(mission_id, f"frames/orig/{frame_id}.jpg", data)
        ctx.queue.put(PhotoJob(mission_id, frame_id, rel, now_iso(), name))
        accepted.append(frame_id)
    for r in rejected:  # the uploader sees the reason; the mission's feed and trace keep it too
        _photo_rejected(store, mission_id, r["name"], r["reason"])
    return {"accepted": accepted, "rejected": rejected}


def _photo_rejected(store: MissionStore, mission_id: str, name: str, reason: str) -> None:
    from sightline.agent.trace import trace_call

    data = {"failure": "photo.rejected", "name": name, "reason": reason}
    summary = f"photo.rejected {name}: {reason}"
    store.emit(mission_id, "mission.note", summary, data=data)
    trace_call(store, mission_id, actor="pipeline", kind="note", summary=summary, output=data)


@missions_router.get("/missions/{mission_id}/survey")
def get_survey(mission_id: str, request: Request) -> dict:
    return _dump(_store(request, mission_id).survey(mission_id))


@missions_router.get("/missions/{mission_id}/detections")
def get_detections(mission_id: str, request: Request) -> dict:
    return _dump(_store(request, mission_id).detections(mission_id))


@missions_router.get("/missions/{mission_id}/map_base")
def get_map_base(mission_id: str, request: Request) -> dict:
    store = _store(request, mission_id)
    try:
        return _dump(store.live(mission_id).base)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e


@missions_router.get("/missions/{mission_id}/sectors")
def get_sectors(mission_id: str, request: Request) -> list[dict]:
    """Each sector now: label, POA on the live map, and drone coverage (the share of its cells a
    photo has looked at), for the command view's task board (lane E). Read-only."""
    return effects.sector_overview(_store(request, mission_id), mission_id)


@missions_router.get("/missions/{mission_id}/debrief.md")
def get_debrief(mission_id: str, request: Request, narrative: bool = False) -> Response:
    """C's debrief (D-R5): tables from the log; ``?narrative=true`` adds the checked model
    paragraph (a network call, so not by default)."""
    from sightline.search.debrief import debrief

    store = _store(request, mission_id)
    client = _ctx(request).chat_factory() if narrative else None
    md = debrief(
        store.state(mission_id),
        store.trace_entries(mission_id),
        store.events(mission_id),
        client,
        sectors=effects.sector_overview(store, mission_id),
        now=now_iso(),
    )
    return Response(md, media_type="text/markdown; charset=utf-8")


@missions_router.get("/missions/{mission_id}/trace")
def get_trace(mission_id: str, request: Request, after: str | None = None) -> list[dict]:
    """The agent's trace (contract §12 ``TraceEntry``), oldest first: every tool call, model call,
    verdict, proposal and decision, for the web app's Trace tab. ``after``: only the entries after
    that id (polling); an id it doesn't know returns them all. Read-only."""
    entries = _store(request, mission_id).trace_entries(mission_id)
    ids = [e.id for e in entries]
    if after is not None and after in ids:
        entries = entries[ids.index(after) + 1 :]
    return _dump(entries)


@missions_router.get("/missions/{mission_id}/map_updates")
def get_map_updates(mission_id: str, request: Request, after: int = 0) -> list[dict]:
    return _dump(_store(request, mission_id).map_updates(mission_id, after))


@missions_router.get("/missions/{mission_id}/files/{rel_path:path}")
def get_file(mission_id: str, rel_path: str, request: Request) -> Response:
    store = _store(request, mission_id)
    try:
        data = store.read_file(mission_id, rel_path)
    except (KeyError, ValueError):
        raise HTTPException(404, "no such file") from None
    kind = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".wav": "audio/wav"}
    return Response(
        data, media_type=kind.get(Path(rel_path).suffix.lower(), "application/octet-stream")
    )


# --- decisions and field reports (effects.py) ---------------------------------------------


class Review(BaseModel):
    detection_id: str
    answer: Literal["person", "not_person", "unsure"]


@missions_router.post("/missions/{mission_id}/reviews")
def post_review(mission_id: str, body: Review, request: Request) -> Any:
    store = _store(request, mission_id)
    try:
        r = effects.on_review(
            store, mission_id, body.detection_id, body.answer, _ctx(request).hooks
        )
    except KeyError as e:
        raise HTTPException(404, str(e)) from e
    return _map_result(r)


class Decision(BaseModel):
    decision: Literal["approve", "reject"]
    by: str
    reason: str | None = None
    edits: dict[str, str] | None = None


@missions_router.post("/missions/{mission_id}/proposals/{pid}/decide")
def decide(mission_id: str, pid: str, body: Decision, request: Request) -> dict:
    store = _store(request, mission_id)
    if body.decision == "reject" and not body.reason:
        raise HTTPException(422, "a rejection needs a reason")
    try:
        p = store.decide_proposal(mission_id, pid, body.decision, body.by, body.reason, body.edits)
    except KeyError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(409, str(e)) from e
    effects.on_decision(store, mission_id, p)
    return _dump(p)


class TaskUpdate(BaseModel):
    state: Literal["proposed", "assigned", "in_progress", "searched"]
    team_id: str | None = None
    pod: float | None = None
    note: str | None = None


@missions_router.post("/missions/{mission_id}/tasks/{sector_id}")
def post_task(mission_id: str, sector_id: str, body: TaskUpdate, request: Request) -> dict:
    store = _store(request, mission_id)
    old = next((t for t in store.state(mission_id)["tasks"] if t.sector_id == sector_id), None)
    try:
        task = SectorTask(
            sector_id=sector_id,
            state=body.state,
            team_id=body.team_id,
            poa=old.poa if old else 0.0,
            pod=body.pod,
            note=body.note,
            updated_at=now_iso(),
        )
        r = effects.on_task_update(store, mission_id, task, _ctx(request).hooks)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    return {"task": _dump(task), "map": _map_result(r)}


@missions_router.post("/missions/{mission_id}/teams", status_code=201)
def post_team(mission_id: str, team: Team, request: Request) -> dict:
    _store(request, mission_id).upsert_team(mission_id, team)
    return _dump(team)


@missions_router.patch("/missions/{mission_id}/teams/{tid}")
def patch_team(mission_id: str, tid: str, patch: dict, request: Request) -> dict:
    store = _store(request, mission_id)
    team = next((t for t in store.state(mission_id)["teams"] if t.id == tid), None)
    if team is None:
        raise HTTPException(404, "no such team")
    try:
        new = Team.model_validate({**team.model_dump(), **patch, "id": tid})
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    effects.on_team_update(store, mission_id, new, _ctx(request).hooks)  # a new position re-plans
    return _dump(new)


@missions_router.post("/missions/{mission_id}/clues", status_code=201)
def post_clue(mission_id: str, draft: ClueDraft, request: Request) -> dict:
    """A clue from the form or the radio. A radio draft needs ``confirmed_by_turn`` (the team's
    "affirmative" after the readback). "At the team's position" uses the team's last position."""
    store = _store(request, mission_id)
    try:
        clue = effects.clue_from_draft(store, mission_id, draft)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    clue, r = effects.on_clue(store, mission_id, clue, _ctx(request).hooks)
    return {**_dump(clue), "map": _map_result(r)}


@missions_router.put("/missions/{mission_id}/fleet")
def put_fleet(mission_id: str, t: FleetTelemetry, request: Request) -> dict:
    store = _store(request, mission_id)
    try:
        return _dump(effects.on_fleet(store, mission_id, t, _ctx(request).hooks))
    except ValueError as e:
        raise HTTPException(409, str(e)) from e


# --- other lanes' parts -------------------------------------------------------------------


@missions_router.post("/missions/{mission_id}/conditions/refresh")
def refresh_conditions(mission_id: str, request: Request) -> dict:
    _store(request, mission_id)
    try:
        return _dump(_ctx(request).refresh_conditions(mission_id))
    except LookupError as e:
        raise HTTPException(503, str(e)) from None


@missions_router.get("/missions/{mission_id}/cards/{sector_id}")
def get_card(mission_id: str, sector_id: str, request: Request) -> Response:
    store = _store(request, mission_id)
    try:
        from sightline.geo.cards import assignment_card, to_gpx, to_kml  # type: ignore[import-not-found]
    except ImportError:
        raise HTTPException(503, "assignment cards wait for lane B (B-K1)") from None
    layout = effects._layout(store, mission_id)
    if layout is None:
        raise HTTPException(503, "assignment cards wait for lane C (C-S1 sectors)")
    base, _, ext = sector_id.partition(".")
    try:
        card = assignment_card(mission_id, base, store, layout)
    except KeyError as e:
        raise HTTPException(404, str(e)) from None
    if ext == "gpx":
        return Response(to_gpx(card), media_type="application/gpx+xml")
    if ext == "kml":
        return Response(to_kml(card), media_type="application/vnd.google-earth.kml+xml")
    return Response(card.model_dump_json(), media_type="application/json")
