#!/usr/bin/env bash
# COOL (Cloud-Optimized OpenCV) against the pip wheels, same Graviton box, same interpreter.
# docs/report/COOL_GRAVITON.md has the results; deploy/aws/cool/cool.sh starts the instance and
# runs this script on it through user-data. To run it by hand on a COOL AMI instance (as root):
#
#   git clone https://github.com/Drivera0/sightline.git /opt/sl/repo && cd /opt/sl/repo
#   bash scripts/cool_bench.sh                       # results in /opt/sl/out
#   RUNS=1 PHOTOS=20 bash scripts/cool_bench.sh      # a quicker pass
#
# Three Python environments on the same CPython 3.12 (the COOL venv's base interpreter) and the
# same numpy (the COOL venv's, 1.26.4 on COOL-V3):
#   cool: /opt/cool/venvs/python_3.12 with what its bin/activate sets (PYTHONPATH to COOL's cv2,
#         LD_LIBRARY_PATH to /opt/cool/cpp_sdk/lib): the AMI's own OpenCV build, as shipped
#   pip:  a fresh venv with the pip wheel of COOL's OpenCV version (the newest opencv-python
#         release of that version): the baseline
#   pip5: a fresh venv with opencv-python==5.0.0.93, the version the project pins: a reference
# The wheels go in with --no-deps next to COOL's numpy (they declare numpy>=2; a smoke call is
# checked); if one does not run, its venv gets the numpy it asks for and phases.log says so.
# Other dependencies (pydantic, Pillow for JPEG headers) come from one shared --target directory,
# so cv2 is the only thing that differs. Each environment runs, on the 101 HERIDAL test photos:
#   1. cv2.getBuildInformation()
#   2. scripts/cool_imgproc_bench.py: the imgproc calls of the second look and the map
#   3. scripts/reproduce_cv2.py: the published-number check (4 processes x 4 threads), wall time
#   4. scripts/bench_cv2_backend.py --runs $RUNS: one process, s/photo and ms/slice, boxes saved
# then bench_cv2_backend.py --compare checks the runs' boxes against each other. vmstat samples
# the CPU every 5 s for the whole run (phases are marked in phases.log).
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-/opt/sl}
OUT=${OUT:-$WORK/out}
COOL_VENV=${COOL_VENV:-/opt/cool/venvs/python_3.12}
COOL_PYTHONPATH=${COOL_PYTHONPATH-/opt/cool/python_3.12/site-packages/cv2/python-3.12}
COOL_LD=${COOL_LD-/opt/cool/cpp_sdk/lib}
RUNS=${RUNS:-2}
PHOTOS=${PHOTOS:-}          # empty: all 101 test photos
PIP5_OPENCV=${PIP5_OPENCV:-opencv-python==5.0.0.93}
ENVS=(cool pip pip5)
REL=https://github.com/Drivera0/sightline/releases/download
ONNX_SHA256=095fcc4340c0b9069e2706999e2cc360d7e973a189d4b722f8dd9143d91dcf88
mkdir -p "$OUT" "$WORK"
cd "$REPO"
phase() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$OUT/phases.log"; }

phase "start $(git rev-parse HEAD)"

# --- the machine --------------------------------------------------------------------------------
{
  TOKEN=$(curl -fsS --max-time 3 -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 600" || true)
  for k in instance-type ami-id placement/region placement/availability-zone; do
    echo "$k: $(curl -fsS --max-time 3 -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/$k" || echo '?')"
  done
  echo; uname -a; echo; cat /etc/os-release; echo; lscpu; echo; free -g
  echo; echo "COOL venv: $COOL_VENV"; ls -la /opt/cool /opt/cool/venvs 2>&1 || true
  ls /opt/cool/cpp_sdk/lib 2>&1 | head -60 || true
} > "$OUT/machine.txt" 2>&1
for f in $(find /opt/cool -maxdepth 2 \( -iname '*version*' -o -iname 'README*' \) -type f 2>/dev/null | head -5); do
  echo "== $f" >> "$OUT/cool_files.txt"; head -100 "$f" >> "$OUT/cool_files.txt"
done

# --- tools: unzip, /usr/bin/time, vmstat, libGL for the pip wheel ----------------------------
if [ "$(id -u)" != 0 ]; then
  echo "not root: skipping package installs"
elif command -v apt-get >/dev/null; then
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
# run_py ENV ARGS...: ENV's python with its cv2, the repo and the shared deps on the path;
# with TIME_OUT=<file> set, under /usr/bin/time -v (CPU %, max RSS).
run_py() {
  local env=$1 py pp ld=${LD_LIBRARY_PATH:-}
  shift
  if [ "$env" = cool ]; then
    py=$COOL_PY
    pp="$REPO:$WORK/deps${COOL_PYTHONPATH:+:$COOL_PYTHONPATH}"
    ld="$COOL_LD${ld:+:$ld}"
  else
    py=$WORK/venv-$env/bin/python
    pp="$REPO:$WORK/deps"
  fi
  if [ -n "${TIME_OUT:-}" ]; then
    PYTHONPATH=$pp LD_LIBRARY_PATH=$ld /usr/bin/time -v -o "$TIME_OUT" "$py" "$@"
  else
    PYTHONPATH=$pp LD_LIBRARY_PATH=$ld "$py" "$@"
  fi
}
export PYTHONUNBUFFERED=1
BASE_PY=$("$COOL_PY" -c 'import sys; print(sys._base_executable)')
NUMPY_V=$("$COOL_PY" -c 'import numpy; print(numpy.__version__)')
COOL_CV=$(run_py cool -c 'import cv2; print(cv2.__version__)')
if [ -z "${PIP_OPENCV:-}" ]; then
  PIP_OPENCV=opencv-python==$(curl -fsS https://pypi.org/pypi/opencv-python/json | "$BASE_PY" -c '
import json, sys
v = sys.argv[1]
rels = [r for r in json.load(sys.stdin)["releases"] if r.startswith(v + ".")]
print(max(rels, key=lambda r: [int(x) for x in r.split(".")]))' "$COOL_CV")
fi
phase "COOL cv2 $COOL_CV, numpy $NUMPY_V; baseline $PIP_OPENCV, reference $PIP5_OPENCV"
"$COOL_PY" -m pip list > "$OUT/pip-list-cool.txt" 2>&1 || true
for env in pip pip5; do
  wheel=$PIP_OPENCV
  [ $env = pip5 ] && wheel=$PIP5_OPENCV
  vpy=$WORK/venv-$env/bin/python
  if [ ! -x "$vpy" ]; then
    if ! "$BASE_PY" -m venv "$WORK/venv-$env"; then  # Debian/Ubuntu: ensurepip is a separate package
      rm -rf "$WORK/venv-$env"
      apt-get install -y -qq "python3.$("$BASE_PY" -c 'import sys; print(sys.version_info[1])')-venv" >/dev/null
      "$BASE_PY" -m venv "$WORK/venv-$env"
    fi
  fi
  "$vpy" -m pip install -q --upgrade pip
  "$vpy" -m pip install -q "numpy==$NUMPY_V"
  "$vpy" -m pip install -q --no-deps "$wheel"
  if ! "$vpy" -c 'import cv2, numpy; cv2.dnn.blobFromImage(numpy.zeros((8, 8, 3), numpy.uint8))'; then
    phase "$env: $wheel does not run with numpy $NUMPY_V; installing the numpy it asks for"
    "$vpy" -m pip install -q "$wheel"
  fi
  "$vpy" -m pip list > "$OUT/pip-list-$env.txt" 2>&1
done
[ -d "$WORK/deps/pydantic" ] || "$WORK/venv-pip/bin/python" -m pip install -q --target "$WORK/deps" pydantic pillow
for env in "${ENVS[@]}"; do
  run_py "$env" - > "$OUT/buildinfo-$env.txt" <<'PY'
import sys, cv2, numpy
print("python", sys.version)
print("executable", sys.executable)
print("cv2", cv2.__version__, cv2.__file__)
print("numpy", numpy.__version__)
print("threads", cv2.getNumThreads(), "cpus", cv2.getNumberOfCPUs())
print("useOptimized", cv2.useOptimized())
print(cv2.getBuildInformation())
PY
  phase "$env: $(sed -n 3p "$OUT/buildinfo-$env.txt"), $(sed -n 4p "$OUT/buildinfo-$env.txt")"
done
if cmp -s <(sed -n 3p "$OUT/buildinfo-cool.txt") <(sed -n 3p "$OUT/buildinfo-pip.txt"); then
  echo "cool and pip load the same cv2: stop" >&2; exit 2
fi

# --- runs -----------------------------------------------------------------------------------------
vmstat -n -t 5 > "$OUT/vmstat.log" &
VMSTAT=$!
trap 'kill $VMSTAT 2>/dev/null || true' EXIT
ONNX=data/weights/release_v2/sightline-detector-v2.onnx
LIMIT=(); [ -n "$PHOTOS" ] && LIMIT=(--limit "$PHOTOS")
SUBSET=(); [ -n "$PHOTOS" ] && SUBSET=(--subset "$PHOTOS")
for env in "${ENVS[@]}"; do
  phase "$env imgproc start"
  run_py "$env" scripts/cool_imgproc_bench.py --photos 10 --repeats 20 --out "$OUT/imgproc-$env.json" \
    > "$OUT/imgproc-$env.log" 2>&1 || echo "imgproc exit $?" >> "$OUT/imgproc-$env.log"
  phase "$env reproduce start"
  TIME_OUT=$OUT/time-reproduce-$env.txt run_py "$env" scripts/reproduce_cv2.py --onnx "$ONNX" \
    "${SUBSET[@]}" > "$OUT/reproduce-$env.log" 2>&1 || echo "reproduce exit $?" >> "$OUT/reproduce-$env.log"
  phase "$env bench start"
  TIME_OUT=$OUT/time-bench-$env.txt run_py "$env" scripts/bench_cv2_backend.py --backend cpu \
    --onnx "$ONNX" --runs "$RUNS" "${LIMIT[@]}" --out "$OUT/bench-$env.json" \
    > "$OUT/bench-$env.log" 2>&1 || echo "bench exit $?" >> "$OUT/bench-$env.log"
  phase "$env done"
done
# imgproc a second time in the reverse order, to see drift between the first and the last run.
for env in pip5 pip cool; do
  run_py "$env" scripts/cool_imgproc_bench.py --photos 10 --repeats 20 \
    --out "$OUT/imgproc-$env-2.json" > "$OUT/imgproc-$env-2.log" 2>&1 || true
done
phase "imgproc second pass done"
for pair in "pip cool" "pip5 cool" "pip5 pip"; do
  read -r a b <<< "$pair"
  { echo "== $a vs $b"; run_py pip scripts/bench_cv2_backend.py --compare "$OUT/bench-$a.json" "$OUT/bench-$b.json"; } \
    >> "$OUT/parity.txt" 2>&1 || true
done
phase "all done"
