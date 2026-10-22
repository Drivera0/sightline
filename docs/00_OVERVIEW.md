# 00 · Sightline: read this first

> What Sightline is today, who it is for, how it works, what is real and what is simulated, and where
> to read next. Then read `01_CONTRACT.md` and the lane file for the part you are touching.

---

## 1. What Sightline is

**Sightline is the brain of a drone search: one brain, many eyes, every channel.** When a hiker goes
missing, search-and-rescue teams fly drones over the search area and come back with hundreds of
12-megapixel photos in which a person is about 70 px wide. Sightline finds the likeliest people in
those photos, turns every photo, every negative sweep and every field report into one updated
probability map, and proposes where drones and ground teams should go next. A person approves every
move. It reaches the people in the search on the screen they use: the command view at the command
post, and the radio for teams in the field.

It assists searchers. **It never rules an area out:** a searched sector says how well it was searched
("searched at POD 60 %"), and its probability of detection is capped below 1.

## 2. The three users

| User | Their question | Where Sightline answers it |
|---|---|---|
| Search manager | Where do I send drones and teams next, and why? | Command view: live map, proposals with reasons and numbers, approval inbox, task board, clue log |
| Image reviewer | Show me the likeliest person first. | Review queue, ranked by the detector, with a second look on uncertain crops |
| Ground team leader | Where do I go, what am I looking for, what changed? | Printable assignment card with GPX/KML, and the radio desk |

## 3. How photos get in

- **After each landing:** drag the SD card's photos into the browser, or point
  `python -m sightline.client watch FOLDER` at the folder the card is copied to.
- **During the flight:** a drone (or the simulated fleet) posts each photo to the mission API as it is
  taken (`POST /missions/{id}/photos`); `python -m sightline.client replay` replays a folder at drone pace.

Either way each photo is processed on its own as it arrives, and the command view updates over
server-sent events.

## 4. The pipeline, per photo

1. **Pose:** position, altitude, yaw and pitch from the photo's EXIF and DJI XMP (`sightline/geo/pose.py`);
   oblique photos and photos without a full pose are refused with the reason.
2. **Detect:** YOLO11s fine-tuned on HERIDAL, run on overlapping 1024 px tiles with **OpenCV 5 `cv2.dnn`**
   from its ONNX export (`sightline/ml/detect_cv.py`), threshold 0.29 chosen on validation.
3. **Place:** each detection projected to the ground through the photo's footprint, with a 10 m radius.
4. **Map step:** the photo's footprint, the canopy under it (measured from its own pixels) and the
   detector's recall set its POD per cell; the Bayesian map is updated (`sightline/search/live.py`).
5. **Agent:** near-miss detections get a second look (OpenCV 5 re-look tools, then Nemotron VL on Nebius
   Token Factory); verdicts, clues, conditions and the planner's legs become **proposals**
   (`sightline/agent/loop.py`).
6. **Human approval:** the search manager approves, edits or rejects each proposal; only then does a
   drone fly a leg, a team get an assignment, or the radio transmit a briefing.
7. **Trace and debrief:** every tool call, model call, verdict, proposal and decision is a line in the
   mission's `trace.jsonl`; `GET /missions/{id}/debrief.md` writes the debrief from it.

Conditions come from live web search (Tavily, `sightline/geo/conditions.py`), checked every 30 minutes per
active mission and cached per area and clock hour; they decide whether drones may fly, how much a photo
can see, and what briefings say. The radio desk (`sightline/radio/`) answers teams by voice from the same
mission state and logs a clue only after a readback the team confirms.

Architecture figures: `docs/architecture/sightline-architecture.html` (system, ML pipeline, a live mission
on AWS, the agent workflow).

## 5. Lanes

| Lane | Owns | Code | Lane file |
|---|---|---|---|
| **A · Detect & Agent** | data, training, evaluation, the `cv2.dnn` detector, the second look, the agent loop, the Nebius Serverless Job, the reports | `sightline/ml/`, `sightline/agent/`, `scripts/`, `deploy/nebius/` | `LANE_A_ML.md` |
| **B · Geo** | camera poses, footprints, pins, base map, clues, conditions (Tavily) | `sightline/geo/`, `web/src/map/` | `LANE_B_GEO.md` |
| **C · Search** | probability map, live map, sectors, planner, simulated fleet and evaluations | `sightline/search/`, `web/src/map/heat/` | `LANE_C_SEARCH.md` |
| **D · Pipeline** | contract, pipeline, mission store and API, website shell, review queue, AWS | `sightline/pipeline/`, `sightline/mission/`, `sightline/api/`, `web/src/shell/`, `deploy/aws/` | `LANE_D_PIPELINE.md` |
| **E · Ops & Voice** | front door, command view, radio desk | `web/src/front/`, `web/src/command/`, `web/src/radio/`, `sightline/radio/` | `web/src/command/README.md`, `sightline/radio/README.md` |

The lanes meet at one contract (`01_CONTRACT.md`, v1.2): only the pipeline and the `MissionStore` write
files, every write is validated against the contract, and the website only reads. How the pipeline calls
the lanes: `LANE_INTERFACES.md`. Shared website rules: `05_FRONTEND_SHARED.md`.

## 6. Real and simulated

| Real | Simulated (and labelled so on screen and in the trace) |
|---|---|
| The detector on OpenCV 5 `cv2.dnn`, and its HERIDAL test numbers | The demo survey's flight path over Mount Seymour (real HERIDAL photos, simulated positions) |
| The map math (pose, footprints, POD, Bayesian update, planner) | The search-map and planner evaluations (`sightline/search/sim.py`, `planner_sim.py`) |
| The agent: Nemotron models on Nebius Token Factory, every call traced | The drone fleet: flight, battery, and its photos (HERIDAL validation crops with written EXIF) |
| Conditions from Tavily, with quotes and source URLs | Ground-team positions in the demo and fixture missions |
| The radio desk (Parakeet, Nemotron, Magpie) | The human steps in the recorded agent chains (review, approvals), scripted and labelled |
| The AWS deployment (EC2, S3, SQS, CloudWatch, Secrets Manager) and the Nebius Serverless Job | |

The search prior is Koester's distance-from-IPP rings when the subject category is set, else uniform
within the search area; the clue and shelter factors of the live map are labelled planning heuristics.
No real search data has been used; all imagery is HERIDAL (CC BY 3.0).

## 7. Where to read next

- `docs/report/OPENCV_REPORT.md`: the technical report, with every measured number and its source.
- `docs/report/EVIDENCE_INDEX.md`: every claim a judge might check, where it is backed, and how to regenerate it.
- `docs/report/TAVILY.md`: conditions from the web, with a live run's trace.
- `docs/architecture/agent.md`: the agent, with real traces of one decision.
- `docs/DETECTOR_LIMITS.md`: where the detector fails, with figures.
- `docs/feedback/nebius.md`, `docs/feedback/radio.md`: what worked and what didn't with Token Factory,
  Serverless Jobs, Parakeet and Magpie.
- `deploy/aws/README.md`: the AWS deployment and the remote check.
- Lane files: `LANE_A_ML.md`, `LANE_B_GEO.md`, `LANE_C_SEARCH.md`, `LANE_D_PIPELINE.md`.
- `docs/sprint/README.md`: how the Oct 20–30 sprint was planned, and what each planned task became.

## 8. History

Sightline began at **BCS Hackathon 2026** (Oct 16–17, 36 hours, a team of four, tag
`bcs-final-submission`) as a batch tool: the tiled detector, the review queue and the Bayesian search map,
run once over a 500-frame demo survey and played back in the browser with no server. For the OpenCV AI
Competition 2026 and the Nebius × NVIDIA hackathon it became a live system: the detector moved to OpenCV 5
`cv2.dnn`, photos are processed as they arrive, an agent proposes and people approve, conditions come from
the web, a radio desk reaches the teams, a simulated fleet flies approved legs, and the API runs on AWS. The
BCS-era plan for this file (timeline, checkpoints, the 60-second pitch) is in git history.

## 9. Glossary

| Term | Meaning |
|---|---|
| **IPP / LKP** | Initial planning point / last known point: where the missing person was last seen. |
| **Prior** | The probability map before any photo. |
| **POD** | Probability of detection: if the person were in this cell, the chance this search would have found them. |
| **POS** | Probability of success: POC (containment, the map's probability in the cell) × POD. |
| **Canopy** | Fraction of a cell under trees or deep shadow; high canopy means low POD. |
| **Sector** | A piece of the search area a drone leg or a ground team is assigned. |
| **Proposal** | An action the agent suggests (promote a detection, fly a leg, re-task a drone, assign a sector, alert); nothing happens until a person approves it. |
| **Trace** | The mission's `trace.jsonl`: every tool call, model call, verdict, proposal and decision. |
| **Tiling / SAHI** | Cutting big photos into overlapping tiles so small people aren't shrunk away. |

## 10. Sources

- Pyrrö, Naseri & Jung (2021), *Rethinking Drone-Based Search and Rescue with Aerial Person Detection*: https://arxiv.org/abs/2111.09406
- HERIDAL in VOC format (CC BY 3.0), Zenodo: https://zenodo.org/records/5662351
- Search theory, lost-person behaviour and related systems: `docs/report/OPENCV_REPORT.md` §6.1 and §1.1.
