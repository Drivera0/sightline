# Nebius Serverless Endpoint: the detector on demand

Lane A. The frozen Sightline detector (weights-v2, OpenCV 5 `cv2.dnn` on CPU, no torch) behind an HTTPS
URL, as a **Nebius Serverless Endpoint**: a photo goes in, boxes come out. The mission worker can send
its detection there instead of running it in-process (`SIGHTLINE_DETECT_URL`). The batch job for the
same detector is in `README.md` next to this file.

| | |
|---|---|
| App | `sightline/serve/detect_app.py`: `POST /detect` (multipart `photo`, optional `?conf=`, default 0.05) → `{width, height, boxes: [{box, conf}], n_candidates, candidate_threshold: 0.29, timing_ms}`; `GET /healthz` |
| Detection | `CvDetector.detect_tiled`, the same path as the pipeline and the batch job: 1024 px slices, overlap 0.2, per-slice NMS, merge NMS, candidates at 0.29 |
| Image | `deploy/nebius/Dockerfile.endpoint` (+ `.dockerignore`): the batch image's base and layers, uvicorn on port 8080; ONNX from release `model-onnx-v2`, checked by SHA256 |
| Registry | `cr.us-north1.nebius.cloud/$REGISTRY_PATH/sightline-detect-endpoint:v1` (registry from `deploy/nebius/.state.env`, gitignored). **Kept**; the endpoint is deleted |
| Worker switch | `SIGHTLINE_DETECT_URL=https://…` (+ `SIGHTLINE_DETECT_TOKEN`) makes `make_detector()` return `RemoteDetector` (`sightline/ml/remote.py`); unset (the default), detection stays in-process. `/health` then reports `"detector": "remote"` |
| Bench | `scripts/nebius_endpoint_bench.py URL PHOTO_DIR`: first request (cold), 50 warm, 4 concurrent, cost per 1,000 photos |
| Tests | `tests/ml/test_remote_detect.py` (the app with a fake detector; the switch against a mocked HTTP server) |

## Deploy, use, delete

```bash
export PATH=$HOME/.nebius/bin:$PATH                       # CLI 0.12.293, profile `sightline` (us-north1 project)
set -a; . deploy/nebius/.state.env; set +a                # REGION=us-north1, REGISTRY_PATH (created by run_job.sh)
IMAGE=cr.$REGION.nebius.cloud/$REGISTRY_PATH/sightline-detect-endpoint:v1

# build + push (5 s: the layers are shared with the batch image already in the registry)
docker build -f deploy/nebius/Dockerfile.endpoint -t sightline-detect-endpoint .
nebius registry configure-helper && docker tag sightline-detect-endpoint "$IMAGE" && docker push "$IMAGE"

# create: about 5 minutes. One command once the image is in the registry:
export SIGHTLINE_DETECT_TOKEN=$(openssl rand -hex 32)
nebius ai endpoint create --name sightline-detect --image "$IMAGE" --container-port 8080 \
  --platform cpu-d3 --preset 8vcpu-32gb --disk-size 30Gi --auth token --token "$SIGHTLINE_DETECT_TOKEN"

export SIGHTLINE_DETECT_URL=$(nebius ai endpoint get-by-name --name sightline-detect --format json \
  | python3 -c 'import json,sys; print(next(u for u in json.load(sys.stdin)["status"]["public_endpoints"] if u.startswith("https://")))')
curl -H "Authorization: Bearer $SIGHTLINE_DETECT_TOKEN" -F photo=@some.jpg "$SIGHTLINE_DETECT_URL/detect"
uv run python scripts/nebius_endpoint_bench.py "$SIGHTLINE_DETECT_URL" PHOTO_DIR --price-per-hour 0.264 --out docs/evidence/nebius_endpoint/<ts>
# the worker / API: same two env vars, then `uv run python -m sightline.api` as usual

nebius ai endpoint delete --id $(nebius ai endpoint get-by-name --name sightline-detect --format jsonpath='{.metadata.id}')
```

Locally, without Nebius: `docker run --rm -p 8080:8080 sightline-detect-endpoint`, then the same `curl` or
bench against `http://localhost:8080` (`SIGHTLINE_DETECT_TOKEN`, if set in the container, is checked by
the app itself; on Nebius the platform checks it in front of the container).

**Cost.** An endpoint is a VM that bills while it runs; there is no per-request price and no scale to
zero (none in the CLI's `create` flags or the endpoint docs, read 2026-10-22). `cpu-d3` `8vcpu-32gb` is
8 × $0.015 + 32 × $0.0045 = **$0.264 per hour** (list prices from Oct 1, 2026, as in `README.md`), plus the
30 GiB network SSD. This run: created 17:45:53Z, deleted 18:09:18Z, 23.4 min ≈ **$0.10**. Delete when
done; `stop` keeps the URL and the token but its billing while stopped is not documented.

## Measured (2026-10-22, us-north1, cpu-d3 / 8vcpu-32gb)

Run files: `docs/evidence/nebius_endpoint/20261022-1747/` (every request's client and server timings, and
`commands.log`, the whole session's commands and output with the token replaced by `<token>`). Client:
the dev machine in the Pacific time zone, so each wall time includes upload over the internet.

| | Fleet photos (creek scenario, 912×684 to 2667×2000) | HERIDAL test photos (4000×3000, 20 slices) |
|---|---|---|
| Cold: `endpoint create` → first `/healthz` 200 | 291.2 s (the create call itself returned at 290.3 s) | |
| Cold: create → first detection | 291.5 s; that request 365 ms | |
| Cold after `stop` → `start` → first detection | 272.9 s (logs show the image downloaded again); request 330 ms | |
| Warm, 50 requests one at a time, client wall p50 / p90 / max | 717 / 3451 / 3504 ms | 5675 / 5797 / 5905 ms |
| of which detection in the container, p50 / p90 | 517 / 3065 ms (by size: 912×684 189 ms, 1309×982 515 ms, 1469×1102 1016 ms, 2667×2000 3057 ms) | 5101 / 5163 ms |
| 4 concurrent, 50 requests | 0.82 photos/s (wall 61.0 s; per request p50 4383 ms) | 0.193 photos/s (wall 259.1 s; p50 20665 ms) |
| **Cost per 1,000 photos** at $0.264/h, best throughput | **$0.089** | **$0.38** |
| Same output as the batch job | f0665: one candidate, box [420, 291, 477, 379] at 0.735, as in the job | |
| Auth | `/detect` and `/healthz` without the token: 401 | |
| While stopped | the URL answers 404 | |

Concurrency adds little (0.193 vs 0.177 photos/s one at a time on full photos): the app runs one photo
at a time and `cv2.dnn` already uses all 8 vCPUs, so 4 in flight only overlap uploads. More throughput
means a bigger preset (detection scales with cores: 16 vCPUs gave 0.68 s per fleet photo in the job) or
more endpoints. For comparison, the batch job did 711 fleet photos for about $0.10 (≈ $0.14 per 1,000
including its 3 min start); the endpoint is the per-photo, answer-in-seconds path, the job the bulk one.

Local Docker on the dev machine (8 pinned CPUs, a busy host, load average 17–27):
`docs/evidence/nebius_endpoint/20261022-local-docker/creek-fleet.json`, `docker run` → first detection
2.6 s (no image pull, model load included), warm p50 266 ms on the same fleet photos.

## Every command and what came back

Times UTC, 2026-10-22. Nothing failed on the Nebius side in this session; the notes are what surprised us.

| Time | Command | Result |
|---|---|---|
| 17:37 | `nebius ai --help`, `nebius ai endpoint create --help`, `… endpoint --help` | create/delete/get/get-by-name/list/logs/operation/restart/ssh/start/stop; no scaling flags. `--platform` help: "default is gpu-h100-sxm in eu-north1 and gpu-h200-sxm elsewhere" |
| 17:40 | `nebius compute platform list --parent-id <us-north1 project> --format json` | `gpu-b300-sxm` and `cpu-d3` (2vcpu-8gb … 256vcpu-1024gb). Our first try merged stderr into the JSON pipe and failed to parse; with `2>/dev/null` it parsed |
| 17:45:02 | `docker push cr.us-north1.nebius.cloud/…/sightline-detect-endpoint:v1` | 5 s, every layer but the last already in the registry |
| 17:45:14 | `nebius ai endpoint create --dry-run --name sightline-detect --image … --container-port 8080 --platform cpu-d3 --preset 8vcpu-32gb --disk-size 30Gi --auth token --token …` | `Endpoint validation succeeded; no resource was created.` |
| 17:45:53 | the same without `--dry-run`, `--format json` | waited 290 s; stderr: `Token: <the token>` and `Endpoint ID: aiendpoint-…`. **The token we passed in is printed back in plain text** |
| 17:50:44 | `nebius ai endpoint get <id> --format json` | `state: RUNNING`, `public_endpoints: ["https://port8080-<id>.tunnel.applications.us-north1.nebius.cloud"]` |
| 17:50–18:02 | bench, parity photo, unauthenticated `curl` | numbers above; 401 on both paths without the token |
| 18:02:02 | `nebius ai endpoint stop --id <id>` | 68 s; prints the endpoint as YAML **including `spec.auth_token` in plain text**; `state: STOPPED` |
| 18:03:10 | `curl $URL/healthz` while stopped | 404 |
| 18:03:10 | `nebius ai endpoint start --id <id>` | 272 s (returned with `state: STARTING` while the instance already said RUNNING); same URL; YAML again with the token |
| 18:07:43 | `nebius ai endpoint logs <id> --tail 30` | the container's stdout, then `Provisioning resources for the workload / Workload initialization started / Downloading container image / Starting workload container` for the restart |
| 18:07:44 | `nebius ai endpoint delete --id <id>` | 98 s; `nebius ai endpoint list` → `No endpoints, jobs, or Devlabs` |

`nebius ai endpoint get` takes the id as an argument; the help marks `--id` as required for `stop`,
`start` and `delete`, while the deploy tutorial writes `delete $ENDPOINT_ID` and the manage page
`delete --id <id>`. We used `--id`.

Docs read 2026-10-22: https://docs.nebius.com/serverless/tutorials/deploy-model.md (GPU only: vLLM on
`gpu-l40s-a`), https://docs.nebius.com/serverless/endpoints/manage.md (CPU-only endpoints need ≥ 20 GiB
disk; 120 Mbps and 300 new connections per second per endpoint; settings can't change after create).
