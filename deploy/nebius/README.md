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

## Still to do (lane A, Mon Oct 27)

- [ ] push the image to a registry Nebius can pull from (Nebius Container Registry)
- [ ] mount or sync the fleet photos into the job's input, run it as a Serverless Job, read `out/` back
- [ ] record time and cost in `docs/feedback/nebius.md` ("Serverless Jobs") and the README's NVIDIA + Nebius table
