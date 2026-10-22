# Devpost: Nebius × NVIDIA Global AI Hackathon (Physical AI track)

**Name:** Sightline
**Subtitle:** One search map for drones, ground teams and the radio, on Nemotron: drone photos and voice reports in, where to search next out
**Track:** Physical AI
**Repo:** https://github.com/Drivera0/sightline (AGPL-3.0, tag `nebius-submit`, created at submission)
**Demo:** https://sightline-iota-sandy.vercel.app (`#m/demo/command` opens the command view on a demo mission, no server needed)
**Video:** <to add>

<!--
Video outline for Dan (≤ 3:00, public YouTube; from .documents/WIN_RESEARCH.md §8, Nebius video, a trim of the OpenCV master):
0:00–0:10 Dan on camera, one line + "runs on Nebius Token Factory" said aloud.
0:10–0:25 Front door + upload, 2× speed.
0:25–0:55 Detection → re-look with the Trace tab showing which NVIDIA model did what (Nemotron VL, Nemotron Super, Parakeet, Magpie).
0:55–1:25 Fleet re-task moment: clue by radio → map shifts → agent proposes diverting the nearest drone → approve → drone turns (≥ 1 min of key modules in action starts here).
1:25–1:50 Assignment card → radio exchange, 8 s of audio.
1:50–2:15 Tavily moment: gusts → no-fly → recall, with the cited source. Architecture with the Nebius box highlighted; Serverless Job line (711 photos, 483 s, ~$0.10).
2:15–2:40 Limits (2 bullets) + what's next (Jetson field kit, thermal).
2:40–3:00 On camera close, repo + live URL.
Production: burn in captions; name Nebius and NVIDIA with audio; mark "Not for Kids"; no copyrighted music.
-->

**Gallery (in this order):**

1. *The command view: drone detections on the probability map, the task board, the approval inbox.* (`docs/architecture/screens/command-view.png`)
2. *Which NVIDIA model did what: the re-look crop and the native zoom Nemotron VL answered from, with its trace line.* (`docs/architecture/av-chain/`)
3. *The radio desk: Parakeet hears the team, Nemotron 3 Super answers from tools, Magpie speaks; clues are read back before they are logged.* (screenshot to take)
4. *A team's clue re-tasks the nearest simulated drone; the approval inbox shows the planner's reason.* (`docs/architecture/screens/approval-inbox.png`)
5. *Architecture with Token Factory, the GPU speech models and the Serverless Job marked.* (`docs/architecture/system.png`)
6. *Results: detector vs the human baseline, the fleet simulation, radio latency.* (screenshot of the results table)

---

For search managers, Sightline turns drone photos and radio reports into one map that says where to look next, so teams are tasked in minutes.

Measured, with the caveat beside each number:

- **The detector finds 89.6 % of people on the HERIDAL test set against 68 % for people reviewing by eye, scored the study's loose SAR-APD way; under strict VOC scoring it is 86.4 %** [1].
- **In simulation, on a flat prior, three coordinated drones find the person within 30 minutes in 20.9 % of trials, against 20.0 % for a hand split and 6.8 % for one drone (3×); with a clue the edge over the hand split is 3 points** [2].
- **Nemotron VL's second look finds 4 more of 337 people on test at the cost of 15 more false alarms (95 % CI of the gain [+0.003, +0.023], p < 0.05), and is advisory** [3].
- **The planner adds nothing on a flat prior; with a clue it finds the person within 30 minutes in 10.7 % of trials against 6.3 % for a fixed order** [4].

## Inspiration

A drone brings back hundreds of photos per flight; a missing person is about 70 px wide in each, and people reviewing by eye found 68 % of them in the published study [1]. The search manager meanwhile decides where drones and teams go next, from radio calls and a paper map.

Everyone detects; nobody closes the loop. DJI FlightHub 2, Skydio and Eagle Eyes stop at a flagged pixel; CalTopo tracks clues but has no probability map. Sightline joins the two: every photo, negative sweep and radio report updates one map, and the map directs both drones and people.

## What it does

- Detects each drone photo as it lands and places it on the map from its own GPS and camera pose.
- Updates a probability map with every photo, review, searched sector and clue. Searched ground shows how well it was searched; the software never rules an area out.
- Proposes the next drone leg, re-task, team assignment or alert, with its reason. **A person approves every move.**
- Talks to ground teams on a secondary radio channel, and logs a clue only after a readback.

## How we built it

Every language and vision model call goes through **Nebius Token Factory** at run time, through one OpenAI-compatible client (`sightline/agent/llm.py:23-25`). Every model is an NVIDIA open model:

| Job | NVIDIA model | Runs on | Code |
|---|---|---|---|
| Second look at uncertain detections (crop + OpenCV re-look images → JSON verdict) | `nvidia/Nemotron-3.5-Super-VL` | Token Factory | `sightline/agent/verify.py` |
| Briefings for teams; reading conditions pages with quotes | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | Token Factory | `agent/loop.py:151`, `geo/conditions.py:316` |
| Radio turns with tool calls | `nvidia/nemotron-3-super-120b-a12b` | Token Factory | `radio/turn.py:232` |
| Speech to text | Parakeet TDT 0.6B v2 | RTX 4080 SUPER (NeMo) | `radio/asr.py` |
| Text to speech | Magpie TTS multilingual 357M | RTX 4080 SUPER (NeMo) | `radio/tts.py` |

- **Measured on Token Factory:** the VL verdict takes 1.35 s p50, costs about 0.00033 per detection, and 461 of 461 replies were valid JSON [5]. A radio turn's first sound comes in 2.5 s p50 with real voices [6].
- **Nebius Serverless Job:** the simulated fleet's 711 photos detected on CPU with OpenCV 5 `cv2.dnn` in 483 s on 16 vCPUs, about $0.10 [7].
- **Tavily** brings the forecast, warnings and park alerts; they decide whether drones may fly.
- **AWS** runs the live API and the photo worker.

**What is simulated.** The drones, their flight and battery, and their photos (crops of HERIDAL validation photos at simulated poses) are simulated, as are the ground teams' positions and the search-map evaluations. In the recorded traces the human steps are scripted, and the trace says so. Real: detection, the map math, every Nemotron call on Token Factory, Tavily, the radio's speech models, the AWS deployment and the Serverless Job [8].

**Physical AI fit.** Sightline is the decision layer of an embodied team: drones sense, the agent decides, drones and people act, and each action changes what is sensed next. A clue from a team re-tasks the nearest drone; that drone's photo shows the person [9]. The FAQ allows simulation, and our fleet flies through the same photo API a real drone would use. The edge is roadmap only: Ultralytics measures YOLO26n with TensorRT FP16 at 4.57 ms per image on a Jetson Orin Nano Super [10], so a field kit without internet is plausible, but we have not run Sightline on a Jetson.

## Challenges

- **Small people:** below 60 px Nemotron VL mostly answers "unclear". We kept that abstention rather than prompt it away [3].
- **Keeping a voice model honest:** with thinking off, Nemotron 3 Super sometimes put its reasoning in the reply, and our radio spoke it; it once invented weather without calling the tool. Both are now enforced in code [11].
- **Never letting software rule an area out.** Tests check every proposal, briefing and screen string.

## Accomplishments

- Five NVIDIA models in one loop, each doing one job, each call traced.
- 6 of 6 radio clue reports read back and confirmed before they were logged [6].
- A clue-to-re-task chain on a live mission with the real planner [9].

## What we learned

Tool calling with thinking off needs code-side guards for anything safety-relevant. Thinking tokens count against `max_tokens`, silently. Details, per tool: `docs/feedback/nebius.md`, `docs/feedback/radio.md`.

## What's next

A Jetson field kit without internet; thermal for night searches; real drone photos through DJI FlightHub 2; a field trial with a search-and-rescue team.

**What changed during the submission period:** `docs/submission/NEBIUS_WHAT_CHANGED.md`.

---

### Sources for every number

1. `docs/report/OPENCV_REPORT.md:19-20`, `:331-333`; `README.md:42`, `:66`
2. `docs/report/OPENCV_REPORT.md:417-429`
3. `docs/report/OPENCV_REPORT.md:350-355`; `docs/LANE_A_ML.md:314`
4. `docs/report/OPENCV_REPORT.md:395-403`
5. `docs/feedback/nebius.md:26-29`
6. `docs/feedback/radio.md:84`, `:101`
7. `docs/feedback/nebius.md:116-119`; `README.md:80`
8. `docs/report/OPENCV_REPORT.md:466-467`, `:512-514`
9. `README.md:33`; `docs/architecture/agent.md` ("A second chain"); `scripts/creek_run.py`, `scripts/retask_chain.py`
10. Ultralytics, "NVIDIA Jetson" guide, Orin Nano Super benchmark table, YOLO26n, TensorRT FP16 (https://docs.ultralytics.com/guides/nvidia-jetson/, read 2026-10-22)
11. `docs/feedback/radio.md:76-79`, `:115-120`
