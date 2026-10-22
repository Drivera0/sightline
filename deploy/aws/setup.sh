#!/usr/bin/env bash
# Sightline on AWS (LANE_D §5.7, D-W1). Idempotent: run it again and it reuses what exists.
#
#   aws sso login                                   # or any credentials the AWS CLI can use
#   bash deploy/aws/setup.sh                        # from the repo root
#   BUDGET_EMAIL=you@example.org bash deploy/aws/setup.sh   # also a $20 budget alarm
#
# Creates (all named sightline-*, tagged project=sightline):
#   S3 bucket for originals (30-day lifecycle, no public access) · SQS FIFO queue + dead-letter
#   queue (3 tries) · Secrets Manager secret with NEBIUS_API_KEY / TAVILY_API_KEY (read from the
#   environment or the repo's .env; never printed) · IAM role with iam-policy.json (least
#   privilege) + SSM for shell access (no SSH port) · security group (80, 443) · CloudWatch log
#   group and dashboard · an Elastic IP · one EC2 instance (Amazon Linux 2023, INSTANCE_TYPE) that
#   builds the image from GitHub (GIT_REF) and runs docker-compose.yml.
# The API's address is https://<elastic-ip-with-dashes>.sslip.io (Caddy gets the certificate).
# Writes the ids to deploy/aws/.state.env (gitignored); teardown.sh deletes everything.
set -euo pipefail
cd "$(dirname "$0")/../.."

PREFIX=${PREFIX:-sightline}
REGION=${AWS_REGION:-$(aws configure get region || echo us-west-2)}
INSTANCE_TYPE=${INSTANCE_TYPE:-c7i.xlarge}
GIT_REF=${GIT_REF:-main}
REPO=${REPO:-https://github.com/Drivera0/sightline.git}
CORS_ORIGINS=${CORS_ORIGINS:-https://sightline-iota-sandy.vercel.app}
COMPOSE_VERSION=v2.39.4
STATE=deploy/aws/.state.env
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION
TAGS="Key=project,Value=$PREFIX"
say() { printf '\033[1m%s\033[0m\n' "$*"; }

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
say "account $ACCOUNT, region $REGION, instance $INSTANCE_TYPE"

# --- API keys: from the environment, else the repo's .env (values never echoed) ---------------
for k in NEBIUS_API_KEY TAVILY_API_KEY; do
  if [ -z "${!k:-}" ] && [ -f .env ]; then
    v=$(grep -E "^$k=" .env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true)
    [ -n "$v" ] && export "$k=$v"
  fi
done
[ -n "${NEBIUS_API_KEY:-}" ] || { echo "NEBIUS_API_KEY is not set (environment or .env)"; exit 1; }

# --- S3: originals ------------------------------------------------------------------------------
BUCKET="$PREFIX-$ACCOUNT-$REGION"
if ! aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration LocationConstraint="$REGION" >/dev/null
fi
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration \
  '{"Rules":[{"ID":"originals-30-days","Status":"Enabled","Filter":{"Prefix":"missions/"},"Expiration":{"Days":30}}]}' >/dev/null
aws s3api put-bucket-tagging --bucket "$BUCKET" --tagging "TagSet=[{$TAGS}]"
say "S3 bucket $BUCKET"

# --- SQS: FIFO queue (one message group per mission) + dead-letter queue -------------------------
DLQ_URL=$(aws sqs create-queue --queue-name "$PREFIX-photos-dlq.fifo" \
  --attributes FifoQueue=true,MessageRetentionPeriod=1209600 --tags project=$PREFIX --query QueueUrl --output text)
DLQ_ARN=$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)
QUEUE_URL=$(aws sqs create-queue --queue-name "$PREFIX-photos.fifo" --tags project=$PREFIX \
  --attributes "{\"FifoQueue\":\"true\",\"VisibilityTimeout\":\"300\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"}" \
  --query QueueUrl --output text)
QUEUE_ARN=$(aws sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)
say "SQS $QUEUE_URL (dead letters: $DLQ_URL)"

# --- Secrets Manager: API keys ------------------------------------------------------------------
SECRET_ID="$PREFIX/api-keys"
SECRET_JSON=$(python3 -c 'import json,os; print(json.dumps({k: os.environ.get(k, "") for k in ("NEBIUS_API_KEY", "TAVILY_API_KEY")}))')
# The ARN comes from the call itself: a describe right after a create can still say "not found".
if aws secretsmanager describe-secret --secret-id "$SECRET_ID" >/dev/null 2>&1; then
  SECRET_ARN=$(aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --secret-string "$SECRET_JSON" --query ARN --output text)
else
  SECRET_ARN=$(aws secretsmanager create-secret --name "$SECRET_ID" --secret-string "$SECRET_JSON" --tags "$TAGS" --query ARN --output text)
fi
unset SECRET_JSON
say "secret $SECRET_ID (keys only, values not shown)"

# --- CloudWatch log group -------------------------------------------------------------------------
aws logs create-log-group --log-group-name /sightline --tags project=$PREFIX 2>/dev/null || true
aws logs put-retention-policy --log-group-name /sightline --retention-in-days 14

# --- IAM: instance role (iam-policy.json, least privilege) + SSM ----------------------------------
ROLE="$PREFIX-ec2"
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --tags "$TAGS" --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
fi
POLICY=$(sed -e "s|__BUCKET__|$BUCKET|" -e "s|__QUEUE_ARN__|$QUEUE_ARN|" -e "s|__REGION__|$REGION|" \
  -e "s|__ACCOUNT__|$ACCOUNT|" -e "s|__SECRET_ARN__|$SECRET_ARN|" deploy/aws/iam-policy.json)
aws iam put-role-policy --role-name "$ROLE" --policy-name "$PREFIX-app" --policy-document "$POLICY"
aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
if ! aws iam get-instance-profile --instance-profile-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$ROLE" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
  sleep 10  # a new instance profile takes a moment before EC2 accepts it
fi
say "IAM role $ROLE"

# --- Network: default VPC, security group (HTTP for the certificate, HTTPS) -----------------------
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values="$PREFIX-web" Name=vpc-id,Values="$VPC" \
  --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = "None" ]; then
  SG=$(aws ec2 create-security-group --group-name "$PREFIX-web" --description "Sightline: HTTP, HTTPS" --vpc-id "$VPC" \
    --tag-specifications "ResourceType=security-group,Tags=[{$TAGS}]" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$SG" --ip-permissions \
    'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}]' 'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]' >/dev/null
fi
say "security group $SG"

# --- Elastic IP → the sslip.io address Caddy serves ------------------------------------------------
EIP_ALLOC=$(aws ec2 describe-addresses --filters Name=tag:project,Values=$PREFIX --query 'Addresses[0].AllocationId' --output text)
if [ "$EIP_ALLOC" = "None" ]; then
  EIP_ALLOC=$(aws ec2 allocate-address --domain vpc --tag-specifications "ResourceType=elastic-ip,Tags=[{$TAGS}]" --query AllocationId --output text)
fi
EIP=$(aws ec2 describe-addresses --allocation-ids "$EIP_ALLOC" --query 'Addresses[0].PublicIp' --output text)
SITE="${EIP//./-}.sslip.io"
say "address https://$SITE"

# --- EC2: one instance running docker-compose.yml -----------------------------------------------
INSTANCE=$(aws ec2 describe-instances --filters Name=tag:project,Values=$PREFIX Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
if [ "$INSTANCE" = "None" ]; then
  AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text)
  USERDATA=$(cat <<EOF
#!/bin/bash
set -euxo pipefail
dnf install -y docker git
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-compose https://github.com/docker/compose/releases/download/$COMPOSE_VERSION/docker-compose-linux-x86_64
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
systemctl enable --now docker
git clone --depth 1 --branch $GIT_REF $REPO /opt/sightline
cd /opt/sightline
docker build -f deploy/aws/Dockerfile -t sightline .
cat > deploy/aws/.env <<ENV
AWS_REGION=$REGION
AWS_DEFAULT_REGION=$REGION
SITE_ADDRESS=$SITE
SIGHTLINE_SQS_URL=$QUEUE_URL
SIGHTLINE_S3_BUCKET=$BUCKET
SIGHTLINE_SECRET_ID=$SECRET_ID
SIGHTLINE_METRICS=cloudwatch
SIGHTLINE_BACKEND=cv2
SIGHTLINE_CORS_ORIGINS=$CORS_ORIGINS
ENV
docker compose -f deploy/aws/docker-compose.yml --env-file deploy/aws/.env up -d
EOF
)
  INSTANCE=$(aws ec2 run-instances --image-id "$AMI" --instance-type "$INSTANCE_TYPE" \
    --iam-instance-profile Name="$ROLE" --security-group-ids "$SG" \
    --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=30,VolumeType=gp3,Encrypted=true}' \
    --metadata-options HttpTokens=required \
    --tag-specifications "ResourceType=instance,Tags=[{$TAGS},{Key=Name,Value=$PREFIX}]" "ResourceType=volume,Tags=[{$TAGS}]" \
    --user-data "$USERDATA" --query 'Instances[0].InstanceId' --output text)
  aws ec2 wait instance-running --instance-ids "$INSTANCE"
fi
aws ec2 associate-address --instance-id "$INSTANCE" --allocation-id "$EIP_ALLOC" >/dev/null
say "instance $INSTANCE ($INSTANCE_TYPE)"

# --- CloudWatch dashboard ---------------------------------------------------------------------------
DASH=$(python3 - "$REGION" "$PREFIX" <<'PY'
import json, sys
region, prefix = sys.argv[1], sys.argv[2]
def w(title, metrics, x, y, stat="Average"):
    return {"type": "metric", "x": x, "y": y, "width": 12, "height": 6,
            "properties": {"title": title, "region": region, "stat": stat, "period": 60, "metrics": metrics}}
print(json.dumps({"widgets": [
    w("Seconds per photo (total, detect)", [["Sightline", "PhotoLatencyMs", "Step", "total"], ["Sightline", "PhotoLatencyMs", "Step", "detect"]], 0, 0),
    w("Candidates per photo", [["Sightline", "DetectionsPerPhoto"]], 12, 0),
    w("Agent model calls", [["Sightline", "AgentModelCalls"]], 0, 6, "Sum"),
    w("Photos waiting / dead letters", [["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", f"{prefix}-photos.fifo"],
                                        ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", f"{prefix}-photos-dlq.fifo"]], 12, 6, "Maximum"),
]}))
PY
)
aws cloudwatch put-dashboard --dashboard-name "$PREFIX" --dashboard-body "$DASH" >/dev/null
say "dashboard https://$REGION.console.aws.amazon.com/cloudwatch/home?region=$REGION#dashboards:name=$PREFIX"

# --- Budget alarm ($20), only with an email -------------------------------------------------------
if [ -n "${BUDGET_EMAIL:-}" ]; then
  aws budgets create-budget --account-id "$ACCOUNT" \
    --budget "{\"BudgetName\":\"$PREFIX\",\"BudgetLimit\":{\"Amount\":\"20\",\"Unit\":\"USD\"},\"TimeUnit\":\"MONTHLY\",\"BudgetType\":\"COST\"}" \
    --notifications-with-subscribers "[{\"Notification\":{\"NotificationType\":\"ACTUAL\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":80},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$BUDGET_EMAIL\"}]}]" \
    2>/dev/null && say "budget alarm: \$20/month, email at 80%" || say "budget alarm already exists"
fi

cat > "$STATE" <<EOF
REGION=$REGION
ACCOUNT=$ACCOUNT
BUCKET=$BUCKET
QUEUE_URL=$QUEUE_URL
DLQ_URL=$DLQ_URL
SECRET_ID=$SECRET_ID
ROLE=$ROLE
SG=$SG
EIP_ALLOC=$EIP_ALLOC
INSTANCE=$INSTANCE
SITE=$SITE
EOF
say "done. The instance builds the image on first boot (~5 min), then:"
echo "  curl https://$SITE/health"
echo "  set VITE_API_URL=https://$SITE on Vercel for the live missions"
echo "  stop when not demoing:  aws ec2 stop-instances --instance-ids $INSTANCE"
