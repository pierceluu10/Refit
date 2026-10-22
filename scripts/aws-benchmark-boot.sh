#!/bin/bash
# EC2 user data for one benchmark shard. scripts/aws-benchmark.mjs prepends BUCKET, RUN, SHARD,
# MINUTES, SOURCE_SHA256, COMMAND and IMAGES. The instance terminates on shutdown, so every exit
# path ends it.
set -euo pipefail
shutdown -h "+${MINUTES}"

OASDIFF_VERSION=1.33.0
NODE_DIST=https://nodejs.org/dist/latest-v22.x
# A deadman shutdown loses at most this much of the command's /work/out.
UPLOAD_SECONDS=600
PREFIX="s3://${BUCKET}/runs/${RUN}"
SHARD_PREFIX="${PREFIX}/shard-${SHARD}"
LOG=/var/log/refit-benchmark.log
exec > >(tee "$LOG") 2>&1

# A failed boot stage exits with its own code, so `status` tells infrastructure failures apart
# from the benchmark command's exit code. The exit-code object records "<code> <stage>".
stage() {
  STAGE=$1
  STAGE_CODE=$2
}

finish() {
  local status=$?
  if [ "$status" -ne 0 ] && [ "$STAGE" != command ]; then status=$STAGE_CODE; fi
  echo "exit ${status} (${STAGE})"
  echo "${status} ${STAGE}" > /tmp/exit-code
  aws s3 cp /tmp/exit-code "${SHARD_PREFIX}/exit-code" --only-show-errors || true
  aws s3 cp "$LOG" "${SHARD_PREFIX}/boot.log" --only-show-errors || true
  shutdown -h now
}
trap finish EXIT

upload() {
  aws s3 sync /work/out "${SHARD_PREFIX}/out" --only-show-errors
}

stage packages 70
dnf install -y -q docker git tar gzip
systemctl start docker

stage node 71
cd /tmp
node_archive=$(curl -fsSL "${NODE_DIST}/SHASUMS256.txt" | awk '/linux-x64\.tar\.gz$/ {print $2}')
curl -fsSLO "${NODE_DIST}/${node_archive}"
curl -fsSL "${NODE_DIST}/SHASUMS256.txt" | grep " ${node_archive}\$" | sha256sum -c -
tar -xzf "$node_archive" -C /usr/local --strip-components=1

stage oasdiff 72
curl -fsSL "https://github.com/oasdiff/oasdiff/releases/download/v${OASDIFF_VERSION}/oasdiff_${OASDIFF_VERSION}_linux_amd64.tar.gz" \
  | tar -xz -C /usr/local/bin oasdiff

stage source 73
mkdir -p /work/refit /work/root /work/out
aws s3 cp "${PREFIX}/source.tar.gz" /work/source.tar.gz --only-show-errors
echo "${SOURCE_SHA256}  /work/source.tar.gz" | sha256sum -c -
tar -xzf /work/source.tar.gz -C /work/refit
# The optional .env (for --ai runs) is deleted from S3 by `collect` and `stop`.
aws s3 cp "${PREFIX}/env" /work/refit/.env --only-show-errors 2>/dev/null || true

stage npm-ci 74
cd /work/refit
npm ci --no-audit --no-fund

stage images 75
for image in $IMAGES; do docker pull -q "$image"; done

stage command 0
# TERM stops the uploader between syncs; bash defers it until an in-flight sync ends, so no older
# sync can land after the final one.
(
  trap 'exit 0' TERM
  while true; do
    sleep "$UPLOAD_SECONDS" &
    wait $!
    upload || echo "incremental upload failed"
  done
) &
uploader=$!
set +e
bash -c "$COMMAND"
status=$?
set -e
kill "$uploader"
wait "$uploader"

stage upload 76
upload
stage command 0
exit "$status"
