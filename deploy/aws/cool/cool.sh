#!/usr/bin/env bash
# One Graviton instance from the COOL AMI that runs scripts/cool_bench.sh and leaves (docs/report/COOL_GRAVITON.md).
#
#   bash deploy/aws/cool/cool.sh launch      # role, security group, instance; the bench starts at boot
#   bash deploy/aws/cool/cool.sh status      # instance state, SSM, the bench's phases so far
#   bash deploy/aws/cool/cool.sh fetch       # results to docs/evidence/cool/ (after "all done")
#   bash deploy/aws/cool/cool.sh terminate   # terminate the instance and delete its role and group
#   bash deploy/aws/cool/cool.sh shell       # an SSM shell on it (needs session-manager-plugin)
#
# Before the first launch the account must subscribe to "Cloud Optimized OpenCV for AWS Graviton4"
# on AWS Marketplace (7-day free trial, then $0.04/h for the software). Without it run-instances
# fails with OptInRequired. Cancel the subscription in the Marketplace console when done.
#
# The instance is separate from the API (deploy/aws/setup.sh): tagged project=sightline-cool, its own
# role (SSM, plus PutObject under cool/ in the project bucket only) and a security group with no
# inbound rules; administration is through SSM only. It shuts itself down (and so terminates) after
# SAFETY_MIN minutes whatever happens.
set -euo pipefail
cd "$(dirname "$0")/../../.."

PREFIX=sightline-cool
REGION=${AWS_REGION:-us-west-2}
AMI=${AMI:-ami-03040ae9b0be1f439}   # COOL-V3-prod (arm64), us-west-2; product code 4eb70u7a6gb5bj1ijix5jlokv
INSTANCE_TYPE=${INSTANCE_TYPE:-c6g.4xlarge}  # Graviton2: the only family the listing accepted in us-west-2 (Oct 2026)
GIT_REF=${GIT_REF:-main}
REPO=${REPO:-https://github.com/Drivera0/sightline.git}
SAFETY_MIN=${SAFETY_MIN:-240}
BENCH_ENV=${BENCH_ENV:-}            # e.g. "RUNS=1 PHOTOS=20" for a quick pass
STATE=deploy/aws/cool/.state.env
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET=${BUCKET:-sightline-$ACCOUNT-$REGION}
say() { printf '\033[1m%s\033[0m\n' "$*"; }
# shellcheck disable=SC1090
[ -f "$STATE" ] && source "$STATE"

launch() {
  local role=$PREFIX-ec2
  if ! aws iam get-role --role-name "$role" >/dev/null 2>&1; then
    aws iam create-role --role-name "$role" --tags Key=project,Value=$PREFIX --assume-role-policy-document \
      '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  fi
  aws iam attach-role-policy --role-name "$role" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam put-role-policy --role-name "$role" --policy-name "$PREFIX-results" --policy-document \
    "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"s3:PutObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/cool/*\"},{\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/cool/inputs/*\"}]}"
  if ! aws iam get-instance-profile --instance-profile-name "$role" >/dev/null 2>&1; then
    aws iam create-instance-profile --instance-profile-name "$role" >/dev/null
    aws iam add-role-to-instance-profile --instance-profile-name "$role" --role-name "$role"
    sleep 15  # a new instance profile takes a moment before EC2 accepts it
  fi
  say "IAM role $role (SSM, s3:PutObject on $BUCKET/cool/*, s3:GetObject on cool/inputs/*)"

  local vpc sg
  vpc=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
  sg=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$PREFIX Name=vpc-id,Values="$vpc" \
    --query 'SecurityGroups[0].GroupId' --output text)
  if [ "$sg" = "None" ]; then
    sg=$(aws ec2 create-security-group --group-name $PREFIX --description "Sightline COOL bench: no inbound" \
      --vpc-id "$vpc" --tag-specifications "ResourceType=security-group,Tags=[{Key=project,Value=$PREFIX}]" \
      --query GroupId --output text)
  fi
  say "security group $sg (no inbound rules)"

  local run_id userdata instance
  run_id=$(date -u +%Y%m%dT%H%M%SZ)
  userdata=$(cat <<EOF
#!/bin/bash
exec > >(tee -a /var/log/sightline-cool.log) 2>&1
set -x
shutdown -h +$SAFETY_MIN "sightline-cool safety stop"
export HOME=/root DEBIAN_FRONTEND=noninteractive
if ! systemctl list-unit-files | grep -q amazon-ssm-agent; then
  snap install amazon-ssm-agent --classic || true
fi
apt-get update -qq || true; apt-get install -y -qq git curl >/dev/null || dnf install -y -q git || true
PY=\$(/opt/cool/venvs/python_3.12/bin/python -c 'import sys; print(sys._base_executable)' || command -v python3)
\$PY -m venv /opt/sl/awscli 2>/dev/null || { apt-get install -y -qq python3.12-venv; \$PY -m venv /opt/sl/awscli; }
/opt/sl/awscli/bin/pip install -q awscli
AWS=/opt/sl/awscli/bin/aws
DEST=s3://$BUCKET/cool/$run_id
mkdir -p /opt/sl/out
( while sleep 120; do \$AWS s3 cp --quiet /opt/sl/out/phases.log \$DEST/phases.log; \$AWS s3 cp --quiet /var/log/sightline-cool.log \$DEST/boot.log; done ) &
git clone --depth 1 --branch $GIT_REF $REPO /opt/sl/repo
cd /opt/sl/repo && git rev-parse HEAD > /opt/sl/out/git-head.txt
env $BENCH_ENV bash scripts/cool_bench.sh || echo "cool_bench.sh exit \$?" >> /opt/sl/out/phases.log
cp /var/log/sightline-cool.log /opt/sl/out/boot.log
tar czf /opt/sl/results.tgz -C /opt/sl out
\$AWS s3 cp /opt/sl/results.tgz \$DEST/results.tgz
\$AWS s3 cp /opt/sl/out/phases.log \$DEST/phases.log
echo uploaded
EOF
)
  instance=$(aws ec2 run-instances --image-id "$AMI" --instance-type "$INSTANCE_TYPE" \
    --iam-instance-profile Name="$role" --security-group-ids "$sg" \
    --instance-initiated-shutdown-behavior terminate \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=80,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}' \
    --metadata-options HttpTokens=required \
    --tag-specifications "ResourceType=instance,Tags=[{Key=project,Value=$PREFIX},{Key=Name,Value=$PREFIX}]" \
    "ResourceType=volume,Tags=[{Key=project,Value=$PREFIX}]" \
    --user-data "$userdata" --query 'Instances[0].InstanceId' --output text)
  cat > "$STATE" <<EOF
INSTANCE=$instance
SG=$sg
ROLE=$role
RUN_ID=$run_id
EOF
  say "instance $instance ($INSTANCE_TYPE, $AMI), run $run_id, results to s3://$BUCKET/cool/$run_id/"
  aws ec2 wait instance-running --instance-ids "$instance"
  say "running; it terminates itself after $SAFETY_MIN min. Next: bash deploy/aws/cool/cool.sh status"
}

status() {
  aws ec2 describe-instances --instance-ids "$INSTANCE" \
    --query 'Reservations[0].Instances[0].[InstanceId,State.Name,InstanceType,LaunchTime]' --output text
  aws ssm describe-instance-information --filters Key=InstanceIds,Values="$INSTANCE" \
    --query 'InstanceInformationList[0].[PingStatus,PlatformName,PlatformVersion]' --output text || true
  aws s3 cp --quiet "s3://$BUCKET/cool/$RUN_ID/phases.log" - 2>/dev/null || echo "(no phases.log yet)"
}

fetch() {
  local tmp out=docs/evidence/cool
  tmp=$(mktemp -d)
  aws s3 cp --quiet "s3://$BUCKET/cool/$RUN_ID/results.tgz" "$tmp/results.tgz"
  tar xzf "$tmp/results.tgz" -C "$tmp"
  mkdir -p "$out"
  cp -r "$tmp/out/." "$out/"
  rm -rf "$tmp"
  say "results in $out/"
}

terminate() {
  aws ec2 terminate-instances --instance-ids "$INSTANCE" >/dev/null && say "terminating $INSTANCE"
  aws ec2 wait instance-terminated --instance-ids "$INSTANCE"
  aws ec2 describe-instances --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].State.Name' --output text
  aws ec2 delete-security-group --group-id "$SG" && say "deleted $SG"
  aws iam remove-role-from-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
  aws iam delete-instance-profile --instance-profile-name "$ROLE"
  aws iam detach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam delete-role-policy --role-name "$ROLE" --policy-name "$PREFIX-results"
  aws iam delete-role --role-name "$ROLE" && say "deleted role $ROLE"
  say "the results stay in s3://$BUCKET/cool/; cancel the Marketplace subscription in the console"
}

case "${1:-}" in
  launch) launch ;;
  status) status ;;
  fetch) fetch ;;
  terminate) terminate ;;
  shell) aws ssm start-session --target "$INSTANCE" ;;
  *) sed -n '2,9p' "$0"; exit 1 ;;
esac
