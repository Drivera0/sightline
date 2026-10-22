# Lane A · Sprint 2: OpenCV detector path, second look and agent

> Superseded by [`docs/LANE_A_ML.md`](../LANE_A_ML.md) §6.7–§6.8 (the `cv2.dnn` runtime and the
> verifier) and [`docs/architecture/agent.md`](../architecture/agent.md) (the agent, with real traces).
> This file keeps the sprint plan and each task's outcome.

**Folders:** `sightline/ml/`, `sightline/agent/`, ML, agent and eval `scripts/`, `tests/ml/`,
`tests/agent/`, `deploy/nebius/`, `web/src/metrics/`, `web/src/detect/`, `docs/architecture/`,
`docs/feedback/` (except `radio.md`).

## 1. Mission

1. **Run the detector on OpenCV 5** (`cv2.dnn`), with a parity table against the Torch path.
2. **Give Sightline a second look:** when the detector is unsure, OpenCV re-looks at the crop
   (contrast, native-resolution zoom, re-detection) and a Nemotron vision model gives a verdict.
   Tuned on val, scored once on test.
3. **Run the agent:** one loop that turns verdicts, the planner's legs, clues and conditions into
   proposals a person approves, every step in the trace.

Plus the shared Token Factory client and trace helpers other lanes call, the Nebius Serverless Job, and
assembling the reports.

## 2. Design decisions

- **Backend switch.** `make_detector()` returns the `cv2.dnn` detector when `SIGHTLINE_BACKEND` is `cv2`
  (the default) and Torch when it is `torch`. `detect_cv.py` is a line-for-line port of
  `web/src/detect/tiling.ts`, which already matched the Torch detector; where Python and TS disagree,
  TS is the reference. The pipeline always calls `detect_tiled` on full-size photos.
- **Fallback, prepared and not needed:** if the ONNX had not run in `cv2.dnn`, Torch would have kept
  inference and OpenCV would have owned slicing, letterbox, NMS and the re-look tools.
- **Which detections get a second look:**

  | Case | Outcome |
  |---|---|
  | conf ≥ 0.29 (in the review queue) | a verdict shown as a badge with notes; never removed from the queue |
  | 0.15 ≤ conf < 0.29 (near-miss) | `promote_detection` proposal when the verdict is "person" |
  | reviewer answered "unsure" | a verdict beside the crop; nothing automatic |

- **No automatic dismissals.** The agent never proposes `dismiss_detection`: a missed person costs far
  more than a false alarm a reviewer dismisses in seconds.
- **Re-look tool per failure mode** (from `DETECTOR_LIMITS.md`): low contrast → `enhance_contrast`
  (CLAHE on L); person under about 40 px → `zoom_native` from the original photo; possible group or
  lying person → `redetect_region` (native window and a 2× upscaled pass).
- **Verifier prompt:** answer only from what is visible, return JSON to a schema, use `unclear` when
  unsure, never guess clothing; temperature 0; invalid JSON gets one retry, then `unclear`.
- **Briefings** are written only from the facts given, at most 60 words, without coordinates (the card
  carries them); a post-check rejects any number not in the facts and the forbidden area wording.
- **Trace:** every model and tool call, with image paths, never base64 or keys. A per-mission token
  budget stops model calls with a `mission.note`; at most 4 model calls at once.

## 3. Work items

| ID | Task | Outcome |
|---|---|---|
| A-X1 | `cv2.dnn` smoke test on the weights-v2 ONNX | Done: matches Ultralytics + SAHI on 12 val photos (19/19 boxes, max confidence difference 0.0012) |
| A-X2 | `sightline/ml/detect_cv.py` tiled path, `sightline/ml/backend.py` | Done #7, #10, #14, #20 |
| A-X3 | Parity table, val and test | Done #13 (`scripts/parity_table.py`): identical scores, 363/363 boxes at IoU ≥ 0.95; 1.9 s per photo on CPU |
| A-L1 | `ChatClient`, `token_factory_client()`, `FakeChatClient` | Done #7, #12 (`sightline/agent/llm.py`) |
| A-T1 | `trace_call`, `trim` | Done #7 (`sightline/agent/trace.py`) |
| A-H1 | `hooks.py`, stubs first | Done #7; real behaviour in #17 |
| A-V1 | Re-look tools | Done #11 (`sightline/agent/relook.py`) |
| A-V2 | Verifier, val tuning, one test score | Done #15, #16: recall 0.864 → 0.875 on test (+4 of 337) for 15 more false alarms; 461/461 valid JSON |
| A-G1 | Agent loop | Done #17, #66 (`sightline/agent/loop.py`, `runner.py`) |
| A-G2 | Workflow diagram, trace excerpt | Done #18, #68 (`docs/architecture/agent.png`, `scripts/trace_excerpt.py`, the re-task chain) |
| A-N1 | Nebius Serverless Job | Done #92, #97: 711 photos in 483 s on 16 vCPUs, about $0.10 |
| A-N2 | README "Built with NVIDIA + Nebius", feedback report | Done #19, #22, #29 (`docs/feedback/nebius.md`) |
| — | OpenCV report | Done #21 and later passes (`docs/report/OPENCV_REPORT.md`) |
| — | Submissions and tags | Deferred to Oct 26 and Oct 30 |

Built beyond the plan: an agent evaluation (#140, `docs/report/AGENT_EVAL.md`), INT8 and CUDA
experiments for `cv2.dnn` (#143, #146), a `cv2.dnn`-only reproduction of the test table (#136,
`scripts/reproduce_cv2.py`), and a large share of lane E's screens.

## 4. Tests

`tests/ml/` and `tests/agent/` pass with no GPU, no network and no API keys: the ported `tiling.test.ts`
cases, backend choice, re-look geometry, verifier retry to `unclear`, each trigger's proposal kinds,
superseding, briefing post-checks, hooks returning in under 5 ms, and no key in any trace.

## 5. Cut order

From the bottom: trace excerpt polish · Serverless Job (fallback: batch on the GPU desktop) ·
conditions-triggered proposals · verifier badges on queue items · alert on a confirmed sighting ·
`assign_sector` and briefings · `promote_detection` and drone legs · verifier on near-misses · shared
plumbing (never) · `cv2.dnn` path (never). Nothing was cut.
