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

**Cost:** c7i.xlarge (4 vCPU) is about $0.18 an hour in us-west-2 (≈ $4.30 a day running); S3, SQS, CloudWatch and
Secrets Manager stay well under $1 for a demo. Stop the instance between demos; `teardown.sh` after judging.

**Checked locally (2026-10-21):** the image (with the `agent`, `conditions` and `aws` extras) runs the mission API; one
real HERIDAL val photo through `POST /photos` → `photo.processed` in 2.4 s (cv2.dnn 2.0 s, 32 threads).

## Still to do

- [x] `worker` command, SQS FIFO queue, S3 originals, CloudWatch metrics, Secrets Manager (lane A)
- [x] `docker-compose.yml`, Caddy (HTTPS, SSE unbuffered), `setup.sh`, `teardown.sh`, `iam-policy.json` (lane A)
- [x] first `docker build` + `container_check.py` (locally, lane A; numbers above)
- [ ] Run `setup.sh` on the team account; `container_check.py` on the instance; per-photo latency and a dashboard
      screenshot for the OpenCV report §6
