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

## Still to do (lane D)

- [ ] `worker` command (`python -m sightline.pipeline worker`, LANE_D §4) and the per-photo pipeline it runs;
      build its detector with `sightline.ml.backend.make_detector()` (issue #8)
- [ ] `docker-compose.yml` (api, worker, caddy), Caddy for HTTPS, SSE with buffering off
- [ ] `setup.sh`, `teardown.sh`, `iam-policy.json`
- [ ] S3 bucket, SQS queue + DLQ, EC2 instance, EBS, Secrets Manager, CloudWatch dashboard, $20 budget alarm
- [x] first `docker build` + `container_check.py` (locally, lane A; numbers above)
- [ ] `container_check.py` on the instance; record the numbers in the OpenCV report §6
