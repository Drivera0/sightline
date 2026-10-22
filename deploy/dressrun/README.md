# Clean-machine dress run

One command proves Sightline works from nothing (no GPU, no keys, no HERIDAL download, no training)
and times every step:

```bash
bash deploy/dressrun/run.sh          # needs Docker and git; writes runs/dressrun/<timestamp>/times.md
```

## What it proves

`run.sh` sends exactly what a fresh clone has (tracked files plus new files git does not ignore) as
the build context, builds `deploy/dressrun/Dockerfile` with `--no-cache --pull`, runs the container,
and writes `times.md` (stage, seconds, pass/fail) next to the full `build.log` and `run.log`. Every
stage prints `=== STAGE <name> <seconds>s ===`.

| Stage | When | What it shows |
|---|---|---|
| `install-python-deps` | build | `uv sync --frozen --extra ml --extra conditions` installs from `uv.lock` alone (Python 3.11, uv 0.13.4) |
| `install-web-deps` | build | `pnpm install --frozen-lockfile` (Node 22.20, pnpm 9.15.9) |
| `fetch-model` | build | `web/scripts/fetch-model.sh`: the ONNX detector from release `model-onnx-v2`, SHA256-checked |
| `fetch-caches` | build | `web/scripts/fetch-caches.sh`: the `demo-cache` and `real-gps-cache` releases, as the Vercel build does |
| `install-project` | build | the project itself into the same environment |
| `pytest` | run | `uv run pytest tests -q`, keys unset, as CI runs it |
| `smoke` | run | `scripts/smoke.sh`: the whole live-mission loop on a real server, with fakes |
| `validate-demo-cache` | run | the README's `python -m sightline.pipeline validate cache/demo`: every file of the published demo cache passes the contract |
| `demo-cache-metrics` | run | prints the detector numbers the site shows (from the cache's `metrics.json`) |
| `api-remote-check` | run | the mission API on the downloaded caches with the cv2.dnn detector, then `scripts/remote_check.py` against it: health, CORS, a mission, one photo through upload → worker → `photo.processed` with a candidate, the event stream, a 404 |
| `web-build` | run | `VITE_CACHE_DIR=demo pnpm build` |

Keys: with no env vars the agent and the conditions use the built-in fakes (`SIGHTLINE_FAKE_LLM=1`,
`SIGHTLINE_FAKE_TAVILY=1`). If `NEBIUS_API_KEY` or `TAVILY_API_KEY` is set, `run.sh` passes it to
`docker run` by name for the API stage; it is never written into the image. `pytest` and `smoke` always
run without keys.

The photo for `remote_check` is demo-cache frame `f0002` (a published frame the detector finds a
person in) with drone GPS and gimbal metadata added by `stamp_photo.py`, so the check needs no
HERIDAL download. The script's default photo is a HERIDAL **val** photo, used against AWS.

Not run here: `scripts/evaluate_model.py` (the detector numbers from scratch). It needs the HERIDAL
val and test splits and the `weights-v2` checkpoint and takes several minutes on a GPU; the README's
"Reproduce the results" block has the commands.

Skipped tests (4), with pytest's reasons: `test_pose.py:25` "DJI fixture has not been supplied" and
`test_pose.py:39` "HERIDAL test split has not been supplied" (local data); `test_scoring.py:212` "no
detector_metrics.json on this machine" (written by `evaluate_model.py`); `test_turn_api.py:210`
"ffmpeg not installed" (the radio's audio path). None needs a GPU; the torch tests run on the CPU.

Options: `DRESSRUN_CACHE=1` reuses Docker's layer cache (the build times then measure nothing),
`DRESSRUN_CPUS=4` caps the container at 4 CPUs, `DRESSRUN_TAG` names the image. The GitHub Actions
workflow `dressrun` (manual, `workflow_dispatch`) runs the same script and uploads `times.md` and the logs.

## Measured wall time

2026-10-22, commit `7571a94`, AMD Ryzen 9 9950X (16 cores, 32 threads), 30 GB RAM, WSL2, Docker
29.8.2, home broadband; fakes, no keys. From nothing:

| Stage | Seconds | All CPUs | 4 CPUs (`DRESSRUN_CPUS=4`) |
|---|---:|---|---:|
| install-python-deps | 259.3 | pass | |
| install-web-deps | 7.6 | pass | |
| fetch-model | 3.0 | pass | |
| fetch-caches | 8.2 | pass | |
| install-project | 1.7 | pass | 1.3 |
| pytest (1108 passed, 4 skipped) | 158.9 | pass | 122.5 |
| smoke | 13.1 | pass | 12.4 |
| validate-demo-cache | 1.0 | pass | 1.6 |
| demo-cache-metrics | 0.0 | pass | 0.0 |
| api-remote-check | 2.5 | pass | 4.8 |
| web-build | 2.9 | pass | 4.5 |
| **docker build (total)** | 618.6 | pass | |
| **docker run (total)** | 186.6 | pass | 148.1 |
| **end to end** | **805.4** (13.4 min) | pass | |

The build is mostly downloading and unpacking about 3.7 GB of wheels: `uv.lock` pins torch from
PyPI, which brings its CUDA libraries even on a CPU machine (image: 11.2 GB on disk). On a 4-core
laptop, expect **15 to 20 minutes** end to end: the build is bound by the network and the disk, and
the run stages took 2.5 minutes on 4 CPUs.

## Judge's 10-minute path

No Docker, no torch, no training: the pre-built demo cache and the ONNX detector. Needs uv, Node 22
and pnpm. About 3 minutes here once the packages are downloaded (pytest is 2 of them).

```bash
git clone https://github.com/Drivera0/sightline && cd sightline && uv sync --extra conditions   # the Python environment from uv.lock (no torch)
uv run pytest -q                                                                            # 1100+ tests pass; the agent and conditions run on fakes, no keys
curl -fsSL https://github.com/Drivera0/sightline/releases/download/demo-cache/demo-cache.tar.gz | tar -xz -C cache   # the survey the site shows
uv run python -m sightline.pipeline validate cache/demo                                     # every cache file passes the contract (docs/01_CONTRACT.md)
uv run python -c "import json; d = json.load(open('cache/demo/metrics.json'))['detector']; print(d['voc'], d['sar'])"   # the README's detector numbers
SIGHTLINE_FAKE_LLM=1 SIGHTLINE_FAKE_TAVILY=1 bash scripts/smoke.sh                          # the live-mission loop end to end on a real server
(cd web && bash scripts/fetch-model.sh)                                                     # the detector as ONNX (release model-onnx-v2, SHA256-checked)
SIGHTLINE_FAKE_LLM=1 SIGHTLINE_FAKE_TAVILY=1 SIGHTLINE_ONNX=web/public/models/sightline-detector-v2.onnx SIGHTLINE_CORS_ORIGINS=https://sightline-iota-sandy.vercel.app uv run python -m sightline.pipeline serve &   # the mission API, OpenCV 5 cv2.dnn on the CPU
uv run python deploy/dressrun/stamp_photo.py cache/demo/frames/f0002.jpg /tmp/f0002.jpg && uv run python scripts/remote_check.py --api http://127.0.0.1:8000 --photo /tmp/f0002.jpg   # one photo to a candidate, about 1 s
mkdir -p web/public/cache && cp -r cache/demo web/public/cache/ && cd web && pnpm install --frozen-lockfile && VITE_CACHE_DIR=demo pnpm dev   # the site on the demo survey
```
