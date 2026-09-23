#!/bin/sh
# Nightly Postgres dump to S3. Cron (as ec2-user): 0 3 * * * /home/ec2-user/app/deploy/backup-db.sh
set -eu
cd "$(dirname "$0")/.."
# Read only what we need; the env file is Compose syntax, not shell.
S3_BUCKET=$(sed -n 's/^S3_BUCKET=//p' .env.production)
S3_REGION=$(sed -n 's/^S3_REGION=//p' .env.production)
stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
docker compose -f docker/docker-compose.prod.yml --env-file .env.production exec -T postgres \
  pg_dump -U dsp -d dsp --format=custom \
  | aws s3 cp - "s3://${S3_BUCKET}/_backups/db-${stamp}.dump" --region "${S3_REGION}"
