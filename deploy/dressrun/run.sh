#!/usr/bin/env bash
# Sightline clean-machine dress run: build the image from nothing, run every stage, write the times.
#
#   bash deploy/dressrun/run.sh
#
# Writes runs/dressrun/<timestamp>/{times.md,build.log,run.log}. Needs Docker, git and awk.
# No env vars needed: without NEBIUS_API_KEY / TAVILY_API_KEY the agent and conditions use the
# built-in fakes (SIGHTLINE_FAKE_LLM=1, SIGHTLINE_FAKE_TAVILY=1). If they are set, they are passed
# to `docker run` by name (never written into the image, the command line or the logs).
#
#   DRESSRUN_CACHE=1   reuse Docker's layer cache (faster reruns; the build times then measure
#                      nothing). Default: --no-cache --pull, a build from nothing.
#   DRESSRUN_TAG       image tag (default sightline-dressrun)
#   DRESSRUN_CPUS=4    cap the container at 4 CPUs (docker run --cpus), to time a laptop-sized run
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
TAG="${DRESSRUN_TAG:-sightline-dressrun}"
TS="$(date -u +%Y%m%d-%H%M%S)"
OUT="$ROOT/runs/dressrun/$TS"
mkdir -p "$OUT"
BUILD_LOG="$OUT/build.log"
RUN_LOG="$OUT/run.log"

cache_flags=(--no-cache --pull)
[ "${DRESSRUN_CACHE:-0}" = "1" ] && cache_flags=()

now() { date +%s.%N; }
secs() { awk -v s="$1" -v e="$2" 'BEGIN { printf "%.1f", e - s }'; }

# The build context is exactly what a fresh clone has: tracked files plus new files git doesn't
# ignore (no data/, runs/, node_modules, .venv, downloaded caches or weights, .env).
echo "dress run $TS: building $TAG (log: $BUILD_LOG)"
t0="$(now)"
git ls-files -z --cached --others --exclude-standard \
  | while IFS= read -r -d '' f; do [ -e "$f" ] && printf '%s\0' "$f"; done \
  | tar --null -cf - -T - \
  | DOCKER_BUILDKIT=1 docker build "${cache_flags[@]}" --progress=plain \
      -f deploy/dressrun/Dockerfile -t "$TAG" - >"$BUILD_LOG" 2>&1
build_rc=$?
t1="$(now)"
build_s="$(secs "$t0" "$t1")"
echo "build: exit $build_rc in ${build_s}s"

run_rc=1
run_s=0
if [ "$build_rc" -eq 0 ]; then
  env_flags=()
  [ -n "${DRESSRUN_CPUS:-}" ] && env_flags+=(--cpus "$DRESSRUN_CPUS")
  for k in NEBIUS_API_KEY TAVILY_API_KEY NEBIUS_BASE_URL SIGHTLINE_MODEL_VISION SIGHTLINE_MODEL_FAST SIGHTLINE_MODEL_REASON; do
    [ -n "${!k:-}" ] && env_flags+=(-e "$k")
  done
  echo "dress run $TS: running stages (log: $RUN_LOG)"
  t2="$(now)"
  docker run --rm "${env_flags[@]}" "$TAG" 2>&1 | tee "$RUN_LOG"
  run_rc="${PIPESTATUS[0]}"
  run_s="$(secs "$t2" "$(now)")"
fi

# times.md: one row per "=== STAGE <name> <s>s ===" line (build log lines carry BuildKit's
# "#12 3.456 " prefix), then the totals.
{
  echo "# Sightline dress run $TS"
  echo
  echo "Commit \`$(git rev-parse --short HEAD)\`$(git diff --quiet HEAD -- . 2>/dev/null || echo ' (with uncommitted changes)'),"
  echo "host: $(nproc) CPUs, $(awk '/MemTotal/ { printf "%.0f GB", $2 / 1048576 }' /proc/meminfo 2>/dev/null || echo '? GB') RAM,"
  echo "$(uname -sr), Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)."
  echo "Container CPUs: ${DRESSRUN_CPUS:-all}."
  echo "Image build: $([ ${#cache_flags[@]} -gt 0 ] && echo 'from nothing (--no-cache --pull)' || echo 'with the layer cache')."
  echo "LLM: $([ -n "${NEBIUS_API_KEY:-}" ] && echo 'Nebius Token Factory' || echo 'fake (no key)'); conditions: $([ -n "${TAVILY_API_KEY:-}" ] && echo 'Tavily' || echo 'fake (no key)')."
  echo
  echo "| Stage | Seconds | Result |"
  echo "|---|---:|---|"
  cat "$BUILD_LOG" "$RUN_LOG" 2>/dev/null \
    | grep -E '=== STAGE [^ ]+ [0-9.]+s ===' \
    | sed -E 's/^.*=== STAGE ([^ ]+) ([0-9.]+)s ===(.*)$/\1 \2 \3/' \
    | while read -r name s rest; do
        if [ -z "$rest" ]; then res=pass; else res="FAIL ${rest#*FAILED }"; fi
        echo "| $name | $s | $res |"
      done
  echo "| **docker build (total)** | $build_s | $([ "$build_rc" -eq 0 ] && echo pass || echo "FAIL (exit $build_rc)") |"
  echo "| **docker run (total)** | $run_s | $([ "$run_rc" -eq 0 ] && echo pass || echo "FAIL (exit $run_rc)") |"
  echo "| **end to end** | $(secs "$t0" "$(now)") | $([ "$build_rc" -eq 0 ] && [ "$run_rc" -eq 0 ] && echo pass || echo FAIL) |"
} >"$OUT/times.md"

echo
cat "$OUT/times.md"
echo
echo "logs: $OUT"
[ "$build_rc" -eq 0 ] && [ "$run_rc" -eq 0 ]
