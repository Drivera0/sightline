# Workstream D · Pipeline & Platform: contract, live missions, API, ingest, AWS, integration

> Superseded by [`docs/LANE_D_PIPELINE.md`](../LANE_D_PIPELINE.md),
> [`sightline/mission/README.md`](../../sightline/mission/README.md) and
> [`deploy/aws/README.md`](../../deploy/aws/README.md). This file keeps the plan, the table of
> what each human decision does, and each task's outcome.

**Folders:** `sightline/contract.py`, `sightline/mission/`, `sightline/pipeline/`, `sightline/api/`,
`tests/pipeline/`, `tests/api/`, `tests/fixtures/`, repo config, `web/src/shell/`, `web/src/lib/`,
`web/src/review/`, `web/src/ingest/`, `web/src/App.tsx`, `web/src/contract.ts` (generated),
`deploy/aws/`, `scripts/smoke.sh`, shared docs.

## 1. Mission

Turn the five workstreams into one product that visibly takes photos in and directs a search: the contract
and the mission store (the only writer of mission files), the mission API with server-sent events and
every side effect of a human decision, the per-photo pipeline, the web platform (`useMission`, live
mode, the review queue in live mode, the New search screen, mounting the other workstreams' screens), AWS, and
integration.

## 2. The per-photo pipeline as planned

1. `read_pose` (B) and the footprint from the original's size; photos without GPS are refused with the
   reason.
2. A 1000×750 display frame; the original kept at `frames/orig/<id>.jpg` for the re-look tools.
3. Detection on the **original** with `make_detector()` and `detect_tiled` (one pass on a full photo
   would shrink it and lose most people). Crops for conf ≥ 0.29; near-miss crops (0.15–0.29) saved for
   the verifier.
4. `georef_detection` (B), then the frame ranked among all frames so far.
5. `LiveMap.frame_update` (C) with the conditions' visibility factor → `map.updated`.
6. `detection.new` events, then `hooks.on_detection` (A) for candidates and near-misses.

## 3. What each human decision does

Nothing below happens without the decision or field report that triggers it.

| Trigger | Effect |
|---|---|
| `drone_leg` / `retask_drone` approved | the leg joins the fleet as approved; a re-task cancels the current leg |
| `assign_sector` approved | task → assigned with the team; team → assigned |
| `promote_detection` approved | the detection joins the live review queue |
| `alert` approved | status only; the radio's outbound queue reads approved briefings |
| any proposal rejected | status, reason and who |
| edits on approval | applied first; only the edited, approved text is ever transmitted |
| task → searched with POD | ground step on the map |
| clue posted | radio drafts without a confirming turn refused; position resolved; clue step; agent hook |
| review posted | review update on the map; agent hook |
| conditions refreshed | stored; shelter shift if the band changed; agent hook |
| fleet telemetry | only approved → flying → done; agent hook for each finished leg |

## 4. Work items

| ID | Task | Outcome |
|---|---|---|
| D-G1 | Repo hygiene, cross-workstream files, labels | Done #116 |
| D-C1 | Contract v1.2 merged, models, generated TS, extras | Done #52 |
| D-M0 | `MissionStore`, `validate_mission` | Done #53 (`sightline/mission/store.py`, `validate.py`) |
| D-A1 | Mission API + SSE with resume | Done #55 (`sightline/api/`, `sse.py`) |
| D-P1 | Per-photo pipeline | Done #55 (`sightline/mission/pipeline.py`) |
| — | Decision side effects (§3) | Done #55 (`sightline/mission/effects.py`); task moves enforced on the server #102 |
| D-M1 | `useMission` live and demo | Done #57 |
| D-M2 | Team, drone and clue selection | Done #99 |
| D-L1 | Live shell `#m/<id>/<step>` | Done #57 |
| D-Q1 | Review in live mode, verdict badges | Done #57 |
| D-I1 | New search screen: details, LKP on the map, upload, `watch` command | Done #57 (`web/src/ingest/`) |
| D-R1, D-R2 | Front door at `#`, command view | Done #77, #78 |
| D-R3, D-R4 | Radio panel and `radio_router` | Done #119 |
| D-R5 | Debrief endpoint, `PUT /fleet` | Done (`sightline/api/missions.py`) |
| D-K1 | Card, GPX and KML endpoints | Done (`/missions/{id}/cards/{sector}`) |
| — | Conditions every 30 min, agent tick every 5 min | Done #56 (`sightline/mission/scheduler.py`) |
| D-W1 | AWS: S3, SQS FIFO with dead-letter queue, EC2 with Caddy HTTPS, CloudWatch, IAM, Secrets Manager, budget alarm, teardown | Done #58, #59, #61, #85, #87, #117 (`deploy/aws/`): 7.1 s from upload to processed on c7i.2xlarge |
| D-S1 | `scripts/smoke.sh` | Done #56 |
| — | Clean-machine dress run | Done ahead of the freeze #138 (`deploy/dressrun/`) |
| — | "What changed since BCS" statement | Done #111 (`docs/submission/NEBIUS_WHAT_CHANGED.md`) |
| — | Freeze, submissions, tags `opencv-submit` and `nebius-submit` | Deferred to Oct 25, 26 and 30 |

## 5. Tests

`tests/pipeline/`, `tests/api/` and Vitest: contract round-trips; `validate_mission` catches each
invariant violation; concurrent appends keep sequence numbers contiguous and a restart rebuilds the same
`LiveMap`; photos without GPS refused; every row of §3 produces exactly its state changes and events; SSE
resume; `useMission` in both modes; review live mode; ingest; and the area-wording check.

## 6. Cut order

From the bottom: budget alarm and dead-letter polish · debrief endpoint · `PUT /fleet` · conditions
scheduler · AWS beyond one EC2 with S3 and CloudWatch · review live mode · decision side effects · New
search screen (never) · `useMission` and routing (never) · API and pipeline (never) · contract and store
(never). Nothing was cut.
