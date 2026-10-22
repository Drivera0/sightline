# Nebius Serverless Job: batch detection (A-N1)

Lane A. The fleet scenario's photos (lane C, C-F2) are detected in a batch as a **Nebius Serverless Job**
("process sensor data at scale", Physical AI track). The job runs the Sightline detector on OpenCV 5
`cv2.dnn`, no torch.

| | |
|---|---|
| Image | `deploy/nebius/Dockerfile` (+ `Dockerfile.dockerignore`), 1.09 GB, the variable-size ONNX from release `model-onnx-v2` checked by SHA256 |
| Command | `nebius_batch_detect.py IN_DIR OUT_DIR` → `OUT_DIR/detections_raw.json` (run_survey's format) + `job_summary.json` (photos, wall time, s/photo, CPUs) |
| Checked locally | 2026-10-20, Docker on WSL2: 20 demo frames in 1.7 s (0.09 s each, 32 CPUs); output identical to the published demo cache |

```bash
docker build -f deploy/nebius/Dockerfile -t sightline-nebius .                        # from the repo root
docker run --rm --user $(id -u):$(id -g) -v $PWD/photos:/in:ro -v $PWD/out:/out sightline-nebius /in /out
```

## Running it (`run_job.sh`)

```bash
curl -sSL https://artifacts.nebius.cloud/cli/install.sh | bash && exec -l $SHELL   # once: the nebius CLI
nebius profile create                                   # once: browser login (or --no-browser for a link)
bash deploy/nebius/run_job.sh                           # the latest creek run's photos (scripts/creek_run.py)
bash deploy/nebius/run_job.sh --local                   # the same job image under local Docker, no Nebius
```

The photos go into the job image (`FROM` the batch image + `COPY photos /in`), so no bucket or S3 keys are
needed. The results come back through the job's logs: `nebius_batch_detect.py --print-results` prints both
JSON files between markers, and `collect.py` writes them to `deploy/nebius/.job/out/` (tested in
`tests/ml/test_nebius_batch.py`). The script creates a Container Registry once (`.state.env`, gitignored),
pushes, runs `nebius ai job create` on `cpu-d3` / `4vcpu-16gb` with a 1 h timeout (the minimum), waits, reads the
logs and deletes the job. Set `SUBNET_ID` if the project has several subnets, and `PLATFORM`/`PRESET` to
change the VM. Docs read 2026-10-22: https://docs.nebius.com/serverless/jobs/manage.md. Price: cpu-d3 is
$0.015 per vCPU-hour + $0.0045 per GiB-hour from Oct 1, 2026, so about $0.13/h for 4vcpu-16gb plus disk.

**Checked locally (2026-10-22, `--local`):** the 711 photos of the creek run (crops of HERIDAL val photos at
simulated poses), 2.09 GB image; 334 s, 0.47 s per photo on 32 CPUs. **One candidate: f0665 at 0.735**, the
same photo that gave the live run's candidate, and no other.

## Still to do (lane A)

- [x] job script, results through the logs, local run (above)
- [ ] `nebius` CLI login (Dan), then `bash deploy/nebius/run_job.sh`
- [ ] record time and cost in `docs/feedback/nebius.md` ("Serverless Jobs") and the README's NVIDIA + Nebius table
