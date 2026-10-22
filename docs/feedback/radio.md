# Radio desk: spike results (E-R0) and feedback data

Lane E's file (LANE_E §8.6). The **E-R0 spike** below was run by lane A on 2026-10-20 (issue #24)
because lane E had no owner yet; whoever builds the radio desk starts from here. The latency tables
are below (E-18); the word error rate with three human voices still needs recordings (issue #49).

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

## Safety checks found by measuring 30 live turns (E-18, `scripts/radio_latency.py`)

Repeated runs of the demo questions in conversation (5 turns per mission) found two failures the
one-off tests hadn't, both now enforced in code (`sightline/radio/turn.py`), not left to the prompt:

8. **A clue claimed but never drafted.** Late in a conversation the model sometimes *said* "Drafted clue:
   blue backpack…" without calling `draft_clue` (3 of 6 reports), then answered the team's "affirmative"
   with "Copy that, out.": the team would have believed a clue was logged that wasn't. Now a report
   ("found", "spotted", "heard", "footprints", "tracks") or a reply claiming one ("drafted", "logged") with
   no real draft gets one explicit retry, then "say again your report"; a bare "affirmative" with nothing
   pending gets "nothing awaiting confirmation" from code, with no model call.
9. **Invented weather.** Asked for the conditions in a fresh session, the model answered "partly cloudy,
   light wind, twelve Celsius" without calling `get_conditions`, while the mission had gusts of 30 km/h and
   rain. Conditions questions now must call the tool that turn (one retry), else "conditions not available".

After the fixes, 30 live turns (Nemotron 3 Super on Token Factory, `docs/evidence/radio-latency-20261020.json`):

| Turns | First sound p50 / p90 | Answer p50 / p90 | Model p50 / p90 | Standby played | Clue reports | Conditions from the tool |
|---|---|---|---|---|---|---|
| 30 | 2.0 / 3.0 s | 2.0 / 3.3 s | 2.3 / 3.2 s | 13 % of turns | 6 / 6 drafted, read back, committed | 6 / 6 |

Standby plays after 3 s (the model's p90); at 2 s it fired on 63 % of turns, mostly 0.3 s before the
answer. These are text turns (ASR adds 45–153 ms). For the feedback form: tool calling with thinking off
needs code-side guards for anything safety-relevant; a "tool_choice: required" that the model honours, or
a structured-output mode that forces a tool call, would remove most of them.

### Per stage

Each stage from the run that measured it (the text-turn runs leave out speech; the voice rehearsals log
only end to end):

| Stage | p50 | p90 | Measured on |
|---|---|---|---|
| Speech → text (Parakeet TDT 0.6B v2, RTX 4080 SUPER) | 45–130 ms per phrase (3.9–8.7 s of audio) | 153 ms (max) | the spike, 5 phrases |
| Reasoning + tools (Nemotron 3 Super, Token Factory, thinking off) | 2.3 s | 3.2 s | 30 text turns |
| Text → speech (Magpie 357M) | about 0.5× real time per sentence; the "<callsign>, Sightline" opener is cached (0 ms) | — | the spike; the opener cache in `sightline/radio/tts.py` |
| **First sound, end to end, real voices** | **2.5 s** | **3.0 s** | 18 inbound turns of the demo script, 2 rehearsals (`scripts/radio_rehearse.py`) |
| Full answer spoken, end to end, real voices | 2.6 s | 7.0 s | the same 18 turns (long replies are spoken sentence by sentence) |

The ≤ ~5 s target is met for the first sound in every rehearsed turn (max 3.01 s): a spoken "standby"
covers a slow model call. The full answer passes 5 s when the model takes over 4 s (p90 model time in the
rehearsals 7.4 s, with a retry when the model described a tool instead of calling it).

## Voice and text didn't match (fixed)

Reported in the second real-voice session; two causes, both fixed:

10. **Audio from an earlier server run.** Turn ids restart at r0001 with every run and audio chunks were
    named by turn id, so a chunk not generated yet could be served from an earlier run's file of the same
    name. Audio names now carry a per-run token, and audio is served `no-store`.
11. **The model's reasoning in the reply.** With thinking off, Nemotron 3 Super sometimes put its
    reasoning before the answer after a tool call ("Now respond per rules … Keep brief.`</think>`"), and the
    radio spoke it. Found by transcribing every generated chunk with Parakeet and comparing it with the
    text it should say; the client now strips everything up to the last `</think>`. Once it leaked without a
    `</think>` ("Now respond, Team Two, Sightline. Sector Bravo Three…"): the post-check now drops anything
    before the reply's "<Callsign>, Sightline" opening.
12. **Conditions answered from memory.** After a full conditions answer, "how windy is it?" and "can the
    drones fly?" were answered from the conversation with no tool call (once with "km/h" in the text), and
    "when is sunset?" got the whole summary again. Questions about one condition now also must call
    `get_conditions`, and get only that sentence, built in code: 8 / 8 live.

## How numbers are spoken

Radio procedure: **digit by digit only where one misheard digit changes a place or a direction**:
bearings and headings ("bearing two seven zero", "heading zero niner five") and coordinates. Everything
else is said as in speech: distances, speeds, temperatures, counts ("six hundred metres", "eighteen
kilometres per hour"). Times are radio style in local time ("eighteen twelve local"). The sector-boundary
answer gives the sector's size and the way to its entry instead of four generic corner names:
"Sector Bravo Three, about two hundred fifty metres across, entry east ridge, bearing two seven zero
degrees, distance six hundred metres, over." (8 / 8 live). Replies holding a template placeholder
("[tool output]", seen once) get one retry and are never spoken.

## Measuring WER

E-18, issue #49: still to record. `tests/radio/phrases.txt` has the 20 phrases; three voices read them as
written (coordinates digit by digit). Put each voice in its own folder, either one file per phrase
(`data/radio_wer/<voice>/01.m4a` … `20.m4a`) or one file per voice with about a second's pause between
phrases (`data/radio_wer/<voice>/<any name>.m4a`). Any format ffmpeg reads works (phone voice memos are
m4a); `01.radio.m4a` (or `<name>.radio.m4a`) is the same voice through the radio-sound filter, reported
separately. Then, in the NeMo env:

```bash
~/radio-env/bin/python scripts/radio_wer.py                 # one file per phrase
~/radio-env/bin/python scripts/radio_wer.py --one-file      # one file per voice, split on silence
uv run python scripts/radio_wer.py --dry-run                # no NeMo: mock transcripts, checks the pipeline
```

Each clip goes through the radio desk's own path (`to_mono16k` → 16 kHz mono WAV in a temp dir →
`ParakeetAsr`). WER is word level after `protocol.normalize` on both sides (so "Team 2" = "Team Two",
"Sight line" = "Sightline"), pooled per voice and overall, with the coordinate exact-match rate. It writes
`runs/radio_wer/<timestamp>/wer.md`: per-voice and per-phrase tables and the five worst phrases with what
Parakeet heard (plus `wer.json`). If `--one-file` finds the wrong number of phrases, lower `--min-silence`
(default 0.6 s) or raise `--silence-db` (default -35, e.g. -30 for a noisy room). `--synthetic` runs the
same on Magpie's voices as a labelled baseline.

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
- [x] E-18 latency over 30 turns (lane A; table above); scripts `radio_latency.py`, `radio_wer.py`
- [ ] E-18 WER: record 3 voices (instructions above), then run `radio_wer.py`
- [x] Demo script rehearsal (lane A): `scripts/radio_rehearse.py`, 5 / 5 runs as scripted with real voices, first sound ≤ 3.0 s; WAVs for the video with `--audio --radio-sound` (`sightline/radio/README.md`)
