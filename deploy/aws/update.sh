#!/usr/bin/env bash
# Deploy the latest code to the running stack. From the repo root:
#
#   bash deploy/aws/update.sh             # main
#   bash deploy/aws/update.sh some-branch
#
# Starts the instance if it's stopped, then over SSM (no SSH): fetches the ref, rebuilds the image
# and recreates the containers (mission data and deploy/aws/.env stay), and waits until /health
# answers. It leaves the instance running: run scripts/remote_check.py, then stop it.
set -euo pipefail
cd "$(dirname "$0")/../.."
STATE=deploy/aws/.state.env
REF=${1:-main}
[ -f "$STATE" ] || { echo "no $STATE: run setup.sh first"; exit 1; }
# shellcheck disable=SC1090
source "$STATE"
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION

if [ "$(aws ec2 describe-instances --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].State.Name' --output text)" != "running" ]; then
  aws ec2 start-instances --instance-ids "$INSTANCE" >/dev/null
  aws ec2 wait instance-running --instance-ids "$INSTANCE"
  echo "started"
fi
for _ in $(seq 60); do  # the SSM agent registers a little after the instance is running
  [ "$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$INSTANCE" --query 'length(InstanceInformationList)' --output text)" = "1" ] && break
  sleep 5
done

CMD="set -eux; cd /opt/sightline; git fetch --depth 1 origin $REF; git reset --hard FETCH_HEAD; git log -1 --oneline; \
docker build -q -f deploy/aws/Dockerfile -t sightline .; \
docker compose -f deploy/aws/docker-compose.yml --env-file deploy/aws/.env up -d --force-recreate"
ID=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --parameters "commands=[\"$CMD\"]" --timeout-seconds 1800 --query Command.CommandId --output text)
echo "building on the instance (SSM command $ID; a few minutes)"
while :; do
  S=$(aws ssm get-command-invocation --command-id "$ID" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  case "$S" in
    Success) break ;;
    Pending|InProgress|Delayed) sleep 10 ;;
    *) aws ssm get-command-invocation --command-id "$ID" --instance-id "$INSTANCE" --query StandardErrorContent --output text | tail -20
       echo "update failed: $S"; exit 1 ;;
  esac
done
aws ssm get-command-invocation --command-id "$ID" --instance-id "$INSTANCE" --query StandardOutputContent --output text | grep -m1 -E '^[0-9a-f]{7,} ' || true
for _ in $(seq 60); do
  curl -sf --max-time 5 "https://$SITE/health" && { echo; echo "updated: https://$SITE"; exit 0; }
  sleep 5
done
echo "API not answering after the update: check the container logs in CloudWatch (/sightline)"; exit 1
