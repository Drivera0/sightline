"""The radio desk's HTTP API (LANE_E §8.3): one ``APIRouter`` that lane D mounts in
``sightline/api/app.py`` (D-R4) with ``app.include_router(radio_router)`` and a
``RadioContext`` on ``app.state.radio``. ``dev.py`` serves it alone with a fixture mission.

    POST /missions/{id}/radio/turn               multipart: audio (+ mime) or text, callsign_hint
    GET  /missions/{id}/radio/audio/{turn}.wav   the whole reply or transmission (once all spoken)
    GET  /missions/{id}/radio/audio/{turn}-{k}.wav  sentence k: play 0, 1, ... in order

When the model is slow, a turn that isn't answered within ``STANDBY_AFTER_S`` returns a
**standby** response instead: ``{"standby": true, "audio_chunks": ["…/audio/sNNNN.wav"], "poll":
"/missions/{id}/radio/turn/pending/{key}"}``. The chunk says "<Callsign>, Sightline. Standby." (pre-spoken,
so instant); ``GET poll`` answers 202 until the turn is done, then 200 with the normal turn response.

Replies are spoken sentence by sentence: the response returns once sentence 0 is ready, with
``audio_chunks`` (URLs in order); the rest are generated in the background, so a chunk may 404
for a moment: retry it. Time to first sound is ASR + model + one short sentence.
    GET  /missions/{id}/radio/outbound           approved briefings not yet transmitted
    POST /missions/{id}/radio/outbound/{pid}/transmit
    POST /missions/{id}/radio/outbound/{pid}/skip
"""

from __future__ import annotations

import asyncio
import re
import threading
import uuid
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from sightline.agent._contract_v12 import RadioTurn
from sightline.agent.llm import ChatClient
from sightline.radio.asr import Asr
from sightline.radio.mission_api import MissionApi
from sightline.radio.protocol import parse_callsign
from sightline.radio.tts import Tts, concat_wavs, split_sentences
from sightline.radio.turn import (
    RadioSession,
    TurnResult,
    handle_inbound,
    opening,
    outbound,
    transmit,
)

radio_router = APIRouter(prefix="/missions/{mission_id}/radio", tags=["radio"])
_AUDIO_ID = re.compile(r"^(r\d{4,}(-\d+)?|s\d{4,})$")
_PENDING_KEY = re.compile(r"^[0-9a-f]{12}$")
STANDBY_AFTER_S = 2.0  # radio procedure: "standby" when the answer will take a while


@dataclass
class RadioContext:
    api: MissionApi
    tts: Tts
    llm: ChatClient | None
    audio_dir: Path
    asr: Asr | None = None  # None: text turns only
    # Called with every turn, e.g. lane A's trace_call(actor="radio", kind="radio_turn") + an event.
    on_turn: Callable[[str, RadioTurn], None] | None = None
    sessions: dict[str, RadioSession] = field(default_factory=dict)
    # One background worker: sentences after the first are spoken here, in order.
    executor: ThreadPoolExecutor = field(default_factory=lambda: ThreadPoolExecutor(1))
    _pending: list[Future] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    # Turns run here, one at a time (a mission's radio session is not shared between threads).
    turn_executor: ThreadPoolExecutor = field(default_factory=lambda: ThreadPoolExecutor(1))
    standby_after_s: float = STANDBY_AFTER_S
    # Turns answered with "standby": key -> (mission id, the running turn, its response once spoken).
    _slow: dict[str, list[Any]] = field(default_factory=dict)
    _standby_count: int = 0

    def session(self, mission_id: str) -> RadioSession:
        return self.sessions.setdefault(mission_id, RadioSession())

    def wait(self) -> None:
        """Block until every background sentence is spoken (tests, shutdown)."""
        while self._pending:
            self._pending.pop().result()

    def speak_chunked(self, mission_id: str, turn: RadioTurn) -> tuple[RadioTurn, list[str]]:
        """Speak ``turn.reply``: sentence 0 now, the rest in the background. Returns the turn with
        ``tts_ms`` (time to sentence 0) and ``audio`` set, and the chunk URLs in order."""
        if not turn.reply:
            return turn, []
        d = self.audio_dir / mission_id
        d.mkdir(parents=True, exist_ok=True)
        sentences = split_sentences(turn.reply)
        first = self.tts.speak(sentences[0])
        (d / f"{turn.id}-0.wav").write_bytes(first.wav)

        def rest() -> None:
            wavs = [first.wav]
            for k, sentence in enumerate(sentences[1:], 1):
                wav = self.tts.speak(sentence).wav
                (d / f"{turn.id}-{k}.wav").write_bytes(wav)
                wavs.append(wav)
            (d / f"{turn.id}.wav").write_bytes(concat_wavs(wavs))

        with self._lock:
            self._pending.append(self.executor.submit(rest))
        urls = [
            f"/missions/{mission_id}/radio/audio/{turn.id}-{k}.wav" for k in range(len(sentences))
        ]
        return turn.model_copy(update={"tts_ms": first.ms, "audio": f"radio/{turn.id}.wav"}), urls


def _ctx(request: Request) -> RadioContext:
    ctx = getattr(request.app.state, "radio", None)
    if ctx is None:
        raise HTTPException(503, "radio desk not configured")
    return ctx


def _standby(
    ctx: RadioContext, mission_id: str, future: Future, callsign: str | None
) -> dict[str, Any]:
    """Speak "<Callsign>, Sightline. Standby." now and hand back where to collect the answer."""
    ctx._standby_count += 1
    name = f"s{ctx._standby_count:04d}"
    d = ctx.audio_dir / mission_id
    d.mkdir(parents=True, exist_ok=True)
    text = f"{opening(callsign)} Standby." if callsign else "Sightline. Standby."
    (d / f"{name}.wav").write_bytes(ctx.tts.speak(text).wav)
    key = uuid.uuid4().hex[:12]
    ctx._slow[key] = [mission_id, future, None]
    return {
        "standby": True,
        "reply": text,
        "audio_chunks": [f"/missions/{mission_id}/radio/audio/{name}.wav"],
        "poll": f"/missions/{mission_id}/radio/turn/pending/{key}",
    }


def _finish(ctx: RadioContext, mission_id: str, result: TurnResult) -> dict[str, Any]:
    turn, chunks = ctx.speak_chunked(mission_id, result.turn)
    if ctx.on_turn is not None:
        ctx.on_turn(mission_id, turn)
    return {**turn.model_dump(mode="json"), "clue": result.clue, "audio_chunks": chunks}


@radio_router.post("/turn")
async def post_turn(
    mission_id: str,
    request: Request,
    audio: Annotated[UploadFile | None, File()] = None,
    mime: Annotated[str, Form()] = "audio/webm",
    text: Annotated[str | None, Form()] = None,
    callsign_hint: Annotated[str | None, Form()] = None,
) -> dict[str, Any]:
    ctx = _ctx(request)
    if (audio is None) == (text is None):
        raise HTTPException(422, "send either audio or text")
    if audio is not None and ctx.asr is None:
        raise HTTPException(503, "speech recognition is not loaded; send text")
    audio_bytes = await audio.read() if audio is not None else None
    future = ctx.turn_executor.submit(
        handle_inbound,
        mission_id=mission_id,
        session=ctx.session(mission_id),
        asr=ctx.asr,
        tts=None,  # spoken sentence by sentence in _finish
        llm=ctx.llm,
        api=ctx.api,
        work_dir=ctx.audio_dir / mission_id / "in",
        audio=audio_bytes,
        mime=audio.content_type or mime if audio is not None else mime,
        text=text,
        callsign_hint=callsign_hint,
    )
    try:
        # shield: the timeout only stops waiting; the turn keeps running for the poll.
        result = await asyncio.wait_for(
            asyncio.shield(asyncio.wrap_future(future)), ctx.standby_after_s
        )
    except TimeoutError:
        teams = {t["id"]: t["callsign"] for t in ctx.api.state(mission_id)["teams"]}
        team = (parse_callsign(text, teams) if text else None) or callsign_hint
        return _standby(ctx, mission_id, future, teams.get(team) if team else None)
    return _finish(ctx, mission_id, result)


@radio_router.get("/turn/pending/{key}")
def get_pending(mission_id: str, key: str, request: Request) -> Any:
    """The answer to a turn that got "standby": 202 while it runs, then the turn response."""
    ctx = _ctx(request)
    slot = ctx._slow.get(key) if _PENDING_KEY.match(key) else None
    if slot is None or slot[0] != mission_id:
        raise HTTPException(404, "no such pending turn")
    if slot[2] is None:
        if not slot[1].done():
            return JSONResponse({"pending": True}, status_code=202)
        try:
            result = slot[1].result()
        except Exception as e:  # the turn failed after "standby": say so, don't hang the desk
            raise HTTPException(500, f"radio turn failed: {type(e).__name__}") from e
        slot[2] = _finish(ctx, mission_id, result)
    return slot[2]


@radio_router.get("/audio/{turn_id}.wav")
def get_audio(mission_id: str, turn_id: str, request: Request) -> FileResponse:
    if not _AUDIO_ID.match(turn_id):
        raise HTTPException(404, "no such turn")
    path = _ctx(request).audio_dir / mission_id / f"{turn_id}.wav"
    if not path.is_file():
        raise HTTPException(404, "no audio for that turn")
    return FileResponse(path, media_type="audio/wav")


@radio_router.get("/outbound")
def get_outbound(mission_id: str, request: Request) -> list[dict]:
    ctx = _ctx(request)
    return outbound(mission_id, ctx.session(mission_id), ctx.api)


@radio_router.post("/outbound/{proposal_id}/transmit")
def post_transmit(mission_id: str, proposal_id: str, request: Request) -> dict[str, Any]:
    ctx = _ctx(request)
    try:
        result = transmit(mission_id, proposal_id, ctx.session(mission_id), ctx.api, None)
    except KeyError as e:
        raise HTTPException(404, str(e)) from e
    return _finish(ctx, mission_id, result)


@radio_router.post("/outbound/{proposal_id}/skip")
def post_skip(mission_id: str, proposal_id: str, request: Request) -> dict[str, str]:
    ctx = _ctx(request)
    ctx.session(mission_id).handled.add(proposal_id)
    return {"skipped": proposal_id}
