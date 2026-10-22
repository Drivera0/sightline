# AWS deployment (OpenCV entry)

Lane D owns the AWS deployment (LANE_D §5.7, task D-W1). Lane A built **the image** (issue #23);
everything under "Still to do" is D's. Add to this file as pieces land so nobody rebuilds them.

## The image (done, lane A)

`deploy/aws/Dockerfile`: one image for both containers, `api` and `worker`.

| | |
|---|---|
| Base | `python:3.11-slim` + `libgl1`, `libglib2.0-0` (needed by `opencv-python`, which we pin instead of the headless build because ultralytics and sahi require it) |
| Python | `uv sync --frozen --no-dev` from `uv.lock`; extras through `--build-arg UV_EXTRAS="--extra agent --extra conditions --extra aws"` once D-C1 adds them |
| Detector | OpenCV 5 `cv2.dnn`, no torch. The variable-size ONNX (`sightline-detector-v2-dynamic.onnx`, release `model-onnx-v2`) is downloaded at build and checked by SHA256; `SIGHTLINE_ONNX` points at it, `SIGHTLINE_BACKEND=cv2` |
| Default command | `python -m sightline.pipeline serve --host 0.0.0.0 --port 8000` (the current upload API) |
| Build context | the repo root; `Dockerfile.dockerignore` sends only `pyproject.toml`, `uv.lock`, `README.md`, `LICENSE`, `sightline/` and the check script |

```bash
docker build -f deploy/aws/Dockerfile -t sightline .                  # from the repo root
docker run --rm sightline python scripts/container_check.py           # can it detect, and how fast?
docker run --rm -p 8000:8000 -e NEBIUS_API_KEY sightline              # the API
```

`scripts/container_check.py` builds the detector exactly as the pipeline does (`make_detector`) and prints one
JSON line: backend, ONNX, threads, CPUs, ms per 1024 px slice and estimated seconds per 4000×3000 photo; exit 1
if it can't detect. Run it on the instance before choosing a size: `cv2.dnn` needs about 30 CPU-seconds per full
photo (1.9 s on a 16-core desktop, about 0.1 s per 1000×750 frame).

**Built and checked locally (2026-10-20, Docker 29.8 on WSL2):** image 1.09 GB, build about 45 s;
`container_check.py` inside it: `ok`, cv2.dnn with the variable-size ONNX, 32 threads, 128 ms per slice
(≈ 2.6 s per 4000×3000 photo); `docker run -p 8000:8000 sightline` serves the API (`/docs` → 200).

Secrets: pass `NEBIUS_API_KEY` and `TAVILY_API_KEY` as environment variables (from Secrets Manager on AWS); never
bake them into the image.

## The deployment (lane A for lane D, issue #51)

```
browser (Vercel) ── HTTPS ──► Caddy ──► api container ──► SQS FIFO (one group per mission) ──► worker container
                    <ip>.sslip.io        POST /photos: original → S3, job → SQS     cv2.dnn pipeline, agent hooks
                                         SSE reads events.jsonl ◄── shared EBS volume (missions/) ──┘
CloudWatch: container logs (/sightline), metrics (namespace Sightline), dashboard · Secrets Manager: API keys
```

| File | What it does |
|---|---|
| `docker-compose.yml` | `api` (`serve --queue sqs --radio text`), `worker` (`worker`), `caddy`; one image; mission files on a volume shared by api and worker; container logs to CloudWatch |
| `Caddyfile` | HTTPS with an automatic certificate for `<elastic-ip>.sslip.io` (no DNS to set up); SSE unbuffered |
| `iam-policy.json` | the instance role, least privilege: `missions/*` in the bucket, the one queue, `PutMetricData` in namespace `Sightline` only, the log group, the one secret. Plus SSM for shell access (no SSH port open) |
| `setup.sh` | idempotent: S3 (30-day lifecycle, private), SQS FIFO + dead-letter queue (3 tries), the secret, the role, a security group (80, 443), the log group, an Elastic IP, the instance (Amazon Linux 2023, builds this image from GitHub on first boot), the dashboard, and a $20 budget alarm with `BUDGET_EMAIL` |
| `teardown.sh` | deletes all of it (asks first) |

The code it runs: `sightline/mission/aws.py` (`SqsQueue`, `CloudWatchMetrics`, `load_secrets`), the `worker` command and
`serve --queue sqs` (`sightline/pipeline/__main__.py`). SQS delivers at least once, so `ingest_photo` skips a frame it
already has; the API's SSE also reads events the worker appends (`MissionStore.subscribe`). Tests: `tests/pipeline/test_aws.py`.

```bash
aws sso login                                         # credentials for the CLI
bash deploy/aws/setup.sh                              # ~2 min, then ~5 min for the instance to build and start
curl https://<ip-with-dashes>.sslip.io/health         # setup.sh prints the address
aws ec2 stop-instances --instance-ids <id>            # when not demoing (start-instances to resume)
bash deploy/aws/teardown.sh                           # everything gone
```

On Vercel, set `VITE_API_URL=https://<ip-with-dashes>.sslip.io` so the site's live missions use it
(`SIGHTLINE_CORS_ORIGINS` in `setup.sh` already allows the Vercel site).

**Cost:** c7i.2xlarge (8 vCPU, the default since Oct 22) is about $0.36 an hour in us-west-2 (≈ $8.60 a day running; c7i.xlarge $0.18 missed the 10 s per photo target); S3, SQS, CloudWatch and
Secrets Manager stay well under $1 for a demo. Stop the instance between demos; `teardown.sh` after judging.

**Checked locally (2026-10-21):** the image (with the `agent`, `conditions` and `aws` extras) runs the mission API; one
real HERIDAL val photo through `POST /photos` → `photo.processed` in 2.4 s (cv2.dnn 2.0 s, 32 threads).

**Deployed (2026-10-22, us-west-2, c7i.xlarge, 4 vCPU):** `https://44-227-39-234.sslip.io/health` → `{"status":"ok",
"contract_version":"1.2","backend":"cv2"}`. Three real HERIDAL **val** photos (4000×3000) uploaded at once: all three
`photo.processed` over SSE 31 s after the upload began, the worker taking them one at a time, **about 10 s each**
(cv2.dnn 9.4–9.8 s, pose 0.2 s, store 0.2–0.4 s); the agent's second look ran on Nemotron with the key from Secrets
Manager (5 verdicts). cv2.dnn needs ~30 CPU-seconds per full photo, so a bigger instance is roughly linear: 8 vCPU ≈ 5 s,
16 vCPU ≈ 2.5 s (`INSTANCE_TYPE=c7i.4xlarge`). Found on the first run, fixed in `setup.sh`: boto3 needs
`AWS_DEFAULT_REGION` (not `AWS_REGION`), and the secret's ARN must come from the create call.

**Before a demo or submitting, run the remote check** (start the instance first if it's stopped):

```bash
aws ec2 start-instances --instance-ids <id>           # ~1 min; the containers come back on their own
uv run python scripts/remote_check.py --api https://<ip-with-dashes>.sslip.io --mission <an earlier mission id>
```

It checks HTTPS + `/health`, CORS for the Vercel site, that an earlier mission survived, one real val photo through
upload → SQS → worker → `photo.processed`, the event stream, and a 404. **Tested 2026-10-22: all 7 pass before and after
a stop/start of the instance** (same address, data kept, API back 5 s after the instance is running; the first photo
after a boot took 14.5 s, then ~11 s).

**Bigger only while recording:** `bash deploy/aws/resize.sh c7i.4xlarge --start` (stops, resizes, starts, waits for
the API), then `bash deploy/aws/resize.sh c7i.2xlarge` afterwards (back to the default size, left stopped). Tested
2026-10-22: on c7i.4xlarge the remote check passed with a photo in **3.5 s in the worker (cv2.dnn 3.1 s)**, the first
photo after a boot, against ~12 s on c7i.xlarge. Found while testing it: AWS reports the old size for a few seconds after
a change, so the script waits until it reports the new one.

## Still to do

- [x] `worker` command, SQS FIFO queue, S3 originals, CloudWatch metrics, Secrets Manager (lane A)
- [x] `docker-compose.yml`, Caddy (HTTPS, SSE unbuffered), `setup.sh`, `teardown.sh`, `iam-policy.json` (lane A)
- [x] first `docker build` + `container_check.py` (locally, lane A; numbers above)
- [x] `setup.sh` run on the team account (lane A); per-photo latency above
- [x] Instance size: **c7i.2xlarge** normally (since 2026-10-22: remote check 7.1 s upload → processed, cv2.dnn 4.7 s; c7i.xlarge took 11.5 s, over the 10 s target, and batching slices, the FP16 target and OpenCV's ORT engine gave no speed-up), stopped between demos; c7i.4xlarge while recording (`resize.sh`)
- [x] CloudWatch graphs for the OpenCV report §6, from a 20-photo run on c7i.xlarge (`docs/architecture/aws/latency.png`, `queue-agent.png`)
- [x] `update.sh` (deploy the latest `main` over SSM: start, fetch, rebuild, recreate, wait for `/health`). Run 2026-10-22 to `3806c20` (#86); `remote_check.py` all 7 passed (val photo 13.5 s upload → processed); debrief and sector outlines answer on AWS; instance stopped after
