# Hostile review, 2026-10-22 (main at cba05ae, #180)

Read cold, in a judge's order. `pytest tests -q -x --timeout 900`: 1381 passed, 6 skipped, 83 s (needs `uv run --with pytest-timeout`). `check_evidence_index.py`: 74 rows pass. Ten rows spot-checked: nine match; row 36 cited `agent.md:187-211`, but the chain is at 207-237 (fixed).

## (a) OpenCV AI Competition 2026

| Rubric line | Score | Why |
|---|---|---|
| Technical execution (30) | 23 | `cv2.dnn` matches Torch box for box (report §3.1), and `reproduce_cv2.py` exits 1 on a mismatch, but the agent evaluation runs on fakes (`AGENT_EVAL.md:93`, "the VL model always says yes"). |
| Innovation (20) | 14 | The map, the planner and the approval gate together are new (report §1.1). Each part is standard. |
| Real-world impact (20) | 11 | No search manager has reviewed it (`JUDGE_QA.md` Q3), no real flight (`REAL_FLIGHT.md` status), and recall is 0.516 on LADD. |
| UX (10) | 6 | One screen shows both "Flyable" and "Not flyable" (`run-t4-…png`), and every sector reads 3 % after three clues (`t3-d.webp`). |
| Documentation (10) | 9 | The evidence index is CI-checked. "Real voices" meant three different things. |
| Cloud delivery (10) | 7 | SQS FIFO with a dead-letter queue, CloudWatch and IAM (report §4). The API has no login and is stopped between demos. |
| **Total** | **70** | |

**Agentic Vision award:** perception → decision → action 22/30 (one real chain, the 0.18 near-miss, `agent.md:107-137`); orchestration and autonomy 20/25 (the API enforces the gate, `missions.py:470`); task effectiveness and evaluation 11/20 (+4 of 337 people for +15 false alarms, and the routing evaluation uses fakes); observability 11/15 (`trace.jsonl` and the Trace view, but the demo's own proposals "are fixtures with no trace"); docs 9/10. **73/100.**

**Strongest:** (1) The parity table and a 5-minute CPU reproduction (README:169-180). (2) Weaknesses come first: WHAT_BREAKS_FIRST, the test disclosure (README:40), the 0-of-25 negative. (3) One re-look tool per failure mode (report §3.5).

**Weakest:** (1) The Debrief says "+22 pts better" and "131× faster" against a human figure the README calls "not a head-to-head", and the speed is the GPU Torch time, not the shipped `cv2.dnn`. (2) The showcase approval is scripted (`agent.md:150`). (3) The demo's 0.18 card is a "recorded second look on another HERIDAL photo". (4) A 3 % engine difference (96 vs 99 ms) sold as a finding. (5) There is no video (`DEVPOST_OPENCV.md:10`).

**On stage:** "Show me one decision on a live mission where a person, not a script, pressed Approve."

## (b) Nebius × NVIDIA, Physical AI track

| Line (equal weight) | /10 | Why |
|---|---|---|
| Technological implementation | 7 | Three Nemotron models on one client; a Serverless Job and an Endpoint, measured (`nebius.md` §5–6), the endpoint since deleted; no Jetson. |
| Design | 6 | One console with honest SIM labels, but the flyability contradiction and a UTC clock at a BC command post. |
| Potential impact | 6 | Cost is under $1 per 500 photos (report §4.1), but the "physical" part is simulated (`DEVPOST_NEBIUS.md:87`). |
| Quality of the idea | 8 | Field teams as sensors, a readback before a clue is logged, a person at the gate. |
| **Total** | **27/40** | |

**Strongest:** (1) Actionable feedback: thinking inside `max_tokens`, the CLI printing the token, the 0-vCPU quota (`nebius.md`). (2) Safety is enforced in code after live failures (radio.md findings 8–12). (3) Tavily values are kept only with a verbatim quote (`TAVILY.md:21-23`).

**Weakest:** (1) No physical hardware, and the Jetson is roadmap only. (2) "First sound … with real voices" meant Sightline's TTS while team lines were sent as text (`radio_rehearse.py` docstring); fixed. (3) WER on one voice through a desk microphone. (4) The bulletin tool's only proposal came from an article titled "missing hiker's body found" (`docs/evidence/subject/20261022T181056Z/proposal.json`). (5) The video is missing (`DEVPOST_NEBIUS.md:9`).

**On stage:** "Which part of this would still work on a ridge with no internet?"

## (c) SAR volunteer who has run a command post

| Line | /10 | Why |
|---|---|---|
| Fits the command post | 6 | ICS 204/214 and CalTopo GeoJSON (`EXPORTS.md`) are what we file, but the clock is in UTC. |
| Trust in the map | 4 | After the boot prints, the lake sighting and the trailhead car, Team One goes to corner A1, "tied for the most" at 3.3 % (`t3-d.webp`). |
| Safety and human control | 8 | Readback before logging, no "clear", POD capped at 0.9 (report §11). |
| Field readiness | 3 | No login (`SECURITY.md`), needs AWS and the internet, English only, no real flight. |

**Strongest:** (1) "Searched at POD 60 %" instead of "done". (2) It writes the forms we already file. (3) The briefing check rejects "No further action is needed" (`agent.md:200`).

**Weakest:** (1) The map does not move on clues in the demo. (2) Proposal reasons say "expected to rule out 3.1 % of the probability", which reads as the language the product bans. (3) A re-look leg is worth "0.010 % of the probability" (`agent.md:255`). (4) Recall on unfamiliar terrain is about half. (5) A real minor's description sits in `docs/evidence/subject/` (Golden Ears, `TAVILY.md:237`).

**On stage:** "Your three clues all point east of the trailhead. Why does my first team go north-west?"

## Ranked fix list

| # | File | Wrong (quote) | Fix | Min | Who |
|---|---|---|---|---|---|
| 1 | `DEVPOST_*.md` | "**Video:** <to add>" | Upload the final4 cuts (OpenCV 3:52.8, Nebius 2:41.1) and link them | 30 | D |
| 2 | demo fixture, `web/` | "A1 holds 3.3% of the probability, tied for the most" after three clues | Make clues move the sector shares, and send the first team toward them | 120 | C |
| 3 | Debrief, `web/` | "+22 pts better", "131× faster", "0.25 s" | "reference, not a matched study"; show the `cv2.dnn` time; add "best of three seeds" to 3.0 ha | 30 | C |
| 4 | Conditions panel, `web/` | "Flyable" beside "Not flyable: after civil twilight" | Mark the recorded verdict "at 05:31 UTC, not now" | 30 | C |
| 5 | `agent.md:151` | "the chain is run again with a real person approving" | Do it during the recording and replace the trace | 20 | D |
| 6 | Trace view | "The demo mission's proposals are fixtures with no trace" | Record traces for the demo's proposals | 90 | C |
| 7 | `REAL_FLIGHT.md` | no real footage run | One real folder through `real_flight.py run` | 60 | D |
| 8 | `docs/evidence/subject/` | "missing-hikers-body-found…"; a 16-year-old's clothing | Keep with a sensitivity note, or rerun on a synthetic bulletin | 15 | D |
| 9 | `SECURITY.md` | the API "is open by default" | Turn on `SIGHTLINE_API_TOKEN` during judging | 10 | D |
| 10 | `AGENT_EVAL.md` | creek scenarios run on fakes only | Run `--live` once and report it | 30 | C (key) |
| 11 | proposal reasons, `planner.py` | "expected to rule out 3.1 %" | "expected to lower its probability by 3.1 points" | 20 | C |
| 12 | console clock, `web/` | "20:35 UTC" | Local time, with UTC on hover | 30 | C |
| 13 | 14 cites to `runs/…` | evidence not committed (`.gitignore:21`) | Commit the small summary JSONs to `docs/evidence/` | 30 | C |
| 14 | `agent.md:109` | "A **val** photo (`train_ZRI_2061`…)" | Explain HERIDAL's `train_` prefix against our val split, after checking the split file | 10 | C |
| 15 | `pyproject.toml` | the review's `--timeout 900` fails | Add `pytest-timeout` to the dev group | 5 | C |

## Applied in this PR (docs only, line numbers of README and the report unchanged)

1. `README.md:5`: the GIF caption described the pre-#171 recording ("18 s … Drone 1 re-tasked to the water-bottle clue"). It now describes the 16 s one-console GIF.
2. "real voices" became "replies spoken by Magpie, team lines typed" in README:114, report:807/811/842, both Devposts, EVIDENCE_INDEX rows 58 and 61, `radio.md`:101/102/188 and `nebius.md`:308.
3. Agent evaluation "about 20 s" became "about 6 min" (README:36, report:1086, EVIDENCE_INDEX row 38), matching `AGENT_EVAL.md:7`.
4. View switch "keys 1 to 5" became "· Radio, keys 1 to 6" (README:68, DEVPOST_OPENCV:81), as in `web/src/shell/README.md:11`.
5. Report §6.2: added "seed 7, the best of the three seeds", which the README states and the report left out. The same caveat is in both gallery captions.
6. Report §10: "`--live` has not been run" became "run once, for the re-look scenario only" (`AGENT_EVAL.md:125-135`).
7. EVIDENCE_INDEX row 36: `agent.md:187-211` became `:207-237`.
8. Overclaims softened: "None turns" became "None we found turns" (DEVPOST_OPENCV:64), and "CalTopo … has no probability map" was rewritten the same way (DEVPOST_NEBIUS:56).
9. DEVPOST_NEBIUS:64 and `REAL_FLIGHT.md`: added "tested on synthetic files only, no real footage yet".
10. `SECURITY.md`: "stores nothing about real people" now names the redacted bulletin excerpts.
11. DEVPOST_NEBIUS:78: added the missing "$" to the VL cost.
12. `JUDGE_QA.md`: updated the stale "as of #143" line-number note.
