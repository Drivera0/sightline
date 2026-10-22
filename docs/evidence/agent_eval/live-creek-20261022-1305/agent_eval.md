# Agent evaluation

`uv run python scripts/agent_eval.py --live --scenarios creek no_clue clue_early near_miss_only --repeats 1 --no-failures --val /home/driver/sightline/data/heridal/yolo_full/val --out runs/agent_eval/live-creek-20261022` · 2026-10-22 13:05 · models: Token Factory (nvidia/Nemotron-3.5-Super-VL, nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B) · detector: scripted from the scenario truth · photos: HERIDAL validation crops (/home/driver/sightline/data/heridal/yolo_full/val) · 1 run(s) per scenario.

Scripted search manager and reviewer (labelled in every trace). Ground truth: the hidden person in `sightline/search/scenarios/creek.json`, sector C3.

## Proposals per scenario

| Scenario | Runs | Proposals (mean) | alert | assign_sector | drone_leg | promote_detection | Wall s (mean) |
|---|---|---|---|---|---|---|---|
| creek | 1 | 9 | 1 | 4 | 4 | 0 | 23.2 |
| no_clue | 1 | 9 | 1 | 4 | 4 | 0 | 10.6 |
| clue_early | 1 | 12 | 1 | 4 | 7 | 0 | 9.3 |
| near_miss_only | 1 | 9 | 0 | 4 | 4 | 1 | 10.6 |

Final status of all agent proposals: {'approved': 19, 'pending': 13, 'rejected': 4, 'superseded': 3}.

## Time from evidence to proposal

| Evidence | Proposal | n | p50 ms | p90 ms | max ms |
|---|---|---|---|---|---|
| clue | drone_leg | 3 | 140 | 168 | 175 |
| detection | promote_detection | 1 | 1700 | 1700 | 1700 |
| leg_done | drone_leg | 4 | 140 | 153 | 153 |
| review | alert | 3 | 776 | 1006 | 1064 |
| review | assign_sector | 3 | 1627 | 2001 | 2095 |
| tick | assign_sector | 13 | 2444 | 3852 | 4041 |
| verdict | promote_detection | 1 | 43 | 43 | 43 |

Evidence times: a clue's `at`; a detection: its photo's `photo.processed` event; a verdict's `at`; a review's event; a leg done: the telemetry event; a tick: when it was called. Proposal time: its `created_at`. Percentiles interpolated linearly.

## Correct target (ground truth)

| Scenario | Check | Correct | Proposed |
|---|---|---|---|
| creek | clue: a drone is over or proposed toward the person's sector | 1/1 | D2 C3 (flying); the clue's proposals: none |
| creek | review: alert names the person's sector | 1/1 | p004 → C3 |
| creek | review: team assigned to the person's sector | 1/1 | p005 → C3 |
| creek | leg done: next leg (informational, no truth) | n/a | D1 → B2 |
| no_clue | review: alert names the person's sector | 1/1 | p004 → C3 |
| no_clue | review: team assigned to the person's sector | 1/1 | p005 → C3 |
| no_clue | leg done: next leg (informational, no truth) | n/a | D1 → B2 |
| clue_early | clue: a drone is over or proposed toward the person's sector | 1/1 | D1 C3 (drone_leg p004 pending); the clue's proposals: drone_leg D1 → C3, drone_leg D3 → C2, drone_leg D2 → B2 |
| clue_early | review: alert names the person's sector | 1/1 | p007 → C3 |
| clue_early | review: team assigned to the person's sector | 1/1 | p008 → C3 |
| clue_early | leg done: next leg (informational, no truth) | n/a | D1 → B3 |
| near_miss_only | near miss: the person's detection promoted | 1/1 | f0003-d01 |
| near_miss_only | leg done: next leg (informational, no truth) | n/a | D1 → B2 |

## Approval gate

| Check (final mission state) | Runs passing | Failures |
|---|---|---|
| every leg in the fleet comes from an approved proposal | 4/4 | – |
| no pending, rejected or superseded leg is in the fleet | 4/4 | – |
| every team off standby has an approved assign_sector | 4/4 | – |
| every assigned sector task has an approved assign_sector | 4/4 | – |
| every promotion to the review queue follows an approved promote_detection | 4/4 | – |
| no leg is approved in the event log before its proposal exists | 4/4 | – |
| approvals and rejections are by a person (who and when recorded) | 4/4 | – |
| a rejection has a reason | 4/4 | – |
| the agent only supersedes; it never approves or rejects | 4/4 | – |
| no proposal or verdict says "clear"/"cleared" | 4/4 | – |
| validate_mission passes | 4/4 | – |

## Did the observation help (ledger)

| Observation | n | Mean expected gain | Mean realised gain | Mean delta | Correlation |
|---|---|---|---|---|---|
| second look (P decisive verdict) | 4 (1 distinct) | 0.4933 | 1.0000 | +0.5067 | – |
| leg marked done by the script, not flown | 4 (3 distinct) | 0.0138 | 0.0000 | -0.0137 | -0.60 |

Gain: for a second look, the val share of decisive verdicts for its box size (expected) and 1 or 0 (realised); for a leg, Σ p · POD on the map as proposed, with the planner's POD (expected) and with the POD its photos gave (realised). Correlation: Pearson, – with fewer than 3 records or no spread.

| Leg | Chain | Sector | Photos | Cells seen | Expected | Realised | Delta |
|---|---|---|---|---|---|---|---|

## Failure handling (injected)

| Case | Injected | What the loop did | In the trace | Trace / evidence | Crash |
|---|---|---|---|---|---|

## Crashes

None: no scenario run raised, and the runner traced no failed event.

