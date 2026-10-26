# COOL on AWS Graviton: the Sightline detector and API on the Arm path

Measured 26 Oct 2026 (UTC) on one AWS **c6g.4xlarge** (Graviton2, 16 vCPU, 32 GB) in us-west-2,
started from the **COOL-V3** AMI (`ami-03040ae9b0be1f439`, "Cloud Optimized OpenCV for AWS Graviton",
Marketplace product code `4eb70u7a6gb5bj1ijix5jlokv`). Every file quoted here is in
[`docs/evidence/cool/`](../evidence/cool/); `scripts/cool_bench.sh` produced them and
`deploy/aws/cool/cool.sh` starts, reads and terminates the instance.

**Result.**

- **COOL runs Sightline's core workload on Graviton and gives the published numbers.** The 101 HERIDAL
  test photos through `cv2.dnn` (1024 px tiles, 20 per photo) score VOC P / R / AP50
  **0.802 / 0.864 / 0.868** with COOL's `cv2`, the same as `detector_metrics.json`
  (`scripts/reproduce_cv2.py` prints MATCH). The boxes are those of the pip wheel of the same OpenCV
  version **to the pixel and to the confidence: 538 of 538 saved boxes, 363 of 363 at the threshold,
  101 of 101 photos identical**.
- **The API and its photo worker run on COOL too:** `scripts/remote_check.py` passes **6 / 6**, three
  times, against `python -m sightline.pipeline serve` on the Graviton box (bound to 127.0.0.1, reached
  through SSM; no port open to the internet): 6.2 to 7.2 s from upload to `photo.processed`, of which
  `cv2.dnn` is 5.1 to 5.7 s.
- **Image processing is faster with COOL than with the pip wheel of the same version**, on the calls
  Sightline makes, on real 4000×3000 photos: `GaussianBlur` on the full photo **1.32×** (8.2 against
  10.9 ms), the second look's CLAHE contrast step **1.23×** (1.71 against 2.10 ms), `cvtColor` to grey
  **1.19×**, the letterbox `resize` **1.16×**, the second look's zoom (`INTER_CUBIC`) **1.14×**;
  single-threaded the gains are about the same (1.15 to 1.35×). JPEG decoding, `blobFromImage`, the
  canopy box filter and `fillPoly` are within 5 %.
- **The detector itself is not faster with COOL.** With 4 processes × 4 threads (the throughput
  setting) COOL and the pip wheel are equal: **3.80 against 3.77 s per photo** of wall time. In one
  process the pip wheel was 9 % faster (5.35 against 5.85 s per photo, both with a large spread between
  runs; alternating runs below). That is what COOL's listing leads one to expect: it names image
  processing, not `dnn`. Image processing is under 1 % of a photo's time in Sightline, so for this
  workload COOL changes the cost of the second look and the map, not of detection.
- **Cost:** $0.31 per 500 photos on COOL (c6g.4xlarge at $0.544/h plus $0.04/h for COOL), $0.29 with
  the pip wheel on the same box. The x86 deployment on c7i.4xlarge, same vCPU count, processes a photo
  faster (3.5 s in the worker against 6.0 s here), so per photo Graviton2 costs about 40 % more for this
  model; a newer Graviton was not available for this listing in us-west-2 (below).

## What COOL is, on this AMI

| | COOL-V3 (`/opt/cool`) | Baseline: pip `opencv-python==4.12.0.88` | Reference: pip `opencv-python==5.0.0.93` (the project's pin) |
|---|---|---|---|
| OpenCV | **4.12.0** (`Version control: 4.12.0-dirty`) | 4.12.0 | 5.0.0 |
| Python binding | `/opt/cool/python_3.12/site-packages/cv2/python-3.12/cv2.cpython-312-aarch64-linux-gnu.so`, libraries in `/opt/cool/cpp_sdk/lib` | wheel | wheel |
| Compiler | GCC 13.3.0 | GCC 10.2.1 | GCC 14.2.1 |
| CPU baseline / dispatch | NEON, FP16, **DOTPROD** in the baseline; BF16 dispatched | NEON, FP16; DOTPROD, FP16, BF16 dispatched | NEON, FP16; DOTPROD, FP16, BF16 dispatched |
| Custom HAL | carotene + **KleidiCV 0.5.0** | carotene only | carotene + KleidiCV 26.03 |
| Parallel framework | **TBB 2022.1** | pthreads | pthreads |
| JPEG | system libjpeg (Ubuntu, ver 80) | bundled libjpeg-turbo 3.1.0 | bundled libjpeg-turbo 3.1.2 |
| numpy | 1.26.4 (built against 1.26.4) | 1.26.4 (installed `--no-deps`) | 1.26.4 (installed `--no-deps`) |

From `buildinfo-*.txt` (`cv2.getBuildInformation()`). The AMI also carries COOL builds for Python 3.10
and 3.11, a C++ SDK and a benchmark suite (`cool_files.txt`: its own table reports Python
"Augmentation" 27.3 ms with pip against 19.1 ms with COOL). The OS is Ubuntu 24.04.3, kernel
6.14.0-1018-aws (`machine.txt`).

Two things differ from what I expected before the run, and both change the comparison:

- **COOL-V3 is OpenCV 4.12, not 5.0.** Sightline pins OpenCV 5.0 (`pyproject.toml`). The fair baseline
  for COOL is the pip wheel of the *same* version, 4.12.0.88; I ran the 5.0 wheel as a third column so
  the project's own path on this CPU is measured too. The detector runs on 4.12 unchanged: the CPU path
  of `sightline/ml/detect_cv.py` calls `cv2.dnn.readNetFromONNX` without OpenCV 5's `engine=`
  argument. Two things on 4.12: the variable-size ONNX export does not load (the importer fails on a
  `Concat`), so every run here uses the fixed 1024 px export `sightline-detector-v2.onnx`
  (release `model-onnx-v2`, SHA-256 checked); and `CvDetector`'s probe for a variable-size model logs an
  `[ERROR]` from the reshape layer once per process before it falls back to the square input, which is
  expected and harmless (`reproduce-cool.log`).
- **The listing accepts only Graviton2 in us-west-2.** I planned a c8g.4xlarge (Graviton4). With the
  subscription active, `aws ec2 run-instances --dry-run` answered `UnsupportedOperation` for c8g, c7g,
  m8g and m7g with all three COOL AMIs in us-west-2 (COOL-V3, COOL-V2 and the older
  "OpenCV-graviton-optimized" image) and `DryRunOperation` (allowed) for c6g.2xlarge, c6g.4xlarge and
  m6g.4xlarge (`marketplace-dryrun.txt`). So every Arm number here is Graviton2 (Neoverse N1, 2.5 GHz,
  `lscpu` in `machine.txt`), which has no SVE and no BF16 hardware.

## Method

One instance, one interpreter (the COOL venv's base CPython 3.12.3), one numpy (1.26.4), the same
inputs; only `cv2` differs between the three environments:

- **cool:** `/opt/cool/venvs/python_3.12/bin/python` with what that venv's `bin/activate` sets:
  `PYTHONPATH=/opt/cool/python_3.12/site-packages/cv2/python-3.12`,
  `LD_LIBRARY_PATH=/opt/cool/cpp_sdk/lib`. `buildinfo-cool.txt` shows the `cv2` file it loaded.
- **pip:** a new venv from the same interpreter with `opencv-python==4.12.0.88`.
- **pip5:** the same with `opencv-python==5.0.0.93`.

The wheels declare `numpy>=2`; they were installed with `--no-deps` next to numpy 1.26.4 so numpy is
the same in all three, and the script checks that each one imports and runs before it goes on.
pydantic and Pillow (for JPEG headers) come from one shared directory.

Inputs: the 101 photos and labels of the HERIDAL test split (release `data-v1`), the ONNX above and
the published `detector_metrics.json` (release `weights-v2`), downloaded on the instance from the
public GitHub releases. The threshold is the one frozen on val in sprint 1 (0.29); test is only
re-scored, nothing is tuned.

Per environment, in this order (`phases.log` has the times):

1. `scripts/cool_imgproc_bench.py`: ten image-processing calls Sightline makes, each at the size it
   makes it, on the first 10 test photos, 20 timed repeats per photo after a warm-up, at the default
   thread count (16) and at one thread; medians in ms. It also hashes each output on the first photo.
2. `scripts/reproduce_cv2.py`: all 101 photos in 4 processes × 4 threads, scored, compared with the
   published numbers, under `/usr/bin/time -v` (CPU %, max RSS).
3. `scripts/bench_cv2_backend.py --runs 2`: one process, one photo after another, s per photo and the
   network's ms per 1024 px slice (`blobFromImage` + `setInput` + `forward`, 2,000 slices), boxes saved.

Then `imgproc` once more for each environment in reverse order (drift check: every median within 4 %
of the first pass, except `fillPoly` at 0.015 against 0.016 ms) and `bench_cv2_backend.py --compare` between each pair. `vmstat` sampled the CPU
every 5 s throughout (`vmstat.log`). After that, nine alternating 30-photo single-process runs
(cool, pip, pip5, three rounds) and `scripts/cool_api_check.sh`.

## Results

### The detector (101 test photos)

| Environment | OpenCV | 1 process: s / photo | ms / slice (forward) | 4 × 4 processes: s / photo | CPU used (of 1,600 %) | VOC P / R / AP50 | vs published | $ / 500 photos |
|---|---|---|---|---|---|---|---|---|
| **COOL-V3** | 4.12.0 | 5.85 ± 0.92 (5.20, 6.49) | 287 ± 47 | **3.80** | 1,523 % | **0.802 / 0.864 / 0.868** | MATCH | **$0.31** |
| pip wheel | 4.12.0 | 5.35 ± 0.77 (5.89, 4.80) | 262 ± 38 | **3.77** | 1,422 % | 0.802 / 0.864 / 0.868 | MATCH | $0.29 |
| pip wheel (project pin) | 5.0.0 | 4.85 ± 0.03 (4.83, 4.86) | 237 ± 1 | 5.38 | 1,555 % | 0.802 / 0.864 / 0.868 | MATCH | $0.41 |

`bench-*.json`, `reproduce-*.log`, `time-reproduce-*.txt`; mean ± sample standard deviation of 2 runs,
the runs in brackets. "$ / 500 photos" is the 4-process wall time × 500 at the on-demand price,
c6g.4xlarge $0.544/h, plus $0.04/h for COOL (the Marketplace software price after the trial); the pip
rows are priced as if run on the same instance without the COOL fee.

**Parity** (`parity.txt`, boxes matched one-to-one per photo, `parity_table.agreement`):

| Pair | Saved boxes (≥ 0.05) matched at IoU ≥ 0.95 | At the threshold (≥ 0.29) | Largest confidence difference | Photos with identical boxes and confidences |
|---|---|---|---|---|
| pip 4.12 vs **COOL** | 538 / 538 | 363 / 363 | 0.0000 | **101 / 101** |
| pip 5.0 vs COOL | 538 / 538 | 363 / 363 | 0.0000 (rounded) | 4 / 101 |
| pip 5.0 vs pip 4.12 | 538 / 538 | 363 / 363 | 0.0000 (rounded) | 4 / 101 |

COOL's detections are bit-for-bit those of the stock 4.12 build. OpenCV 5's new engine gives the same
boxes to within rounding in the last digits of the confidence on 97 photos; the scores are identical.

Reading the numbers:

- **Throughput is the same with COOL and with the pip wheel**: 3.80 against 3.77 s per photo, a
  0.8 % difference in one run each. COOL used more CPU for it (1,523 against 1,422 %), which fits its
  TBB thread pool spinning while it waits.
- **In one process the order is pip 5.0, pip 4.12, COOL, and both 4.12 builds are noisy**: their two
  runs differ by 25 % (COOL 5.20 then 6.49 s; pip 5.89 then 4.80 s), the 5.0 wheel's by under 1 %.
  Nine alternating runs of the first 30 photos (cool, pip, pip5, three rounds, `alternating.log`,
  `alt-*.json`) settle the order: **COOL 5.15, 5.12, 5.16 s per photo; pip 4.12 4.58, 4.60, 4.95 s;
  pip 5.0 4.85, 4.83, 4.83 s**. In one process COOL is about 9 % slower than the stock 4.12 wheel on
  this model (248 to 250 against 221 to 239 ms per slice), in every round.
- **OpenCV 5's new engine is the fastest in one process and the slowest in four** (4.85 s, then 5.38 s
  per photo). I did not look into why; one candidate is that the new engine's own threading competes
  across four processes on 16 cores. For Sightline's AWS worker, which runs one process per instance,
  the one-process column is the relevant one.

### Image processing (10 photos × 20 repeats, medians)

| Call (where Sightline makes it) | COOL ms | pip 4.12 ms | pip / COOL | pip 5.0 ms | COOL, 1 thread | pip 4.12, 1 thread | pip / COOL, 1 thread | Same output as pip 4.12 |
|---|---|---|---|---|---|---|---|---|
| `GaussianBlur` σ 1, full 4000×3000 photo (reference) | 8.23 | 10.87 | **1.32×** | 8.51 | 114.5 | 154.3 | **1.35×** | yes |
| `enhance_contrast`: LAB, CLAHE, `GaussianBlur`, `addWeighted` on a 384 px crop (second look) | 1.71 | 2.10 | **1.23×** | 1.74 | 5.16 | 6.17 | 1.20× | no |
| `cvtColor` BGR → grey, full photo | 0.55 | 0.65 | **1.19×** | 0.47 | 7.73 | 9.64 | 1.25× | yes |
| `resize` `INTER_LINEAR`, full photo → 1024 px (letterbox) | 0.78 | 0.90 | **1.16×** | 0.65 | 8.39 | 9.97 | 1.19× | yes |
| `zoom_native`: 150 px window → 384 px, `INTER_CUBIC` (second look) | 0.49 | 0.56 | 1.14× | 0.55 | 0.92 | 1.06 | 1.16× | no |
| `resize` `INTER_CUBIC` 2×, 512 → 1024 px (re-detect) | 0.62 | 0.65 | 1.05× | 0.63 | 7.16 | 8.20 | 1.15× | no |
| `dnn.blobFromImage`, one 1024 px slice (detector) | 2.29 | 2.35 | 1.03× | 2.26 | 2.32 | 2.30 | 0.99× | yes |
| `blur` 7×7 on float64, 1000×750 (canopy, map) | 7.01 | 7.11 | 1.01× | 7.08 | 7.08 | 6.98 | 0.99× | yes |
| `imread`, one 4000×3000 JPEG | 131.5 | 130.6 | 0.99× | 124.3 | 131.7 | 130.0 | 0.99× | yes |
| `fillPoly`, one map cell in a 300 px window | 0.016 | 0.015 | 0.95× | 0.013 | 0.016 | 0.015 | 0.94× | yes |

`imgproc-*.json` (second pass: `imgproc-*-2.json`). "Same output" compares a SHA-256 of each output on
the first photo. `pixel-diff.txt` has the size of the differences on that photo: the three "no" rows
differ by at most 1 grey level (the `INTER_CUBIC` resizes, on 0.001 % of values) and 4 levels (the
CLAHE step, on 0.002 %); every other output is identical, including the detector's own calls
(`imread`, the letterbox `resize`, `blobFromImage`), which is why the boxes are.

- **Where COOL helps, it helps by 14 to 35 %**: the Gaussian, colour conversion, resizing and the CLAHE
  step, both multi-threaded and on one thread, so it is the kernels (KleidiCV, the DOTPROD baseline,
  GCC 13), not only TBB.
- **The OpenCV 5.0 wheel closes most of the gap**: it ships KleidiCV 26.03 too, and its Gaussian (8.51
  ms), CLAHE step (1.74 ms) and resize (0.65 ms) are within 4 % of COOL or faster. Against the
  project's own pin, COOL's image-processing lead is small.
- **For Sightline the image processing is a small share.** Per candidate the second look spends about
  2.8 ms in these calls with COOL against 3.3 ms with the pip wheel; per photo the detector's forward
  passes take 4.7 to 5.7 s. COOL does not change the per-photo time in a way the live map would show.

### The API and worker on COOL (`scripts/cool_api_check.sh`)

The same API the x86 deployment runs, started with COOL's `cv2` and the local photo queue (a worker
thread instead of SQS), with no model or Tavily keys on the box (the agent's second look and live
conditions are off; `SIGHTLINE_FAKE_TAVILY=1`). `remote_check.py` with its usual HERIDAL val photo
(`train_BRK_2048.jpg`, which carries the DJI pose; copied to the box through S3), three times:
**6 / 6 checks pass each time** (health with `backend: cv2`, CORS for the Vercel site, create a
mission, photo → `photo.processed`, the event stream replays it, an unknown mission is a 404;
the HTTPS part of the first check is not exercised on 127.0.0.1).

| Instance | vCPU | OpenCV | In the worker | of which `cv2.dnn` | Upload to "processed" | $/h |
|---|---|---|---|---|---|---|
| **c6g.4xlarge, COOL-V3 (Graviton2)** | 16 | COOL 4.12.0 | 5.7, 6.1, 6.3 s | 5.1, 5.5, 5.7 s | 6.2, 7.2, 7.2 s | 0.544 + 0.04 |
| c7i.4xlarge (x86, `docs/report/OPENCV_REPORT.md` §4) | 16 | pip 5.0.0, in Docker | 3.5 s | 3.1 s | 4.9 s | 0.714 |
| c7i.2xlarge (x86, the deployed default) | 8 | pip 5.0.0, in Docker | 5.1 s | 4.7 s | 7.1 s | 0.36 |

`api-check-*.txt`, `api-server.log`. The x86 rows are the earlier measurements, not re-run here; their
build (OpenCV 5.0, the variable-size ONNX, a container, SQS) is not the same as this one. Per photo in
the worker, $0.584/h × 6.0 s is about $0.00097 on Graviton2 against $0.714/h × 3.5 s ≈ $0.00069 on
c7i.4xlarge and $0.36/h × 5.1 s ≈ $0.00051 on c7i.2xlarge.

## How x86 and Arm fit together

Sightline's deployed API is one x86 instance (c7i.2xlarge) with the API, the photo worker and Caddy in
containers, SQS between them (`deploy/aws/`, report §4). The Graviton box is a second, separate
deployment of the same code: same repository, same ONNX, same scoring, an Arm build of OpenCV, no
container. The API is the same process, so the Arm box can stand in for the x86 one as a whole, which
the check above shows. Running the Arm instance as an extra **worker on the existing SQS queue**
(`--queue sqs`) is what the code supports (the worker is `python -m sightline.pipeline worker`, and the
queue's FIFO groups keep each mission's photos in order), but I have not run that split: the x86 API
was kept stopped, and this box's role reads no queue and no secret.

Security as on x86: the instance has its own role (`sightline-cool-ec2`: SSM, `s3:PutObject` under
`cool/` in the project bucket and `s3:GetObject` under `cool/inputs/`), its own security group with
**no inbound rules**, IMDSv2 only, an encrypted root volume, no SSH key, and a shutdown timer that
terminates it after 4 hours whatever happens (`--instance-initiated-shutdown-behavior terminate`). It
is tagged `project=sightline-cool` so `deploy/aws/setup.sh`, which finds its instance by
`project=sightline`, never picks it up.

## Cost of this run

The instance ran from 01:32 to 04:00 UTC on 26 Oct (about 2.5 h, including one failed first start and
the checks after the bench): c6g.4xlarge at $0.544/h is about $1.34, the 80 GB gp3 volume a few cents, and the COOL software is free in the 7-day trial
($0.04/h after it). The Marketplace subscription should be cancelled before the trial ends.

## Limits

- **Graviton2 only.** The listing did not accept Graviton3 or 4 types in us-west-2; Neoverse V1/V2
  (SVE, BF16, wider vectors) may change both the image-processing and the `dnn` numbers.
- **OpenCV 4.12 for COOL, 5.0 for the project.** COOL is compared with the pip wheel of its own
  version. Sightline in production pins 5.0, and the 5.0 wheel already has most of COOL's
  image-processing gain here.
- **One instance, one session.** The 4-process numbers are one run per environment; the 1-process
  numbers are 2 runs of 101 photos plus 3 alternating runs of 30, and the 4.12 builds vary by up to 25 %
  between runs. Cloud instances are not quiet machines.
- **Not measured:** COOL's C++ SDK, video (the AMI's own suite has a transcode test; Sightline does not
  decode video), a TBB thread setting other than the default, and an SQS worker on Arm beside the x86
  API.

## Reproduce

```bash
# once: subscribe to "Cloud Optimized OpenCV for AWS Graviton" on AWS Marketplace (7-day free trial)
aws ec2 run-instances --dry-run --region us-west-2 --image-id ami-03040ae9b0be1f439 \
    --instance-type c6g.4xlarge          # DryRunOperation = allowed; OptInRequired = not subscribed
GIT_REF=main bash deploy/aws/cool/cool.sh launch    # the bench runs at boot (about 85 min)
bash deploy/aws/cool/cool.sh status                 # phases so far; "all done" at the end
bash deploy/aws/cool/cool.sh fetch                  # results to docs/evidence/cool/
python scripts/cool_summary.py docs/evidence/cool   # the tables above
bash deploy/aws/cool/cool.sh terminate              # instance, security group and role
```

On any COOL instance by hand (as root): `bash scripts/cool_bench.sh` (`RUNS=1 PHOTOS=20` for a quick
pass), then, with the val photo copied to `data/heridal/yolo_full/val/images/`,
`bash scripts/cool_api_check.sh`.
