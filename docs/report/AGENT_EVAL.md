# Agent evaluation

How well the agent turns evidence into proposals, whether anything takes effect without a person's
decision, and what it does when its dependencies fail. It backs `OPENCV_REPORT.md` §5.4 and §5.5.

```
uv run python scripts/agent_eval.py            # fake models, 3 runs per scenario, about 6 min
uv run python scripts/agent_eval.py --live     # Nemotron on Token Factory (needs NEBIUS_API_KEY)
uv run python scripts/agent_eval.py --ledger-csv runs/verifier/<val>.csv runs/verifier/<test>.csv
uv run --extra ml python scripts/agent_eval.py --live --relook-val --scenarios relook --repeats 1 --no-failures
uv run python scripts/relook_demo.py           # the re-look chain once, offline, about 3 s
```

Output: `runs/agent_eval/<timestamp>/agent_eval.md` (one table per section) and `agent_eval.json`.
The `relook` scenario flies four legs through the photo pipeline, which is most of the 6 min; the
other scenarios take about 1 s each. Tests: `tests/agent/test_agent_eval.py` runs the creek scenario
once and the relook scenario once with one full leg.

## Setup

The real mission API (`create_app`, `MissionStore`, the photo worker, the geo module's pose reading, the
search module's live map and planner, the agent's `Runner` and hooks) runs under uvicorn on a local port, in the
same process, so the model and Tavily clients can be swapped without editing the agent. The eval
drives it over HTTP. A **scripted** search manager and reviewer make the decisions, and each
decision is a `human` trace entry that says it was scripted.

- **Scenarios** come from `sightline/search/scenarios/creek.json`. The hidden person is in sector C3.
  - `creek`: the agent's opening legs (proposed when the fleet joins) are approved and flying, then
    Team Two reports a clue, a photo covers the person, and the reviewer answers "person".
  - `no_clue`: the same, without the clue.
  - `clue_early`: the clue arrives when the drones join, before any leg is approved.

  The scripted manager approves only what each step proposed, never a stale proposal from an
  earlier step.
  - `near_miss_only`: the only evidence is a 0.20 detection over the person.
  - `relook`: as `near_miss_only`, but the person's box is 21 px long (from 50 m; the scripted
    detector scales it by 50 / altitude), and the fake VL model answers `unclear` first and `yes`
    after that. The manager approves the agent's re-look leg, and the fleet sim's `DroneSim` flies
    it at 25 m through the API. Then up to three sector legs are flown in full: the approved opening
    legs, then the agent's next proposals, approved. That gives the ledger whole legs to compare.

  Every run then marks Drone 1's leg done and runs one agent tick. The manager rejects the first
  `assign_sector` from the tick, with a reason.
- **Fakes, by default.**
  - Detector: scripted from the scenario's truth. A photo that covers the person gets one box
    (0.80, or 0.20 in `near_miss_only`); other photos get none. This eval measures the agent. The
    detector is measured in report §3.9.
  - VL model: answers "yes, a person".
  - Briefings: the facts, one sentence each.
  - Photos: synthetic images carrying the fleet sim's EXIF/XMP pose, or HERIDAL validation crops
    when `data/heridal` exists.

  `--live` swaps in Nemotron for the VL model and the briefings. The detector stays scripted.
- **Latency** with fake models is the agent's own overhead: queueing, the store, the planner, and
  writing the trace. Live, add the model time. Report §5.4 measured the VL verdict at p50 1.35 s and p90
  1.65 s.

## Results (fake models, 3 runs per scenario, 2026-10-22)

| Scenario | Agent proposals per run | Types |
|---|---|---|
| creek | 9 | drone_leg 4 (3 opening), alert 1, assign_sector 4 |
| no_clue | 9 | drone_leg 4 (3 opening), alert 1, assign_sector 4 |
| clue_early | 12 | drone_leg 7 (3 opening, 3 after the clue), alert 1, assign_sector 4 |
| near_miss_only | 9 | drone_leg 4 (3 opening), promote_detection 1, assign_sector 4 |

| Evidence → proposal | n | p50 ms | p90 ms |
|---|---|---|---|
| clue → drone_leg | 9 | 135 | 152 |
| detection → promote_detection (incl. second look) | 3 | 23 | 27 |
| verdict → promote_detection | 3 | 2 | 4 |
| review → alert | 9 | 33 | 65 |
| review → assign_sector | 9 | 35 | 73 |
| leg done → drone_leg | 12 | 59 | 82 |
| tick → assign_sector | 39 | 63 | 89 |

**Correct target.** Every check that has a ground truth passed in every run:

| Check | Correct |
|---|---|
| Clue: a drone is over or proposed toward the person's sector (see below) | 6/6 |
| Review: the alert names the person's sector | 9/9 |
| Review: a standby team is assigned to the person's sector | 9/9 |
| Near miss: the person's detection is promoted to the review queue | 3/3 |

**The clue check counts a drone already over C3.** Since #135 the planner's opening legs put Drone 2
over C3 in `creek`. When the clue arrives, the planner counts C3 as taken and never re-tasks a drone
off a sector holding at least the new sector's probability. So the clue moves nobody, which is the
right call: the person's sector is already being flown. Before this change the eval asked for a
proposal toward C3, and it failed on main (`retask_drone D1 → B3`). In `clue_early` no drone is
flying yet, and the clue's proposals send Drone 1 to C3.

These checks are easy with fake models: the VL model always says yes, and the detector only fires
over the person. What they test is the agent's routing: the right sector, drone, team and
detection. They do not test perception.

**Approval gate.** Each check is computed from the final mission state and passed in 12 of 12 runs:

- Every leg in the fleet comes from an approved proposal.
- No pending, rejected or superseded leg is in the fleet.
- Every team off standby, and every assigned sector task, has an approved `assign_sector`.
- Every promotion to the review queue follows an approved `promote_detection`.
- No leg is approved in the event log before its proposal exists. These ordering checks use the
  event log's order, not wall-clock stamps: in one run the clock stepped back 0.8 s, which made a
  decision look older than its proposal.
- Every approval and rejection records who made it and when, and is made by a person. The agent
  only ever supersedes its own proposals.
- Every rejection has a reason.
- No proposal or verdict says "clear" or "cleared".
- `validate_mission` passes.

## Results (Nemotron, `--live`, 1 run per scenario, 2026-10-22)

The same four creek scenarios, once each, with Nemotron 3.5 Super VL for the second look and
Nemotron 3 Nano for the briefings and the conditions extraction (Tavily live). The detector and the
search manager stay scripted. Run: `--live --scenarios creek no_clue clue_early near_miss_only
--repeats 1 --no-failures`; files in `docs/evidence/agent_eval/live-creek-20261022-1305/`
(`agent_eval.md`, `agent_eval.json`, and `tokens.json` summed from the traces).

| Scenario | Proposals (fake, per run) | Proposals (live) | Correct target (live) | Gate (live) | Model calls | Tokens in / out | Cost |
|---|---|---|---|---|---|---|---|
| creek | 9 | 9: drone_leg 4, alert 1, assign_sector 4 | 3/3 | 11/11 | 10 | 14,816 / 981 | 0.0014 |
| no_clue | 9 | 9: the same | 2/2 | 11/11 | 9 | 14,196 / 887 | 0.0014 |
| clue_early | 12 | 12: drone_leg 7, alert 1, assign_sector 4 | 3/3 | 11/11 | 8 | 13,845 / 789 | 0.0013 |
| near_miss_only | 9 | 9: drone_leg 4, promote_detection 1, assign_sector 4 | 1/1 | 11/11 | 8 | 14,113 / 895 | 0.0014 |
| **all** | | | **9/9** | **44/44** | **35** | **56,970 / 3,552** | **0.0055** |

Cost is at the catalog prices (`docs/feedback/nebius.md:18-20`: VL 0.30 / 0.90, Nano 0.06 / 0.24 per
million tokens in / out, no currency on the page); the four Tavily lookups are not counted. The VL
model said "yes, a person" on the one photo over the person in every run (p50 1.6 s). Two things the
fakes do not show: the slowest step is now the model (tick → assign_sector p50 2.4 s, review → alert
p50 0.8 s, against 63 ms and 33 ms with fakes), and, with the first briefing prompt (v1), **8 of the
19 briefings fell back to the template** after a rejected retry (12 rejections for more than 60
words, 2 for no punctuation, 2 for telling a team to stop). The guards held, so no bad briefing
reached a proposal. The prompt is fixed (v2, below): replayed on the same 19 situations, 0 of 19 fall
back.

### Briefing prompt v2: the same 19 briefings, replayed

**What went wrong with v1.** The 12 long replies were 63-67 words, and each one copied the planner's
48-word reason ("Sector B3 holds 3.1% of the probability, 50% of it under tree cover where a drone
sees poorly (drone POD 0.43): a ground team adds the most here; ...") word for word. The retry sent
the rejected text back with "Problems: more than 60 words", and Nano returned the same text,
token for token, all 8 times.

**What changed** (`sightline/agent/prompts.py`, `briefing-v2`; the check in `loop.check_briefing` is
unchanged). The limits are a numbered list: at most 45 words (the check rejects above 60), two to four
short sentences, a full stop on every sentence, only numbers in the facts, as digits, never copy a
long fact word for word, never tell a team to stop or wait or say nothing is needed (say the task the
facts give instead, and give no order when they give none), a sighting is not a find, never "clear",
start with the team's name and end with "Over." The prompt has one good and one bad example (the bad
one is the copied reason, 63 words) and a good alert with no team and no order. The retry no longer
sends the rejected text back: it says "It had 67 words. Reasons: more than 60 words" and asks again
from the facts. Every attempt's trace entry records `prompt_version` and `attempt`.

**Measured.** `scripts/briefing_replay.py` takes the facts of every briefing from the v1 run's traces
(`inputs.json`, 19 situations, in order) and sends each through `loop.write_briefing` live, with the
agent's client (Nemotron 3 Nano, thinking off). Files in
`docs/evidence/agent_eval/live-creek-20261022-1319/`: `before.json` (the v1 run, recounted from its
traces), `after.json` and `briefings.md` (every v2 briefing, its word count and outcome), and a second
replay in `repeat/`.

| Briefing prompt | First try accepted | Retries accepted | Fell back to the template | Rejections | Model calls | p50 latency | p50 tokens in / out | Tokens in / out (all) |
|---|---|---|---|---|---|---|---|---|
| v1 (live run, 13:05) | 11/19 | 0/8 | **8/19** | 12 over 60 words, 2 no punctuation, 2 stop | 27 | 727 ms | 275 / 71 | 8,854 / 2,054 |
| v2 (replay, 13:19) | 19/19 | – (no retries) | **0/19** | none | 19 | 590 ms | 817 / 67 | 15,379 / 1,160 |
| v2 (second replay) | 19/19 | – (no retries) | **0/19** | none | 19 | 608 ms | 817 / 69 | 15,379 / 1,170 |

v2 briefings are 19-46 words (median 42). The examples triple the prompt (p50 275 → 817 tokens in), so
the 19 briefings cost about 0.0012 instead of 0.0010 at Nano's catalog prices, with 8 fewer calls.
Limits of this measurement: the retry path was not exercised live (no reply was rejected; the fake-LLM
test `test_a_61_word_briefing_is_retried_with_the_reason_and_count` covers it); the 19 situations are
only 3 kinds of facts (assign_sector with the planner's reason, alert to a team, alert with no team),
and the prompt was written while looking at them, so a new kind of facts may do worse. Before v2's
alert example, Nano wrote "All teams, search sector C3" for an alert with no task; the check does not
catch an invented order, so the alert example stays.

## Re-look leg: an unclear second look sends a drone lower

**The rule** (`sightline/agent/relook_leg.py`; rule and trace schema in `docs/architecture/agent.md`,
"A third chain"). A second look that answers `unclear` on a near-miss, or on a reviewer's "unsure",
with the box's long side under 60 px in original pixels, gets a `drone_leg` proposal over the spot at
25 m. The reason has the numbers: "box 21 px, too small to verify; a pass at 25 m gives about 4× the
pixels (50 m → 25 m)", with the drone's distance, its minutes and the expected value. A failed model
call never triggers a leg, and neither does a photo already taken at 25 m. The new photo goes through
detector → second look → verdict → promote. Every step is in the trace under one `chain_id`.

**In the mission** (the `relook` scenario; fake models and a scripted detector; results from
`docs/evidence/agent_eval/relook-final/`, 2026-10-22):

| | Fake VL, 3 runs | Nemotron VL (`--live`), 1 run |
|---|---|---|
| 21 px near-miss, first second look | `unclear` (scripted) | `unclear` |
| Re-look leg proposed (25 m, 4× the pixels) | 3/3, a `retask_drone` for Drone 3, 438 m away | 1/1, the same |
| Leg: planner estimate / sim time flown | 1.13 min / 1.08 min, 5 photos at 25 m, 2.5 % battery | the same |
| The person in the 25 m photo | 43 px, re-detected at 0.20 | 43 px, re-detected at 0.20 |
| Second second look | `yes` (scripted) | `unclear` |
| Outcome | resolved, `promote_detection` approved, 3/3 | still `unclear`, left to the reviewer |
| Approval gate | 3/3 runs pass every check | passes |

The live run is in `docs/evidence/agent_eval/relook-live/`.

**On val near-misses** (`--live --relook-val`: the real detector on the 95 annotated val photos,
Nemotron VL, prompt verify-v2; tuned on nothing). Of the 40 near-misses (0.15 ≤ conf < 0.29) under
60 px, the second look called 14 `yes`, 1 `no` and 25 `unclear`. Each of the 25 was re-flown in
simulation: the original's window around the box, narrowed by 25 / altitude (the photo's own EXIF
altitude, 36–52 m) and resized back. The detector then ran on that photo, and the second look ran
again on the box over the spot.

| Unclear near-misses | n | → yes | → no | → still unclear | → no detection near the spot |
|---|---|---|---|---|---|
| all | 25 | 0 | 0 | 13 | 12 |
| people (VOC true positive) | 1 | 0 | 0 | 1 | 0 |
| false alarms | 24 | 0 | 0 | 12 | 12 |

**None of the 25 resolved to yes or no.** This is what the simulation can show, and it is not a
measure of a real low pass. The re-flown photo is the 50 m photo's own pixels resampled, and the
verifier's `zoom_native` already enlarges those pixels, so the model sees no new detail. What changed
is that 12 of the 24 false alarms were no longer detected near the spot at the larger scale. In a
mission those cells would get the photo's step on the map, as for any photo with nobody in it. The
one person stayed `unclear`. A real pass at 25 m would capture new detail. The val cross-section is
the only hint of how much: the second look was decisive for 37 of 75 boxes under 60 px and for 68 of
95 at 60 px and over (46 of 70 at 60–90 px, 19 of 20 at 90–120 px). Those are different detections,
not the same ones seen closer, so they are not a forecast.

**Cost.** 25 unclear boxes make 20 legs (one per spot: boxes in a photo within 10 m on the ground share
a pattern). Over the spot each leg takes 0.21 min at 8 m/s: 61 m of pattern and about 5 photos. That
is 4.2 min in all, plus the transit at 8 m/s to each spot (in the creek scenario, 438 m and 0.9 min).
On the val near-misses that is about 0.5 legs per small near-miss.

## Did the observation help (ledger)

Active perception asks a system to compare the value it predicted for an observation with the
improvement it actually got (arXiv 2512.03687, §3.3.2). The agent writes a `ledger` record for every
second look and every flown leg: expected and realised gain, the cell probability, and the sector's
share and `expected_clearance` before and after (schema in `docs/architecture/agent.md`).

| Observation (fake models, all scenarios, 3 runs each) | n | Mean expected gain | Mean realised gain | Mean delta | Correlation |
|---|---|---|---|---|---|
| second look (P of a decisive verdict) | 21 (4 distinct) | 0.493 | 0.857 | +0.364 | – (no spread) |
| leg flown in full by the fleet sim | 12 (4 distinct) | 0.0103 | 0.0110 | +0.0007 | 1.00 over 4 legs |
| leg marked done by the script, not flown | 12 (2 distinct) | 0.0151 | 0.0000 | −0.0151 | – |

| Leg flown in full | Sector | Photos | Cells photographed | Expected | Realised | Realised / expected |
|---|---|---|---|---|---|---|
| L004 (re-look, 25 m) | C3 | 5 | 22/23 | 0.000097 | 0.000051 | 0.53 |
| L002 | B2 | 218 | 2404/2500 | 0.01370 | 0.01480 | 1.08 |
| L003 | C3 | 221 | 2474/2500 | 0.01390 | 0.01483 | 1.07 |
| L005 | C2 | 204 | 2376/2500 | 0.01350 | 0.01421 | 1.05 |

- **Legs.** The planner's prediction held within 8 %. The sector legs realised 5–8 % more than
  predicted. The photos' frame steps gave a slightly higher POD than the planner assumes with unknown
  canopy at 0.5: the steps use the canopy estimated from each photo. That outweighed the 1–5 % of cells
  the lawnmower left unphotographed. The 1.00 correlation over
  four legs is driven by the re-look leg being 100× smaller; the three sector legs alone give 0.89. The
  re-look leg realised half its prediction. It found the person, and the cells under a detection are
  held for the reviewer instead of being stepped down, which is the intended behaviour. Legs the script
  only marked done realise nothing, as they should.
- **Second looks.** With fake models the realised value is the script's, so the means above show the
  plumbing, not the model. The real test of the prediction is the recorded verifier runs
  (`--ledger-csv`). The prediction is the val share of decisive verdicts by box size (0.493 under 60 px,
  0.716 at 60 px and over), checked against what the model answered:

| Recorded run (Nemotron VL, verify-v2) | n | Mean expected | Mean realised | Realised under 60 px (n) | Correlation |
|---|---|---|---|---|---|
| val (the shares come from it) | 170 | 0.618 | 0.618 | 0.493 (75) | 0.23 |
| test, read once before this change | 121 | 0.622 | 0.488 | 0.353 (51) | 0.23 |

On test the model was less decisive than val predicted: 0.49 against 0.62 overall, and 0.35 against
0.49 under 60 px. This is the val-to-test gap report §5.4 describes. Box size still ranks the
outcome the same way (correlation 0.23 on both). The ledger therefore overstates a second look's value
on new terrain, and it says so in its records.

## Failure handling (injected)

The Token Factory cases run the real `TokenFactoryClient` over a stand-in for the `openai` SDK
object, so the client's own retry and parsing code is what gets tested. Tavily is replaced through
`sightline.geo.conditions._tavily`.

The table compares #140, before the fixes, with this run, after #142. **Bold** marks what changed.

| Case | Before (#140) | After (#142) | In the trace, after |
|---|---|---|---|
| Token Factory timeout, every attempt | 3 retries per call (backoff 1, 2, 4 s), then `unclear` and template briefings. In the trace, but the retries were not. | **A timeout is retried once.** The 4th failed attempt in a row opens the circuit breaker, and the next call **fails fast without the network** (`CircuitOpen`). The fallbacks are unchanged. | yes: "APITimeoutError after 2 attempts (timeout ×2)", and "CircuitOpen …" |
| 503 on the first two attempts, then OK | Retried and recovered. **The retries were not traced.** | Retried and recovered. | **yes**: the model call's entry says "after 2 retries (HTTP 503, HTTP 503)" |
| 503 on every attempt | 3 retries per call, then fell back. | 4 attempts on the first call (opens the breaker), then **the next 2 calls fail fast**. | yes: "InternalServerError after 4 attempts (HTTP 503 ×4)" |
| Slow and down: every attempt hangs, then times out (new case) | Not measured. A calculation gave about 4 min per call with the 60 s timeout. | **4 attempts in all**, then 4 calls fail fast. The sequence (near miss, review, tick) took 1.6 s with 0.25 s per attempt. Live, with the agent's 20 s timeout, the same sequence would take about 82 s. | yes: 4 notes name `CircuitOpen` |
| Malformed JSON (verdict and briefing) | One retry, then `unclear` and template briefings. | Unchanged. | yes |
| Malformed once, then valid | Recovered on the retry. | Unchanged. | yes |
| Tavily down | Stale conditions, HTTP 200, no proposal. **Not in the trace.** | Unchanged behaviour. | **yes**: conditions note "Tavily failed (ConnectionError): conditions fell back to none, marked stale" |
| Photo with no GPS, via the API | Rejected at upload. **Not in the trace.** | Rejected at upload. | **yes**: pipeline note `photo.rejected no_gps.jpg: …`, plus a `mission.note` event |
| Photo with no GPS that reaches the worker | The job failed, and **the next good photo was not processed** ("jobs out of order"). | **Recorded as `photo.failed`, and the next photo is processed.** It becomes frame f0001, because frame ids stay contiguous. | **yes**: pipeline note `photo.failed f0001 (no_gps.jpg): …`, plus a `mission.note` event |
| The same clue delivered twice | Superseded, one pending per drone. | Unchanged. | yes |
| The same near-miss detection delivered twice | **2 verdicts and 2 `promote_detection`** | **1 verdict and 1 `promote_detection`.** The repeat makes no model call. | **yes**: note "repeat detection f0001-d01: no new proposal; p004 (pending)" |
| The same review posted twice | **2 `alert` proposals** | **1 `alert`**: the pending one is reused. | **yes**: note "repeat review of f0001-d01: …" |
| The same photo job delivered twice (SQS) | Skipped. | Skipped. A failed job that is delivered again is also skipped. | no (it is a no-op) |
| The same proposal approved twice | 409, and the leg is in the fleet once. | Unchanged. | yes, the first decision |

Nothing crashed. No scenario run raised an exception, and the runner traced no failed event. Every
new failure entry uses the trace's existing `note` kind and its existing actors (`pipeline`,
`conditions`, `verifier`, `agent`), so the web Trace view shows them without a change. The
`photo.failed` and `photo.rejected` events are `mission.note` events with `data.failure` set. The
contract's event types are a closed list that the web app shares, so no new type was added.

## What changed (#142)

Each of the four findings in #140 is fixed in its own commit, each with a test that failed before
the fix and passes after it:

1. **A failed photo job no longer stalls the mission** (`sightline/mission/pipeline.py`).
   - A job that can't become a frame is recorded as `photo.failed`, with the reason, as an event and
     a trace note. Its original is kept under `frames/failed/`.
   - A ledger (`frames/jobs.json`) counts the jobs already handled. The next job is therefore in
     order, and it takes the next frame id, so frame ids stay contiguous as the contract requires.
     A frame's id can then be lower than its upload id.
   - Test: `tests/pipeline/test_photo_failures.py`.
2. **Repeated events reuse the proposal** (`sightline/agent/loop.py`).
   - A detection is verified once and promoted at most once.
   - A person confirmed again reuses the pending or approved alert.
   - The repeat is a trace note. After a rejection, a new confirmation proposes again.
   - Test: `tests/agent/test_loop_repeats.py`.
3. **The silent failures are traced.**
   - The client's retries: on the model call's entry, or in the failure note as "after N attempts".
   - Tavily being down: a conditions note.
   - A photo refused at upload, and a failed photo job.
   - Test: `tests/agent/test_failure_tracing.py`.
4. **What a down Token Factory costs is capped** (`sightline/agent/llm.py`, `runner.py`).
   - Circuit breaker: after 4 failed attempts in a row, across calls, every call fails fast with
     `CircuitOpen` for 60 s. One trial call then decides whether it closes. The breaker is logged,
     and the callers' fallback notes name it.
   - A timeout is retried once instead of three times.
   - The agent's calls use a 20 s per-attempt timeout. That is over 4× the slowest measured call:
     VL p90 1.65 s and max 2.19 s over 461 calls, and the radio's first call took up to 4.5 s
     (`docs/feedback/nebius.md`). Other callers keep 60 s; the conditions reader has no measured
     latency yet.
   - Fully down, the agent now pays 4 attempts in all, about 82 s, instead of 4 × 60 s on every call.
   - Test: `tests/agent/test_circuit_breaker.py`, including a check that the queue drains within
     that bound.

The eval itself was updated for the v2 planner (#135), as described under the clue check above.

`--live` was not run for this section: `NEBIUS_API_KEY` was not set. It has since been run once on the
creek scenarios ("Results (Nemotron, `--live`, ...)" above) and once on `relook`.
