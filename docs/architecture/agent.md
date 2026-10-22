# The Sightline agent: Agentic Vision evidence

Sightline's agent turns what OpenCV 5 sees into proposals a person approves. This page holds the
evidence for the OpenCV **Agentic Vision Award**: the workflow, one real trace in which an
OpenCV 5 result changes a later decision, and how the agent is evaluated. Code: `sightline/agent/`
(lane A). Numbers: `docs/LANE_A_ML.md` §6.7–§6.8.

![Agent workflow: perception, decision, action, human approval, effect](agent.png)

Drawn by `docs/architecture/build_architecture.py` (figure 3 of `sightline-architecture.html`).

## The loop

| Step | What runs | Code |
|---|---|---|
| Perception | The detector, on OpenCV 5 `cv2.dnn` (parity with Torch: identical scores on test) | `sightline/ml/detect_cv.py`, `backend.py` |
| Second look | OpenCV 5 re-look tools chosen per failure mode: CLAHE for low contrast, a zoom from the original photo's native pixels for small people, the detector re-run on a native window and a 2× upscale for groups and people lying down | `sightline/agent/relook.py`, `verify.py` |
| Decision | Nemotron VL (Token Factory) answers from the crop and the re-look images in a JSON schema; lane C's information-gain planner proposes drone legs and team assignments | `verify.py`, `loop.py` |
| Action | A **proposal** with a reason, evidence and, for people in the field, a briefing written only from given facts: `promote_detection`, `drone_leg` / `retask_drone`, `assign_sector`, `alert` | `loop.py` |
| Human | The search manager approves, edits or rejects; nothing happens before that | lane E inbox, lane D API |
| Effect | Approved detections join the review queue; approved legs go to the fleet; approved briefings go to the radio | lane D |

## One real chain: an OpenCV 5 result changes the decision

A **val** photo (`train_ZRI_2061`, HERIDAL; never used for training). The detector scored a person
lying on the ground **0.18**, below the 0.29 review threshold, so without the agent no reviewer
would ever see it. The re-look tool was chosen by heuristic (box 21 px in the 1000×750 frame:
small), and the zoom from the original photo's native pixels is what the VL model answered from.

| The review crop (from the 1000×750 frame) | OpenCV 5 `zoom_native` (from the 4000×3000 original) |
|---|---|
| ![crop](av-chain/crop.jpg) | ![zoom](av-chain/zoom_native.jpg) |

`scripts/trace_excerpt.py` prints the chain from the mission's `trace.jsonl` (`av-chain/trace.jsonl`):

```text
2026-10-21T00:33:23.627Z  pipeline note       detection f0001-d01 in train_ZRI_2061: confidence 0.179, below the 0.29 review threshold, so it is not in the review queue (near-miss)
2026-10-21T00:33:24.502Z  verifier tool_call  zoom_native on f0001-d01
    image: relook/f0001-d01-zoom_native.jpg  (0 ms)
    why this tool (heuristics): box 21 px, aspect 1.00, grey spread 32.2
2026-10-21T00:33:25.917Z  verifier model_call VL verdict for f0001-d01
    model nvidia/Nemotron-3.5-Super-VL · 1414 ms · 809 tokens in, 61 out · prompt verify-v2
    images sent: ['relook/f0001-d01-crop.jpg', 'relook/f0001-d01-zoom_native.jpg']
    reply: {"person": "yes", "posture": "lying", "group_size": 1, "clothing": "white top, dark pants", "reason": "A human shape with a head, torso, and limbs is visible lying on the ground."}
2026-10-21T00:33:25.918Z  verifier verdict    f0001-d01: person yes
    person yes · posture lying · group 1 · clothing white top, dark pants
    reason: A human shape with a head, torso, and limbs is visible lying on the ground.
2026-10-21T00:33:25.918Z  agent    proposal   p001 promote_detection: Add f0001-d01 to the review queue: second look says likely a person
    target {'detection': 'f0001-d01'}
    reason: Detector confidence 0.18 is below the review threshold 0.29; the second look (zoom_native) says: A human shape with a head, torso, and limbs is visible lying on the ground.
2026-10-21T00:33:25.928Z  human    decision   p001 approved by Search manager (scripted approval for this demo run)
    {'proposal': 'p001', 'status': 'approved', 'by': 'Search manager (scripted approval for this demo run)'}
```

Reproduce: `uv run --extra ml python scripts/av_chain.py`, then the `trace_excerpt.py` command it
prints. Disclosures: the photo is from val and was picked from the verifier's val results as a
near-miss person it called `yes`; the mission is built in memory by the script in the same shape
as lane D's pipeline (the `pipeline` line is written by the script); and the approval is
**scripted** for this run and says so in the trace. Everything else is the production code path
(`loop.handle`, `verify`, the OpenCV tools, Token Factory).

## End to end on a live mission

`scripts/agent_live.py` runs the agent on the real system: the mission API, OpenCV 5 `cv2.dnn`, lane C's live map,
the mission store, and Nemotron on Token Factory. It uploads six HERIDAL **validation** photos from one site and
acts as the search would: a reviewer answers "person", a clue comes in, a scripted search manager approves one
proposal (labelled in the trace). The fleet is two **simulated** drones until lane C's fleet sim lands.

Run of 2026-10-21 (`runs/agent_live/`): 9 candidates from 6 photos; the second look on all 9 (OpenCV re-look tools:
`zoom_native` on all 9, `enhance_contrast` on 2, `redetect_region` on 1); a confirmed person led to an `alert` to all
teams and an `assign_sector` for the nearest team on standby (approved: the task and the team became "assigned"); the
clue reweighted the map and led to a `drone_leg` from the planner (still the stub, and its reason says so).
12 model calls, about 8.5k tokens in. `validate_mission` passed after every step.

Two problems this run found, both fixed:

- **A briefing told teams to stand down.** Asked to add "no orders", Nemotron ended an alert for a confirmed sighting
  with "No further action is needed." Briefings saying a team should stop or that nothing is needed are now rejected
  in code (one retry, then the facts-only template), and the prompt says to state the facts and stop. A run-on
  without punctuation is rejected too: briefings are read aloud on the radio.
- **Briefing model calls were not in the trace.** Every attempt is now a `model_call` entry (facts in, text and
  tokens out, why it was rejected), and a fallback to the template is a `note`.

## Evaluation

**Task success.** On val (95 photos, 333 people) the second look on near-misses finds 11 more
people with prompt v1 and 9 with v2; on test, scored once with v2 and the rule fixed beforehand,
it finds 4 more of 337 (recall 0.864 → 0.875, 95 % CI of the gain [+0.003, +0.023]) for 15 more
false alarms to dismiss (precision 0.802 → 0.772). It is weakest on the smallest people: on boxes
under 60 px it mostly answers `unclear` rather than guess. Full tables: `docs/LANE_A_ML.md` §6.8.

**Failure handling.** Invalid JSON from the model gets one retry, then a verdict of `unclear`
that says why (none were needed in 461 calls: 170 val with v1, 170 val with v2, 121 test). A timeout, HTTP error or missing
key gives `unclear` naming the error, and no proposal. Without a model client the agent still
makes planner proposals with template briefings. A briefing that is over 60 words, says
"clear", or contains a number not in its facts is rewritten once, then replaced by the template.
A per-mission token budget stops model calls with one `mission.note`. One failing event is
logged and traced and never stops the agent or the pipeline (hooks only enqueue, < 5 ms).

**Observability.** Every tool call (image path, time, the heuristics that chose it), model call
(model, prompt version, ms, tokens, reply), verdict, proposal and decision is one line of
`trace.jsonl`. Images are stored by path, never base64; API keys are redacted (tested).

**Human control.** The agent only proposes. It never dismisses a detection (no
`dismiss_detection` in v1), never writes the fleet, and never transmits: approved briefings are
sent by the radio operator. A newer leg proposal for a drone supersedes the older pending one; a
team has at most one pending assignment. Every decision records who and when (contract §12.3-5,
checked by lane D's `validate_mission`).

**Tests** (no network, no keys): `tests/agent/` — verifier (LANE_A test 4), loop per trigger,
no dismissals, superseding, briefing checks, budget (test 5), hooks under 5 ms (test 6), no
secrets in the trace (test 7).
