# Radio desk: spike results (E-R0) and feedback data

Lane E's file (LANE_E §8.6). The **E-R0 spike** below was run by lane A on 2026-10-20 (issue #24)
because lane E had no owner yet; whoever builds the radio desk starts from here. The WER and
latency tables (E-18, `scripts/radio_wer.py`, `scripts/radio_latency.py`, 3 voices) are still to do.

## Go / no-go: **GO**, with Nemotron 3 Super for the reasoning step

All three NVIDIA model families run on the GPU desktop (RTX 4080 SUPER, WSL2), no fallback needed:

| Step | Model | Result |
|---|---|---|
| Speech → text | Parakeet TDT 0.6B v2 (`nvidia/parakeet-tdt-0.6b-v2`) | **45–130 ms** per phrase (3.9–8.7 s of audio). Loads in 32 s. |
| Reasoning + tools | Nemotron 3 **Super** (`nvidia/nemotron-3-super-120b-a12b`), thinking off, Token Factory | **3 / 3** correct tool calls (`get_sector_boundary{"team_id": "T2"}`), answer only from the tool's data; **1.9–3.4 s** for the tool call plus the reply (two calls) |
| Text → speech | Magpie TTS multilingual 357M (`nvidia/magpie_tts_multilingual_357m`), `do_tts`, speaker 0 | **about 0.5× real time**: 1.8–4.8 s to generate 3.9–8.7 s of speech, 22.05 kHz. Loads in 57 s. |

GPU memory peak with both speech models loaded: **6.1 GB**.

**Round trip** for one inbound question (ASR + 2 Nemotron calls + spoken reply): **3.9 s** with Nano
(which didn't call the tool, see below); with Super, about **0.1 + 2.7 + 3.0 ≈ 6 s**, over the ≤ ~5 s
target. TTS is the largest share. Ways to get under 5 s, to try in E-13/E-16: keep replies to one
sentence (TTS time scales with audio length), start playing while Magpie generates (chunked
inference: `create_chunk_state` / `generate_speech`), and prepend a fixed "<callsign>, Sightline"
clip recorded once.

## Findings that change the design (LANE_E §8.2–§8.3)

1. **Use Nemotron 3 Super, not Nano, for radio turns.** With thinking off, Nano made **0 of 3** tool
   calls; once it **invented** a boundary ("northeast at 45 degrees, 5 kilometers") that no tool
   returned. With thinking on it called the tool (2 / 2) but took 3.1–4.5 s for the first call
   alone. Super with thinking off was correct 3 / 3 and faster than Nano with thinking.
2. **Put the parsed callsign's team id in the turn.** Without it ("Team 2" in the transcript, no
   mapping to `T2`), the model asked for the team id instead of calling the tool. LANE_E's
   `parse_callsign` → team id → system message ("The speaker is team T2 (callsign Team Two)")
   fixes it.
3. **Normalise before comparing.** Parakeet writes numbers as digits and sometimes splits words:
   "Team Two" → "Team 2", "Bravo Three" → "Bravo. 3", "Sightline" → "Sight line". Measured WER on
   the three phrases was 0.29 / 0.11 / 0.00 *before* normalisation; almost all of it is this.
   `protocol.normalize` (LANE_E §8.3) should map number words and digits to one form, and
   `parse_callsign` must accept "Sight line".
4. **Super's replies didn't always start with "<callsign>, Sightline"**: enforce the opening in
   code (prefix it) rather than trusting the prompt, as §8.4 already does for outbound.

## Live runs of the turn handler (after the spike)

With the real `handle_inbound` and Nemotron 3 Super, three more failure modes showed up, each now handled
in code (`sightline/radio/turn.py`, `prompts.py`):

5. **A tool result without the id it needs**: `get_assignment` returned only "Bravo Three"; the model
   then called `get_sector_boundary("Bravo Three")`. Tools now return ids and accept spoken names.
6. **Asking the team for coordinates** instead of using the tool (3 of 5 runs, for boundary questions;
   once for a found object "at our position"). Fixed by putting the team's sector in the turn and saying
   the system knows the team's position.
7. **Describing a tool call instead of making it** ("calling get_sector_boundary…", "drafting clue",
   "requesting sector boundary"). Such replies get one retry and are never spoken.

After the fixes: 8 / 8 tool use on both inbound beats; Nemotron time p50 1.4–2.4 s per turn. Full voice
turn: ASR 51–139 ms, TTS 4.6–10.4 s depending on reply length: **TTS is the bottleneck** for the 5 s target.
Magpie's speed options didn't help (CFG off and bf16 were not faster; about 0.66× real time throughout).
Speaking sentence by sentence with a pre-spoken "<Callsign>, Sightline." opener brought **time to first
audio to 3.6–3.7 s** for model turns and 0.1 s for a confirmation, longest pause between chunks 1.3 s
(`sightline/radio/README.md`). For the feedback form: a streaming TTS API (first audio in < 300 ms) would
matter more for voice agents than raw throughput.

## How to reproduce

```bash
uv venv -p 3.11 ~/radio-env
VIRTUAL_ENV=~/radio-env uv pip install "nemo_toolkit[asr,tts]" openai python-dotenv   # NeMo 3.0.0, torch 2.14
~/radio-env/bin/python scripts/radio_spike.py --out runs/radio_spike                  # ~2 min, downloads ~3 GB once
```

Keep NeMo in its own environment: it pins its own Lightning and versions that the project's `.venv`
doesn't need. `ffmpeg` is not installed on the desktop yet; `to_mono16k` (webm from the browser →
16 kHz WAV) needs it: `sudo apt install ffmpeg`. Model downloads need no Hugging Face token.

## Still to do (lane E)

- [x] E-13 part 1 (lane A, issue #30): `protocol.py`, `asr.py` (`ParakeetAsr`), `tts.py` (`MagpieTts`)
      with tests 1–2; see `sightline/radio/README.md`
- [x] E-13 part 2 + E-16 (lane A, issue #30): `audio.py`, `tools.py`, `turn.py`, `prompts.py`, `api.py`,
      `dev.py`, tests 3–7; the demo script runs end to end (see `sightline/radio/README.md`, "Measured live")
- [x] E-14: the radio desk screen, `web/src/radio/` (lane A, issue #36; see its README)
- [ ] E-18: WER with 3 voices on 20 phrases (`tests/radio/phrases.txt`), latency p50/p90 over 30 turns
