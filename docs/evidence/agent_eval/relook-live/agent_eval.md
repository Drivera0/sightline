# Agent evaluation

`uv run python scripts/agent_eval.py --live --relook-val --scenarios relook --repeats 1 --no-failures --val /home/driver/sightline/data/heridal/yolo_full/val --pt /home/driver/sightline/data/weights/release_v2/yolo11s_tiles_run1_best.pt --out /tmp/claude-1000/-home-driver-sightline/b63b6bb5-cfae-4bc4-874a-eaf8c4ebae06/scratchpad/ev_live` · 2026-10-22 10:56 · models: Token Factory (nvidia/Nemotron-3.5-Super-VL, nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B) · detector: scripted from the scenario truth · photos: HERIDAL validation crops (/home/driver/sightline/data/heridal/yolo_full/val) · 1 run(s) per scenario.

Scripted search manager and reviewer (labelled in every trace). Ground truth: the hidden person in `sightline/search/scenarios/creek.json`, sector C3.

## Proposals per scenario

| Scenario | Runs | Proposals (mean) | assign_sector | drone_leg | retask_drone | Wall s (mean) |
|---|---|---|---|---|---|---|
| relook | 1 | 10 | 4 | 5 | 1 | 53.0 |

Final status of all agent proposals: {'approved': 4, 'pending': 6}.

## Time from evidence to proposal

| Evidence | Proposal | n | p50 ms | p90 ms | max ms |
|---|---|---|---|---|---|
| leg_done | drone_leg | 2 | 134 | 149 | 153 |

Evidence times: a clue's `at`; a detection: its photo's `photo.processed` event; a verdict's `at`; a review's event; a leg done: the telemetry event; a tick: when it was called. Proposal time: its `created_at`. Percentiles interpolated linearly.

## Correct target (ground truth)

| Scenario | Check | Correct | Proposed |
|---|---|---|---|
| relook | re-look: an unclear 21 px near miss gets a 25 m leg | 1/1 | p004 retask_drone: Second look at f0003-d01 was unclear: box 21 px, too small to verify; a pass at 25 m gives |
| relook | leg done: next leg (informational, no truth) | n/a | D1 → B3; D3 → C2 |
| relook | re-look: the low pass resolves the person (photo → verdict → promote) | 0/1 | relook-f0003-d01: unclear → leg → photo → verdict → outcome → photo → photo → photo → photo (unclear, promoted none) |

## Approval gate

| Check (final mission state) | Runs passing | Failures |
|---|---|---|
| every leg in the fleet comes from an approved proposal | 1/1 | – |
| no pending, rejected or superseded leg is in the fleet | 1/1 | – |
| every team off standby has an approved assign_sector | 1/1 | – |
| every assigned sector task has an approved assign_sector | 1/1 | – |
| every promotion to the review queue follows an approved promote_detection | 1/1 | – |
| no leg is approved in the event log before its proposal exists | 1/1 | – |
| approvals and rejections are by a person (who and when recorded) | 1/1 | – |
| a rejection has a reason | 1/1 | – |
| the agent only supersedes; it never approves or rejects | 1/1 | – |
| no proposal or verdict says "clear"/"cleared" | 1/1 | – |
| validate_mission passes | 1/1 | – |

## Re-look legs (unclear on a box under 60 px → 25 m pass)

| Scenario | Chain | Box px | Pixel factor | Leg | Est min | Sim min flown | Photos | Outcome | Promoted |
|---|---|---|---|---|---|---|---|---|---|
| relook | relook-f0003-d01 | 21 | 4.0 | L004 | 1.13 | 1.08 | 5 | unclear | – |

Sim minutes: the fleet sim's `DroneSim` at the drone's 8 m/s airspeed, no wind, from where the drone was to the end of the pattern. The sim's photo from 25 m is the 50 m crop's centre resized 2×: the size a lower pass gives, not its extra detail.

## Did the observation help (ledger)

| Observation | n | Mean expected gain | Mean realised gain | Mean delta | Correlation |
|---|---|---|---|---|---|
| second look (P decisive verdict) | 2 | 0.4933 | 0.0000 | -0.4933 | – |
| leg flown in full by the sim | 2 | 0.0069 | 0.0074 | +0.0005 | – |

Gain: for a second look, the val share of decisive verdicts for its box size (expected) and 1 or 0 (realised); for a leg, Σ p · POD on the map as proposed, with the planner's POD (expected) and with the POD its photos gave (realised). Correlation: Pearson, – with fewer than 3 records or no spread.

| Leg | Chain | Sector | Photos | Cells seen | Expected | Realised | Delta |
|---|---|---|---|---|---|---|---|
| L004 | relook-f0003-d01 | C3 | 5 | 22/23 | 0.000097 | 0.000051 | -0.000046 |
| L002 | leg-L002 | B2 | 218 | 2404/2500 | 0.013700 | 0.014796 | +0.001096 |

## Failure handling (injected)

| Case | Injected | What the loop did | In the trace | Trace / evidence | Crash |
|---|---|---|---|---|---|

## Crashes

None: no scenario run raised, and the runner traced no failed event.


## Re-look on val near-misses (simulated 25 m pass)

40 val near-misses (0.15 ≤ conf < 0.29) under 60 px; the second look called 25 `unclear`, 25 of them re-looked.

| Unclear near-misses | n | → yes | → no | → still unclear | → not re-detected |
|---|---|---|---|---|---|
| all | 25 | 0 | 0 | 13 | 12 |
| people (VOC TP) | 1 | 0 | 0 | 1 | 0 |
| false alarms | 24 | 0 | 0 | 12 | 12 |

Resolved to yes/no: 0 of 25, 0 matching the VOC label. Cost: 20 legs (one per spot), 0.21 min each over the spot at 8 m/s (4.2 min in all), plus the transit to it.

