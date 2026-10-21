"""The radio desk's HTTP API (LANE_E §8.3): one ``APIRouter`` that lane D mounts in
``sightline/api/app.py`` (D-R4) with ``app.include_router(radio_router)`` and a
``RadioContext`` on ``app.state.radio``. ``dev.py`` serves it alone with a fixture mission.

    POST /missions/{id}/radio/turn               multipart: audio (+ mime) or text, callsign_hint
    GET  /missions/{id}/radio/audio/{turn}.wav   the reply or transmission
    GET  /missions/{id}/radio/outbound           approved briefings not yet transmitted
    POST /missions/{id}/radio/outbound/{pid}/transmit
    POST /missions/{id}/radio/outbound/{pid}/skip
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from sightline.agent._contract_v12 import RadioTurn
from sightline.agent.llm import ChatClient
from sightline.radio.asr import Asr
from sightline.radio.mission_api import MissionApi
from sightline.radio.tts import Tts
from sightline.radio.turn import RadioSession, TurnResult, handle_inbound, outbound, transmit

radio_router = APIRouter(prefix="/missions/{mission_id}/radio", tags=["radio"])
_TURN_ID = re.compile(r"^r\d{4,}$")


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

    def session(self, mission_id: str) -> RadioSession:
        return self.sessions.setdefault(mission_id, RadioSession())


def _ctx(request: Request) -> RadioContext:
    ctx = getattr(request.app.state, "radio", None)
    if ctx is None:
        raise HTTPException(503, "radio desk not configured")
    return ctx


def _finish(ctx: RadioContext, mission_id: str, result: TurnResult) -> dict[str, Any]:
    if result.wav is not None:
        d = ctx.audio_dir / mission_id
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{result.turn.id}.wav").write_bytes(result.wav)
    if ctx.on_turn is not None:
        ctx.on_turn(mission_id, result.turn)
    return {**result.turn.model_dump(mode="json"), "clue": result.clue}


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
    result = handle_inbound(
        mission_id=mission_id,
        session=ctx.session(mission_id),
        asr=ctx.asr,
        tts=ctx.tts,
        llm=ctx.llm,
        api=ctx.api,
        work_dir=ctx.audio_dir / mission_id / "in",
        audio=await audio.read() if audio is not None else None,
        mime=audio.content_type or mime if audio is not None else mime,
        text=text,
        callsign_hint=callsign_hint,
    )
    return _finish(ctx, mission_id, result)


@radio_router.get("/audio/{turn_id}.wav")
def get_audio(mission_id: str, turn_id: str, request: Request) -> FileResponse:
    if not _TURN_ID.match(turn_id):
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
        result = transmit(mission_id, proposal_id, ctx.session(mission_id), ctx.api, ctx.tts)
    except KeyError as e:
        raise HTTPException(404, str(e)) from e
    return _finish(ctx, mission_id, result)


@radio_router.post("/outbound/{proposal_id}/skip")
def post_skip(mission_id: str, proposal_id: str, request: Request) -> dict[str, str]:
    ctx = _ctx(request)
    ctx.session(mission_id).handled.add(proposal_id)
    return {"skipped": proposal_id}
