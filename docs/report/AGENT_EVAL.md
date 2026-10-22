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
| clue → drone_leg | 9 | 117 | 130 |
| detection → promote_detection (incl. second look) | 3 | 9 | 10 |
| verdict → promote_detection | 3 | 1 | 2 |
| review → alert | 9 | 42 | 48 |
| review → assign_sector | 9 | 46 | 51 |
| leg done → drone_leg | 12 | 49 | 54 |
| tick → assign_sector | 39 | 50 | 60 |

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
- Leg approvals in the event log come after their decisions.
- Every approval and rejection records who made it and when, and is made by a person. The agent
  only ever supersedes its own proposals.
- Every rejection has a reason.
- No proposal or verdict says "clear" or "cleared".
- `validate_mission` passes.

## Failure handling (injected)

The Token Factory cases run the real `TokenFactoryClient` over a stand-in for the `openai` SDK
object, so the client's own retry and parsing code is what gets tested. Tavily is replaced through
`sightline.geo.conditions._tavily`. No agent file was changed.

| Case | What the loop did | In the trace |
|---|---|---|
| Token Factory timeout, every attempt | Made 3 retries per call (backoff 1, 2, 4 s), then fell back. The verdict is `unclear`, naming `APITimeoutError`, and no promotion is made. Both briefings use the template. | yes: a note per failure |
| 503 on the first two attempts, then OK | Retried and recovered: verdict `yes`, the promotion is made, and the briefings come from the model. | partly: the 4 retries are not traced |
| 503 on every attempt | The same as the timeout case, naming `InternalServerError`. | yes |
| Malformed JSON (verdict and briefing) | One retry, then fell back. The verdict is `unclear` ("not valid JSON after one retry"), and the briefings use the template. | yes: both model calls, the rejection reason, the fallback |
| Malformed once, then valid | Recovered on the retry: verdict `yes`, the promotion is made. | yes |
| Tavily down | Fell back. `POST /conditions/refresh` returned 200 with stale conditions: "no conditions data (offline: ConnectionError)", `flyable` unknown. The agent made no proposal. | **no**: only an event and a log warning |
| Photo with no GPS, via the API | Rejected at upload with the reason, and nothing was queued. | no (the upload response names the reason) |
| Photo with no GPS that reaches the worker | The job failed and was logged. **The next good photo was not processed either** ("f0002 arrived as frame 1: jobs out of order"). | no |
| The same clue delivered twice | The second re-plan superseded the first proposal, leaving one pending. | yes (the superseding is an event, not a trace entry) |
| The same near-miss detection delivered twice | **2 verdicts and 2 pending `promote_detection` proposals for one detection** | yes; nothing marks it as a repeat |
| The same review posted twice | **2 `alert` proposals.** The `assign_sector` was deduplicated. | yes |
| The same photo job delivered twice (SQS) | Skipped as already processed. | no |
| The same proposal approved twice | The second approval was refused with 409, and the leg is in the fleet once. | yes, the first decision |

Nothing crashed. No scenario run raised an exception, and the runner traced no failed event.

## Findings for the code owners

These were reported, not patched here:

1. **A failed photo job stalls the mission's photos** (`sightline/mission/pipeline.py`, lane D).
   Frame ids are given out at upload. If a queued job fails anywhere except the detector, every
   later job fails the order check. The upload's GPS check keeps a no-GPS photo out, but any other
   failure in `ingest_photo` would stall the mission the same way.
2. **Duplicate events give duplicate proposals** (`sightline/agent/loop.py`):
   - A repeated `detection` event makes a second verdict and a second `promote_detection`.
   - A repeated `person` review makes a second `alert`.

   A pending proposal of the same kind for the same target could be reused, as `_assign` already
   does for teams.
3. **Some failures are not in the trace.**
   - The client's retries (`sightline/agent/llm.py`).
   - Tavily being down: the conditions fall back silently (`sightline/geo/conditions.py`, lane B).
   - A failed photo job, and a photo rejected at upload.
4. **Live: a fully down Token Factory costs about 4 minutes per model call.** This is a calculation,
   not a measurement: 4 attempts × the 60 s timeout, plus 7 s of backoff. The agent has a single
   worker thread, so the queue backs up behind those calls. The fallbacks still hold.

`--live` was not run for this page: `NEBIUS_API_KEY` was not set.
