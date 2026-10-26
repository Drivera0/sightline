#!/usr/bin/env bash
# COOL (Cloud-Optimized OpenCV) against the pip wheel, same Graviton box, same interpreter.
# docs/report/COOL_GRAVITON.md has the results; deploy/aws/cool/launch.sh starts the instance and
# runs this script on it through user-data. To run it by hand on a COOL AMI instance (as root):
#
#   git clone https://github.com/Drivera0/sightline.git /opt/sl/repo && cd /opt/sl/repo
#   bash scripts/cool_bench.sh                       # results in /opt/sl/out
#   RUNS=1 PHOTOS=20 bash scripts/cool_bench.sh      # a quicker pass
#
# Two Python environments built from the same CPython 3.12 (the COOL venv's base interpreter):
#   cool: /opt/cool/venvs/python_3.12, the AMI's own OpenCV build, used as shipped
#   pip:  a fresh venv with opencv-python==5.0.0.93 (the version the project pins) and the same
#         numpy version as the COOL venv
# Pure-Python dependencies (pydantic) come from one shared --target directory, so cv2 is the only
# thing that differs. Each environment runs, on the 101 HERIDAL test photos:
#   1. cv2.getBuildInformation()
#   2. scripts/cool_imgproc_bench.py: the imgproc calls of the second look and the map
#   3. scripts/reproduce_cv2.py: the published-number check (4 processes x 4 threads), wall time
#   4. scripts/bench_cv2_backend.py --runs $RUNS: one process, s/photo and ms/slice, boxes saved
# then bench_cv2_backend.py --compare checks the two runs' boxes against each other. vmstat
# samples the CPU every 5 s for the whole run (phases are marked in phases.log).
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-/opt/sl}
OUT=${OUT:-$WORK/out}
COOL_VENV=${COOL_VENV:-/opt/cool/venvs/python_3.12}
RUNS=${RUNS:-3}
PHOTOS=${PHOTOS:-}          # empty: all 101 test photos
PIP_OPENCV=${PIP_OPENCV:-opencv-python==5.0.0.93}
REL=https://github.com/Drivera0/sightline/releases/download
ONNX_SHA256=095fcc4340c0b9069e2706999e2cc360d7e973a189d4b722f8dd9143d91dcf88
mkdir -p "$OUT" "$WORK"
cd "$REPO"
phase() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$OUT/phases.log"; }

phase "start $(git rev-parse HEAD)"

# --- the machine --------------------------------------------------------------------------------
{
  TOKEN=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 600" || true)
  for k in instance-type ami-id placement/region placement/availability-zone; do
    echo "$k: $(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/$k" || echo '?')"
  done
  echo; uname -a; echo; cat /etc/os-release; echo; lscpu; echo; free -g
  echo; echo "COOL venv: $COOL_VENV"; ls -la /opt/cool /opt/cool/venvs 2>&1 || true
  find /opt/cool -maxdepth 2 -iname '*version*' -o -maxdepth 2 -iname '*.md' -o -maxdepth 2 -iname '*.txt' 2>/dev/null | head -20
} > "$OUT/machine.txt" 2>&1
for f in $(find /opt/cool -maxdepth 2 \( -iname '*version*' -o -iname 'README*' \) -type f 2>/dev/null | head -5); do
  echo "== $f" >> "$OUT/cool_files.txt"; head -100 "$f" >> "$OUT/cool_files.txt"
done

# --- tools: unzip, /usr/bin/time, vmstat, libGL for the pip wheel ----------------------------
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq unzip time procps libgl1 libglib2.0-0 >/dev/null
elif command -v dnf >/dev/null; then
  dnf install -y -q unzip time procps-ng mesa-libGL glib2 >/dev/null
fi

# --- inputs: the release test split, ONNX model and published metrics -------------------------
mkdir -p data/weights/release_v2 data/heridal/yolo_full
[ -f data/weights/release_v2/sightline-detector-v2.onnx ] ||
  curl -fsSL -o data/weights/release_v2/sightline-detector-v2.onnx "$REL/model-onnx-v2/sightline-detector-v2.onnx"
echo "$ONNX_SHA256  data/weights/release_v2/sightline-detector-v2.onnx" | sha256sum -c -
[ -f data/weights/release_v2/detector_metrics.json ] ||
  curl -fsSL -o data/weights/release_v2/detector_metrics.json "$REL/weights-v2/detector_metrics.json"
if [ ! -d data/heridal/yolo_full/test/images ]; then
  curl -fsSL -o "$WORK/heridal_test_split.zip" "$REL/data-v1/heridal_test_split.zip"
  unzip -q -o "$WORK/heridal_test_split.zip" -d data/heridal/yolo_full
fi
phase "inputs ready: $(ls data/heridal/yolo_full/test/images | wc -l) test photos"

# --- environments -------------------------------------------------------------------------------
COOL_PY=$COOL_VENV/bin/python
[ -x "$COOL_PY" ] || { echo "no COOL python at $COOL_PY" >&2; exit 2; }
BASE_PY=$("$COOL_PY" -c 'import sys; print(sys._base_executable)')
NUMPY_V=$("$COOL_PY" -c 'import numpy; print(numpy.__version__)')
"$COOL_PY" -m pip list > "$OUT/pip-list-cool.txt" 2>&1 || true
if [ ! -x "$WORK/venv-pip/bin/python" ]; then
  if ! "$BASE_PY" -m venv "$WORK/venv-pip"; then  # Debian/Ubuntu: ensurepip is a separate package
    rm -rf "$WORK/venv-pip"
    apt-get install -y -qq "python3.$("$BASE_PY" -c 'import sys; print(sys.version_info[1])')-venv" >/dev/null
    "$BASE_PY" -m venv "$WORK/venv-pip"
  fi
fi
"$WORK/venv-pip/bin/python" -m pip install -q --upgrade pip
"$WORK/venv-pip/bin/python" -m pip install -q "numpy==$NUMPY_V" "$PIP_OPENCV"
"$WORK/venv-pip/bin/python" -m pip install -q --target "$WORK/deps" pydantic
"$WORK/venv-pip/bin/python" -m pip list > "$OUT/pip-list-pip.txt" 2>&1
declare -A PY=([cool]="$COOL_PY" [pip]="$WORK/venv-pip/bin/python")
export PYTHONPATH="$REPO:$WORK/deps" PYTHONUNBUFFERED=1
for env in cool pip; do
  "${PY[$env]}" - > "$OUT/buildinfo-$env.txt" <<'PY'
import sys, cv2, numpy
print("python", sys.version)
print("executable", sys.executable)
print("cv2", cv2.__version__, cv2.__file__)
print("numpy", numpy.__version__)
print("threads", cv2.getNumThreads(), "cpus", cv2.getNumberOfCPUs())
print("useOptimized", cv2.useOptimized())
print(cv2.getBuildInformation())
PY
  phase "$env: $(sed -n 3p "$OUT/buildinfo-$env.txt")"
done
if cmp -s <(sed -n 3p "$OUT/buildinfo-cool.txt") <(sed -n 3p "$OUT/buildinfo-pip.txt"); then
  echo "both environments load the same cv2: stop" >&2; exit 2
fi

# --- runs -----------------------------------------------------------------------------------------
vmstat -n -t 5 > "$OUT/vmstat.log" &
VMSTAT=$!
trap 'kill $VMSTAT 2>/dev/null || true' EXIT
ONNX=data/weights/release_v2/sightline-detector-v2.onnx
LIMIT=(); [ -n "$PHOTOS" ] && LIMIT=(--limit "$PHOTOS")
SUBSET=(); [ -n "$PHOTOS" ] && SUBSET=(--subset "$PHOTOS")
for env in cool pip; do
  py=${PY[$env]}
  phase "$env imgproc start"
  "$py" scripts/cool_imgproc_bench.py --photos 10 --repeats 20 --out "$OUT/imgproc-$env.json" \
    > "$OUT/imgproc-$env.log" 2>&1
  phase "$env reproduce start"
  /usr/bin/time -v -o "$OUT/time-reproduce-$env.txt" "$py" scripts/reproduce_cv2.py \
    --onnx "$ONNX" "${SUBSET[@]}" > "$OUT/reproduce-$env.log" 2>&1 || echo "reproduce exit $?" >> "$OUT/reproduce-$env.log"
  phase "$env bench start"
  /usr/bin/time -v -o "$OUT/time-bench-$env.txt" "$py" scripts/bench_cv2_backend.py \
    --backend cpu --onnx "$ONNX" --runs "$RUNS" "${LIMIT[@]}" --out "$OUT/bench-$env.json" \
    > "$OUT/bench-$env.log" 2>&1
  phase "$env done"
done
# imgproc a second time in the other order, to see drift between the first and the last run.
for env in pip cool; do
  "${PY[$env]}" scripts/cool_imgproc_bench.py --photos 10 --repeats 20 \
    --out "$OUT/imgproc-$env-2.json" > "$OUT/imgproc-$env-2.log" 2>&1
done
phase "imgproc second pass done"
"$WORK/venv-pip/bin/python" scripts/bench_cv2_backend.py --compare "$OUT/bench-pip.json" \
  "$OUT/bench-cool.json" > "$OUT/parity.txt" 2>&1
phase "all done"
