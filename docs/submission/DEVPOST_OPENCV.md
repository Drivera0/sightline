# Devpost draft: OpenCV AI Competition 2026

**Name:** Sightline
**Tagline:** The brain of a drone search.
**Repo:** https://github.com/Drivera0/sightline (tag `opencv-submit`)
**Report:** `docs/report/OPENCV_REPORT.md`
**Demo:** https://sightline-iota-sandy.vercel.app · **Live API (AWS):** https://44-227-39-234.sslip.io (started for judging)
**Video:** TODO (≤ 5 min)

## The problem

Search-and-rescue drones bring back hundreds of photos per flight. A missing person is about 70 px wide
in each, and reviewing by eye takes about 33 s a photo.

## What it does

Sightline finds the likeliest people first and puts them on a map. It keeps a probability map of where
the person could still be, which every photo, review and ground report updates. It proposes where the
drones and the teams should go next, and a person approves each move. It assists; **it never declares an
area clear.**

## OpenCV 5 at the centre

- **The detector runs on OpenCV 5 `cv2.dnn`** (YOLO11s exported to ONNX, tiled at native resolution). It
  gives the same scores as the PyTorch path on the HERIDAL test set (parity table in the report, §4.1).
  It runs on CPU on the AWS worker and in a Nebius Serverless Job.
- **OpenCV 5 re-look tools** for uncertain detections: CLAHE contrast, native-resolution zoom and a
  re-detection pass. Their images go to a vision model (Nemotron VL) for a second look, and that verdict
  changes what the agent proposes next. The report traces two chains end to end (§5).
- **Results on HERIDAL test** (101 photos, 337 people, never used for tuning):
  - Recall 0.864 and precision 0.802 under strict VOC scoring.
  - 0.896 and 0.898 under the human study's scoring, where people reviewing by eye found 68 %.

## Agentic Vision, with a person in charge

Every OpenCV result, model call, tool call and decision is in the mission's trace. The agent proposes
and the search manager approves, edits or rejects. Nothing moves a drone or reaches a team without
approval.

## AWS

A live mission's photo goes to S3 and an SQS job. A worker runs the pose, OpenCV 5 `cv2.dnn` and the
map step. The browser follows over server-sent events. CloudWatch shows latency and the queue, and the
API keys are in Secrets Manager. A photo takes about 11 s on 4 vCPUs and 3.5 s on 16 (report §6).

## Honest about limits

Groups, clothing that matches rock, and people lying down are where the detector misses. The second
look abstains on the smallest people. The fleet and the demo flight are simulated and labelled.
Everything is in report §8.
