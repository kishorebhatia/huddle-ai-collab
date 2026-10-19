#!/bin/bash
# Create the AWS side of a Huddle deploy: key pair, security group, EC2 (Amazon Linux 2023 + Docker), an Elastic IP,
# and a CloudFront distribution in front of it. Prints what to put in aws/.env and GitHub.
#   AWS_REGION=us-west-2 aws/provision.sh [name]          (needs the AWS CLI with credentials that can do the above)
# Writes the SSH private key to aws/<name>-key.pem (git-ignored by *.pem). Safe to re-run: existing pieces are reused.
set -euo pipefail
NAME=${1:-huddle}; REGION=${AWS_REGION:-us-west-2}; TYPE=${INSTANCE_TYPE:-t3.medium}
REPO=${REPO:-https://github.com/kishorebhatia/huddle-ai-collab.git}
SSH_CIDR=${SSH_CIDR:-0.0.0.0/0}   # GitHub's runners have no fixed IPs; password login is off on AL2023
export AWS_REGION=$REGION AWS_PAGER=""
cd "$(dirname "$0")"

# 1. Key pair
if ! aws ec2 describe-key-pairs --key-names "$NAME-key" >/dev/null 2>&1; then
  aws ec2 create-key-pair --key-name "$NAME-key" --query KeyMaterial --output text > "$NAME-key.pem"
  chmod 600 "$NAME-key.pem"; echo "key pair: aws/$NAME-key.pem"
fi

# 2. Security group: HTTP only from CloudFront's origin-facing prefix list, SSH from SSH_CIDR
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values="$NAME-sg" Name=vpc-id,Values="$VPC" --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = None ]; then
  SG=$(aws ec2 create-security-group --group-name "$NAME-sg" --description "Huddle: CloudFront to 80, SSH" --vpc-id "$VPC" --query GroupId --output text)
  PL=$(aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing --query 'PrefixLists[0].PrefixListId' --output text)
  aws ec2 authorize-security-group-ingress --group-id "$SG" --ip-permissions "IpProtocol=tcp,FromPort=80,ToPort=80,PrefixListIds=[{PrefixListId=$PL}]" >/dev/null
  aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 22 --cidr "$SSH_CIDR" >/dev/null
fi
echo "security group: $SG"

# 3. Instance (Docker + Compose plugin + the repo's live branch, installed on first boot)
ID=$(aws ec2 describe-instances --filters Name=tag:Name,Values="$NAME" Name=instance-state-name,Values=pending,running,stopped --query 'Reservations[0].Instances[0].InstanceId' --output text)
if [ "$ID" = None ]; then
  AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text)
  cat > /tmp/huddle-userdata.sh <<UD
#!/bin/bash
dnf install -y docker git
systemctl enable --now docker
usermod -aG docker ec2-user
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64 -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
sudo -u ec2-user git clone --branch live $REPO /home/ec2-user/huddle || sudo -u ec2-user git clone $REPO /home/ec2-user/huddle
UD
  ID=$(aws ec2 run-instances --image-id "$AMI" --instance-type "$TYPE" --key-name "$NAME-key" --security-group-ids "$SG" \
    --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=30,VolumeType=gp3}' --user-data file:///tmp/huddle-userdata.sh \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" --query 'Instances[0].InstanceId' --output text)
  rm -f /tmp/huddle-userdata.sh
  aws ec2 wait instance-running --instance-ids "$ID"
fi
echo "instance: $ID"

# 4. Elastic IP, so stopping the instance doesn't change the CloudFront origin's DNS name
EIP=$(aws ec2 describe-addresses --filters Name=instance-id,Values="$ID" --query 'Addresses[0].PublicIp' --output text)
if [ "$EIP" = None ]; then
  ALLOC=$(aws ec2 allocate-address --domain vpc --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME}]" --query AllocationId --output text)
  aws ec2 associate-address --instance-id "$ID" --allocation-id "$ALLOC" >/dev/null
fi
HOST=$(aws ec2 describe-instances --instance-ids "$ID" --query 'Reservations[0].Instances[0].PublicDnsName' --output text)
echo "origin host: $HOST"

# 5. CloudFront: HTTP origin on 80, caching off, all viewer headers but Host, all methods, 60 s read timeout
DIST=$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='$NAME'].Id | [0]" --output text 2>/dev/null || echo None)
if [ "$DIST" = None ] || [ -z "$DIST" ]; then
  cat > /tmp/huddle-cf.json <<CF
{"CallerReference":"$NAME-$(date +%s)","Comment":"$NAME","Enabled":true,"HttpVersion":"http2",
 "Origins":{"Quantity":1,"Items":[{"Id":"ec2","DomainName":"$HOST","CustomOriginConfig":{"HTTPPort":80,"HTTPSPort":443,
   "OriginProtocolPolicy":"http-only","OriginReadTimeout":60,"OriginKeepaliveTimeout":5,"OriginSslProtocols":{"Quantity":1,"Items":["TLSv1.2"]}}}]},
 "DefaultCacheBehavior":{"TargetOriginId":"ec2","ViewerProtocolPolicy":"redirect-to-https","Compress":true,
   "CachePolicyId":"4135ea2d-6df8-44a3-9df3-4b5a84be39ad","OriginRequestPolicyId":"b689b0a8-53d0-40ab-baf2-68738e2966ac",
   "AllowedMethods":{"Quantity":7,"Items":["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],"CachedMethods":{"Quantity":2,"Items":["GET","HEAD"]}}}}
CF
  DIST=$(aws cloudfront create-distribution --distribution-config file:///tmp/huddle-cf.json --query Distribution.Id --output text)
  rm -f /tmp/huddle-cf.json
fi
CF_DOMAIN=$(aws cloudfront get-distribution --id "$DIST" --query Distribution.DomainName --output text)

cat <<OUT

Done. CloudFront takes a few minutes to deploy.
  site:        https://$CF_DOMAIN
  instance:    $ID   ($HOST)
  cloudfront:  $DIST
Next (aws/README.md, "First deploy"):
  1. PUBLIC_SITE_URL=https://$CF_DOMAIN node aws/gen-env.mjs, then fill in aws/.env from aws/.env.example
  2. scp -i aws/$NAME-key.pem aws/.env ec2-user@$HOST:huddle/aws/.env
  3. ssh -i aws/$NAME-key.pem ec2-user@$HOST 'cd huddle/aws && sudo docker compose -p huddle up -d'
  4. GitHub: vars HUDDLE_URL=https://$CF_DOMAIN DEPLOY_HOST=$HOST; secrets DEPLOY_SSH_KEY, DEPLOY_KNOWN_HOSTS, EVAL_TOKEN, ARIZE_API_KEY
OUT
