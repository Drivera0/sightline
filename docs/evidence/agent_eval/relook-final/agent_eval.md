# Agent evaluation

`uv run python scripts/agent_eval.py --val /home/driver/sightline/data/heridal/yolo_full/val --ledger-csv /home/driver/sightline/runs/verifier/val-verify-v2-20261020-165932.csv /home/driver/sightline/runs/verifier/test-verify-v2-20261020-170158.csv --out /home/driver/sightline/runs/agent_eval/relook-final` · 2026-10-22 11:07 · models: fake (VL says yes, in relook: unclear then yes; briefing = its facts) · detector: scripted from the scenario truth · photos: HERIDAL validation crops (/home/driver/sightline/data/heridal/yolo_full/val) · 3 run(s) per scenario.

Scripted search manager and reviewer (labelled in every trace). Ground truth: the hidden person in `sightline/search/scenarios/creek.json`, sector C3.

## Proposals per scenario

| Scenario | Runs | Proposals (mean) | alert | assign_sector | drone_leg | promote_detection | retask_drone | Wall s (mean) |
|---|---|---|---|---|---|---|---|---|
| creek | 3 | 9 | 1 | 4 | 4 | 0 | 0 | 1.1 |
| no_clue | 3 | 9 | 1 | 4 | 4 | 0 | 0 | 1.0 |
| clue_early | 3 | 12 | 1 | 4 | 7 | 0 | 0 | 1.2 |
| near_miss_only | 3 | 9 | 0 | 4 | 4 | 1 | 0 | 1.0 |
| relook | 3 | 14 | 0 | 4 | 7 | 2 | 1 | 115.3 |

Final status of all agent proposals: {'approved': 75, 'pending': 63, 'rejected': 12, 'superseded': 9}.

## Time from evidence to proposal

| Evidence | Proposal | n | p50 ms | p90 ms | max ms |
|---|---|---|---|---|---|
| clue | drone_leg | 9 | 122 | 158 | 181 |
| detection | promote_detection | 3 | 64 | 65 | 65 |
| leg_done | drone_leg | 24 | 114 | 253 | 279 |
| review | alert | 9 | 28 | 29 | 31 |
| review | assign_sector | 9 | 30 | 32 | 34 |
| tick | assign_sector | 39 | 33 | 37 | 40 |
| verdict | promote_detection | 9 | 29 | 70 | 70 |

Evidence times: a clue's `at`; a detection: its photo's `photo.processed` event; a verdict's `at`; a review's event; a leg done: the telemetry event; a tick: when it was called. Proposal time: its `created_at`. Percentiles interpolated linearly.

## Correct target (ground truth)

| Scenario | Check | Correct | Proposed |
|---|---|---|---|
| creek | clue: a drone is over or proposed toward the person's sector | 3/3 | D2 C3 (flying); the clue's proposals: none |
| creek | review: alert names the person's sector | 3/3 | p004 → C3 |
| creek | review: team assigned to the person's sector | 3/3 | p005 → C3 |
| creek | leg done: next leg (informational, no truth) | n/a | D1 → B2 |
| no_clue | review: alert names the person's sector | 3/3 | p004 → C3 |
| no_clue | review: team assigned to the person's sector | 3/3 | p005 → C3 |
| no_clue | leg done: next leg (informational, no truth) | n/a | D1 → B2 |
| clue_early | clue: a drone is over or proposed toward the person's sector | 3/3 | D1 C3 (drone_leg p004 pending); the clue's proposals: drone_leg D1 → C3, drone_leg D3 → C2, drone_leg D2 → B2 |
| clue_early | review: alert names the person's sector | 3/3 | p007 → C3 |
| clue_early | review: team assigned to the person's sector | 3/3 | p008 → C3 |
| clue_early | leg done: next leg (informational, no truth) | n/a | D1 → B3 |
| near_miss_only | near miss: the person's detection promoted | 3/3 | f0003-d01 |
| near_miss_only | leg done: next leg (informational, no truth) | n/a | D1 → B2 |
| relook | re-look: an unclear 21 px near miss gets a 25 m leg | 3/3 | p004 retask_drone: Second look at f0003-d01 was unclear: box 21 px, too small to verify; a pass at 25 m gives |
| relook | leg done: next leg (informational, no truth) | n/a | D1 → B3; D2 → C1; D3 → B1; D3 → C2 |
| relook | re-look: the low pass resolves the person (photo → verdict → promote) | 3/3 | relook-f0003-d01: unclear → leg → photo → verdict → outcome → photo → photo → photo → photo (resolved, promoted p005) |

## Approval gate

| Check (final mission state) | Runs passing | Failures |
|---|---|---|
| every leg in the fleet comes from an approved proposal | 15/15 | – |
| no pending, rejected or superseded leg is in the fleet | 15/15 | – |
| every team off standby has an approved assign_sector | 15/15 | – |
| every assigned sector task has an approved assign_sector | 15/15 | – |
| every promotion to the review queue follows an approved promote_detection | 15/15 | – |
| no leg is approved in the event log before its proposal exists | 15/15 | – |
| approvals and rejections are by a person (who and when recorded) | 15/15 | – |
| a rejection has a reason | 15/15 | – |
| the agent only supersedes; it never approves or rejects | 15/15 | – |
| no proposal or verdict says "clear"/"cleared" | 15/15 | – |
| validate_mission passes | 15/15 | – |

## Re-look legs (unclear on a box under 60 px → 25 m pass)

| Scenario | Chain | Box px | Pixel factor | Leg | Est min | Sim min flown | Photos | Outcome | Promoted |
|---|---|---|---|---|---|---|---|---|---|
| relook | relook-f0003-d01 | 21 | 4.0 | L004 | 1.13 | 1.08 | 5 | resolved | p005 |
| relook | relook-f0003-d01 | 21 | 4.0 | L004 | 1.13 | 1.08 | 5 | resolved | p005 |
| relook | relook-f0003-d01 | 21 | 4.0 | L004 | 1.13 | 1.08 | 5 | resolved | p005 |

Sim minutes: the fleet sim's `DroneSim` at the drone's 8 m/s airspeed, no wind, from where the drone was to the end of the pattern. The sim's photo from 25 m is the 50 m crop's centre resized 2×: the size a lower pass gives, not its extra detail.

## Did the observation help (ledger)

| Observation | n | Mean expected gain | Mean realised gain | Mean delta | Correlation |
|---|---|---|---|---|---|
| second look (P decisive verdict) | 21 (4 distinct) | 0.4933 | 0.8571 | +0.3638 | – |
| leg flown in full by the sim | 12 (4 distinct) | 0.0103 | 0.0110 | +0.0007 | 1.00 |
| leg marked done by the script, not flown | 12 (2 distinct) | 0.0151 | 0.0000 | -0.0151 | – |

Gain: for a second look, the val share of decisive verdicts for its box size (expected) and 1 or 0 (realised); for a leg, Σ p · POD on the map as proposed, with the planner's POD (expected) and with the POD its photos gave (realised). Correlation: Pearson, – with fewer than 3 records or no spread.

| Leg | Chain | Sector | Photos | Cells seen | Expected | Realised | Delta |
|---|---|---|---|---|---|---|---|
| L004 | relook-f0003-d01 | C3 | 5 | 22/23 | 0.000097 | 0.000051 | -0.000046 |
| L002 | leg-L002 | B2 | 218 | 2404/2500 | 0.013700 | 0.014796 | +0.001096 |
| L003 | leg-L003 | C3 | 221 | 2474/2500 | 0.013900 | 0.014830 | +0.000930 |
| L005 | leg-L005 | C2 | 204 | 2376/2500 | 0.013500 | 0.014205 | +0.000705 |

## Failure handling (injected)

| Case | Injected | What the loop did | In the trace | Trace / evidence | Crash |
|---|---|---|---|---|---|
| a1 timeout | Token Factory times out on every attempt | retried 2× (backoff 1, 1 s); verdict `unclear` (“No second look: the model call failed (APITimeoutError)”); 2 of 2 briefings fell back to the template; circuit open: 1 call(s) failed fast without the network; proposals: drone_leg 3, alert 1, assign_sector 1 | yes | 0 VL model_call entries, the verdict entry; No second look: the model call failed (APITimeoutError after 2 attempts (timeout ×2)).; ledger second_look (relook-f0001-d01): expected gain 0.4933, realised 0.0000 (delta -0.4933); briefing model call failed (APITimeoutError after 2 attempts (timeout ×2)): template used; briefing model call failed (CircuitOpen: Token Factory failed 4 attempts in a row; calls fail fast for 60 s (next try in 60 s)): template used | no |
| a2 5xx then OK | 503 on the first two attempts, then OK | retried 4× (backoff 1, 2, 1, 2 s); verdict `yes`; proposals: drone_leg 3, promote_detection 1, alert 1, assign_sector 1 | yes | 1 VL model_call entries, the verdict entry; ledger second_look (relook-f0001-d01): expected gain 0.4933, realised 1.0000 (delta +0.5067); model_call entry: “VL verdict for f0001-d01 (after 2 retries (HTTP 503, HTTP 503))”; model_call entry: “briefing (after 2 retries (HTTP 503, HTTP 503))” | no |
| a3 5xx always | 503 on every attempt | retried 3× (backoff 1, 2, 4 s); verdict `unclear` (“No second look: the model call failed (InternalServerError)”); 2 of 2 briefings fell back to the template; circuit open: 2 call(s) failed fast without the network; proposals: drone_leg 3, alert 1, assign_sector 1 | yes | 0 VL model_call entries, the verdict entry; No second look: the model call failed (InternalServerError after 4 attempts (HTTP 503 ×4)).; ledger second_look (relook-f0001-d01): expected gain 0.4933, realised 0.0000 (delta -0.4933); briefing model call failed (CircuitOpen: Token Factory failed 4 attempts in a row; calls fail fast for 60 s (next try in 60 s)): template used; briefing model call failed (CircuitOpen: Token Factory failed 4 attempts in a row; calls fail fast for 60 s (next try in 60 s)): template used | no |
| a4 slow and down | every attempt hangs 0.25 s, then times out (near miss, review, tick) | 4 attempts in all (breaker at 4), then 4 call(s) failed fast; the whole sequence took 1.5 s, about 4 × 0.25 s of waiting plus the pipeline | yes | 4 notes name CircuitOpen | no |
| b1 malformed JSON | VL verdict and briefing replies are broken JSON | verdict `unclear` (“No second look: the model's reply was not valid JSON after one retry”); 2 of 2 briefings fell back to the template; proposals: drone_leg 3, alert 1, assign_sector 1 | yes | 2 VL model_call entries, the verdict entry; ledger second_look (relook-f0001-d01): expected gain 0.4933, realised 0.0000 (delta -0.4933); briefing still had problems after a retry: template used; briefing still had problems after a retry: template used; briefing rejected: not a briefing: write it as plain sentences; briefing rejected: not a briefing: write it as plain sentences | no |
| b2 malformed once | first reply of each kind is not JSON / not a briefing | verdict `yes`; proposals: drone_leg 3, promote_detection 1, alert 1, assign_sector 1 | yes | 2 VL model_call entries, the verdict entry; ledger second_look (relook-f0001-d01): expected gain 0.4933, realised 1.0000 (delta +0.5067); briefing rejected: not a briefing: write it as plain sentences | no |
| c Tavily down | Tavily search/extract raise ConnectionError | fell back: HTTP 200; conditions stale=True, flyable=None, reason “no conditions data (offline: ConnectionError)”; 1 Tavily call(s); 0 agent proposal(s) (none) | yes | conditions/note: Tavily failed (ConnectionError): conditions fell back to none, marked stale | no |
| d1 no GPS (API) | a JPEG without EXIF GPS posted to /photos | skipped: rejected at upload (no GPS position, altitude, heading or focal length in the photo's EXIF/XMP); 0 frames | yes | pipeline/note: photo.rejected no_gps.jpg: no GPS position, altitude, heading or focal length in the photo's EXIF/XMP | no |
| d2 no GPS (worker) | a no-GPS job put on the photo queue directly (bypassing the upload check), then a good photo | skipped f0001 (recorded as photo.failed); the good photo (upload f0002) was processed; frames now ['f0001'] | yes | pipeline/note: photo.failed f0001 (no_gps.jpg): no GPS position, altitude, heading or focal length in the photo's EXIF/XMP; a mission.note event | no |
| e1 duplicate clue hook | on_clue(c001) delivered twice | 9 leg proposals over the opening, the clue and its repeat ({'superseded': 6, 'pending': 3}); pending: D1 → C3, D3 → C2, D2 → B2 (one per drone) | yes | 6 proposal entries cite the clue; the superseding is an event, not a trace entry | no |
| e2 duplicate detection hook | on_detection(f0001-d01) delivered twice (near miss) | 1 verdicts, 1 promote_detection proposals for the one detection (p004 pending) | yes | 1 verdict entries; note “repeat detection f0001-d01: no new proposal; p004 (pending)” | no |
| e3 duplicate review | POST /reviews f0001-d01 person, twice | proposals: {'alert': 1, 'assign_sector': 1} | yes | each proposal is traced; note “repeat review of f0001-d01: no new proposal; p004 (pending)” | no |
| e4 duplicate photo job | the job for f0001 delivered again (SQS at-least-once) | skipped (already processed): 1 frame(s), verdicts 1 → 1 | no | none (the pipeline returns 'already processed' silently) | no |
| e5 duplicate decision | approve p001 twice | second approval refused: HTTP 409 (p001 is approved, not pending); leg L001 in the fleet 1× | yes | the first decision is traced; the refused one is not | no |

Server log warnings and errors during the injected cases:

- a1 timeout: `sightline.agent.verify: verifier model call failed for f0001-d01 (APITimeoutError: Request timed out.)`
- a1 timeout: `sightline.agent.loop: briefing model call failed (APITimeoutError: Request timed out.)`
- a1 timeout: `sightline.agent.loop: briefing model call failed (CircuitOpen: Token Factory failed 4 attempts in a row; calls fail fast for 60 s (next try in 60 s))`
- a3 5xx always: `sightline.agent.verify: verifier model call failed for f0001-d01 (InternalServerError: Error code: 503)`
- a3 5xx always: `sightline.agent.loop: briefing model call failed (CircuitOpen: Token Factory failed 4 attempts in a row; calls fail fast for 60 s (next try in 60 s))`
- a3 5xx always: `sightline.agent.loop: briefing model call failed (CircuitOpen: Token Factory failed 4 attempts in a row; calls fail fast for 60 s (next try in 60 s))`
- a4 slow and down: `sightline.agent.verify: verifier model call failed for f0001-d01 (APITimeoutError: Request timed out.)`
- a4 slow and down: `sightline.agent.loop: briefing model call failed (APITimeoutError: Request timed out.)`
- a4 slow and down: `sightline.agent.loop: briefing model call failed (CircuitOpen: Token Factory failed 4 attempts in a row; calls fail fast for 60 s (next try in 60 s))`
- a4 slow and down: `sightline.agent.loop: briefing model call failed (CircuitOpen: Token Factory failed 4 attempts in a row; calls fail fast for 60 s (next try in 60 s))`
- a4 slow and down: `sightline.agent.loop: briefing model call failed (CircuitOpen: Token Factory failed 4 attempts in a row; calls fail fast for 60 s (next try in 60 s))`
- a4 slow and down: `sightline.agent.loop: briefing model call failed (CircuitOpen: Token Factory failed 4 attempts in a row; calls fail fast for 60 s (next try in 60 s))`

## Crashes

None: no scenario run raised, and the runner traced no failed event.


## Second-look ledger on recorded verifier runs

| Run | n | Mean expected | Mean realised | Realised under 60 px (n) | Correlation |
|---|---|---|---|---|---|
| val-verify-v2-20261020-165932.csv | 170 | 0.618 | 0.618 | 0.493 (75) | 0.23 |
| test-verify-v2-20261020-170158.csv | 121 | 0.622 | 0.488 | 0.353 (51) | 0.23 |

Expected under 60 px: 0.493; at 60 px and over: 0.716 (val, verify-v2).

