#!/usr/bin/env bash
# Dress-run stage: start the mission API on the downloaded caches (cv2.dnn detector, the ONNX from
# the model-onnx-v2 release), then run scripts/remote_check.py against it with a demo-cache frame
# stamped with drone metadata. Runs inside the dress-run container (cwd /app).
set -euo pipefail

PORT=8000
API="http://127.0.0.1:$PORT"
LOG=/tmp/dressrun-api.log
PHOTO=/tmp/dressrun-f0002.jpg

# The CORS check in remote_check expects the Vercel site to be allowed, as on AWS.
export SIGHTLINE_CORS_ORIGINS="https://sightline-iota-sandy.vercel.app"
export SIGHTLINE_BACKEND=cv2

python -m sightline.pipeline serve --host 127.0.0.1 --port "$PORT" \
  --cache-root web/public/cache --data-root /tmp/dressrun-uploads \
  --mission-root /tmp/dressrun-missions >"$LOG" 2>&1 &
API_PID=$!
trap 'kill "$API_PID" 2>/dev/null || true; echo "--- last API log lines:"; tail -n 15 "$LOG"' EXIT

for _ in $(seq 120); do
  curl -sf "$API/health" >/dev/null && break
  kill -0 "$API_PID" 2>/dev/null || { echo "API exited"; exit 1; }
  sleep 1
done
curl -sf "$API/health"
echo

# The API serves the demo cache the website reads.
curl -sf "$API/cache/demo/manifest.json" | python -c \
  'import json,sys; m=json.load(sys.stdin); print("demo cache served:", m["survey_id"], m["n_frames"], "frames")'

python deploy/dressrun/stamp_photo.py web/public/cache/demo/frames/f0002.jpg "$PHOTO"
# remote_check's event-stream check waits for photo.processed; the timeout bounds it if that
# never comes.
timeout 300 python scripts/remote_check.py --api "$API" --photo "$PHOTO"
