# Agent evaluation

How well the agent turns evidence into proposals, whether anything takes effect without a person's
decision, and what it does when its dependencies fail. It backs `OPENCV_REPORT.md` §5 and §7.3.

```
uv run python scripts/agent_eval.py            # fake models, 3 runs per scenario, about 20 s
uv run python scripts/agent_eval.py --live     # Nemotron on Token Factory (needs NEBIUS_API_KEY)
```

Output: `runs/agent_eval/<timestamp>/agent_eval.md` (one table per section) and `agent_eval.json`.
Test: `tests/agent/test_agent_eval.py` runs the creek scenario once.

## Setup

The real mission API (`create_app`, `MissionStore`, the photo worker, lane B's pose reading, lane
C's live map and planner, the agent's `Runner` and hooks) runs under uvicorn on a local port, in the
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

  Every run then marks Drone 1's leg done and runs one agent tick. The manager rejects the first
  `assign_sector` from the tick, with a reason.
- **Fakes, by default.**
  - Detector: scripted from the scenario's truth. A photo that covers the person gets one box
    (0.80, or 0.20 in `near_miss_only`); other photos get none. This eval measures the agent. The
    detector is measured in §7.1.
  - VL model: answers "yes, a person".
  - Briefings: the facts, one sentence each.
  - Photos: synthetic images carrying the fleet sim's EXIF/XMP pose, or HERIDAL validation crops
    when `data/heridal` exists.

  `--live` swaps in Nemotron for the VL model and the briefings. The detector stays scripted.
- **Latency** with fake models is the agent's own overhead: queueing, the store, the planner, and
  writing the trace. Live, add the model time. §7.2 measured the VL verdict at p50 1.35 s and p90
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
`conditions`, `verifier`, `agent`), so the web Trace tab shows them without a change. The
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

`--live` was not run for this page: `NEBIUS_API_KEY` was not set.
