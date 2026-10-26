# Paste-ready: OpenCV AI Competition 2026 (Devpost project form)

> Repo links should point at the tag (`opencv-submit`) once created; until then `main`. To switch, replace
> `/blob/main/` with `/blob/opencv-submit/` throughout. Fields only the owner can fill are marked `<OWNER: …>`.
> Every number below comes from `DEVPOST_OPENCV.md` here, whose sources list ties each one to its file.

---

## Project name

Sightline

## Elevator pitch

(177 characters, limit 200)

```
Drone photos and radio reports in, where to search next out. OpenCV 5 finds people in search-and-rescue photos, an agent proposes the next move, and a person approves every one.
```

## About the project

```markdown
## Inspiration

A search-and-rescue drone brings back hundreds of photos per flight, and a missing person is about 70 px wide in a 4000×3000 photo. Volunteers reviewing by eye take about 33 s a photo and, in the published HERIDAL study, found 68 % of the people. Meanwhile the search manager decides where drones and ground teams go next, from radio reports and a paper map. Plenty of tools flag pixels; none I found turns every photo, negative sweep and radio report into one updated probability map, with a logged approval gate between a suggestion and a drone or team.

## What it does

- **Detects** each photo as it arrives with **OpenCV 5 `cv2.dnn`**, and places every detection on the map from the photo's GPS and camera pose.
- **Keeps a probability map** of where the person could still be. Every photo, review, searched sector and clue updates it. Searched ground shows how well it was searched ("searched at POD 60 %"); the software never rules an area out.
- **Takes a second look** at uncertain detections: OpenCV 5 re-look tools (native-resolution zoom, CLAHE, re-detection) build better images, and NVIDIA Nemotron VL on Nebius Token Factory gives a verdict.
- **Proposes the next move** (promote a detection, fly or re-task a drone, assign a sector, alert the teams) with its reason. **A person approves every one**, logged with who and when.
- **Talks to ground teams** on a secondary radio channel and logs a clue only after a readback.
- **Writes the files a command post files:** ICS 204 per team, ICS 214 from the trace, CalTopo GeoJSON.

On the [live site](https://sightline-iota-sandy.vercel.app) you are the search manager in a three-minute guided simulation: the AI proposes, you decide, and the end screen compares a manual search with yours (**Without Sightline vs with Sightline**, every assumption with its source). **Open the console** runs the same mission hands-on from the call.

**Run a real search:** [`#new`](https://sightline-iota-sandy.vercel.app/#new) starts a live mission on the AWS API: drop aerial photos and each is detected with OpenCV 5 `cv2.dnn` on the server and placed on the map.

## How I built it

- **OpenCV 5 sees.** YOLO11s fine-tuned on 1024 px HERIDAL tiles, exported to ONNX and run on `cv2.dnn` with no PyTorch at run time: identical scores to PyTorch on the test set, 363 of 363 boxes matched one to one. Re-look tools, one per failure mode: `zoom_native` for small people, CLAHE for clothing that matches rock, `redetect_region` for groups and people lying down; `cv2.fillPoly` and `cv2.blur` for coverage and canopy on the map.
- **NVIDIA models read, reason, listen and speak:** Nemotron 3.5 Super VL (second look), Nemotron 3 Super (radio turns with tools), Nemotron 3 Nano (briefings, conditions), Parakeet and Magpie (speech).
- **Nebius runs every model call** (Token Factory) and the batch detection (a Serverless Job: 711 photos in 483 s, about $0.10). **Tavily** brings the forecast, warnings and park alerts that gate the drones.
- **Every AI step in the demo is a real Nemotron answer from Nebius Token Factory:** the demo mission and all four scenarios were re-recorded on Oct 26 with live calls (34 new calls, 50.1 s in all): three Nemotron 3.5 Super VL second looks per mission and one Nemotron 3 Nano briefing per assignment, replayed word for word, each labelled on screen with its model, "Nebius Token Factory" and its time; the Trace view counts them per mission.
- **AWS:** S3, an SQS FIFO queue with a dead-letter queue, an EC2 worker running `cv2.dnn`, CloudWatch metrics and Secrets Manager; 7.1 s per photo from upload to processed. **COOL on Graviton:** the detector and API also run on Cloud Optimized OpenCV with bit-identical boxes (538 of 538).
- **The agent proposes and never acts:** every tool call, model call, verdict, proposal and decision is one line of the mission's trace.
- **The web console** (React, TypeScript, MapLibre) is laid out like a command post: resources, the map, Needs you, and the timeline with the radio.

## Challenges I ran into

- **Small people in big photos.** Shrinking a photo to the model's input drops test recall to 0.234; tiling at native resolution works. The second look mostly answers "unclear" on people under 60 px, and I kept that.
- **`import ultralytics` sets `cv2.setNumThreads(0)`,** which made `cv2.dnn` 5× slower in any process that also loaded Torch.
- **Honest evaluation:** every threshold chosen on validation, test scored once per decision; two early choices saw test, and the report says so.

## Accomplishments that I'm proud of

- A real chain where OpenCV changes the decision: a person lying down, scored 0.18 (below the 0.29 threshold), zoomed from native pixels, called "yes, lying" by Nemotron VL, and proposed for review.
- The detector finds 86.4 % of people on the HERIDAL test set (strict VOC; 89.6 % on the study's looser scoring, against 68 % by eye).
- The whole loop live on AWS, and a [technical report](https://github.com/Drivera0/sightline/blob/main/docs/report/OPENCV_REPORT.md) where every number links to its evidence.
- What breaks first, stated up front: the detector misses 46 of 337 test people (groups, rock-coloured clothing, people sitting or lying); the second look adds only 4 people for 15 false alarms; the fleet is simulated over real HERIDAL photos.

## What I learned

The detector is no longer the hard part; what happens after a pixel is flagged is. Measuring that honestly gave small gains where I hoped for big ones (the second look; the planner, which beats a fixed order only when there is a clue), and I report them as measured. COOL taught me the same: image processing 1.14 to 1.35× faster, `cv2.dnn` not faster.

## What's next for Sightline

Thermal imagery for night searches; photos arriving straight from the drone platform; a word error rate on real volunteers' voices over real handsets; and a field trial with a search-and-rescue team.
```

## Built with

```
opencv, python, onnx, yolo, ultralytics, pytorch, sahi, fastapi, pydantic, docker, caddy, react, typescript, vite, tailwindcss, maplibre, zustand, onnxruntime-web, aws, amazon-ec2, amazon-s3, amazon-sqs, amazon-cloudwatch, aws-secrets-manager, aws-graviton, vercel, nvidia, nemotron, nvidia-nemo, parakeet, magpie, nebius, nebius-token-factory, tavily, playwright, github-actions
```

## Try it out

- https://sightline-iota-sandy.vercel.app (guided simulation and hands-on console)
- https://sightline-iota-sandy.vercel.app/#new (a live search on the AWS API)
- https://sightline-iota-sandy.vercel.app/#try (try your own aerial photo: the detector runs in your browser)
- https://github.com/Drivera0/sightline
- https://github.com/Drivera0/sightline/blob/main/docs/report/OPENCV_REPORT.md

## Video demo link

`<YOUTUBE LINK>`

## Image gallery (upload in this order, 3:2)

Files in `docs/submission/figures/` (and in the Desktop `devpost/` folder).

1. `console-t0-the-call-pitch-bar.png`: 13:35, the call: the console on the overdue-hiker mission, the lost-hiker rings around the last known point on the probability map, two teams out on a hasty search and two at base camp.
2. `photos-land-t1-each-photo-ranked-and-placed.png`: Photos landing: each real HERIDAL photo, on a simulated flight path, is ranked by the OpenCV 5 cv2.dnn detector and placed on the map as it lands.
3. `second-look-t2-a-017-candidate-this-flight-opencv5-zoom-nemotron-vl.png`: The second look: a 0.17 candidate, below the review threshold, zoomed from native pixels by OpenCV 5; Nemotron VL calls it two people standing, and a person decides.
4. `trace-which-model-did-what-second-look.png`: The Trace view: detection, the OpenCV 5 zoom_native tool, the model's verdict and the proposal waiting for a person, step by step.
5. `run-t4-fleet-flying-b4-pod-60-conditions.png`: The run: the simulated fleet (Drone 2 flying on with its link lost, Team Two heard via Drone 3's relay), B4 searched at POD 60 %, and the Conditions panel that gates the drones (forecast via Tavily, each value with its quote).
6. `debrief-t6-after-action-report-what-breaks-first.png`: The Debrief after the find: the after-action report, the areas searched at their POD, and what breaks first, in the report's words.

---

## Hackathon-specific questions

**Special awards (opt in):** tick **Agentic Vision** and **Best Use of COOL**.
- Agentic Vision evidence: [agent workflow and a real trace](https://github.com/Drivera0/sightline/blob/main/docs/architecture/agent.md) (OpenCV 5 output changing the next decision), [agent evaluation](https://github.com/Drivera0/sightline/blob/main/docs/report/AGENT_EVAL.md) (correct target in every run, approval gate 12 of 12, about 82 s in all with Token Factory down), report §5.
- Best Use of COOL evidence: [COOL_GRAVITON.md](https://github.com/Drivera0/sightline/blob/main/docs/report/COOL_GRAVITON.md), report §15: on a c6g.4xlarge from the COOL-V3 AMI, the same HERIDAL test scores (0.802 / 0.864 / 0.868) and bit-identical boxes to the pip wheel (538 of 538, 101 of 101 photos); image processing 1.14 to 1.35× faster; `cv2.dnn` not faster; API and worker passed `remote_check.py` 6 of 6 three times; the run cost about $1.40.

**How does the project use AWS? (deployment description)**
The live pipeline runs in us-west-2, set up and torn down by scripts in [`deploy/aws/`](https://github.com/Drivera0/sightline/tree/main/deploy/aws). One EC2 c7i.2xlarge (Amazon Linux 2023) runs one Docker image as three containers: the API, the photo worker running OpenCV 5 `cv2.dnn` (no PyTorch in the image) and Caddy for HTTPS. Photos go to a private S3 bucket (deleted after 30 days), jobs to an SQS FIFO queue (one group per mission, dead-letter queue after 3 failures), metrics and logs to CloudWatch (`PhotoLatencyMs` per step, `DetectionsPerPhoto`, `AgentModelCalls`, a dashboard), and the Nebius and Tavily keys live in Secrets Manager. The instance role reaches only its own bucket prefix, queue, log group and secret; no SSH port is open (SSM). Measured: 7.1 s from upload to processed per 4000×3000 photo. The Arm path runs on COOL on Graviton (above). Report §4.

**AWS endpoint:** https://44-227-39-234.sslip.io (running through the judging period, Oct 27 – Nov 9; `GET /health` answers with the contract version and the cv2 backend)

**Technical report:** https://github.com/Drivera0/sightline/blob/main/docs/report/OPENCV_REPORT.md (every claim, its file and how to regenerate it: [EVIDENCE_INDEX.md](https://github.com/Drivera0/sightline/blob/main/docs/report/EVIDENCE_INDEX.md))

**Team and eligibility:** Daniel Rivera, Grace Chu, Harvir Nijjar and Jason Kim. `<OWNER: confirm age of majority and country/province of residence as the form asks>`

**Existing project / prior work disclosure:** Sightline began at BCS Hackathon 2026 (Oct 16–17, tag `bcs-final-submission`), built together in 36 hours by our team of four: Daniel Rivera (@Drivera0), Grace Chu (@bamobam), Harvir Nijjar (@har-vir) and Jason Kim (@jkiim). That version was a batch tool (one survey, a tiled detector, a map, a Bayesian probability map from a precomputed cache). Everything added since: the OpenCV 5 `cv2.dnn` production detector and its parity table, the OpenCV re-look tools and second look, the live missions, the agent and approval gate, the AWS deployment and COOL run, the radio desk, the fleet simulation, the console and the report (report §13, `git diff bcs-final-submission..opencv-submit`). The OpenCV organizers agreed to the entry. The same project is also entered in the Nebius × NVIDIA Global AI Hackathon. Development used Claude Code (Anthropic) as an AI coding assistant; it is not part of the running product, whose agent is Nemotron on Nebius Token Factory proposing actions that a person approves.

**Licence:** AGPL-3.0-or-later (code and model weights); HERIDAL imagery CC BY 3.0 (the Pyrrö VOC copy).
