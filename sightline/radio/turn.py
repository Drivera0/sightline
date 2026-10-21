"""One radio turn, in and out (LANE_E §8.3–§8.4).

``handle_inbound``: audio (or text) from a team → transcript → callsign → either the readback
confirmation of a pending clue (no model call) or Nemotron with ``RadioTools`` → a reply that is
spoken. A clue is posted to the mission only after the team answers "affirmative" to the readback,
with ``confirmed_by_turn`` set; the readback itself is built in code, never by the model.

``transmit``: an approved proposal's briefing spoken to its team ("<Callsign>, Sightline. ...").

Every reply is post-checked: it starts with "<callsign>, Sightline", numbers are spoken digit by
digit, and a reply that says "clear"/"cleared" is replaced by "standby".
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sightline.agent._contract_v12 import RadioTurn
from sightline.agent.llm import MODEL_REASON, ChatClient, assistant_message, tool_message
from sightline.radio import prompts
from sightline.radio.asr import Asr
from sightline.radio.audio import AudioError, check_length, to_mono16k
from sightline.radio.mission_api import MissionApi
from sightline.radio.protocol import (
    DEFAULT_CALLSIGNS,
    classify_reply,
    fix_callsign_words,
    normalize,
    parse_callsign,
    speakable,
    spoken_coord,
)
from sightline.radio.tools import TOOL_SPECS, RadioTools
from sightline.radio.tts import Tts

log = logging.getLogger(__name__)

MAX_TOOL_ROUNDS = 3
HISTORY_TURNS = 6  # per callsign, as user/assistant pairs
_CLEAR = re.compile(r"\b(clear|cleared)\b", re.IGNORECASE)
_NUMBER = re.compile(r"-?\d+(?:\.\d+)?")


@dataclass
class RadioSession:
    """One per mission, in memory. ``pending``: team id → clue draft awaiting confirmation."""

    pending: dict[str, dict] = field(default_factory=dict)
    history: dict[str, list[dict]] = field(default_factory=dict)
    handled: set[str] = field(default_factory=set)  # outbound proposal ids transmitted or skipped
    counter: int = 0

    def next_id(self) -> str:
        self.counter += 1
        return f"r{self.counter:04d}"


@dataclass(frozen=True)
class TurnResult:
    turn: RadioTurn
    wav: bytes | None  # the spoken reply (inbound) or transmission (outbound)
    clue: dict | None = None  # the clue the mission accepted, when this turn committed one


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


# Replies that describe an action instead of taking it ("calling get_sector_boundary", "drafting
# clue"): seen live from Nemotron 3 Super; they get one retry and are never spoken.
_DESCRIBED_ACTION = re.compile(
    r"\b(drafting|calling|logging|logged|requesting|retrieving|fetching|checking|looking up|getting)\b",
    re.IGNORECASE,
)


# A report of something found or heard must become a clue draft (then a readback). Live, the model
# sometimes *said* "Drafted clue: ..." without calling draft_clue, and the team would have believed it
# was being logged. Strong report words only, so ordinary questions aren't treated as reports.
_REPORT = re.compile(r"\b(found|spotted|sighting|heard|footprints?|tracks)\b", re.IGNORECASE)
_CLAIMS_CLUE = re.compile(r"\b(drafted|logged|recorded|noted)\b", re.IGNORECASE)
# Conditions change and must come from the tool this turn: live, the model once answered "partly cloudy,
# twelve Celsius" with no tool call while the mission had gusts of 30 km/h and rain.
_NEEDS_CONDITIONS = re.compile(
    r"\b(conditions|weather|wind|rain|daylight|temperature|visibility|forecast|sunset)\b",
    re.IGNORECASE,
)
_FILLER = {"sightline", "team", "over", "out", "one", "two", "three", "four", "1", "2", "3", "4"}


def _bare_reply(text: str) -> bool:
    """Just "affirmative"/"negative" (plus callsign and prowords): an answer to a readback."""
    words = [w for w in normalize(fix_callsign_words(text)).split() if w not in _FILLER]
    return classify_reply(text) in ("affirmative", "negative") and len(words) <= 2


def _names_a_tool(text: str) -> bool:
    return bool(_DESCRIBED_ACTION.search(text)) or any(
        spec["function"]["name"] in text for spec in TOOL_SPECS
    )


def postcheck(reply: str, callsign: str) -> tuple[str, list[str]]:
    """The reply as it may be spoken, and what was changed (for the trace)."""
    notes = []
    if _CLEAR.search(reply):
        return f"{opening(callsign)} Standby, over.", ['model said "clear": replaced by standby']
    spoken = speakable(reply)
    if spoken != reply:
        notes.append("made speakable (numbers, units, times, abbreviations)")
    reply = spoken
    opener = re.match(
        rf"\s*{re.escape(callsign)}\s*[,:.]?\s*(sightline\s*[,:.]?)?\s*", reply, re.IGNORECASE
    )
    if opener and opener.group(0):
        body = reply[opener.end() :]
    else:
        body = reply
        notes.append("callsign prefixed")
    # Always the same opening sentence: it is pre-spoken, so it plays at once (CachedTts.warm).
    return opening(callsign) + (" " + body[:1].upper() + body[1:] if body else ""), notes


def opening(callsign: str) -> str:
    return f"{callsign}, Sightline."


def readback(callsign: str, draft: dict, team_position: dict | None) -> str:
    """Built in code from the draft: the team confirms exactly what will be logged."""
    if draft["at_team_position"]:
        where = (
            f"at your position, {spoken_coord(team_position['lat'], team_position['lon'])}"
            if team_position
            else "at your position"
        )
    else:
        where = f"at {spoken_coord(draft['lat'], draft['lon'])}"
    return f"{opening(callsign)} Copy {draft['kind']}, {draft['text']}, {where}. Confirm, over."


def _turn(
    session: RadioSession,
    direction: str,
    callsign: str | None,
    transcript: str,
    reply: str | None,
    state: str,
    actions: list[str],
    asr_ms: int | None = None,
    llm_ms: int | None = None,
) -> RadioTurn:
    return RadioTurn(
        id=session.next_id(),
        direction=direction,  # type: ignore[arg-type]
        callsign=callsign,
        transcript=transcript,
        reply=reply,
        audio=None,
        state=state,  # type: ignore[arg-type]
        actions=actions,
        asr_ms=asr_ms,
        llm_ms=llm_ms,
        tts_ms=None,
        at=_now(),
    )


def _with_audio(
    turn: RadioTurn, tts: Tts | None, text: str | None
) -> tuple[RadioTurn, bytes | None]:
    """Speak ``text`` now; with ``tts=None`` the caller speaks it (``api.py`` does, sentence by
    sentence)."""
    if not text or tts is None:
        return turn, None
    r = tts.speak(text)
    return turn.model_copy(update={"tts_ms": r.ms, "audio": f"radio/{turn.id}.wav"}), r.wav


def handle_inbound(
    *,
    mission_id: str,
    session: RadioSession,
    asr: Asr | None,
    tts: Tts | None,
    llm: ChatClient | None,
    api: MissionApi,
    work_dir: Path,
    audio: bytes | None = None,
    mime: str = "audio/webm",
    text: str | None = None,
    callsign_hint: str | None = None,
    model: str = MODEL_REASON,
) -> TurnResult:
    """One inbound turn (LANE_E §8.3). Give ``audio`` (+ ``mime``), or ``text`` for the text
    fallback (no microphone, tests)."""
    state = api.state(mission_id)
    callsigns = {t["id"]: t["callsign"] for t in state["teams"]} or DEFAULT_CALLSIGNS

    # 1–2. audio → 16 kHz → transcript → callsign
    asr_ms = None
    if text is None:
        if audio is None or asr is None:
            raise ValueError("give audio (with an ASR) or text")
        try:
            wav = to_mono16k(audio, mime, work_dir)
            check_length(wav)
        except AudioError as e:
            log.info("radio clip rejected: %s", e)
            t = _turn(session, "in", None, "", "Sightline, say again, over.", "say_again", [])
            t, out = _with_audio(t, tts, t.reply)
            return TurnResult(t, out)
        heard = asr.transcribe(wav)
        text, asr_ms = heard.text, heard.ms
    team_id = parse_callsign(text, callsigns) or callsign_hint
    if team_id is None and len(session.pending) == 1:
        # "Affirmative, over" usually comes without a callsign: the one team awaiting a readback.
        team_id = next(iter(session.pending))
    if team_id not in callsigns:
        t = _turn(
            session,
            "in",
            None,
            text,
            "Sightline, say again your callsign, over.",
            "say_again",
            [],
            asr_ms,
        )
        t, out = _with_audio(t, tts, t.reply)
        return TurnResult(t, out)
    callsign = callsigns[team_id]

    # 3. a pending clue: this turn answers the readback; no model call
    if team_id in session.pending:
        kind = classify_reply(text)
        if kind == "affirmative":
            turn = _turn(
                session,
                "in",
                team_id,
                text,
                f"{opening(callsign)} Clue logged. Out.",
                "committed",
                ["post_clue"],
                asr_ms,
            )
            draft = {**session.pending.pop(team_id), "confirmed_by_turn": turn.id}
            clue = api.post_clue(mission_id, draft)
            turn, out = _with_audio(turn, tts, turn.reply)
            return TurnResult(turn, out, clue)
        if kind == "negative":
            session.pending.pop(team_id)
            reply = f"{opening(callsign)} Clue discarded. Say again the report, over."
            turn = _turn(session, "in", team_id, text, reply, "discarded", ["discard_clue"], asr_ms)
        else:
            reply = f"{opening(callsign)} Confirm or negative, over."
            turn = _turn(session, "in", team_id, text, reply, "awaiting_confirm", [], asr_ms)
        turn, out = _with_audio(turn, tts, turn.reply)
        return TurnResult(turn, out)

    # An "affirmative"/"negative" with nothing to confirm: say so in code. ("Copy that, out." from
    # the model would let a team believe a clue had been logged.)
    if _bare_reply(text):
        reply = f"{opening(callsign)} Nothing awaiting confirmation. Say again your report, over."
        turn = _turn(
            session, "in", team_id, text, reply, "say_again", ["nothing to confirm"], asr_ms
        )
        turn, out = _with_audio(turn, tts, turn.reply)
        return TurnResult(turn, out)

    # 4. Nemotron with tools, at most MAX_TOOL_ROUNDS rounds
    tools = RadioTools(api, mission_id, session.pending)
    sector = _assigned_sector(api, mission_id, state, team_id)
    history = session.history.setdefault(team_id, [])
    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": prompts.RADIO_SYSTEM
            + "\n"
            + prompts.speaker_context(team_id, callsign, sector),
        },
        *history[-2 * HISTORY_TURNS :],
        {"role": "user", "content": fix_callsign_words(text)},
    ]
    actions: list[str] = []
    retried = False
    t0 = time.perf_counter()
    reply = f"{opening(callsign)} Say again, over."
    try:
        if llm is None:
            raise RuntimeError("no model client")
        for _ in range(MAX_TOOL_ROUNDS):
            r = llm.chat(messages, model=model, tools=tools.spec(), temperature=0.2)
            if not r.tool_calls:
                if _names_a_tool(r.text) and not retried:
                    # The model described a tool call instead of making it: ask once more.
                    retried = True
                    actions.append("retry: tool described, not called")
                    messages += [
                        {"role": "assistant", "content": r.text},
                        {"role": "user", "content": "Call the tool; don't describe it."},
                    ]
                    continue
                reply = r.text if not _names_a_tool(r.text) else reply
                break
            messages.append(assistant_message(r))
            for c in r.tool_calls:
                actions.append(c["name"])
                messages.append(tool_message(c["id"], tools.call(c["name"], c["arguments"])))
            if team_id in session.pending:
                break  # a clue was drafted: the reply is the readback, built below; no more calls
        # A report that wasn't drafted, or a reply claiming a clue that doesn't exist: one explicit
        # retry, then "say again your report". Never let a clue be claimed without the tool.
        unreported = team_id not in session.pending and (
            _REPORT.search(text) or _CLAIMS_CLUE.search(reply)
        )
        if unreported:
            actions.append("retry: report not drafted")
            messages += [
                {"role": "assistant", "content": reply},
                {
                    "role": "user",
                    "content": "That was a report of something found or heard: call draft_clue now.",
                },
            ]
            r = llm.chat(messages, model=model, tools=tools.spec(), temperature=0.2)
            for c in r.tool_calls:
                actions.append(c["name"])
                tools.call(c["name"], c["arguments"])
            if team_id not in session.pending:
                reply = f"{opening(callsign)} Say again your report, over."
                actions.append("report not drafted: say again")
        if (
            _NEEDS_CONDITIONS.search(text)
            and "get_conditions" not in actions
            and team_id not in session.pending
        ):
            actions.append("retry: conditions not looked up")
            messages += [
                {"role": "assistant", "content": reply},
                {
                    "role": "user",
                    "content": "Call get_conditions and answer only from what it returns.",
                },
            ]
            reply = f"{opening(callsign)} Conditions not available, standby, over."
            for _ in range(2):
                r = llm.chat(messages, model=model, tools=tools.spec(), temperature=0.2)
                if not r.tool_calls:
                    if "get_conditions" in actions and not _names_a_tool(r.text):
                        reply = r.text
                    break
                messages.append(assistant_message(r))
                for c in r.tool_calls:
                    actions.append(c["name"])
                    messages.append(tool_message(c["id"], tools.call(c["name"], c["arguments"])))
            if "get_conditions" not in actions:
                actions.append("conditions not looked up: not answered")
    except Exception:  # offline, timeouts, budget: the team hears "say again", nothing changes
        log.exception("radio model call failed")
        actions.append("model_failed")
    llm_ms = round((time.perf_counter() - t0) * 1000)

    if team_id in session.pending:  # draft_clue was called: the readback, built in code
        team = next(t for t in state["teams"] if t["id"] == team_id)
        reply, state_name = (
            readback(callsign, session.pending[team_id], team.get("position")),
            "awaiting_confirm",
        )
    else:
        reply, notes = postcheck(reply, callsign)
        actions += [f"postcheck: {n}" for n in notes]
        state_name = "answered"
    history += [
        {"role": "user", "content": fix_callsign_words(text)},
        {"role": "assistant", "content": reply},
    ]
    turn = _turn(session, "in", team_id, text, reply, state_name, actions, asr_ms, llm_ms)
    turn, out = _with_audio(turn, tts, reply)
    return TurnResult(turn, out)


def _assigned_sector(
    api: MissionApi, mission_id: str, state: dict, team_id: str
) -> tuple[str, str] | None:
    """(sector id, spoken label) of the team's current assignment, for the speaker context."""
    task = next(
        (
            t
            for t in state["tasks"]
            if t["team_id"] == team_id and t["state"] in ("assigned", "in_progress")
        ),
        None,
    )
    if task is None:
        return None
    try:
        return task["sector_id"], api.card(mission_id, task["sector_id"])["sector_label"]
    except (KeyError, OSError):
        return task["sector_id"], task["sector_id"]


def outbound(mission_id: str, session: RadioSession, api: MissionApi) -> list[dict]:
    """Approved proposals with a briefing, not yet transmitted or skipped (LANE_E §8.4)."""
    return [
        p
        for p in api.state(mission_id)["proposals"]
        if p["status"] == "approved" and p.get("briefing") and p["id"] not in session.handled
    ]


def transmit(
    mission_id: str, proposal_id: str, session: RadioSession, api: MissionApi, tts: Tts | None
) -> TurnResult:
    """Speak an approved briefing: "<Callsign>, Sightline. <briefing>, over." ("All teams" for
    ``{"team": "all"}``). Only approved proposals can be transmitted."""
    p = next((p for p in outbound(mission_id, session, api) if p["id"] == proposal_id), None)
    if p is None:
        raise KeyError(f"{proposal_id} is not an approved, untransmitted briefing")
    team = p["target"].get("team", "all")
    callsigns = {t["id"]: t["callsign"] for t in api.state(mission_id)["teams"]}
    who = "All teams" if team == "all" else callsigns.get(team, team)
    body = speakable(p["briefing"].rstrip(". "))
    text = f"{opening(who)} {body}, over."
    session.handled.add(proposal_id)
    turn = _turn(
        session,
        "out",
        None if team == "all" else team,
        "",
        text,
        "transmitted",
        [f"transmit {proposal_id}"],
    )
    turn, out = _with_audio(turn, tts, text)
    return TurnResult(turn, out)
