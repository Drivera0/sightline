# 00 · Build plan summary (Oct 20–30, 2026)

> Superseded by [`docs/00_OVERVIEW.md`](../00_OVERVIEW.md), which describes the system as built. This
> file keeps what the overview lacks: the task index with each task's outcome, the gates and the working
> rules of the plan.

## 1. Goal

**Sightline is the brain of a drone search: one brain, many eyes, every channel.** Drones and ground
teams feed one probability map, and the map directs both, on screen at the command post and by voice
over the radio. It never rules an area out.

Feedback on the BCS Hackathon version was that it was not obvious who it was for, that photos were
never shown being uploaded, and that it never said whether photos arrive live or after landing. The
plan was to fix that and close the loop: photo → detection → second look → map → proposal → human
approval → drone or team acts → new evidence → map.

**Users:** search manager (command view), image reviewer (review queue), ground team leader
(assignment card and radio).

**Principles, enforced by tests:** assists, never decides (every action human-approved and logged; a
searched area is lowered, never ruled out) · works offline in batch mode · drones and people are both sensors ·
every decision logged · limits stated, simulation labelled.

## 2. Workstreams and folders

| Workstream | Work | Folders |
|---|---|---|
| A · Detect & Agent | `cv2.dnn` path, verifier, agent loop, Token Factory client, Nebius Serverless Job, reports | `sightline/ml/`, `sightline/agent/`, ML/agent/eval `scripts/`, `tests/ml/`, `tests/agent/`, `deploy/nebius/`, `web/src/metrics/`, `web/src/detect/`, `docs/architecture/`, `docs/feedback/` (not `radio.md`) |
| B · Geo & Conditions | conditions (Tavily), clue positions, map layers, assignment cards, GPX/KML, replay and watch clients | `sightline/geo/`, `sightline/client/`, `web/src/map/MapView.tsx`, `web/src/map/base/`, `tests/geo/`, `tests/client/` |
| C · Search & Fleet | live map, sectors in Python, info-gain planner, fleet, debrief | `sightline/search/`, `web/src/search/`, `web/src/map/heat/`, `tests/search/` |
| D · Platform | contract v1.2, mission store, API and SSE, per-photo pipeline, ingest UI, `useMission`, routing, AWS, integration | `sightline/contract.py`, `sightline/mission/`, `sightline/pipeline/`, `sightline/api/`, `web/src/shell/`, `web/src/lib/`, `web/src/review/`, `web/src/ingest/`, `deploy/aws/`, repo config, shared docs |
| E · Ops & Voice | front door (now the home page), command view (now the console), radio desk | `web/src/front/`, `web/src/command/`, `web/src/radio/`, `sightline/radio/`, `tests/radio/`, `scripts/radio_*.py`, `docs/feedback/radio.md` |

## 3. How the workstreams connect

```text
 photos (upload / watch / replay)                     B client ──┐
        │                                                         ▼
        ▼                                         D: POST /missions/{id}/photos
 D pipeline (per photo): B read_pose → A detect (cv2.dnn) → B georef → C LiveMap.frame_update
        │                         │                                      │
        │                 A hooks.on_detection ──► A verifier (OpenCV re-look + Nemotron VL)
        ▼                         ▼                                      ▼
 D MissionStore (only writer) ◄── proposals ◄── A agent loop ◄── C planner (legs, assignments)
        │                                         ▲      ▲
        │ SSE /events                             │      └── B fetch_conditions (Tavily)
        ▼                                         │
 D useMission ──► E command view (approve) ──► D API ──► MissionStore ──► E radio (transmit)
 ground reports: E clue form / E radio (readback) ──► D /clues ──► C clue_update + A on_clue
```

## 4. Task index and outcome

IDs were used in branch names and pull requests. Bold IDs were ones another workstream depended on;
they shipped stub-first with their final signature.

| ID | Workstream | Task | Outcome |
|---|---|---|---|
| **D-C1** | D | Contract v1.2: models, generated TS, extras | Done #52 |
| **D-M0** | D | `MissionStore` + `validate_mission` | Done #53 |
| **D-A1** | D | Mission API + SSE | Done #55 (`sightline/api/`) |
| D-P1 | D | Per-photo pipeline | Done #55 (`sightline/mission/pipeline.py`) |
| **D-M1** | D | `useMission` (live + demo) | Done #57 (`web/src/lib/mission.ts`) |
| D-M2 | D | Team, drone and clue selection | Done #99 |
| D-I1 | D | New search / ingest screen | Done #57 (`web/src/ingest/`) |
| D-L1 | D | Live mode of the shell (`#m/<id>/<step>`) | Done #57 |
| D-Q1 | D | Review queue in live mode, verdict badges | Done #57 (`web/src/review/LiveReview.tsx`) |
| D-R1, D-R2 | D | Mount front door and command view | Done #77, #78 |
| D-R3, D-R4 | D | Mount radio panel and `radio_router` | Done #119 |
| D-R5 | D | `GET /missions/{id}/debrief.md`, `PUT /fleet` | Done (`sightline/api/missions.py`) |
| D-K1 | D | Card, GPX and KML endpoints | Done (`GET /missions/{id}/cards/{sector}`) |
| D-W1 | D | AWS: S3 → SQS → worker, EC2, CloudWatch, IAM, Secrets Manager | Done #58, #61, #85, #117 (`deploy/aws/`) |
| D-S1 | D | `scripts/smoke.sh` | Done #56 |
| D-G1 | D | Repository configuration, cross-workstream files, labels | Done #116 (labels script, issue template, inbox script) |
| **A-X1** | A | `cv2.dnn` smoke test on the ONNX | Done: 19/19 boxes on 12 val photos, max confidence difference 0.0012 |
| A-X2 | A | `detect_cv.py` tiled path + backend switch | Done #7, #10, #14, #20 |
| A-X3 | A | Parity table Torch vs `cv2.dnn` | Done #13: 363/363 boxes at IoU ≥ 0.95 |
| **A-L1** | A | Token Factory `ChatClient` | Done #7, #12 |
| **A-T1** | A | Trace helpers | Done #7 |
| A-V1 | A | OpenCV re-look tools | Done #11 |
| A-V2 | A | Nemotron VL verifier, val tuning, one test score | Done #15, #16 |
| **A-H1** | A | `hooks.py` stubs | Done #7 |
| A-G1 | A | Agent loop | Done #17, #66 |
| A-G2 | A | Workflow diagram + trace excerpt | Done #18, #68 |
| A-N1 | A | Nebius Serverless Job | Done #92, #97 |
| A-N2 | A | Nebius README section + feedback report | Done #19, #22 |
| **B-W1** | B | `fetch_conditions` (Tavily), cache, offline | Done #75 |
| B-W2 | B | Flyability, daylight, exposure band | Done #75 |
| B-C1 | B | Clue positions + clue pins | Done #79, #103 |
| **B-M3** | B | `useMap().onPick` | Done #90 |
| B-T1 | B | Team and drone markers, leg lines | Done #90, #103 |
| **B-K1** | B | `assignment_card` + GPX/KML | Done #76; CalTopo import #122 |
| B-R1 | B | `replay` client | Done #82 |
| B-R2 | B | `watch` client | Done #82 |
| **C-S1** | C | `sectors.py` + shared vectors | Done #65, #100 |
| **C-L1** | C | `LiveMap` + TS `applyReweight` | Done #65 |
| **C-G1** | C | Ground search evidence | Done #65 |
| C-E1 | C | Clue evidence | Done #65 |
| C-E2 | C | Conditions hooks (visibility POD, shelter) | Done #65 |
| **C-P1** | C | Info-gain planner | Done #67 |
| C-P2 | C | Planner evaluation | Done #73 |
| C-H1 | C | Live heat layer | Done #83 |
| C-F1 | C | Fleet sim | Done #84 |
| C-F2 | C | Creek demo scenario | Done #84, #88 |
| C-F3 | C | Fleet evaluation | Done #89, #139 |
| C-D1 | C | Debrief generator | Done #80 |
| E-xx | E | See [`LANE_E_OPS_VOICE.md`](LANE_E_OPS_VOICE.md) | — |

## 5. Gates

- **Gate 1 (Thu Oct 22, 8 pm):** `cv2.dnn` parity, sane planner legs on the demo map, one photo
  round-tripping through `POST /photos` to a `map.updated` event. **Passed**: parity held without the
  fallback, and the planner (#67) and the per-photo pipeline (#55) were merged on Oct 21.
- **OpenCV freeze (Sun Oct 25, noon):** fixes only after it; a dress run on a clean machine. The dress
  run was automated ahead of time (`deploy/dressrun/`, #138). The freeze itself is **Deferred**.
- **Gate 2 (Thu Oct 29, 10 am):** pick the order of the Nebius video. **Deferred**.

## 6. Working rules

1. **Contract first.** No file shape or endpoint outside contract §12–§14; stubs until the real thing.
2. **Each workstream keeps to its folders.** A change another workstream needs is filed as an issue
   (`CROSS_LANE.md`), and work continues against a stub.
3. **Stubs ship first** for anything another workstream depends on, with the final signature.
4. **Merge to `main` at least daily**, small pull requests, `scripts/smoke.sh` green.
5. **Dependencies** in their own pull request; known extras were added with the contract
   (`agent`, `conditions`, `aws`, `radio`, `sim`).
6. **Secrets** (`NEBIUS_API_KEY`, `TAVILY_API_KEY`, `NVIDIA_API_KEY`, AWS) only in environment variables
   or AWS Secrets Manager; never in `web/`, git or the trace.
7. **Honesty:** simulated things carry `simulated: true` and a badge; heuristics are labelled; tuning
   on val only, test scored once, any test-seen choice disclosed.
8. **A searched area is lowered, never ruled out**, and never described as empty. Tests in every workstream check the wording
   (`tests/pipeline/test_no_clear_scan.py`, `web/src/noClear.test.ts`).
9. **Anything slipping more than half a day** is cut using the workstream's cut order, not crunched.

## 7. Before the start

- License changed to AGPL-3.0 (#6), because the detector is trained with Ultralytics (AGPL-3.0).
- BCS version tagged `bcs-final-submission` (planned as `bcs-final`).
