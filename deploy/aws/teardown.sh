#!/usr/bin/env bash
# Delete everything setup.sh created (all tagged project=sightline). Irreversible: the mission
# files on the instance and the originals in S3 go too. From the repo root:
#   bash deploy/aws/teardown.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
STATE=deploy/aws/.state.env
[ -f "$STATE" ] || { echo "no $STATE: nothing recorded to delete"; exit 1; }
# shellcheck disable=SC1090
source "$STATE"
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION
PREFIX=${PREFIX:-sightline}
say() { printf '\033[1m%s\033[0m\n' "$*"; }

read -r -p "Delete Sightline's AWS resources in $ACCOUNT/$REGION (instance, data, queue, bucket, secret)? [y/N] " ok
[ "$ok" = "y" ] || exit 1

aws ec2 terminate-instances --instance-ids "$INSTANCE" >/dev/null && say "terminating $INSTANCE"
aws ec2 wait instance-terminated --instance-ids "$INSTANCE"
aws ec2 release-address --allocation-id "$EIP_ALLOC" && say "released the Elastic IP"
aws ec2 delete-security-group --group-id "$SG" && say "deleted $SG"
aws iam remove-role-from-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
aws iam delete-instance-profile --instance-profile-name "$ROLE"
aws iam detach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam delete-role-policy --role-name "$ROLE" --policy-name "$PREFIX-app"
aws iam delete-role --role-name "$ROLE" && say "deleted role $ROLE"
aws sqs delete-queue --queue-url "$QUEUE_URL"
aws sqs delete-queue --queue-url "$DLQ_URL" && say "deleted the queues"
aws s3 rm "s3://$BUCKET" --recursive --quiet
aws s3api delete-bucket --bucket "$BUCKET" && say "deleted bucket $BUCKET"
aws secretsmanager delete-secret --secret-id "$SECRET_ID" --force-delete-without-recovery >/dev/null && say "deleted secret $SECRET_ID"
aws logs delete-log-group --log-group-name /sightline && say "deleted log group /sightline"
aws cloudwatch delete-dashboards --dashboard-names "$PREFIX" && say "deleted the dashboard"
aws budgets delete-budget --account-id "$ACCOUNT" --budget-name "$PREFIX" 2>/dev/null && say "deleted the budget"
rm -f "$STATE"
say "done"
