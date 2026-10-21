"""The radio desk on its own, before lane D mounts it (LANE_E §8.3, E-13):

    uv run uvicorn sightline.radio.dev:app --port 8010                       # text turns, fake voice
    curl -F text="Sightline, Team Two, say again the sector boundary, over." \\
         http://127.0.0.1:8010/missions/demo0001/radio/turn

The fixture mission is the radio demo script's (``mission_api.demo_mission``). Nemotron runs on
Token Factory when ``NEBIUS_API_KEY`` is set (``.env`` is read), otherwise a fixed reply.
``SIGHTLINE_RADIO_MODELS=real`` loads Parakeet and Magpie (needs the NeMo environment, see
``README.md``); the default fake voice returns silence and accepts text turns only.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import FastAPI

from sightline.agent.llm import NO_THINKING, FakeChatClient, LLMError, token_factory_client
from sightline.contract import RadioTurn
from sightline.radio.api import RadioContext, radio_router
from sightline.radio.mission_api import InMemoryMissionApi, demo_mission
from sightline.radio.tts import CachedTts, FakeTts

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "radio"  # gitignored (data/)


def _llm():
    try:
        from dotenv import load_dotenv

        load_dotenv(ROOT / ".env")
    except ImportError:
        pass
    try:
        return token_factory_client(extra_body=NO_THINKING)
    except LLMError:
        return FakeChatClient(default="Sightline, say again, over.")


def _local_trace(mission_id: str, turn: RadioTurn) -> None:
    """Until lane D's MissionStore is mounted: one JSON line per turn (LANE_E §4)."""
    DATA.mkdir(parents=True, exist_ok=True)
    with open(DATA / "trace_local.jsonl", "a", encoding="utf-8") as f:
        f.write(
            json.dumps(
                {
                    "mission_id": mission_id,
                    "kind": "radio_turn",
                    "output": turn.model_dump(mode="json"),
                }
            )
            + "\n"
        )


def create_app() -> FastAPI:
    state, cards = demo_mission()
    if os.environ.get("SIGHTLINE_RADIO_MODELS") == "real":
        from sightline.radio.asr import ParakeetAsr
        from sightline.radio.tts import MagpieTts

        asr, tts = ParakeetAsr(), CachedTts(MagpieTts())
        # Every reply opens with "<Callsign>, Sightline.": say each once now, so it plays at once.
        tts.warm(
            [f"{t['callsign']}, Sightline." for t in state["teams"]]
            + [f"{t['callsign']}, Sightline. Standby." for t in state["teams"]]
            + ["All teams, Sightline.", "Sightline. Standby."]
        )
    else:
        asr, tts = None, CachedTts(FakeTts())
    app = FastAPI(title="Sightline radio desk (dev)")
    app.state.radio = RadioContext(
        api=InMemoryMissionApi(state, cards),
        tts=tts,
        llm=_llm(),
        audio_dir=DATA / "audio",
        asr=asr,
        on_turn=_local_trace,
    )
    app.include_router(radio_router)
    # web/radio.html runs on Vite's port during development (pnpm dev): let it call this API.
    from fastapi.middleware.cors import CORSMiddleware

    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )
    return app


app = create_app()
