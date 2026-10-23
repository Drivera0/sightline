"""The radio desk on live missions (LANE_D D-R4): ``radio_router`` in the same app as the mission
API, reading and writing the mission through ``MissionStore`` in-process.

    app.state.radio = radio_context(store, hooks=hooks, voices="text")  # or "real" (NeMo env)
    app.include_router(radio_router)

``create_app(radio="text"|"real")`` and ``serve --radio text|real`` do this. ``StoreMissionApi`` is
the radio's ``MissionApi`` over the store: state as JSON, team updates, clues through the same
checks as ``POST /clues`` (``effects.clue_from_draft``). Every turn goes into the mission's trace
(``kind: radio_turn``) and the event feed (``radio.turn``); audio goes to ``missions/<id>/radio/``.

Built by lane A (issues #36, #51).
"""

from __future__ import annotations

import logging
from typing import Any

from sightline.contract import ClueDraft, RadioTurn, Team, TraceEntry
from sightline.mission import effects
from sightline.mission.store import MissionStore
from sightline.radio.api import RadioContext
from sightline.radio.tts import CachedTts, FakeTts

log = logging.getLogger(__name__)


class StoreMissionApi:
    """``sightline.radio.mission_api.MissionApi`` over an in-process ``MissionStore``."""

    def __init__(self, store: MissionStore, hooks: Any = None) -> None:
        self.store = store
        self.hooks = hooks

    def state(self, mission_id: str) -> dict:
        s = self.store.state(mission_id)
        return {
            k: (
                [x.model_dump(mode="json") for x in v]
                if isinstance(v, list)
                else v.model_dump(mode="json")
                if v is not None
                else None
            )
            for k, v in s.items()
        }

    def card(self, mission_id: str, sector_id: str) -> dict:
        """Lane B's assignment card; KeyError until B-K1 and C-S1 land (the radio says so)."""
        try:
            from sightline.geo.cards import assignment_card  # type: ignore[import-not-found]
        except ImportError:
            raise KeyError(f"no card for {sector_id}: assignment cards wait for lane B") from None
        layout = effects._layout(self.store, mission_id)
        if layout is None:
            raise KeyError(f"no card for {sector_id}: sectors wait for lane C")
        return assignment_card(mission_id, sector_id, self.store, layout).model_dump(mode="json")

    def patch_team(self, mission_id: str, team_id: str, patch: dict) -> dict:
        team = next((t for t in self.store.state(mission_id)["teams"] if t.id == team_id), None)
        if team is None:
            raise KeyError(f"no team {team_id}")
        new = Team.model_validate({**team.model_dump(), **patch, "id": team_id})
        self.store.upsert_team(mission_id, new)
        return new.model_dump(mode="json")

    def post_clue(self, mission_id: str, draft: dict) -> dict:
        clue = effects.clue_from_draft(self.store, mission_id, ClueDraft.model_validate(draft))
        clue, _ = effects.on_clue(self.store, mission_id, clue, self.hooks)
        return clue.model_dump(mode="json")

    def record_turn(self, mission_id: str, turn: RadioTurn) -> None:
        """A radio turn into the trace and the event feed, once per turn. A turn is recorded
        before its clue is posted and again when it has been spoken; ids restart at r0001 with
        every radio session, so a turn is its id *and* its time."""
        traced = {
            ((e.output or {}).get("id"), (e.output or {}).get("at"))
            for e in self.store.trace_entries(mission_id)
            if e.kind == "radio_turn"
        }
        if (turn.id, turn.at) in traced:
            return
        self.store.trace(
            mission_id,
            TraceEntry(
                id="",
                at=turn.at,
                actor="radio",
                kind="radio_turn",
                summary=f"{turn.direction} {turn.callsign or '?'}: {turn.state}",
                input={"transcript": turn.transcript} if turn.transcript else None,
                output=turn.model_dump(mode="json"),
                model=None,
                ms=turn.llm_ms,
                tokens_in=None,
                tokens_out=None,
                refs=[r for r in (turn.callsign,) if r],
            ),
        )
        if turn.direction == "in" and turn.callsign:
            from sightline.mission.command import heard, team_id_for

            tid = team_id_for(self.store.state(mission_id)["teams"], turn.callsign)
            if tid is not None:
                heard(self.store, mission_id, tid, turn.at, None)  # the turn is in the timeline
        self.store.emit(
            mission_id,
            "radio.turn",
            (turn.reply or turn.transcript)[:120],
            ref=turn.id,
            data=turn.model_dump(mode="json"),
        )


def chat_client() -> Any:
    """Nemotron on Token Factory (``.env`` is read), ``SIGHTLINE_FAKE_LLM=1`` canned replies, or a
    fixed "say again" when there is no key."""
    from sightline.agent.llm import NO_THINKING, FakeChatClient, LLMError, token_factory_client

    try:
        from dotenv import load_dotenv

        load_dotenv()
    except ImportError:
        pass
    try:
        return token_factory_client(extra_body=NO_THINKING)
    except LLMError:
        return FakeChatClient(default="Sightline, say again, over.")


def load_voices(real: bool, callsigns: list[str]) -> tuple[Any, Any]:
    """(asr, tts): Parakeet + Magpie when ``real`` (NeMo environment, ``README.md``), else no ASR
    (text turns only) and silent speech. Each "<Callsign>, Sightline." is spoken once now."""
    if not real:
        return None, CachedTts(FakeTts())
    from sightline.radio.asr import ParakeetAsr
    from sightline.radio.tts import MagpieTts

    asr, tts = ParakeetAsr(), CachedTts(MagpieTts())
    tts.warm(
        [f"{c}, Sightline." for c in callsigns]
        + [f"{c}, Sightline. Standby." for c in callsigns]
        + ["All teams, Sightline.", "Sightline. Standby."]
    )
    return asr, tts


DEFAULT_CALLSIGNS = ["Team One", "Team Two", "Team Three", "Team Four"]


def radio_context(store: MissionStore, *, hooks: Any = None, voices: str = "text") -> RadioContext:
    """The radio for every mission in ``store``. ``voices``: "text" (typed turns, silent audio)
    or "real" (Parakeet + Magpie)."""
    if voices not in ("text", "real"):
        raise ValueError("radio voices must be text or real")
    api = StoreMissionApi(store, hooks)
    asr, tts = load_voices(voices == "real", DEFAULT_CALLSIGNS)
    return RadioContext(
        api=api,
        tts=tts,
        llm=chat_client(),
        audio_dir=store.root,
        asr=asr,
        on_turn=api.record_turn,
        audio_sub="radio",
    )
