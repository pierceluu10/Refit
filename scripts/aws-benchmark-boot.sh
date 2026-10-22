#!/bin/bash
# EC2 user data for one benchmark shard. scripts/aws-benchmark.mjs prepends BUCKET, RUN, SHARD,
# MINUTES, COMMAND and IMAGES. The instance terminates on shutdown, so every exit path ends it.
set -euo pipefail
shutdown -h "+${MINUTES}"

OASDIFF_VERSION=1.33.0
NODE_DIST=https://nodejs.org/dist/latest-v22.x
PREFIX="s3://${BUCKET}/runs/${RUN}"
SHARD_PREFIX="${PREFIX}/shard-${SHARD}"
LOG=/var/log/refit-benchmark.log
exec > >(tee "$LOG") 2>&1

finish() {
  local status=$?
  echo "exit ${status}"
  echo "$status" > /tmp/exit-code
  aws s3 cp /tmp/exit-code "${SHARD_PREFIX}/exit-code" --only-show-errors || true
  aws s3 cp "$LOG" "${SHARD_PREFIX}/boot.log" --only-show-errors || true
  shutdown -h now
}
trap finish EXIT

dnf install -y -q docker git tar gzip
systemctl start docker

cd /tmp
node_archive=$(curl -fsSL "${NODE_DIST}/SHASUMS256.txt" | awk '/linux-x64\.tar\.gz$/ {print $2}')
curl -fsSLO "${NODE_DIST}/${node_archive}"
curl -fsSL "${NODE_DIST}/SHASUMS256.txt" | grep " ${node_archive}\$" | sha256sum -c -
tar -xzf "$node_archive" -C /usr/local --strip-components=1
curl -fsSL "https://github.com/oasdiff/oasdiff/releases/download/v${OASDIFF_VERSION}/oasdiff_${OASDIFF_VERSION}_linux_amd64.tar.gz" \
  | tar -xz -C /usr/local/bin oasdiff

mkdir -p /work/refit /work/root /work/out
aws s3 cp "${PREFIX}/source.tar.gz" /work/source.tar.gz --only-show-errors
tar -xzf /work/source.tar.gz -C /work/refit
# The optional .env (for --ai runs) is deleted from S3 by `collect` and `stop`.
aws s3 cp "${PREFIX}/env" /work/refit/.env --only-show-errors 2>/dev/null || true
cd /work/refit
npm ci --no-audit --no-fund
for image in $IMAGES; do docker pull -q "$image"; done

set +e
bash -c "$COMMAND"
status=$?
set -e
aws s3 cp /work/out "${SHARD_PREFIX}/out" --recursive --only-show-errors
exit "$status"
