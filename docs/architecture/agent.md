# The Sightline agent: Agentic Vision evidence

Sightline's agent turns what OpenCV 5 sees into proposals a person approves. This page holds the
evidence for the OpenCV **Agentic Vision Award**: the workflow, one real trace in which an
OpenCV 5 result changes a later decision, and how the agent is evaluated. Code: `sightline/agent/`
(lane A). Numbers: `docs/LANE_A_ML.md` §6.7–§6.8.

![Agent workflow: perception, decision, action, human approval, effect](agent.png)

Drawn by `docs/architecture/build_architecture.py` (figure 3 of `sightline-architecture.html`).

## The workflow: perception → decision → action → human → effect

```mermaid
flowchart LR
  subgraph PER["Perception (OpenCV 5)"]
    photo["Drone photo<br/>4000×3000"]
    det["cv2.dnn detector<br/>YOLO11s ONNX, 20 tiles"]
    relook["OpenCV re-look tools<br/>zoom_native · CLAHE · redetect_region"]
  end
  subgraph DEC["Decision"]
    pick["Tool choice<br/>box size, contrast, shape"]
    vl["Nemotron VL verdict<br/>JSON: person, posture, reason"]
    map["Probability map<br/>every photo, review, clue"]
    planner["Information-gain planner"]
    cond["Conditions<br/>Tavily + Nemotron Nano"]
  end
  subgraph ACT["Action"]
    prop["Proposal with reason<br/>promote · drone_leg · retask · assign · alert"]
  end
  gate{"Search manager<br/>approves?"}
  subgraph EFF["Effect"]
    queue["Review queue"]
    leg["Drone leg / re-task"]
    radio["Radio briefing<br/>sent by the operator"]
  end
  logged["Rejected or edited:<br/>logged, nothing happens"]

  photo --> det
  det -- "near-miss 0.15–0.29<br/>or uncertain" --> pick
  pick -- "re-look: ask OpenCV<br/>for a better view" --> relook
  relook -- "re-look images" --> vl
  relook -. "redetect_region re-runs" .-> det
  det --> map
  cond --> planner
  map --> planner
  vl --> prop
  planner --> prop
  prop --> gate
  gate -- "approve" --> queue
  gate -- "approve" --> leg
  gate -- "approve" --> radio
  gate -- "reject / edit" --> logged
  leg -. "new photos" .-> photo
```

The re-look is the back-edge from decision to perception: when the detector is unsure, the verifier
chooses an OpenCV tool for that failure mode (`sightline/agent/verify.py:86-100`), the tool goes back
to the photo's native pixels (`sightline/agent/relook.py:81-170`), and the model decides from what
OpenCV produced. Every arrow out of the diamond needs a person: the agent never acts on its own
(`sightline/api/missions.py:441-442`, `POST /missions/{id}/proposals/{pid}/decide`).

## The showcase chain as a sequence

The first chain below (`av-chain/trace.jsonl`), and what an approval leads to on a live mission
(the second chain, `scripts/retask_chain.py`):

```mermaid
sequenceDiagram
  autonumber
  actor Operator as Search manager
  participant Agent as Agent (sightline/agent)
  participant Detector as Detector (OpenCV 5 cv2.dnn)
  participant Tools as OpenCV re-look tools
  participant VL as Nemotron VL (Token Factory)
  participant Map as Map + planner
  participant Radio as Radio desk

  Detector->>Agent: f0001-d01 scored 0.179, below the 0.29 review threshold (near-miss)
  Agent->>Tools: zoom_native (box 21 px, aspect 1.00, grey spread 32.2)
  Tools-->>Agent: relook/f0001-d01-zoom_native.jpg (native 4000×3000 pixels)
  Agent->>VL: crop + zoom, prompt verify-v2
  VL-->>Agent: {"person": "yes", "posture": "lying", ...} in 1414 ms
  Agent->>Operator: proposal p001 promote_detection, with the reason
  Operator->>Agent: approve (scripted in this recording)
  Agent->>Map: f0001-d01 joins the review queue
  Note over Operator,Radio: On a live mission (second chain): a reviewer confirms a person, the sighting is logged as a clue
  Map->>Agent: the clue reweights the map, and the planner picks sector B3 for Drone 1
  Agent->>Operator: proposal p004 retask_drone, "3.1% expected in 12 min"
  Operator->>Agent: approve (scripted in this recording)
  Agent->>Radio: briefing written from facts only, transmitted only when the operator presses Transmit
```

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

The same six trace lines as a table (every value from `av-chain/trace.jsonl`, line n = span n):

| Span | Tool / model | Input (summary) | Output (summary) | ms | What it changed next |
|---|---|---|---|---|---|
| 1 `pipeline` note | the detector, OpenCV 5 `cv2.dnn` | photo `train_ZRI_2061`, box (1900, 2633)–(1982, 2717) in the original | confidence 0.179, below the 0.29 threshold: not in the review queue (near-miss) | — | the near-miss triggers the second look; without it no reviewer would see this person |
| 2 `verifier` tool_call | `zoom_native` (OpenCV 5, `relook.py:91`) | the box; heuristics: 21 px long side, aspect 1.00, grey spread 32.2 | `relook/f0001-d01-zoom_native.jpg`, cut from native pixels | 0 | the small box chose the zoom; the zoom is the image the model answers from |
| 3 `verifier` model_call | `nvidia/Nemotron-3.5-Super-VL`, prompt `verify-v2` | the review crop + the native zoom; 809 tokens in | `person: yes, posture: lying, group 1, white top, dark pants`; 61 tokens out | 1414 | a `yes` on a near-miss is the condition for a promotion |
| 4 `verifier` verdict | — | — | verdict `v0001`: person yes, tool `zoom_native` | 1488 (tool + model) | the verdict is stored on the detection and handed to the agent loop |
| 5 `agent` proposal | `loop.py:413` (`_on_detection`) | verdict `v0001` | `p001 promote_detection`, reason: "confidence 0.18 is below the review threshold 0.29; the second look (zoom_native) says…" | — | a pending proposal in the approval inbox; nothing changes until a person decides |
| 6 `human` decision | — | `p001` | approved, by "Search manager (scripted approval for this demo run)" | — | the detection joins the review queue |

**The approval in this showcase run was scripted**, and the trace says so in its own words (span 6).
When the video is recorded, the chain is run again with a real person approving in the inbox, and that
trace replaces this one (Dan's item). The second chain's human steps are scripted too, also labelled.

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
clue reweighted the map and led to a `drone_leg` from the planner (on 21 Oct still a stand-in, and its reason said so; the information-gain planner, C-P1, replaced it the next day and drives the re-task chain below).
12 model calls, about 8.5k tokens in. `validate_mission` passed after every step.

Two problems this run found, both fixed:

- **A briefing told teams to stand down.** Asked to add "no orders", Nemotron ended an alert for a confirmed sighting
  with "No further action is needed." Briefings saying a team should stop or that nothing is needed are now rejected
  in code (one retry, then the facts-only template), and the prompt says to state the facts and stop. A run-on
  without punctuation is rejected too: briefings are read aloud on the radio.
- **Briefing model calls were not in the trace.** Every attempt is now a `model_call` entry (facts in, text and
  tokens out, why it was rejected), and a fallback to the template is a `note`.

## A second chain: a VL sighting re-tasks a flying drone

`scripts/retask_chain.py` (live mission, real planner; the fleet is simulated and the human steps are scripted, as
the trace says). Excerpt (`scripts/trace_excerpt.py --proposal p004`):

```text
2026-10-22T01:48:41.458Z  verifier tool_call  zoom_native on f0005-d01
    image: relook/f0005-d01-zoom_native.jpg  (1 ms)
    why this tool (heuristics): box 20 px, aspect 1.33, grey spread 25.5
2026-10-22T01:48:42.772Z  verifier model_call VL verdict for f0005-d01
    model nvidia/Nemotron-3.5-Super-VL · 1312 ms · 809 tokens in, 63 out · prompt verify-v2
    images sent: ['crops/f0005-d01.jpg', 'relook/f0005-d01-zoom_native.jpg']
    reply: {"person": "yes", "posture": "sitting", "group_size": 1, "clothing": "blue jacket, dark head covering", "reason": "A human shape with a head, torso, and raised arms is visible at the centre."}
2026-10-22T01:48:42.774Z  verifier verdict    f0005-d01: person yes
    person yes · posture sitting · group 1 · clothing blue jacket, dark head covering
    reason: A human shape with a head, torso, and raised arms is visible at the centre.
2026-10-22T01:49:08.722Z  human    decision   Reviewer (scripted for this run): f0005-d01 is a person
    {'answer': 'person'}
2026-10-22T01:49:09.673Z  agent    model_call briefing
    model nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B · 949 ms · 203 tokens in, 57 out · prompt None
    images sent: None
    reply: Team, a reviewer confirmed a person in a drone photo. The subject is an adult hiker. The person is wearing a blue jacket and a dark head covering. The posture is sitting. The photo is from sector B3. The photo identifier is f0005.
2026-10-22T01:49:34.480Z  human    note       Search manager (scripted for this run): logged the sighting as clue c001 (100 m, the default for a sighting)
2026-10-22T01:49:34.492Z  agent    proposal   p004 retask_drone: Re-task Drone 1 to sector B3 (3.1% expected)
    target {'drone': 'D1', 'leg': 'L002'}
    reason: After clue c001 (sighting, high reliability: person in photo f0005, confirmed by the reviewer) in sector B3, which now holds 6.9% of the probability. Sector B3: expected to rule out 3.1% of the probability in 12 min (0.26%/min) — 1.1× the next best for Drone 1 (sector B2). Within battery (95%).
2026-10-22T01:50:00.642Z  human    decision   p004 approved by Search manager (scripted approval for this run)
    {'proposal': 'p004'}
```

After the approval: Drone 1's leg L001 (sector A1) `cancelled`, L002 (sector B3) `approved`; `validate_mission` → `[]`.

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

## The Agentic Vision rubric, line by line

- **Substantive OpenCV 5 and agent integration (30 %).** The detector the agent reacts to is OpenCV 5
  `cv2.dnn`, with identical scores to PyTorch on test and 363 of 363 boxes matched
  (`docs/report/OPENCV_REPORT.md:139-148`). The re-look tools are OpenCV 5 (`sightline/agent/relook.py`,
  report §3.5), and the model answers from OpenCV's images, so the visual evidence changes what the
  system does next: a 0.18 near-miss becomes a review-queue proposal (span 1 → span 5 above).
- **Orchestration and appropriate autonomy (25 %).** Events go through hooks that only enqueue
  (`sightline/agent/hooks.py:36-72`) to one loop (`sightline/agent/loop.py:615`, `handle`) that turns
  each into proposals. Models are used where they add information (vision verdicts, briefings,
  conditions, radio); the planner and code decide the rest. Autonomy stops at the proposal: the
  diamond in the workflow diagram, enforced by the API (`sightline/api/missions.py:441`).
- **Task effectiveness and evaluation (20 %).** On test the second look finds 4 more of 337 people
  (recall 0.864 → 0.875, 95 % CI of the gain [+0.003, +0.023]) for 15 more false alarms; F2 does not
  change clearly (`docs/report/OPENCV_REPORT.md:464-466`). On the whole system, the agent evaluation
  (`scripts/agent_eval.py`, `docs/report/AGENT_EVAL.md`) sends the drone, the alert, the team and the
  promotion to the person's sector or detection in every run (6/6, 9/9, 9/9, 3/3), with fake models and
  a scripted detector, so it tests routing rather than perception. Planner and fleet are evaluated in
  simulation, with the flat-prior result stated as no gain (`docs/report/OPENCV_REPORT.md:589-656`).
  Rules are chosen on val and test is read once.
- **Failure handling, observability, security, human control (15 %).** The four paragraphs under
  Evaluation above, with their tests in `tests/agent/` (for example
  `test_loop.py::test_never_dismisses_and_never_says_clear`,
  `test_loop.py::test_budget_stops_model_calls_and_notes_it_once`, `test_trace.py`). Every span is in
  `trace.jsonl` with model, ms and tokens; keys are redacted. Injected failures (Token Factory down or
  slow, malformed replies, Tavily down, a photo with no GPS, repeated events) are handled and traced, and
  the approval-gate checks pass in 12 of 12 runs (`docs/report/AGENT_EVAL.md`).
- **UX, documentation, demonstration (10 %).** The approval inbox and command view
  (`docs/architecture/screens/approval-inbox.png`), this page, report §5 and two reproducible chains
  (`scripts/av_chain.py`, `scripts/retask_chain.py`). The Trace tab shows each chain in the product
  (`#m/<id>/trace`, `web/src/command/TraceView.tsx`; `#m/demo/trace` without a server). The gap we know
  about: the recorded approvals are scripted until the video run.
