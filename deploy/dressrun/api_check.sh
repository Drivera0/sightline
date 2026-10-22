#!/usr/bin/env bash
# Dress-run stage: start the mission API on the downloaded caches (cv2.dnn detector, the ONNX from
# the model-onnx-v2 release), then run scripts/remote_check.py against it with a demo-cache frame
# stamped with drone metadata. Runs inside the dress-run container (cwd /app).
#
#   api_check.sh          the detector in the API's own process
#   api_check.sh remote   the detector behind HTTP: sightline/serve/detect_app.py (the Nebius
#                         Serverless Endpoint's app) on :8080, the API pointed at it with
#                         SIGHTLINE_DETECT_URL; /health must then report "detector": "remote"
set -euo pipefail

MODE="${1:-local}"
PORT=8000
API="http://127.0.0.1:$PORT"
LOG=/tmp/dressrun-api-$MODE.log
DLOG=/tmp/dressrun-detect.log
PHOTO=/tmp/dressrun-f0002.jpg
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  echo "--- last API log lines:"
  tail -n 15 "$LOG"
  if [ "$MODE" = remote ]; then echo "--- last detector log lines:"; tail -n 8 "$DLOG"; fi
}
trap cleanup EXIT

wait_up() { # url pid
  for _ in $(seq 120); do
    curl -sf "$1" >/dev/null && return 0
    kill -0 "$2" 2>/dev/null || { echo "$1: the server exited"; return 1; }
    sleep 1
  done
  echo "$1: no answer in 120 s"
  return 1
}

# The CORS check in remote_check expects the Vercel site to be allowed, as on AWS.
export SIGHTLINE_CORS_ORIGINS="https://sightline-iota-sandy.vercel.app"
export SIGHTLINE_BACKEND=cv2

if [ "$MODE" = remote ]; then
  python -m uvicorn sightline.serve.detect_app:app --host 127.0.0.1 --port 8080 >"$DLOG" 2>&1 &
  PIDS+=($!)
  wait_up http://127.0.0.1:8080/healthz "${PIDS[-1]}"
  curl -sf http://127.0.0.1:8080/healthz
  echo
  export SIGHTLINE_DETECT_URL=http://127.0.0.1:8080
fi

python -m sightline.pipeline serve --host 127.0.0.1 --port "$PORT" \
  --cache-root web/public/cache --data-root "/tmp/dressrun-uploads-$MODE" \
  --mission-root "/tmp/dressrun-missions-$MODE" >"$LOG" 2>&1 &
PIDS+=($!)
wait_up "$API/health" "${PIDS[-1]}"
curl -sf "$API/health"
echo

# The API serves the demo cache the website reads.
curl -sf "$API/cache/demo/manifest.json" | python -c \
  'import json,sys; m=json.load(sys.stdin); print("demo cache served:", m["survey_id"], m["n_frames"], "frames")'

python deploy/dressrun/stamp_photo.py web/public/cache/demo/frames/f0002.jpg "$PHOTO"
# remote_check's event-stream check waits for photo.processed; the timeout bounds it if that
# never comes.
timeout 300 python scripts/remote_check.py --api "$API" --photo "$PHOTO"

if [ "$MODE" = remote ]; then
  # The photo went through the HTTP detector: the API loaded the remote one, and the detector
  # app answered a /detect.
  curl -sf "$API/health" | python -c \
    'import json,sys; h=json.load(sys.stdin); print("API detector:", h["detector"]); assert h["detector"] == "remote", h'
  grep -q 'POST /detect' "$DLOG" && echo "the detector app served POST /detect"
fi
