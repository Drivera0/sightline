#!/usr/bin/env bash
# The Sightline API and its photo worker on COOL, on the Graviton box, checked end to end.
# Run after scripts/cool_bench.sh on the same instance (it reuses its inputs and /opt/sl/deps):
#
#   bash scripts/cool_api_check.sh            # results in /opt/sl/out/api-*.txt
#
# Starts `python -m sightline.pipeline serve` with COOL's cv2 (the same settings as the COOL
# venv's bin/activate), the local photo queue (a worker thread, no SQS) and the fixed-size ONNX
# (OpenCV 4.12's importer cannot read the dynamic export), bound to 127.0.0.1 only: no port is
# opened to the internet. Then scripts/remote_check.py against it, three times, with its usual
# HERIDAL val photo (train_BRK_2048.jpg, which has the DJI pose metadata the pipeline needs; the
# public release has only the test split, whose photos carry no pose, so copy it onto the box
# first or set PHOTO). There is no
# NEBIUS_API_KEY or TAVILY_API_KEY on this box: the agent's second look and conditions are off,
# so the timings are the pose, cv2.dnn and the map step, as in the worker on AWS.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-/opt/sl}
OUT=${OUT:-$WORK/out}
COOL_PY=${COOL_PY:-/opt/cool/venvs/python_3.12/bin/python}
COOL_PYTHONPATH=${COOL_PYTHONPATH-/opt/cool/python_3.12/site-packages/cv2/python-3.12}
COOL_LD=${COOL_LD-/opt/cool/cpp_sdk/lib}
PORT=${PORT:-8000}
PHOTO=${PHOTO:-$REPO/data/heridal/yolo_full/val/images/train_BRK_2048.jpg}  # remote_check.py's photo (val, DJI pose metadata)
cd "$REPO"

# The API's own dependencies, without numpy: COOL's numpy (1.26.4) stays the only one.
if [ ! -d "$WORK/deps-api/fastapi" ]; then
  "$WORK/venv-pip/bin/python" -m pip install -q --target "$WORK/deps-api" \
    fastapi uvicorn typer python-multipart httpx shapely pillow pydantic openai tavily-python \
    python-dotenv astral
  rm -rf "$WORK"/deps-api/numpy "$WORK"/deps-api/numpy-* "$WORK"/deps-api/numpy.libs "$WORK"/deps-api/bin
fi
export PYTHONPATH="$REPO:$WORK/deps-api:$COOL_PYTHONPATH" LD_LIBRARY_PATH="$COOL_LD"
export SIGHTLINE_ONNX=$REPO/data/weights/release_v2/sightline-detector-v2.onnx SIGHTLINE_BACKEND=cv2
export SIGHTLINE_FAKE_TAVILY=1 PYTHONUNBUFFERED=1 SIGHTLINE_CORS_ORIGINS=https://sightline-iota-sandy.vercel.app
"$COOL_PY" -c 'import cv2, numpy; print("api on cv2", cv2.__version__, cv2.__file__, "numpy", numpy.__version__)' \
  | tee "$OUT/api-env.txt"
rm -rf "$WORK/api"
mkdir -p "$WORK/api"
"$COOL_PY" -m sightline.pipeline serve --host 127.0.0.1 --port "$PORT" --backend cv2 \
  --mission-root "$WORK/api/missions" --data-root "$WORK/api/uploads" --cache-root "$WORK/api/cache" \
  > "$OUT/api-server.log" 2>&1 &
API=$!
trap 'kill $API 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -fsS http://127.0.0.1:$PORT/health >/dev/null 2>&1 && break; sleep 2; done
curl -fsS http://127.0.0.1:$PORT/health | tee "$OUT/api-health.json"; echo
for i in 1 2 3; do
  timeout 300 "$COOL_PY" scripts/remote_check.py --api http://127.0.0.1:$PORT --photo "$PHOTO" \
    > "$OUT/api-check-$i.txt" 2>&1 || true
  head -1 "$OUT/api-check-$i.txt"
done
grep -h "processed (" "$OUT"/api-check-*.txt | sort -u || true
