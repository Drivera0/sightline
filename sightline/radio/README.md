# sightline/radio: the radio desk backend (lane E)

Lane E's package (LANE_E §8). Lane E has no owner yet, so lane A built the first part (issue #30)
on top of the E-R0 spike (issue #24, results in `docs/feedback/radio.md`). **Build on this; don't
start these files again.** Update the checklist below as pieces land.

## What exists

| File | What it does | Tested |
|---|---|---|
| `protocol.py` | `normalize` (number words → digits, "niner" → 9, "point" → ".", "minus" → "-", commas as the pause between numbers, "sight line" → "sightline"), `parse_callsign` (→ team id, default roster T1–T4 or the mission's), `classify_reply` (only an explicit affirmative confirms; "copy"/"roger" don't), `spoken_number`, `spoken_coord` (digit by digit, so the model never speaks a coordinate) | `tests/radio/`: 30 coordinates round-trip, callsign and reply fixtures |
| `asr.py` | `Asr` protocol, `AsrResult` (text, ms, word timestamps), `ParakeetAsr` (Parakeet TDT 0.6B v2 via NeMo, lazy, warm-up on load), `FakeAsr` | fake in tests; real class run on the RTX 4080: 76 ms for a 5 s phrase, 13 word timestamps |
| `tts.py` | `Tts` protocol, `TtsResult` (WAV bytes, rate, ms), `MagpieTts` (Magpie 357M via NeMo `do_tts`, lazy), `FakeTts`, `wav_bytes` | fake in tests; real class run on the RTX 4080: 3.95 s for the same phrase, 22.05 kHz |
| `audio.py` | `to_mono16k` (ffmpeg: browser webm/opus, ogg, wav → 16 kHz mono 16-bit), `duration_s`, `check_length` (0.4–30 s, else "say again") | test 6 (webm made with ffmpeg) |
| `mission_api.py` | `MissionApi`: how the radio reads and writes the mission. `HttpMissionApi` (lane D's REST API, contract §13: state, cards, `PATCH /teams`, `POST /clues`), `InMemoryMissionApi` + `demo_mission()` (the LANE_E §8.7 demo mission) | used by every turn test |
| `tools.py` | `RadioTools` + `TOOL_SPECS`: `get_assignment`, `get_sector_boundary` (accepts "B3" or "Bravo Three"), `get_conditions`, `get_updates_since`, `draft_clue` (stored, **not** posted), `report_position`, `report_status` (searching / returning only) | test 5: no tool changes an assignment |
| `prompts.py` | `RADIO_SYSTEM` (LANE_E §8.3, `radio-v1`) and `speaker_context` (team id, its sector, "never ask for coordinates") | |
| `turn.py` | `handle_inbound`: audio or text → (a clip with no words: "say again", no model call) → callsign → readback confirmation (no model call) or Nemotron 3 Super with tools (≤ 3 rounds) → post-check (callsign prefix, units and digits spoken as words, "clear" → standby, a described-not-called tool gets one retry) → speech. The clue readback is built in code; the clue is posted only after "affirmative", with `confirmed_by_turn`. `transmit`: approved briefings only | tests 3–4, plus failure paths |
| `api.py` | `radio_router` (`/turn`, `/audio/{id}.wav`, `/outbound`, `/transmit`, `/skip`) and `RadioContext` (put it on `app.state.radio`) | test 7 |
| `dev.py` | the router alone with the demo mission: `uv run uvicorn sightline.radio.dev:app --port 8010`; live Nemotron if `NEBIUS_API_KEY` is set; `SIGHTLINE_RADIO_MODELS=real` loads Parakeet + Magpie | run live (below) |

NeMo and torch are imported lazily: the package imports on any laptop, and `tests/radio/` runs with no
GPU, network or NeMo.

## Running the real models

NeMo lives in its own environment (it pins its own Lightning; keep it out of the project's `.venv`):

```bash
uv venv -p 3.11 ~/radio-env
VIRTUAL_ENV=~/radio-env uv pip install "nemo_toolkit[asr,tts]" openai python-dotenv
~/radio-env/bin/python scripts/radio_spike.py          # the spike: load, speak, transcribe, one Nemotron turn
```

From code (in that environment, with the repo on `PYTHONPATH`):

```python
from sightline.radio.asr import ParakeetAsr
from sightline.radio.tts import MagpieTts

tts, asr = MagpieTts(), ParakeetAsr()  # ~57 s + ~32 s to load on the 4080; load once at startup
reply = tts.speak(
    "Team Two, Sightline. Copy. Over."
)  # TtsResult: .wav bytes, .sample_rate 22050, .ms
heard = asr.transcribe(wav_16k_mono_path)  # AsrResult: .text, .ms, .words
```

Parakeet needs 16 kHz mono; Magpie returns 22.05 kHz, so resample (the spike uses
`scipy.signal.resample_poly`). Browser audio (webm/opus) needs ffmpeg, which `audio.py` will call.

## Rehearse the demo (2026-10-21)

`scripts/radio_rehearse.py` plays the LANE_E §8.7 script against a running server (`dev.py`), checks
every step (state, tool, the words the script needs, first sound ≤ 5 s), and with `--audio` keeps the
replies as WAVs plus one `demo.wav` per run (`--radio-sound` adds a copy with the desk's radio filter,
for the video), under `runs/radio/rehearsal-<timestamp>/`. Run it before recording the video:

```bash
SIGHTLINE_RADIO_MODELS=real <radio-env>/bin/uvicorn sightline.radio.dev:app --port 8010
uv run python scripts/radio_rehearse.py --runs 5 --audio --radio-sound
```

Last result, real voices: **5 / 5 runs as scripted**, first sound mean 1.3 s, max 3.0 s (the standby).
It found "Copy object, Found a blue backpack…" in a readback (fixed: `tools.clue_text`). The demo
briefing now matches the script word for word ("bearing two seven zero, six hundred metres … Two hours
forty of daylight"), and "what are the conditions" is answered in short sentences built in code
(`RadioTools.conditions_summary`), so the voice pauses in the right places.

## Measured live (2026-10-20, Nemotron 3 Super on Token Factory, RTX 4080)

- The LANE_E §8.7 demo script runs end to end through the API: transmit the assignment → "say again the
  sector boundary" → "found a blue backpack, our position" → readback → "affirmative" → clue posted.
- Tool reliability on the two inbound beats, after the fixes above: **8 / 8 and 8 / 8**; Nemotron time p50
  1.4 s (clue report, one call) and 2.4 s (boundary, two calls).
- Full voice turns (Magpie speaking the team, encoded as webm like a browser, then `/turn`): ASR 51–139 ms.
  Magpie runs at about 0.66× real time whatever the setting (CFG off and bf16 were not faster), so speaking
  a whole 25-word reply took 10.4 s. **Fixed by speaking sentence by sentence**: every reply opens with
  "<Callsign>, Sightline." (pre-spoken at start-up, plays at once), long sentences are cut at commas into
  ≤ 10-word chunks, and the rest are generated while the first plays. **Time to first audio: 3.7 s
  (boundary question), 3.6 s (clue report), 0.1 s (confirmation)**, under the 5 s target; the longest pause
  between chunks was 1.3 s.

**Standby when the model is slow.** Token Factory's response time varies (1.9–3.4 s most of the
evening, 3–9 s later). If a turn isn't answered within 2 s (`STANDBY_AFTER_S`), `/turn` answers at once
with `{"standby": true, "reply": "<Callsign>, Sightline. Standby.", "audio_chunks": [...], "poll": ...}`
(the phrase is pre-spoken, so it plays immediately, which is also proper radio procedure). The turn keeps
running; `GET poll` returns 202 until it is done, then the normal turn response. The desk plays the
standby, shows "Standby sent · thinking…", polls every 300 ms, then plays and logs the answer. So the team
always hears something within about 2 s.

## For the radio desk UI (lane E, E-14): playing a reply

`POST /turn` and `POST /outbound/{id}/transmit` return the turn plus **`audio_chunks`**: URLs in order.
Chunk 0 is ready when the response arrives; later chunks appear while it plays. Play them one after the
other; if a chunk returns 404, it is still being generated: retry after ~100 ms. The whole reply is also at
`/missions/{id}/radio/audio/{turn}.wav` once every chunk is done (for the log or a replay). `tts_ms` in the
turn is the time to chunk 0. In `dev.py` (and when D mounts the router), wrap the TTS in `CachedTts` and
`warm()` it with `"<Callsign>, Sightline."` for every team plus `"All teams, Sightline."`.

## Decisions already made (from the spike and the live runs, `docs/feedback/radio.md`)

- **Reasoning model: Nemotron 3 Super, thinking off**, through `sightline.agent.llm` (tool-call ids
  and `assistant_message` / `tool_message` helpers are there). Nano made 0 / 3 tool calls and once
  invented an answer.
- **Put the speaker's team id in the turn** (from `parse_callsign`), or the model asks for it instead
  of calling the tool.
- **Prefix "<callsign>, Sightline" in code**, don't trust the prompt to.
- Known limit: a positive longitude spoken straight after the latitude with no pause can merge into
  one number; the readback-and-confirm step (LANE_E §8.3) is the safety net.

## Still to do (lane E)

- [ ] `VOICES` in `tts.py`: listen to Magpie's speakers and pick one female and one male English voice
- [x] `audio.py`, `tools.py`, `turn.py`, `prompts.py`, `api.py`, `dev.py`, tests 3–7 (lane A, issue #30)
- [x] Time to first audio under 5 s: chunked speech + cached openers (lane A, above)
- [ ] Optional: stream within a chunk with Magpie's chunked inference (`create_chunk_state` /
      `generate_speech`) to shorten the ~1 s pauses between chunks
- [ ] Lane D: mount `radio_router` with a `RadioContext` (D-R4) whose `api` is `HttpMissionApi` (or an
      in-process equivalent) and whose `on_turn` writes `trace_call(actor="radio", kind="radio_turn")` + a `radio.turn` event
- [ ] Real roster callsigns for `parse_callsign` come from the mission's teams (already passed in `turn.py`)
- [x] E-14: the radio desk UI in `web/src/radio/` (lane A, issue #36; see its README)
- [ ] E-18: WER with 3 voices on 20 phrases, latency p50/p90 over 30 turns (`scripts/radio_wer.py`, `scripts/radio_latency.py`)
