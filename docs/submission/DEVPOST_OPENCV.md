# Devpost: OpenCV AI Competition 2026

**Name:** Sightline
**Subtitle:** Drone photos and radio reports in, where to search next out: a search-and-rescue map with a person in charge
**Repo:** https://github.com/Drivera0/sightline (tag `opencv-submit`, created at submission)
**Report:** `docs/report/OPENCV_REPORT.md` · **Agentic Vision evidence:** `docs/architecture/agent.md`
**Demo:** https://sightline-iota-sandy.vercel.app (no server needed). Start from the home page: press **Try the guided simulation** and pick a scenario under **Guided simulation** (**Start the simulation**; the overdue hiker is marked "Start here"). You are the search manager: the clock runs to each decision and waits, the AI proposes with its reason and what each option costs in minutes, you decide, and the simulation shows what your decisions change on the map, the teams and the clock. The end screen opens on **Without Sightline vs with Sightline**: a manual search (a lawnmower survey, one reviewer looking at every photo at 33 s each, a fixed hand split of the teams) against your run, on the same engine and seed, with each assumption and its source; a third column, the AI's choice every time, appears only when yours differed. **Open the console** (`#m/demo/map`) is the same console hands-on: a fresh mission at the call, a clock (Play/Pause, 1×/2×/4×) and Restart, and the decisions are yours, made with the console's own controls. The recorded mission's checkpoints stay at `#m/demo?t=0` to `?t=6`.
**Where to look, in order:** the home page (`#`) → **Start the simulation** on a scenario card (about 3 min, `#m/demo?s=<seed>&guide=1`) → its end screen, Without Sightline vs with Sightline → **Open the console** for the hands-on run (`#m/demo/map`) → the Trace view (`#m/demo/trace`) → Conditions, W in the console (`#m/demo/map/conditions`) → the Debrief: results, what breaks first and the links out (`#m/demo?t=6`; `#judges` redirects to its list for judges) → About, a section of the home page, for the method (`#about` scrolls there)
**Live API (AWS):** https://44-227-39-234.sslip.io (stopped between demos to save cost)
**Special awards (opt in on the form):** Agentic Vision (evidence: `docs/architecture/agent.md`, the trace and `docs/report/AGENT_EVAL.md`) and Best Use of COOL (evidence: `docs/report/COOL_GRAVITON.md`, report §15)
**Built with, equally:** OpenCV 5 sees (`cv2.dnn` detector, re-look tools, the map's coverage), NVIDIA models read, reason, listen and speak (Nemotron VL, Nemotron 3 Super and Nano, Parakeet, Magpie), Nebius runs every model call (Token Factory) and the batch jobs (Serverless Job and Endpoint); Tavily brings the conditions [27]
**Video:** <to add>

<!--
Video outline (≤ 5:00):
0:00–0:12 Presenter on camera, lower-third, one line: "A missing hiker, 400 hectares, two hours of light. Sightline turns 500 drone photos into a ranked search plan." Logo card 1 s.
0:12–0:30 The home page → Start on the overdue hiker: the guided search, map with search area and drone track, the first decision waiting. Burned-in decision labels throughout.
0:30–1:05 Upload → detection: photos tick in, detections with confidence, heat map filling. Split screen: photo + boxes | map.
1:05–1:35 Re-look: the 0.17 candidate from this flight (f0273-d02, two people on a forest trail), OpenCV zoom_native, Nemotron VL verdict; Trace view visible (tool → model → result → proposal).
1:35–2:05 Approval: a real person approves in the inbox; the gate shown explicitly.
2:05–2:40 Map re-task → assignment card → GPX opens in CalTopo.
2:40–3:20 Radio desk: a real exchange with audio and transcript; team acknowledges; clue lands on the map.
3:20–3:55 Architecture: one left-to-right diagram (photos → cv2.dnn → map → agent/tools → approval → drone/team/radio), AWS and OpenCV 5 boxes highlighted as narration passes.
3:55–4:30 Numbers slide, big digits: parity table, test recall vs human, 7.1 s/photo on AWS, verifier +4 at +15 FA.
4:30–4:50 Limits: three honest bullets (lying-down/groups/rock-coloured clothing; val-only tuning and the test disclosure; simulated fleet).
4:50–5:00 Presenter on camera: repo, live URL, thanks.
Production: burn in captions; 1080p master; YouTube "Not for Kids"; no copyrighted music.
-->

**Gallery (in this order):**

1. *The console on the demo mission at 13:35 PDT, the call (the "Simulation on real aerial photographs" chip): the status line (5 min elapsed, 5 h 02 min of daylight left, drones can fly until 18:36, subject not found), the subject strip (adult, red jacket, day hiker, last seen 10:30 at the trailhead lot), the Resources board with Teams One and Two out on a hasty search and Teams Three and Four free at base camp, Koester's lost-hiker rings around the last known point on the probability map, Needs you empty, and the timeline with the talk bar along the bottom.* (`docs/submission/figures/console-t0-the-call-pitch-bar.png`)
2. *14:00 PDT, photos landing: partway through the survey flight (real HERIDAL photos on a simulated flight path), each photo is ranked by the detector as it lands (re-detected on OpenCV 5 `cv2.dnn`, the same boxes and scores), the map lowers where the first leg has looked, and Needs you fills with the first 8 candidates for a person to confirm.* (`docs/submission/figures/photos-land-t1-each-photo-ranked-and-placed.png`)
3. *14:31 PDT, the second look in Needs you: "Put this photo in Review photos?" A detection from this flight's photo f0273 scored only 0.17, under the 0.29 review threshold; the AI re-check (an OpenCV 5 native-resolution zoom, read by Nemotron VL) says two human figures are visible, one in a red jacket and blue top. The detector's crop and the re-check zoom sit side by side, and a person decides: Add it to Review photos, or Reject.* (`docs/submission/figures/second-look-t2-a-017-candidate-this-flight-opencv5-zoom-nemotron-vl.png`)
4. *The Trace view on that chain: the 0.173 detection f0273-d02, the OpenCV 5 `zoom_native` tool, the crop and the zoom Nemotron VL answered "person: yes, standing, 2" from (its live answer, replayed word for word in the demo's own trace), then the proposal, waiting for a person.* (`docs/submission/figures/trace-which-model-did-what-second-look.png`)
5. *14:58 PDT, the run: three simulated drones (Drone 2 has lost its link and flies its approved flight line on its own; Drone 3 is charging) and Team Two heard via Drone 3's relay; B4 searched at POD 60 %, its probability lowered by that. The Conditions panel (W) is open: the flyability gate (drones can fly until about 18:36 PDT, gust limit 43 km/h), the demo's own conditions, and another evening's recorded live lookup folded below for the sources.* (`docs/submission/figures/run-t4-fleet-flying-b4-pod-60-conditions.png`)
6. *15:00 PDT, the Debrief after the find: the after-action report (found by Team One in C2 at 14:59, where found, the areas searched at their POD: B4 60 %, C4 40 %) and what breaks first, in the report's words, beside the map, with the radio exchange that reported the find in the timeline. The key events, the per-sector POD table, the flight lines, the exports and the measured results sit between the two in the app and are left out of this frame.* (`docs/submission/figures/debrief-t6-after-action-report-what-breaks-first.png`)

---

For search managers, Sightline turns drone photos and radio reports into one map that says where to look next, so teams are tasked in minutes.

**What breaks first,** before you ask [18]:

1. The detector misses 46 of the 337 people in the HERIDAL test set (recall 0.864, strict VOC), and 28 of those 46 are at two sites, MED and CAB: groups, clothing that matches pale or dark rock, people sitting or lying down.
2. The second look is a small gain: on test it finds 4 more of the 337 people for 15 more false alarms (95 % CI of the recall gain [+0.003, +0.023]), it is advice a person approves, and on people under 60 px it mostly answers "unclear".
3. The fleet is a simulation, the approvals are not: the drones, their flights and where each photo was taken are generated over real aerial photographs (HERIDAL), and the site's one "Simulation on real aerial photographs" chip says so. In the guided run and in free play the visitor makes every approval live in the browser (Watch instead, if they pick it, is logged as such), and every move in the log names its approver. The mission trace in the Trace view was generated offline with stand-in models and a pre-written search manager, and its header says so.

Measured, with the caveat beside each number:

- **The detector finds 89.6 % of people on the HERIDAL test set against 68 % for people reviewing by eye, scored the study's loose SAR-APD way; under strict VOC scoring it is 86.4 %** [8]. Two early model choices saw test scores, so test is slightly optimistic, and I say so [9].
- **The second look finds 4 more of 337 people on test at the cost of 15 more false alarms (95 % CI of the recall gain [+0.003, +0.023], p < 0.05), and is advisory:** a person approves each promotion [10].
- **In simulation, with a clue at the start, three drones planning on one shared map find the person within 30 minutes in 22.7 % of trials against 20.0 % for a hand split; with realistic wind, battery swaps, GPS error and link loss the lead holds (15.9 % vs 11.5 %, seed ranges apart). With no clue they are level, and I say so** [11].
- **On the whole live system, the agent sent the drone, the alert, the team and the promotion to the person's sector or detection in every run of its evaluation (fake models, scripted detector), the approval-gate checks passed in 12 of 12 runs, and with Token Factory fully down a mission pays about 82 s in all, not minutes per call** [17].
- **The planner's honest result:** on a flat prior it is no better than a fixed serpentine. With a clue it flies there first, and finds the person within 30 minutes in 10.7 % of trials against 6.3 % [12].
- **A 500-photo mission's compute costs under a dollar:** about $0.67 with detection on AWS, the Nemotron VL second look and Tavily, or $0.49 with detection as a Nebius Serverless Job; the detector uses about 17 Wh (an estimate from CPU-seconds) [19].
- **On a dataset it never saw, the detector finds about half the people:** frozen, scored once on LADD (1,365 photos, 4,733 people, Russian forest, fields and snow), VOC precision / recall / AP50 0.509 / 0.516 / 0.458, and 0.436 recall on snow [20].
- **Recall falls with the pixels a person gets, and the map now knows it:** 0.64 at about 18 px, 0.87–0.89 from 37 px (val); each photo's POD reads this curve at its own GSD for a 0.8 m person, times a terrain factor measured on LADD (snow 0.508) [21].
- **Beside published HERIDAL results** (AIR 90.1 / 86.1 / 84.6 P / R / AP, self-reported; Faster R-CNN 67.3 / 88.3 / 86.1), Sightline's is 80.2 / 86.4 / 86.8 under strict VOC, the one row anyone can re-check in about 5 minutes on a CPU; the rows are not strictly comparable [22].
- **COOL on AWS Graviton (the Arm path):** the detector and the API run on COOL (Cloud Optimized OpenCV, COOL-V3 AMI) on a c6g.4xlarge with the same test scores and boxes bit-identical to the pip wheel of the same OpenCV version (538 of 538 boxes, 101 of 101 photos); the image-processing calls Sightline makes are 1.14 to 1.35× faster; `cv2.dnn` is not faster (equal in throughput, about 9 % slower in one process); the run cost about $1.40 [28].
- **A negative I kept:** sending a drone to 25 m when the second look says `unclear` resolved 0 of 25 val near-misses in simulation (12 of the 24 false alarms stopped being detected), and the ledger shows the second look's value predicted on val (0.62 decisive) overstates test (0.49) [23].

## Inspiration

A search-and-rescue drone brings back hundreds of photos per flight. A missing person is about 70 px wide in a 4000×3000 photo [1]. Volunteers reviewing by eye take about 33 s a photo and, in the published study, found 68 % of the people [2]. Meanwhile the search manager decides where drones and ground teams go next, from radio reports and a paper map.

Everyone detects; nobody closes the loop. DJI FlightHub 2, Skydio, Eagle Eyes and Loc8 flag pixels; SARUAV adds a mobility model; CalTopo tracks assignments and clues. None I found turns every photo, negative sweep and radio report into one updated probability map, and none puts a logged approval gate between a suggestion and a drone or team.

## What it does

- **Detects** each photo as it arrives, with OpenCV 5 `cv2.dnn`, and places every detection on the map from the photo's own GPS and camera pose.
- **Keeps a probability map** of where the person could still be. Every photo, review, searched sector and clue updates it. Searched ground shows how well it was searched ("searched at POD 60 %"); the software never rules an area out.
- **Takes a second look** at uncertain detections: OpenCV 5 re-look tools (native-resolution zoom, CLAHE, re-detection) build better images, and Nemotron VL gives a verdict.
- **Proposes the next move** (promote a detection, fly or re-task a drone, assign a sector, alert the teams), each with its reason. **A person approves every one**, and the decision is logged with who and when.
- **Talks to ground teams** on a secondary radio channel. A clue is logged only after Sightline reads it back and the team confirms.
- **Writes the files a command post already files:** an ICS 204 Assignment List per team, an ICS 214 Activity Log from the trace and a CalTopo / SARTopo GeoJSON, every searched area "searched at POD 0.6", linked from a live mission's Debrief [24].

## How I built it

- **Detector:** YOLO11s fine-tuned on 1024 px HERIDAL tiles, exported to ONNX and run on **OpenCV 5 `cv2.dnn`** with no PyTorch at run time. It gives identical scores to the PyTorch path on the test set, and 363 of 363 boxes match one to one [3]. On the CPU, OpenCV 5's new engine took 96 ms per slice against 99 ms for the ONNX Runtime engine inside OpenCV [4].
- **OpenCV 5 re-look tools,** one per failure mode from the error analysis: `zoom_native` for small people, CLAHE for clothing that matches rock, `redetect_region` for groups and people lying down. Also `cv2.fillPoly` and `cv2.blur` for coverage and canopy on the map [5].
- **Agent:** proposes; never acts. Every tool call, model call, verdict, proposal and decision is one line of the mission's `trace.jsonl` [6].
- **AWS:** S3, an SQS FIFO queue, an EC2 worker running `cv2.dnn`, CloudWatch metrics and Secrets Manager. 7.1 s per photo from upload to "processed" on the default c7i.2xlarge [7]. The same code also runs on the Arm path, COOL on Graviton, measured against the pip wheel on the same instance [28].
- **One console, laid out like a command post:** resources on the left (a T-card board of teams and drones), the map in the middle, Needs you (one question per item) on the right and the timeline with the talk bar below; four views (Map · Photos · Trace · Debrief) change the rail, never the map. The guided simulation (about 3 min) stops the clock at each decision for the visitor to make, as the search manager, and ends on Without Sightline vs with Sightline; Open the console runs the same engine hands-on from the call, with a clock and Restart; the Trace view shows each chain step by step, with chips for which model and tool ran and what each observation was worth [25].
- **Built by** Daniel Rivera (the BCS Hackathon 2026 version was built by a team of four: Daniel Rivera, Grace Chu (@bamobam), Harvir Nijjar (@har-vir) and Jason Kim (@jkiim); everything added for this hackathon is solo). Development used Claude Code (Anthropic) as an AI coding assistant. The agentic workflow in this entry is Sightline's runtime agent (Nemotron on Nebius Token Factory proposing actions that a person approves), not the coding assistant; every model call in the running product is listed in the README's models table [26].

## Challenges

- **Small people in big photos.** Shrinking a photo to the model's input drops test recall to 0.234; tiling at native resolution is what works [1]. The second look abstains on people under 60 px rather than guess [10].
- **`import ultralytics` sets `cv2.setNumThreads(0)`,** which made `cv2.dnn` 5× slower in any process that also loaded Torch [4].
- **Honest evaluation:** every threshold and rule chosen on validation; test scored once per decision.

## Accomplishments

- A real chain where OpenCV changes the decision: a person lying down on a validation photo, scored 0.18 (below the 0.29 review threshold; a separate chain from the demo flight's 0.17 standing pair, f0273-d02, in the gallery), is zoomed from native pixels, called "yes, lying" by Nemotron VL, and proposed for review [13].
- OpenCV 5 `cv2.dnn` as the production detector, with a parity table against PyTorch rather than a claim [3].
- The whole loop live on AWS, with a dead-letter queue, per-step latency metrics and keys only in Secrets Manager [7].
- A radio desk where the first sound comes back in 2.5 s (p50) with the replies spoken by Magpie (team lines typed), and 6 of 6 clue reports were read back and confirmed before they were logged [16].

## What I learned

The detector is no longer the hard part; what happens after a pixel is flagged is. Measuring that honestly showed small gains where I hoped for big ones (the second look, the planner without a clue), and I report them as measured.

## What's next

- Thermal imagery for night searches; a larger search grid for hiker missions, whose Koester rings reach well past the 1 km grid.
- DJI FlightHub 2 so photos arrive by themselves.
- A word error rate on real volunteers' voices over real handsets.
- A field trial with a search-and-rescue team.

**Limits, stated plainly:** the detector misses groups, clothing that matches pale or dark rock, and people sitting or lying down [14]. The fleet (the drones, their flights and their positions, over real HERIDAL aerial photos), the demo flight path and the search-map evaluation are simulated and labelled so on screen. In the guided and hands-on runs the visitor makes every approval, each logged with who decided ("You approved…"); the demo mission's recorded trace in the Trace view was generated offline with stand-in models and a scripted search manager and image reviewer, says so in its header, and marks the stand-in model calls "Replayed" (the one live Nemotron VL answer is kept word for word) [15]. The find in a run comes from seeded draws at each searched sector's POD; the manual line on the end screen is the same engine with stated assumptions, not a measured human search.

---

### Sources for every number

1. `README.md:104` (70 px, tiling, shrinking to 1024 px gives recall 0.234)
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
15. `docs/report/OPENCV_REPORT.md:884-886`, `:999-1002`; `web/src/command/README.md` (Free play, the visitor decides, Trace view); `web/src/command/TraceView.tsx` ("Replayed"); `web/src/command/compare.ts` (Without Sightline vs with Sightline)
16. `docs/feedback/radio.md:84`, `:101`
17. `docs/report/AGENT_EVAL.md` (correct target, approval gate, failure handling); `docs/report/OPENCV_REPORT.md:547-562`, `:577`, `:583-587`
18. `docs/submission/WHAT_BREAKS_FIRST.md`; `docs/report/OPENCV_REPORT.md:853-855`, `:537-538`, `:884-886`; `docs/DETECTOR_LIMITS.md:39`, `:54`
19. `docs/report/OPENCV_REPORT.md` §4.1 (inputs: `:374`, `:377`, `:381`; `docs/feedback/nebius.md:75`, `:175-178`; `docs/report/TAVILY.md:15`; `docs/report/CV2_CUDA.md:143`)
20. `docs/report/LADD.md:6-8`, `:36-40`; `docs/evidence/ladd/20261022T174430Z/ladd.json`
21. `docs/report/POD.md:8-15`, `:156-197`; `sightline/search/pod.py:55`, `:72`
22. `docs/report/OPENCV_REPORT.md:322-353`
23. `docs/report/AGENT_EVAL.md:203-229`, `:238-247`
24. `docs/EXPORTS.md`; `tests/geo/test_exports.py`
25. `web/src/command/README.md:127-171`, `:173-212`, `:103-116`; `README.md:58-67`
26. `README.md:106-116` (Built with NVIDIA + Nebius: every model, what it does, where it runs); `README.md:280-282` (Credits)
27. `web/src/front/Home.tsx` (Built with: OpenCV, NVIDIA and Nebius cards side by side, PR #232); `README.md:106-116`
28. `docs/report/COOL_GRAVITON.md:9-36` (result), `:221-225` (cost of the run: c6g.4xlarge about $1.34 plus the volume, COOL free in the trial); `docs/report/OPENCV_REPORT.md:1216-1240` (§15); `docs/evidence/cool/`
