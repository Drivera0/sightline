# Sightline: the brain of a drone search

**OpenCV AI Competition 2026 · technical report · DRAFT (freeze Sat Oct 25, 12:00)**

> **Status of this draft.** Lane A sections are written from committed results. Sections marked
> **TODO (lane X)** need that lane's numbers or screenshots by Saturday 12:00; each says exactly
> what is needed. Every number must come from a file in the repo or a cited source; anything
> simulated is labelled simulated. Lead: Dan (lane A).

Repository: https://github.com/Drivera0/sightline (tag `opencv-submit`) · Live demo:
https://sightline-iota-sandy.vercel.app · **TODO (lane D):** AWS endpoint URL.

---

## 1. Problem and users

When a hiker goes missing, search-and-rescue teams fly drones over the search area and come back
with hundreds of photos. A person is about 70 px wide in a 4000×3000 photo; a volunteer reviewing
them by eye takes about 33 s per photo (Pyrrö, Naseri & Jung 2021), so 500 photos is over four
hours, and humans in that study found 68 % of the people. Meanwhile the search manager has to
decide where to send drones and ground teams next.

Sightline is the brain of that search: **one brain, many eyes, every channel.** Drones and ground
teams feed one probability map, and the map directs both, on screen at the command post and by
voice over the radio. It assists searchers and **never declares an area clear**.

| User | Question | Where Sightline answers it |
|---|---|---|
| Search manager | Where do I send drones and teams next, and why? | Command view: map, proposals with reasons, approvals |
| Image reviewer | Show me the likeliest person first. | Review queue, with a second look on uncertain crops |
| Ground team leader | Where do I go, what am I looking for, what changed? | Assignment card, GPX, radio |

**TODO (lane E):** one screenshot each of the front door, the command view and the approval inbox.

## 2. What is new since BCS Hackathon 2026 (disclosure)

Sightline was first built in 36 hours at BCS Hackathon 2026 (Oct 16–17, tag `bcs-final-submission`):
the tiled detector, the review queue and the Bayesian search map, run as a batch over a demo survey.
The OpenCV organizers confirmed the existing project is eligible. Built for this competition, Oct 20–26:

- the detector running on **OpenCV 5 `cv2.dnn`**, with a parity table against the Torch path (§4.1);
- **OpenCV 5 re-look tools** and a Nemotron VL second look on uncertain detections (§4.2, §5);
- the **agent loop**: verdicts, planner legs, clues and conditions become proposals a person
  approves, every step traced (§5);
- live missions: photos uploaded one at a time, processed as they arrive (**TODO (lane D)**);
- the AWS deployment (§6, **TODO (lane D)**);
- the command view and front door (**TODO (lane E)**), the information-gain planner (**TODO (lane C)**),
  conditions from live web search (**TODO (lane B)**).

Diff: `git diff bcs-final-submission..opencv-submit`.

## 3. Architecture

![System](../architecture/system.png)

**TODO (lane D):** replace with the live-mission architecture once the mission API is merged
(photos → `POST /missions/{id}/photos` → per-photo pipeline → MissionStore → SSE → web), and add
where AWS sits.

![Agent workflow](../architecture/agent.png)

The agent workflow (figure 3 in `docs/architecture/sightline-architecture.html`): perception
(detector on `cv2.dnn`) → OpenCV 5 re-look → decision (Nemotron VL verdict; the planner's legs) →
action (a proposal) → human approval → effect, with every step in the trace and new photos and
field reports starting the loop again.

## 4. OpenCV 5 implementation

### 4.1 The detector on `cv2.dnn`

The detector is YOLO11s fine-tuned on 1024 px tiles of HERIDAL drone photos (weights-v2; training
and ablations in `scripts/README.md`). For this competition it runs on **OpenCV 5.0 `cv2.dnn`**
from its ONNX export, with no PyTorch at run time (`sightline/ml/detect_cv.py`):

- **Tiling:** each 4000×3000 photo is cut into 20 overlapping 1024 px slices (SAHI's slice loop,
  20 % overlap), each letterboxed onto the model input, run through `net.forward()`, decoded, and
  suppressed per slice with `cv2.dnn.NMSBoxes`; the slices are merged with NMS at IoU 0.5 and
  boxes are rounded and clipped like the Torch path. The port follows the browser copy in
  `web/src/detect/tiling.ts` line for line, with its tests ported (`tests/ml/test_detect_cv.py`).
- **Frames smaller than the input:** Ultralytics pads a 1000×750 frame only to a multiple of 32
  (1024×768). A fixed-size ONNX needs the full 1024×1024 square, and the grey bands changed boxes
  near the frame's top and bottom edges. We export a variable-size ONNX (`scripts/export_onnx.py`);
  `CvDetector` detects that it accepts non-square input and pads the same way.
- **Backend switch:** `SIGHTLINE_BACKEND=cv2` (default) or `torch` through
  `sightline.ml.backend.make_detector()`, which the demo-cache build (`run_survey`) uses; the
  Nebius batch job runs `CvDetector` directly. **TODO (lane D):** confirm the live pipeline and
  the AWS worker build their detector with `make_detector()` (issue #8).

**Parity** (`scripts/parity_table.py`; the same weights, the same photos, the frozen threshold
0.29, the same scoring code; test read once, only to check agreement):

| Split | Backend | Device | VOC P / R / AP50 | SAR P / R | s per 4000×3000 photo |
|---|---|---|---|---|---|
| val (95 photos) | Torch (Ultralytics + SAHI) | RTX 4080 SUPER | 0.735 / 0.859 / 0.861 | 0.887 / 0.922 | 0.33 |
| val | **OpenCV 5 cv2.dnn** | Ryzen 9 9950X, 32 threads | 0.735 / 0.859 / 0.861 | 0.887 / 0.922 | 1.91 |
| test (101 photos, 337 people) | Torch | RTX 4080 SUPER | 0.802 / 0.864 / 0.868 | 0.898 / 0.896 | 0.30 |
| test | **OpenCV 5 cv2.dnn** | Ryzen 9 9950X | **0.802 / 0.864 / 0.868** | **0.898 / 0.896** | — |

Every score is identical to three decimals. At or above the threshold, 100 % of boxes match
one-to-one between backends at IoU ≥ 0.95 (363/363 on test, 389/389 on val), with a largest
confidence difference of 0.0015. Among all saved boxes (confidence ≥ 0.05) 99.8 % match; the rest
are low-confidence boxes that move slightly. **The demo cache re-detected on the cv2 path is
identical to the published one**: the same 36 boxes on 500 frames to the pixel, confidences to
three decimals, the same 14 review crops.

**Speed.** The pip OpenCV wheels have no CUDA, so `cv2.dnn` runs on the CPU: 1.9 s per full photo
(about 0.1 s per 1024 px slice) and 0.1 s per 1000×750 demo frame on a 16-core desktop. Engine
choice, measured per slice: OpenCV 5's default (new) engine 96 ms; the classic engine 105 ms (and
outputs differ by up to 0.003); classic with the FP16 CPU target 118 ms; the ONNX Runtime engine
inside OpenCV 99 ms; batching 4 slices 84 ms (not adopted). One pitfall worth sharing:
**importing `ultralytics` calls `cv2.setNumThreads(0)`**, which made `cv2.dnn` single-threaded and
5× slower in any process that also loads Torch; `CvDetector` now keeps and restores its own
thread count.

### 4.2 OpenCV 5 re-look tools

When the detector is unsure, OpenCV gives the next model a better look (`sightline/agent/relook.py`).
One tool per failure mode from our error analysis (`docs/DETECTOR_LIMITS.md`):

| Failure mode | Tool | OpenCV |
|---|---|---|
| Clothing that matches the ground (white on limestone, dark on dark rock) | `enhance_contrast` | CLAHE on the L channel in LAB, then a light unsharp mask (`cv2.createCLAHE`, `GaussianBlur`, `addWeighted`) |
| A person too small to read in the 1000×750 frame | `zoom_native` | a square around the box cut from the **original** photo's native pixels, `INTER_CUBIC` up to 384 px |
| Groups, people sitting or lying down | `redetect_region` | the `cv2.dnn` detector again on a 1024 px native window and on its centre upscaled 2×, boxes drawn back (`cv2.rectangle`) |

The tool is chosen per detection by labelled heuristics (box size, grey-level spread, box shape;
`sightline/agent/verify.py: choose_tools`). Tests: CLAHE keeps shape and type and raises local
contrast on a low-contrast fixture; the zoom reads the right native pixels for a frame downscaled
4× (`tests/agent/test_relook.py`).

### 4.3 OpenCV elsewhere

**TODO (lane C, lane B):** the search map's canopy and coverage use OpenCV (`cv2.blur` in
`sightline/search/canopy.py`, `cv2.fillPoly` in `sightline/search/pod.py`); add any new uses
(sector rasterisation, footprints) with one line each.

## 5. The agent (Agentic Vision)

Full evidence: `docs/architecture/agent.md`. Summary:

**The loop** (`sightline/agent/loop.py`). Each event produces **proposals a person approves**; the
agent never acts and never dismisses a detection:

| Event | Proposal |
|---|---|
| A near-miss detection (0.15–0.29) the second look calls a person | `promote_detection`: add it to the review queue |
| A reviewer confirms a person | `alert` to all teams, and `assign_sector` for the nearest team on standby, with a briefing |
| A clue from the field, a finished drone leg, visibility dropping | `drone_leg` / `retask_drone` from the planner, with its numbers as the reason |
| Flying becomes unsafe | `alert`: recall the drones |
| Periodically | `assign_sector` for teams on standby |

**One real chain where an OpenCV 5 result changes the decision.** A val photo; the detector scored
a person lying on the ground **0.18**, below the 0.29 threshold, so no reviewer would have seen
it. The tool heuristic picked `zoom_native` (the box was 21 px in the frame). From the native
zoom, Nemotron VL answered `yes, lying, white top, dark pants`; the agent proposed
`promote_detection`; the proposal was approved (scripted for the recording, and labelled so in
the trace). The review crop is a blur; the OpenCV zoom shows the person:

| Review crop (1000×750 frame) | OpenCV 5 native zoom (4000×3000 original) |
|---|---|
| ![crop](../architecture/av-chain/crop.jpg) | ![zoom](../architecture/av-chain/zoom_native.jpg) |

The trace excerpt (`scripts/trace_excerpt.py`) is in `docs/architecture/agent.md`.

**TODO (lane A, after C-P1):** a second chain where an OpenCV/VL result leads to a drone
`retask_drone` proposal through the planner, recorded on the live mission.

## 6. AWS deployment

**TODO (lane D):** what runs where (S3 uploads → SQS → worker running `cv2.dnn` → API on EC2 behind
HTTPS → CloudWatch), instance type, IAM and Secrets Manager, per-photo latency from CloudWatch,
a dashboard screenshot, teardown, and the cost so far. Note for sizing: `cv2.dnn` takes about
30 CPU-seconds of work per full photo (1.9 s on 16 cores); measure on the instance.

## 7. Evaluation

### 7.1 Detector (HERIDAL test set, 101 photos, 337 people)

| Scoring | Recall | Precision | AP50 | Time per photo |
|---|---|---|---|---|
| SAR-APD, as in the human study | **0.896** | **0.898** | — | 0.25 s (GPU) |
| Human baseline (Pyrrö et al. 2021) | 0.68 | 0.59 | — | 33 s |
| VOC (one box per person, IoU ≥ 0.5) | 0.864 | 0.802 | 0.868 | 1.9 s (cv2.dnn, CPU) |

Threshold 0.29 chosen on validation by maximising F2 (a missed person costs more than a false
alarm). On the demo survey, all 6 photos with a person are in the first 7 of the review queue.
Ablations (tiling vs shrinking vs native-resolution single pass, whole-photo training, mirror
TTA): `scripts/README.md`.

### 7.2 Second look (verifier)

`scripts/eval_verifier.py`; Nemotron-3.5-Super-VL on Token Factory, thinking off. Rule chosen on
val among a fixed set by F2; prompt v2 chosen over v1 on val; **test scored once** with both fixed.

| | Precision | Recall | F2 |
|---|---|---|---|
| Val: threshold only | 0.735 | 0.859 | 0.831 |
| Val: + promote near-misses the verifier calls `yes` (prompt v2) | 0.699 | 0.886 | 0.841 |
| Test: threshold only | 0.802 | 0.864 | 0.850 |
| **Test: + promote near-misses called `yes`** | 0.772 | **0.875** | 0.853 |

On test the second look finds 4 more of the 337 people (recall +0.012, 95 % CI [+0.003, +0.023],
paired bootstrap over photos) for 15 more false alarms to dismiss; F2 does not change clearly.
The gain is smaller than on val (+0.027): on test the model answered `unclear` for most
near-misses and for 65 % of crops where the person is under 60 px. Test also contains four sites
that are in neither training nor validation (114 of the 337 people, `docs/DETECTOR_LIMITS.md` §5),
which may explain part of the gap. Cost: about 890 tokens in and 67 out, p50 1.35 s and p90
1.65 s per detection; 461 of 461 replies were valid JSON.

### 7.3 Agent: failure handling, observability, human control

- **Failure handling:** invalid JSON → one retry → `unclear` with the reason; timeouts, HTTP errors
  or a missing key → `unclear` naming the error, no proposal; without a model, planner proposals
  continue with template briefings; briefings that are over 60 words, say "clear", or contain a
  number not in their facts are rewritten once, then replaced by a template; a per-mission token
  budget stops model calls with one notice; hooks only enqueue (< 5 ms) and a failing event never
  stops the pipeline.
- **Observability:** every tool call (image path, time, the heuristics that chose it), model call
  (model, prompt version, latency, tokens, reply), verdict, proposal and decision is a line in the
  mission's `trace.jsonl`; images by path, never base64; API keys redacted (tested).
- **Human control:** proposals only; no dismissals; the fleet and the radio act only on approved
  proposals; every decision records who and when.
- **Tests:** `uv run pytest tests/ml tests/agent`, no network or keys needed.

### 7.4 Search map and planner

**TODO (lane C):** the planner simulation (median and P90 flight minutes to find, share found
within 30 min, planner vs static order, 3 seeds × noise levels, labelled simulated), and the
existing map result (28–30 % fewer cells to search than a naive map; README).

### 7.5 End to end

**TODO (lane D):** per-photo latency through the live pipeline (upload → pin → map update), on
AWS from CloudWatch.

## 8. Limitations and failure cases

- **Where the detector misses** (`docs/DETECTOR_LIMITS.md`): groups of people, clothing that
  matches pale or dark rock, people sitting or lying down; two sites (MED, CAB) hold 28 of the 46
  misses. Figures: `docs/figures/limits/`.
- **Validation and test sites differ:** validation shares sites with training; four test sites
  are new. Validation numbers are an optimistic guide to new terrain.
- **The second look is weak on the smallest people:** under 60 px it mostly abstains, and with a
  neutral prompt it called many false alarms a person. It is advice that a person approves, never
  a decision.
- **cv2.dnn on CPU:** 1.9 s per full photo on 16 cores, slower than the GPU Torch path (0.3 s).
- **Simulated parts:** the demo flight path over Mount Seymour, the search-map evaluation and the
  fleet are simulated and labelled so on screen. **TODO (lane C/D):** list any others.

## 9. Responsible use

- **Never "clear":** no text the system writes says an area is clear or cleared; searched sectors
  say how well they were searched ("searched at POD 60 %"). Lane A's tests check every verdict,
  proposal and briefing for it; **TODO (lanes C, D, E):** name your tests.
- **Every action is approved by a person and logged** with who and when.
- **No secrets in the browser, the repo or the trace**; keys come from environment variables
  (and AWS Secrets Manager, **TODO (lane D)**).
- **Honest evaluation:** thresholds and rules are chosen on validation; test is scored once per
  decision. Choices that saw test results are disclosed (§10).
- **Imagery:** HERIDAL (Božić-Štulić, Marušić & Gotovac, 2019), CC BY 3.0; no real search data.

## 10. Disclosures

1. **Existing project:** started at BCS Hackathon 2026 (§2); eligibility confirmed by the organizers.
2. **Test-seen choices (sprint 1):** keeping training run 2 over run 1, and dropping the
   hard-negative fine-tune, were made with test scores in view; the mirror-TTA setting was
   scored on test and not adopted (README). Test numbers are therefore slightly optimistic.
3. **Verifier benchmark:** two early 20-crop prompt runs used test photos; they were superseded by
   val runs and played no part in the final choice (`docs/LANE_A_ML.md` §6.7).
4. **This sprint:** the parity check and the verifier rule each read test once, after every
   choice was fixed on val.
5. **The AV chain's approval is scripted** for the recording, and the trace says so.
6. **AI assistance:** parts of the code and docs were written with an AI coding assistant; the
   agent described in §5 is Sightline's own runtime agent.

## 11. Reproduce

```bash
uv sync --extra ml                                        # Python, with the Torch path for parity
gh release download weights-v2   -R Drivera0/sightline -D data/weights/release_v2
gh release download model-onnx-v2 -R Drivera0/sightline -D data/weights/release_v2
uv run pytest tests/ml tests/agent                         # no GPU, network or keys needed
uv run --extra ml python scripts/parity_table.py           # §4.1 (needs the HERIDAL data, scripts/README.md)
uv run --extra ml python scripts/eval_verifier.py          # §7.2 (needs NEBIUS_API_KEY)
uv run --extra ml python scripts/av_chain.py               # §5 chain, then scripts/trace_excerpt.py
```

**TODO (lane D):** run the app and the AWS deployment (`deploy/aws/README.md`).
