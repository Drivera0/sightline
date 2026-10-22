#!/usr/bin/env bash
# A-N1: the simulated fleet's photos detected as a Nebius Serverless Job. From the repo root:
#
#   bash deploy/nebius/run_job.sh [PHOTO_DIR]       # default: the latest creek run's photos
#   bash deploy/nebius/run_job.sh --local [DIR]     # the same image under local Docker, no Nebius
#
# Needs the `nebius` CLI logged in (`nebius profile create`, see README) and Docker. Steps: build the
# batch image with the photos inside (no bucket or S3 keys needed), push it to a Container Registry
# in the profile's project (created once, kept in deploy/nebius/.state.env), create the job on a
# CPU VM (cpu-d3, 4vcpu-16gb, timeout 1h), wait, read the results back from the job's logs into
# deploy/nebius/.job/out/, delete the job. Costs: Compute pricing for the VM while it runs (about
# $0.13/h for 4vcpu-16gb from Oct 1, 2026) plus its disk. Set SUBNET_ID if the project has several.
set -euo pipefail
cd "$(dirname "$0")/../.."
LOCAL=""
[ "${1:-}" = "--local" ] && { LOCAL=1; shift; }
SRC=${1:-$(ls -d runs/creek/*/missions/*/frames/orig 2>/dev/null | tail -1)}
[ -d "$SRC" ] || { echo "no photo folder (run scripts/creek_run.py, or pass one)"; exit 1; }
STATE=deploy/nebius/.state.env
WORK=deploy/nebius/.job
PLATFORM=${PLATFORM:-cpu-d3}
PRESET=${PRESET:-4vcpu-16gb}
NAME=sightline-batch-$(date +%Y%m%d-%H%M%S)

rm -rf "$WORK" && mkdir -p "$WORK/photos" "$WORK/out"
cp "$SRC"/*.jpg "$WORK/photos/"
N=$(ls "$WORK/photos" | wc -l)
echo "$N photos from $SRC"
docker build -q -f deploy/nebius/Dockerfile -t sightline-nebius . >/dev/null
printf 'FROM sightline-nebius\nCOPY photos /in\n' > "$WORK/Dockerfile"
docker build -q -t "sightline-nebius-job:$NAME" "$WORK" >/dev/null
echo "image built ($(docker image inspect "sightline-nebius-job:$NAME" --format '{{.Size}}' | awk '{printf "%.2f GB", $1/1e9}'))"

collect() { python3 deploy/nebius/collect.py "$WORK/out"; }  # results from the logs (stdin)

if [ -n "$LOCAL" ]; then
  docker run --rm "sightline-nebius-job:$NAME" /in /out --print-results | tee "$WORK/logs.txt" | grep -v '^\[' | collect
  exit 0
fi

command -v nebius >/dev/null || { echo "install the nebius CLI first (deploy/nebius/README.md)"; exit 1; }
[ -f "$STATE" ] && source "$STATE"
REGION=${REGION:-$(nebius config get region 2>/dev/null || echo eu-north1)}
if [ -z "${REGISTRY_PATH:-}" ]; then
  REGISTRY_PATH=$(nebius registry create --name sightline --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["metadata"]["id"].split("-",1)[1])')
  printf 'REGION=%s\nREGISTRY_PATH=%s\n' "$REGION" "$REGISTRY_PATH" > "$STATE"
fi
nebius registry configure-helper >/dev/null
IMAGE=cr.$REGION.nebius.cloud/$REGISTRY_PATH/sightline-batch:$NAME
docker tag "sightline-nebius-job:$NAME" "$IMAGE"
docker push -q "$IMAGE" >/dev/null
echo "pushed $IMAGE"

T0=$(date +%s)
JOB=$(nebius ai job create --name "$NAME" --image "$IMAGE" \
  --container-command "python scripts/nebius_batch_detect.py" --args "/in /out --print-results" \
  --platform "$PLATFORM" --preset "$PRESET" --timeout 1h --disk-size 50Gi \
  ${SUBNET_ID:+--subnet-id "$SUBNET_ID"} --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["metadata"]["id"])')
echo "job $JOB ($PLATFORM $PRESET)"
while :; do
  S=$(nebius ai job get "$JOB" --format json | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",{}).get("state","?"))')
  case "$S" in
    *COMPLETED*|*SUCCEEDED*) break ;;
    *FAILED*|*CANCELLED*|*ERROR*) nebius ai job logs "$JOB" --tail 40 || true; echo "job $S"; exit 1 ;;
    *) sleep 15 ;;
  esac
done
WALL=$(( $(date +%s) - T0 ))
nebius ai job logs "$JOB" > "$WORK/logs.txt"
collect < "$WORK/logs.txt"
echo "job wall time ${WALL}s (create → completed, VM start included); state: $S"
nebius ai job delete "$JOB" >/dev/null && echo "job deleted"
