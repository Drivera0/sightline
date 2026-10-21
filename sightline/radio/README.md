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
tts, asr = MagpieTts(), ParakeetAsr()          # ~57 s + ~32 s to load on the 4080; load once at startup
reply = tts.speak("Team Two, Sightline. Copy. Over.")   # TtsResult: .wav bytes, .sample_rate 22050, .ms
heard = asr.transcribe(wav_16k_mono_path)              # AsrResult: .text, .ms, .words
```

Parakeet needs 16 kHz mono; Magpie returns 22.05 kHz, so resample (the spike uses
`scipy.signal.resample_poly`). Browser audio (webm/opus) needs ffmpeg, which `audio.py` will call.

## Decisions already made (from the spike, `docs/feedback/radio.md`)

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
- [ ] `audio.py`: `to_mono16k` (ffmpeg; `sudo apt install ffmpeg` on the desktop), `duration_s`, test 6
- [ ] `tools.py`: `RadioTools` (read-mostly; nothing changes assignments), test 5
- [ ] `turn.py`: `RadioSession`, `handle_inbound` (readback → `POST /clues` only after "affirmative"), `transmit`, tests 3–4
- [ ] `prompts.py`: the radio system prompt (LANE_E §8.3; the spike's `RADIO_SYSTEM` is a start)
- [ ] `api.py`: `radio_router` (`/turn`, `/audio/{id}.wav`, `/outbound`, transmit, skip), `dev.py`, test 7
- [ ] E-14 onward: the radio desk UI in `web/src/radio/`, outbound queue, WER and latency scripts
