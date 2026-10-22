# Devpost: OpenCV AI Competition 2026

**Name:** Sightline
**Subtitle:** Drone photos and radio reports in, where to search next out: a search-and-rescue map with a person in charge
**Repo:** https://github.com/Drivera0/sightline (tag `opencv-submit`, created at submission)
**Report:** `docs/report/OPENCV_REPORT.md` · **Agentic Vision evidence:** `docs/architecture/agent.md`
**Demo:** https://sightline-iota-sandy.vercel.app (`#m/demo/command` opens the command view on a demo mission, no server needed)
**Live API (AWS):** https://44-227-39-234.sslip.io (stopped between demos to save cost)
**Video:** <to add>

<!--
Video outline for Dan (≤ 5:00; from .documents/WIN_RESEARCH.md §8, OpenCV video):
0:00–0:12 Dan on camera, lower-third, one line: "A missing hiker, 400 hectares, two hours of light. Sightline turns 500 drone photos into a ranked search plan." Logo card 1 s.
0:12–0:30 Front door → demo mission: map with search area and drone track. Burned-in step labels throughout.
0:30–1:05 Upload → detection: photos tick in, detections with confidence, heat map filling. Split screen: photo + boxes | map.
1:05–1:35 Re-look: a 0.18 candidate, OpenCV zoom_native/CLAHE, Nemotron VL verdict; Trace tab visible (tool → model → result → proposal).
1:35–2:05 Approval: a real person approves in the inbox; the gate shown explicitly.
2:05–2:40 Map re-task → assignment card → GPX opens in CalTopo.
2:40–3:20 Radio desk: a real exchange with audio and transcript; team acknowledges; clue lands on the map.
3:20–3:55 Architecture: one left-to-right diagram (photos → cv2.dnn → map → agent/tools → approval → drone/team/radio), AWS and OpenCV 5 boxes highlighted as narration passes.
3:55–4:30 Numbers slide, big digits: parity table, test recall vs human, 7.1 s/photo on AWS, verifier +4 at +15 FA.
4:30–4:50 Limits: three honest bullets (lying-down/groups/rock-coloured clothing; val-only tuning and the test disclosure; simulated fleet).
4:50–5:00 Dan on camera: repo, live URL, thanks.
Production: burn in captions; 1080p master; YouTube "Not for Kids"; no copyrighted music.
-->

**Gallery (in this order):**

1. *The command view on the demo mission (DEMO chip, simulated data): detections on the map, task board, approval inbox.* (`docs/submission/figures/command-view-detections-task-board-approval-inbox.png`)
2. *An OpenCV 5 result changes the next decision: the blurred review crop of a 0.18 detection, and the native-resolution zoom Nemotron VL answered "yes, lying" from, in the Trace tab.* (`docs/submission/figures/trace-which-model-did-what-second-look.png`)
3. *The approval inbox: every proposal carries its reason, and nothing happens until a person approves it.* (`docs/submission/figures/approval-inbox-every-proposal-carries-its-reason.png`)
4. *A printable assignment card for Team Two's sector B3, and the same sector's GPX opened in CalTopo.* (`docs/submission/figures/assignment-card-gpx-kml-opened-in-caltopo.png`)
5. *Architecture: photos → OpenCV 5 `cv2.dnn` → map → agent and re-look tools → human approval → drone, team or radio, on AWS.* (`docs/submission/figures/architecture-photos-cv2dnn-map-agent-approval-on-aws.png`)
6. *Results in the app: the detector vs people reviewing by eye (SAR-APD scoring), time per photo, ground left to search. The `cv2.dnn` vs PyTorch parity and the other numbers are in the report's tables (§3.1, §3.9).* (`docs/submission/figures/results-detector-vs-human-baseline.png`)

---

For search managers, Sightline turns drone photos and radio reports into one map that says where to look next, so teams are tasked in minutes.

**What breaks first,** before you ask [18]:

1. The detector misses 46 of the 337 test people (strict VOC recall 0.864), and 28 of the 46 are at two sites, MED and CAB: groups, clothing that matches rock, people sitting or lying down.
2. The second look is a small gain: 4 more of the 337 people for 15 more false alarms (95 % CI of the gain [+0.003, +0.023]), and it is advice a person approves.
3. The fleet and the approvals in the demo are simulated: the drones, their flights and photos are simulated, and the human approvals in the recorded traces are scripted, labelled so on screen and in the trace.

Measured, with the caveat beside each number:

- **The detector finds 89.6 % of people on the HERIDAL test set against 68 % for people reviewing by eye, scored the study's loose SAR-APD way; under strict VOC scoring it is 86.4 %** [8]. Two early model choices saw test scores, so test is slightly optimistic, and we say so [9].
- **The second look finds 4 more of 337 people on test at the cost of 15 more false alarms (95 % CI of the recall gain [+0.003, +0.023], p < 0.05), and is advisory:** a person approves each promotion [10].
- **In simulation, with a clue at the start, three drones planning on one shared map find the person within 30 minutes in 22.7 % of trials against 20.0 % for a hand split; with realistic wind, battery swaps, GPS error and link loss the lead holds (15.9 % vs 11.5 %, seed ranges apart). With no clue they are level, and we say so** [11].
- **On the whole live system, the agent sent the drone, the alert, the team and the promotion to the person's sector or detection in every run of its evaluation (fake models, scripted detector), the approval-gate checks passed in 12 of 12 runs, and with Token Factory fully down a mission pays about 82 s in all, not minutes per call** [17].
- **The planner's honest result:** on a flat prior it is no better than a fixed serpentine. With a clue it flies there first, and finds the person within 30 minutes in 10.7 % of trials against 6.3 % [12].
- **A 500-photo mission's compute costs under a dollar:** about $0.67 with detection on AWS, the Nemotron VL second look and Tavily, or $0.49 with detection as a Nebius Serverless Job; the detector uses about 17 Wh (an estimate from CPU-seconds) [19].

## Inspiration

A search-and-rescue drone brings back hundreds of photos per flight. A missing person is about 70 px wide in a 4000×3000 photo [1]. Volunteers reviewing by eye take about 33 s a photo and, in the published study, found 68 % of the people [2]. Meanwhile the search manager decides where drones and ground teams go next, from radio reports and a paper map.

Everyone detects; nobody closes the loop. DJI FlightHub 2, Skydio, Eagle Eyes and Loc8 flag pixels; SARUAV adds a mobility model; CalTopo tracks assignments and clues. None turns every photo, negative sweep and radio report into one updated probability map, and none puts a logged approval gate between a suggestion and a drone or team.

## What it does

- **Detects** each photo as it arrives, with OpenCV 5 `cv2.dnn`, and places every detection on the map from the photo's own GPS and camera pose.
- **Keeps a probability map** of where the person could still be. Every photo, review, searched sector and clue updates it. Searched ground shows how well it was searched ("searched at POD 60 %"); the software never rules an area out.
- **Takes a second look** at uncertain detections: OpenCV 5 re-look tools (native-resolution zoom, CLAHE, re-detection) build better images, and Nemotron VL gives a verdict.
- **Proposes the next move** (promote a detection, fly or re-task a drone, assign a sector, alert the teams), each with its reason. **A person approves every one**, and the decision is logged with who and when.
- **Talks to ground teams** on a secondary radio channel. A clue is logged only after Sightline reads it back and the team confirms.

## How we built it

- **Detector:** YOLO11s fine-tuned on 1024 px HERIDAL tiles, exported to ONNX and run on **OpenCV 5 `cv2.dnn`** with no PyTorch at run time. It gives identical scores to the PyTorch path on the test set, and 363 of 363 boxes match one to one [3]. On the CPU, OpenCV 5's new engine took 96 ms per slice against 99 ms for the ONNX Runtime engine inside OpenCV [4].
- **OpenCV 5 re-look tools,** one per failure mode from our error analysis: `zoom_native` for small people, CLAHE for clothing that matches rock, `redetect_region` for groups and people lying down. Also `cv2.fillPoly` and `cv2.blur` for coverage and canopy on the map [5].
- **Agent:** proposes; never acts. Every tool call, model call, verdict, proposal and decision is one line of the mission's `trace.jsonl` [6].
- **AWS:** S3, an SQS FIFO queue, an EC2 worker running `cv2.dnn`, CloudWatch metrics and Secrets Manager. 7.1 s per photo from upload to "processed" on the default c7i.2xlarge [7].

## Challenges

- **Small people in big photos.** Shrinking a photo to the model's input drops test recall to 0.234; tiling at native resolution is what works [1]. The second look abstains on people under 60 px rather than guess [10].
- **`import ultralytics` sets `cv2.setNumThreads(0)`,** which made `cv2.dnn` 5× slower in any process that also loaded Torch [4].
- **Honest evaluation:** every threshold and rule chosen on validation; test scored once per decision.

## Accomplishments

- A real chain where OpenCV changes the decision: a person lying down, scored 0.18 (below the 0.29 review threshold), is zoomed from native pixels, called "yes, lying" by Nemotron VL, and proposed for review [13].
- OpenCV 5 `cv2.dnn` as the production detector, with a parity table against PyTorch rather than a claim [3].
- The whole loop live on AWS, with a dead-letter queue, per-step latency metrics and keys only in Secrets Manager [7].
- A radio desk where the first sound comes back in 2.5 s (p50) with real voices, and 6 of 6 clue reports were read back and confirmed before they were logged [16].

## What we learned

The detector is no longer the hard part; what happens after a pixel is flagged is. Measuring that honestly showed small gains where we hoped for big ones (the second look, the planner without a clue), and we report them as measured.

## What's next

- Thermal imagery for night searches; a larger search grid for hiker missions, whose Koester rings reach well past the 1 km grid.
- DJI FlightHub 2 so photos arrive by themselves.
- A word error rate on real volunteers' voices over real handsets.
- A field trial with a search-and-rescue team.

**Limits, stated plainly:** the detector misses groups, clothing that matches pale or dark rock, and people sitting or lying down [14]. The fleet, the demo flight path and the search-map evaluation are simulated and labelled so on screen. The human approvals in the recorded agent traces are scripted and labelled so in the trace [15].

---

### Sources for every number

1. `README.md:89` (70 px, tiling, shrinking to 1024 px gives recall 0.234)
2. `docs/report/OPENCV_REPORT.md:34-35`, `:295`
3. `docs/report/OPENCV_REPORT.md:139-148`
4. `docs/report/OPENCV_REPORT.md:153-160`, `:187-191`
5. `docs/report/OPENCV_REPORT.md:228-256`, `:271-288`
6. `docs/architecture/agent.md` (Evaluation, Observability)
7. `docs/report/OPENCV_REPORT.md:374`
8. `docs/report/OPENCV_REPORT.md:294-296`; scoring explained at `README.md:39`
9. `README.md:40`; `docs/report/OPENCV_REPORT.md:308-315`
10. `docs/report/OPENCV_REPORT.md:537-544`; `docs/LANE_A_ML.md:314`
11. `docs/report/FLEET_V2.md` (results table); `docs/report/OPENCV_REPORT.md:712-723`
12. `docs/report/OPENCV_REPORT.md:662-672`
13. `docs/architecture/agent.md` ("One real chain"); `docs/architecture/av-chain/trace.jsonl`
14. `docs/report/OPENCV_REPORT.md:853-855`
15. `docs/report/OPENCV_REPORT.md:884-886`, `:999-1002`
16. `docs/feedback/radio.md:84`, `:101`
17. `docs/report/AGENT_EVAL.md` (correct target, approval gate, failure handling); `docs/report/OPENCV_REPORT.md:547-562`, `:577`, `:583-587`
18. `docs/submission/WHAT_BREAKS_FIRST.md`; `docs/report/OPENCV_REPORT.md:853-855`, `:537-538`, `:884-886`; `docs/DETECTOR_LIMITS.md:39`, `:54`
19. `docs/report/OPENCV_REPORT.md` §4.1 (inputs: `:374`, `:377`, `:381`; `docs/feedback/nebius.md:74`, `:174-177`; `docs/report/TAVILY.md:15`; `docs/report/CV2_CUDA.md:143`)
