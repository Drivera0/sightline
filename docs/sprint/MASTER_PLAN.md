# Master plan for Sprint 2 (Oct 20–30, 2026)

> The reasons behind the sprint plan, written on Oct 20 for two events: the OpenCV AI Competition 2026
> (submission Oct 26) and the Nebius × NVIDIA Global AI Hackathon (submission Oct 30). Superseded by
> [`docs/00_OVERVIEW.md`](../00_OVERVIEW.md) for what Sightline is, and by
> [`docs/report/OPENCV_REPORT.md`](../report/OPENCV_REPORT.md) for what was measured. The lane files in
> this folder carry the task-level outcomes. The plan's lanes E–H were folded into lanes A–E on Oct 20.

## 1. Positioning

**Sightline is the brain of a drone search: one brain, many eyes, every channel.** Drones and ground
teams feed one probability map, and the map directs both, on screen at the command post and by voice
over the radio.

| User | Question | Screen |
|---|---|---|
| Search manager | Where do I send drones and teams next, and why? | Command view: task board, map, briefings, approvals |
| Image reviewer | Show me the likeliest person first. | Review queue |
| Ground team leader | Where do I go, what am I looking for, what changed? | Assignment card (print, GPX) and radio desk |

### Design principles

1. **Assists, never decides.** A searched sector says how well it was searched ("searched at POD 0.6");
   every consequential action needs a logged human approval.
2. **Works at the command post.** Batch mode needs no connectivity; near-live mode is a bonus. Stills,
   not video: a person is about 70 px in a 4000×3000 still and about 15 px in compressed video.
3. **Humans and drones are both sensors.** Clues update the same map as drone detections.
4. **Every decision is logged.** Trace, reviewer answers and approvals make the mission debrief real SAR
   teams have to produce.
5. **Known limits stated openly** (`docs/DETECTOR_LIMITS.md`); simulated elements labelled.

**Lead metric:** time to the first confirmed sighting. On the demo survey all 6 photos with people are in
the first 7 of the review queue, against about 4.5 h for a person at 33 s per photo over 500 photos.

## 2. State on Oct 20

Strong: the tiled YOLO11s detector with ablations and error analysis; the Bayesian search map with a
simulated evaluation and a TypeScript mirror; EXIF pose to footprints; an 8-stage pipeline behind one
validated cache contract; a 5-step guided demo on Vercel.

Gaps, which became the work:

1. It was not obvious who it was for, uploads were never shown, and live versus batch was never
   explained.
2. OpenCV 5 was pinned but used in 5 lines; detection ran on Ultralytics, SAHI and Torch.
3. No cloud deployment, no LLM or agent, no LICENSE file.
4. Only drones fed the map: no ground teams, clues, conditions or second drone.

## 3. Target architecture

```text
                     ┌───────────────────────── Sightline core (existed) ────────────────────────┐
 photos (batch or    │  per-photo ingest → detect (cv2.dnn | torch) → georef → rank → review      │
 near-live) ────────►│  queue → Bayesian map  ◄── clue log (new) ◄── ground reports               │
                     └───────────────┬────────────────────────────────────────────────────────────┘
                                     │ uncertain detections, map state, sectors, clues, conditions
                                     ▼
                     ┌── Coordinator agent (new, Nemotron on Nebius Token Factory) ──┐
                     │  OpenCV 5 re-look tools (CLAHE / native zoom / re-detect)     │
                     │  Nemotron VL verdict on crops                                  │
                     │  Info-gain flight planner (per drone; fleet re-tasking)        │
                     │  fetch_conditions (Tavily: weather, daylight, alerts)          │
                     │  briefing writer + debrief generator                           │
                     └──────────────┬────────────────────────────────┬───────────────┘
                                    ▼ (all actions human-approved)   ▼
                     Command view: task board, approvals,   Radio desk: Parakeet ASR →
                     assignment cards (GPX/KML), fleet map  Nemotron → Magpie TTS
 AWS: S3 uploads → SQS → worker (cv2.dnn detect) → results → CloudWatch
```

Conventions: new mission files go through the contract-change process; every LLM call goes through
Token Factory with the key server-side only; every agent and tool call is traced; thresholds are tuned on
val only and test is scored once.

## 4. Workstreams and outcome

| # | Workstream | Plan in one line | Outcome |
|---|---|---|---|
| W1 | Clarity and ingestion | Front door, New search flow, per-photo API, live replay and `watch` | Done: `web/src/front/` (#77), `web/src/ingest/` (#57), API (#55), clients (#82) |
| W2 | OpenCV 5 detection | ONNX in `cv2.dnn`, backend switch, both numbers side by side | Done: identical scores, 363/363 boxes (#7, #13); demo cache re-detected identically on `cv2.dnn` |
| W3 | AWS | S3 → SQS → worker → CloudWatch, IAM, Secrets Manager, teardown | Done: CPU EC2 (`cv2.dnn` fast enough, so no GPU instance), `deploy/aws/` (#58, #117) |
| W4 | Agent: verifier and planner | Re-look tools → Nemotron VL verdict; info-gain legs with reasons; briefings | Done: `sightline/agent/` (#15, #17), `sightline/search/planner.py` (#67); approvals moved from the map panel to the command view |
| W5 | Fleet | 2–3 simulated drones on one map, re-tasked mid-mission; batch detection as a Nebius Serverless Job | Done: `sightline/search/fleet.py` (#84, #139), creek scenario, Serverless Job (#92) |
| W6 | Conditions (Tavily) | Runtime Tavily calls feeding flyability, urgency and the prior, honest coverage, briefings | Done: `sightline/geo/conditions.py` (#75); all four hooks wired |
| W7 | Command view and clue log | Task board, assignment cards with GPX/KML, typed clues that move the map | Done: `web/src/command/` (#71, #78, #93) |
| W8 | Radio desk | Parakeet → Nemotron with tools → Magpie; readback before a clue commits | Done: `sightline/radio/`, `web/src/radio/` (#31, #34, #37, #119) |
| W9 | Debrief generator | After-action report from the trace and mission state | Done: `sightline/search/debrief.py` (#80), `GET /missions/{id}/debrief.md` |

Centralised brain, distributed eyes: real searches have one accountable incident commander, and the
approval principle needs one decision point. Drone-to-drone swarming stayed on the roadmap.

## 5. Evaluation discipline

Carried over from BCS: tuning on val only, test scored once, any choice that saw test disclosed.

| Planned number | Outcome |
|---|---|
| `cv2.dnn` vs Torch parity | Done: identical VOC and SAR scores; 1.9 s per photo on CPU |
| Verifier uplift, val and one test score | Done: recall 0.864 → 0.875 on test, for 15 more false alarms |
| Planner vs static map (simulated) | Done: with a clue, 10.7 % vs 6.3 % found within 30 min; no gain on a flat prior |
| Fleet coordinated vs independent (simulated) | Done: ahead with a clue at the start, level without (`docs/report/FLEET_V2.md`) |
| Per-photo latency on AWS | Done: 7.1 s upload to processed (c7i.2xlarge) |
| ASR word error on 20 radio phrases | Deferred: script ready (`scripts/radio_wer.py`), three-voice recordings pending (issue #49) |

## 6. Timeline

The plan spread the work over Oct 20–30 with Gate 1 on Oct 22, the OpenCV freeze at noon Oct 25,
the OpenCV submission on Oct 26, Gate 2 on Oct 29 and the Nebius submission on Oct 30. In practice
nearly every workstream merged between Oct 20 and Oct 22; the freeze, both submissions and their tags
(`opencv-submit`, `nebius-submit`) were still ahead when this record was written.

## 7. Deliverables

| Deliverable | Outcome |
|---|---|
| Technical report with architecture, OpenCV 5 implementation, AWS, evaluation, limits, responsible use, BCS origin | Done: `docs/report/OPENCV_REPORT.md`, `docs/report/EVIDENCE_INDEX.md` |
| Agent workflow diagram and a trace where an OpenCV result changes a later proposal | Done: `docs/architecture/agent.md` |
| Build, deploy and test instructions with pinned dependencies | Done: `README.md`, `uv.lock`, `deploy/dressrun/` |
| Live web endpoint | Done: the API on AWS behind the Vercel site |
| README section on NVIDIA models, Token Factory and Serverless | Done #22 |
| "What changed since BCS" statement | Done: `docs/submission/NEBIUS_WHAT_CHANGED.md` |
| Platform feedback with measured data | Done: `docs/feedback/nebius.md`, `docs/feedback/radio.md` |
| Tavily write-up | Done: `docs/report/TAVILY.md` |
| Demo videos | Cuts rendered (#137, #151); uploads Deferred |

## 8. Risks and what happened

| Risk | Mitigation planned | What happened |
|---|---|---|
| The ONNX does not run in `cv2.dnn` | Test on day 1; OpenCV keeps preprocessing, NMS and re-look tools | Ran on day 1 with identical results; fallback unused |
| Nemotron VL weak on 60 px crops | Zoom and CLAHE first; demote to an advisory flag if still weak | Small but real recall gain on test; verdicts stay advisory |
| Voice latency or quality poor | Scripted phrases, readback, text fallback | First sound p50 2.5 s with real voices |
| AWS cost or time | One instance, teardown script, CPU if fast enough | One CPU instance, stopped when not in use |
| Scope | Gates and an ordered cut list | Nothing on the cut list was cut |

The cut list, lowest first: physical radio and Serverless Endpoint for Parakeet · GPX/KML · debrief ·
fleet · radio desk · conditions · command view · AWS · agent (never) · `cv2.dnn` path (never) ·
clarity (never). Only the first item was dropped.

## 9. Decisions

- **License:** AGPL-3.0 (#6), since the detector is trained with Ultralytics (AGPL-3.0).
- **One repository, no fork:** per-event snapshots are tags; event-specific parts live side by side
  (`deploy/aws/`, `deploy/nebius/`).
- **Models** (ids confirmed in the Token Factory console on Oct 20): Nemotron 3 Super
  `nvidia/nemotron-3-super-120b-a12b` (reasoning and tools), Nemotron 3 Nano (briefings, conditions
  extraction), Nemotron VL (verdicts), Parakeet TDT 0.6B v2 (speech to text), Magpie TTS (speech).

## 10. Sources

- Human baseline: Pyrrö, Naseri & Jung (2021), [arXiv:2111.09406](https://arxiv.org/abs/2111.09406)
- [Nemotron Nano 2 VL on Nebius](https://nebius.com/blog/posts/nvidia-nemotron-nano-2-vl-in-ai-studio) ·
  [Nemotron 3 Super on Token Factory](https://nebius.com/blog/posts/nemotron3-super-now-available)
- [Parakeet TDT 0.6B v2](https://venturebeat.com/technology/nvidia-launches-fully-open-source-transcription-ai-model-parakeet-tdt-0-6b-v2-on-hugging-face) ·
  [Magpie TTS](https://huggingface.co/blog/nvidia/magpie-tts-multilingual-voice-agents)
- [Tavily API credits](https://docs.tavily.com/documentation/api-credits.md)
- Production ingestion path: [DJI FlightHub 2 auto-upload and OpenAPI](https://advexure.com/products/dji-flighthub-2)
