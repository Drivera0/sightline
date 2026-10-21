"""LANE_E §9 Python tests 3–7: the radio turn, tools, audio and API, with fakes (no GPU, no
network, no NeMo)."""

from __future__ import annotations

import io
import shutil
import subprocess
import wave
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from sightline.agent._contract_v12 import ClueDraft, RadioTurn
from sightline.agent.llm import ChatResult, FakeChatClient
from sightline.radio.api import RadioContext, radio_router
from sightline.radio.audio import AudioError, check_length, to_mono16k
from sightline.radio.mission_api import InMemoryMissionApi, demo_mission
from sightline.radio.tools import RadioTools
from sightline.radio.tts import FakeTts
from sightline.radio.turn import RadioSession, handle_inbound, outbound, postcheck, transmit

MID = "demo0001"
REPORT = "Sightline, Team Two. Found a blue backpack by the creek, our position, over."
QUESTION = "Sightline, Team Two, say again the sector boundary, over."


def _tool(name: str, args: dict, call_id: str = "call_1") -> ChatResult:
    return ChatResult("", [{"id": call_id, "name": name, "arguments": args}], "m", 1, 10, 5)


def _setup(llm: FakeChatClient):
    state, cards = demo_mission()
    return InMemoryMissionApi(state, cards), RadioSession(), llm


def _inbound(api, session, llm, text, tmp_path):
    return handle_inbound(
        mission_id=MID, session=session, asr=None, tts=FakeTts(), llm=llm, api=api,
        work_dir=tmp_path, text=text,
    )  # fmt: skip


CLUE = {
    "team_id": "T2",
    "kind": "object",
    "text": "blue backpack by the creek",
    "at_team_position": True,
}


# --- test 3: clue by voice: readback, then commit only on "affirmative" --------------------------


def test_clue_is_read_back_and_posted_once_on_affirmative(tmp_path: Path) -> None:
    api, session, llm = _setup(FakeChatClient({"backpack": [_tool("draft_clue", CLUE), "unused"]}))
    first = _inbound(api, session, llm, REPORT, tmp_path)
    assert first.turn.state == "awaiting_confirm" and first.turn.actions == ["draft_clue"]
    assert first.turn.reply.startswith(
        "Team Two, Sightline. Copy object, blue backpack by the creek, at your position"
    )
    assert "four niner point three seven four" in first.turn.reply  # team's position, spoken
    assert not any(c[0] == "post_clue" for c in api.calls)  # nothing posted before the confirmation

    second = _inbound(api, session, llm, "Affirmative, over", tmp_path)
    posts = [c for c in api.calls if c[0] == "post_clue"]
    assert len(posts) == 1 and second.turn.state == "committed"
    draft = posts[0][2]
    assert draft["confirmed_by_turn"] == second.turn.id and draft["source"] == "radio"
    ClueDraft.model_validate(draft)  # what D's /clues receives is a valid contract draft
    assert (
        second.clue["id"] == "c001"
        and second.turn.reply == "Team Two, Sightline. Clue logged. Out."
    )
    assert len(llm.calls) == 1  # the confirmation turn made no model call


def test_negative_discards_and_other_asks_again(tmp_path: Path) -> None:
    api, session, llm = _setup(FakeChatClient({"backpack": _tool("draft_clue", CLUE)}))
    _inbound(api, session, llm, REPORT, tmp_path)
    again = _inbound(api, session, llm, "Sightline, Team Two, copy", tmp_path)
    assert (
        again.turn.state == "awaiting_confirm" and "confirm or negative" in again.turn.reply.lower()
    )
    no = _inbound(api, session, llm, "Team Two, negative, over", tmp_path)
    assert no.turn.state == "discarded" and session.pending == {}
    assert not any(c[0] == "post_clue" for c in api.calls)


# --- test 4: replies with digits or "clear" are rewritten or rejected ----------------------------


def test_postcheck() -> None:
    r, notes = postcheck(
        "Team Two, Sightline. Sector B3, bearing 270, 600 metres, over.", "Team Two"
    )
    assert "two seven zero" in r and "six zero zero" in r and not any(c.isdigit() for c in r)
    assert notes == ["digits spoken as words"]
    r, _ = postcheck("The sector is clear now.", "Team Two")
    assert r == "Team Two, Sightline. Standby, over."
    r, _ = postcheck("Team Two, Sightline. Bearing 270°, 600 m, gusts 30 km/h, over.", "Team Two")
    assert (
        "two seven zero degrees" in r and "six zero zero metres" in r and "kilometres per hour" in r
    )
    r, notes = postcheck("Copy, over.", "Team Two")
    assert r == "Team Two, Sightline. Copy, over." and notes == ["callsign prefixed"]


def test_a_tool_turn_answers_from_the_tool(tmp_path: Path) -> None:
    reply = "Team Two, Sightline. Sector Bravo Three, corners NW, NE, SE, SW; entry east ridge, bearing 270, over."
    llm = FakeChatClient(
        {"boundary": [_tool("get_sector_boundary", {"sector_id": "B3", "from_team": "T2"}), reply]}
    )
    api, session, _ = _setup(llm)
    r = _inbound(api, session, llm, QUESTION, tmp_path)
    assert r.turn.state == "answered" and r.turn.actions[0] == "get_sector_boundary"
    assert "two seven zero" in r.turn.reply
    tool_msg = llm.calls[1]["messages"][-1]
    assert tool_msg["role"] == "tool" and "east ridge" in tool_msg["content"]
    assert (
        "sector B3 (Bravo Three)" in llm.calls[0]["messages"][0]["content"]
    )  # the speaker's team id is in the turn


def test_model_failure_is_say_again(tmp_path: Path) -> None:
    api, session, llm = _setup(FakeChatClient(default=TimeoutError("slow")))
    r = _inbound(api, session, llm, QUESTION, tmp_path)
    assert (
        r.turn.reply == "Team Two, Sightline. Say again, over." and "model_failed" in r.turn.actions
    )


def test_unknown_callsign_is_say_again(tmp_path: Path) -> None:
    api, session, llm = _setup(FakeChatClient(default="x"))
    r = _inbound(api, session, llm, "Sightline, radio check, over", tmp_path)
    assert r.turn.state == "say_again" and llm.calls == []


# --- test 5: tools never change assignments ------------------------------------------------------


def test_tools_never_mutate_assignments() -> None:
    state, cards = demo_mission()
    api = InMemoryMissionApi(state, cards)
    tools = RadioTools(api, MID, drafts={})
    tasks_before = [dict(t) for t in state["tasks"]]
    for name, args in [
        ("get_assignment", {"team_id": "T2"}),
        ("get_sector_boundary", {"sector_id": "B3", "from_team": "T2"}),
        ("get_conditions", {}),
        ("get_updates_since", {"team_id": "T2", "minutes": 100000}),
        ("draft_clue", CLUE),
        ("report_position", {"team_id": "T2", "lat": 49.37, "lon": -122.93}),
        ("report_status", {"team_id": "T2", "status": "searching"}),
        ("report_status", {"team_id": "T2", "status": "assigned"}),  # not reportable: refused
        ("assign_sector", {"team_id": "T2", "sector_id": "A1"}),  # no such tool
    ]:
        tools.call(name, args)
    assert state["tasks"] == tasks_before
    assert {c[0] for c in api.calls} <= {"patch_team"}
    for _, _, patch in api.calls:
        assert set(patch) <= {"position", "position_at", "status"}
        assert patch.get("status", "searching") in {"searching", "returning"}
    assert tools.call("get_assignment", {"team_id": "T2"})["sector"] == "Bravo Three"


# --- test 6: browser audio to 16 kHz mono -----------------------------------------------------------


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_webm_to_mono16k(tmp_path: Path) -> None:
    webm = tmp_path / "clip.webm"
    subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5",
         "-ac", "2", "-ar", "48000", "-c:a", "libopus", str(webm)],
        check=True,
    )  # fmt: skip
    wav = to_mono16k(webm.read_bytes(), "audio/webm;codecs=opus", tmp_path / "out")
    with wave.open(str(wav)) as w:
        assert (w.getnchannels(), w.getframerate(), w.getsampwidth()) == (1, 16000, 2)
    assert check_length(wav) == pytest.approx(1.5, abs=0.05)
    with pytest.raises(AudioError):
        to_mono16k(b"not audio", "audio/webm", tmp_path / "out")


# --- test 7: the API ------------------------------------------------------------------------------


@pytest.fixture
def client(tmp_path: Path):
    state, cards = demo_mission()
    seen = []
    llm = FakeChatClient({"boundary": "Team Two, Sightline. Entry east ridge, over."})
    app = FastAPI()
    app.state.radio = RadioContext(
        api=InMemoryMissionApi(state, cards), tts=FakeTts(), llm=llm, audio_dir=tmp_path,
        on_turn=lambda mid, turn: seen.append(turn),
    )  # fmt: skip
    app.include_router(radio_router)
    return TestClient(app), seen, app.state.radio


def test_text_turn_returns_a_valid_radio_turn(client) -> None:
    c, seen, ctx = client
    r = c.post(f"/missions/{MID}/radio/turn", data={"text": QUESTION})
    assert r.status_code == 200
    body = r.json()
    turn = RadioTurn.model_validate(
        {k: v for k, v in body.items() if k not in ("clue", "audio_chunks")}
    )
    assert turn.direction == "in" and turn.callsign == "T2" and seen == [turn]
    # "Team Two, Sightline. Entry east ridge, over." -> two sentences, sentence 0 ready at once
    assert body["audio_chunks"] == [
        f"/missions/{MID}/radio/audio/{turn.id}-{k}.wav" for k in (0, 1)
    ]
    assert c.get(body["audio_chunks"][0]).content[:4] == b"RIFF"
    ctx.wait()
    for url in body["audio_chunks"] + [f"/missions/{MID}/radio/audio/{turn.id}.wav"]:
        assert c.get(url).status_code == 200


def test_outbound_transmit_and_skip(client) -> None:
    c, _, _ = client
    out = c.get(f"/missions/{MID}/radio/outbound").json()
    assert [p["id"] for p in out] == ["p014"]
    t = c.post(f"/missions/{MID}/radio/outbound/p014/transmit").json()
    assert t["direction"] == "out" and t["state"] == "transmitted"
    assert t["reply"].startswith("Team Two, Sightline. New assignment, sector Bravo Three")
    assert c.get(f"/missions/{MID}/radio/outbound").json() == []
    assert c.post(f"/missions/{MID}/radio/outbound/p014/transmit").status_code == 404


def test_only_approved_briefings_are_transmitted() -> None:
    state, cards = demo_mission()
    state["proposals"][0]["status"] = "pending"
    api, session = InMemoryMissionApi(state, cards), RadioSession()
    assert outbound(MID, session, api) == []
    with pytest.raises(KeyError):
        transmit(MID, "p014", session, api, FakeTts())


def test_turn_needs_audio_or_text(client) -> None:
    c, _, _ = client
    assert c.post(f"/missions/{MID}/radio/turn", data={}).status_code == 422


def test_confirmation_without_a_callsign_goes_to_the_only_pending_team(tmp_path: Path) -> None:
    api, session, llm = _setup(FakeChatClient({"backpack": _tool("draft_clue", CLUE)}))
    _inbound(api, session, llm, REPORT, tmp_path)
    assert _inbound(api, session, llm, "Affirmative", tmp_path).turn.callsign == "T2"


@pytest.mark.parametrize("name", ["B3", "b3", "Bravo Three", "bravo 3"])
def test_sector_boundary_accepts_the_spoken_name(name: str) -> None:
    state, cards = demo_mission()
    tools = RadioTools(InMemoryMissionApi(state, cards), MID, drafts={})
    assert tools.call("get_sector_boundary", {"sector_id": name})["sector_id"] == "B3"
    assert tools.call("get_assignment", {"team_id": "T2"})["sector_id"] == "B3"


def test_a_described_tool_call_is_retried_never_spoken(tmp_path: Path) -> None:
    described = "Team Two, Sightline, calling get_sector_boundary for sector B3, over."
    good = "Team Two, Sightline. Entry east ridge, over."
    boundary = _tool("get_sector_boundary", {"sector_id": "B3", "from_team": "T2"})
    # FakeChatClient answers by the last user message: the question, then the retry request.
    llm = FakeChatClient({"boundary": described, "Call the tool": [boundary, good]})
    api, session, _ = _setup(llm)
    r = _inbound(api, session, llm, QUESTION, tmp_path)
    assert r.turn.reply == good and "retry: tool described, not called" in r.turn.actions

    stubborn = FakeChatClient(
        {"boundary": described, "Call the tool": described}
    )  # keeps describing
    api, session, _ = _setup(stubborn)
    r = _inbound(api, session, stubborn, QUESTION, tmp_path)
    assert (
        "get_sector_boundary" not in r.turn.reply
        and r.turn.reply == "Team Two, Sightline. Say again, over."
    )
    assert "model_failed" not in r.turn.actions


def test_a_described_draft_is_retried(tmp_path: Path) -> None:
    llm = FakeChatClient(
        {
            "backpack": "Team Two, Sightline, drafting clue, over.",
            "Call the tool": _tool("draft_clue", CLUE),
        }
    )
    api, session, _ = _setup(llm)
    r = _inbound(api, session, llm, REPORT, tmp_path)
    assert r.turn.state == "awaiting_confirm" and "draft_clue" in r.turn.actions


def test_split_sentences_and_concat() -> None:
    from sightline.radio.tts import concat_wavs, split_sentences, wav_bytes

    assert split_sentences(
        "Team Two, Sightline. Entry east ridge, bearing two seven zero, over."
    ) == [
        "Team Two, Sightline.",
        "Entry east ridge, bearing two seven zero, over.",
    ]
    import numpy as np

    a, b = wav_bytes(np.zeros(100), 22050), wav_bytes(np.zeros(50), 22050)
    with wave.open(io.BytesIO(concat_wavs([a, b]))) as w:
        assert w.getnframes() == 150


def test_cached_tts_speaks_each_phrase_once() -> None:
    from sightline.radio.tts import CachedTts

    calls = []

    class Counting(FakeTts):
        def speak(self, text, voice="en_female"):
            calls.append(text)
            return super().speak(text, voice)

    tts = CachedTts(Counting())
    tts.warm(["Team Two, Sightline."])
    assert tts.speak("Team Two, Sightline.").ms == 0 and calls == ["Team Two, Sightline."]
