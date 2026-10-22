#!/usr/bin/env bash
# Change the instance size, e.g. bigger only while recording the demo video. From the repo root:
#
#   bash deploy/aws/resize.sh c7i.4xlarge --start     # 16 vCPU: ~2.5 s per photo, ~$0.71/h
#   bash deploy/aws/resize.sh c7i.xlarge              # back to 4 vCPU (~10 s, ~$0.18/h), left stopped
#
# The instance is stopped first (a size can only change while stopped); the address, the mission
# data and everything else stay. --start starts it again and waits until the API answers.
set -euo pipefail
cd "$(dirname "$0")/../.."
STATE=deploy/aws/.state.env
TYPE=${1:?usage: resize.sh <instance-type> [--start]}
START=${2:-}
[ -f "$STATE" ] || { echo "no $STATE: run setup.sh first"; exit 1; }
# shellcheck disable=SC1090
source "$STATE"
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION

NOW=$(aws ec2 describe-instances --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].[InstanceType,State.Name]' --output text)
echo "now: $NOW"
if [ "$(echo "$NOW" | cut -f2)" != "stopped" ]; then
  aws ec2 stop-instances --instance-ids "$INSTANCE" >/dev/null
  aws ec2 wait instance-stopped --instance-ids "$INSTANCE"
  echo "stopped"
fi
current_type() {
  aws ec2 describe-instance-attribute --instance-id "$INSTANCE" --attribute instanceType --query InstanceType.Value --output text
}
if [ "$(current_type)" != "$TYPE" ]; then
  aws ec2 modify-instance-attribute --instance-id "$INSTANCE" --instance-type "Value=$TYPE"
  # AWS reports the old size for a few seconds after a change: wait until it says the new one,
  # so the next run (or --start) never acts on the old size.
  for _ in $(seq 1 30); do [ "$(current_type)" = "$TYPE" ] && break; sleep 2; done
fi
[ "$(current_type)" = "$TYPE" ] || { echo "the size didn't change to $TYPE"; exit 1; }
echo "size: $TYPE"
if [ "$START" = "--start" ]; then
  aws ec2 start-instances --instance-ids "$INSTANCE" >/dev/null
  aws ec2 wait instance-running --instance-ids "$INSTANCE"
  for _ in $(seq 1 60); do
    curl -sf --max-time 5 "https://$SITE/health" >/dev/null && { echo "running, API up: https://$SITE"; exit 0; }
    sleep 5
  done
  echo "running, but the API didn't answer within 5 min: check CloudWatch /sightline" && exit 1
fi
echo "left stopped ($TYPE); start with: aws ec2 start-instances --instance-ids $INSTANCE"
