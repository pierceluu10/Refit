#!/bin/sh
# Starts the in-VM Docker daemon, writes the App key from its Fly secret, then runs the hosted worker.
set -eu

DOCKER_READY_SECONDS=60
mkdir -p /data/docker /data/state /data/ai-budget
dockerd --data-root=/data/docker >/var/log/dockerd.log 2>&1 &
i=0
until docker info >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge "$DOCKER_READY_SECONDS" ]; then
    echo "Docker daemon did not start; see /var/log/dockerd.log" >&2
    exit 1
  fi
  sleep 1
done
# Validation images named by approved .refit.json files must exist before doctor runs.
for image in ${REFIT_HOSTED_IMAGES:-}; do docker pull "$image"; done

umask 077
mkdir -p /run/refit
printf '%s\n' "${GITHUB_APP_PRIVATE_KEY:?GITHUB_APP_PRIVATE_KEY secret is required}" >/run/refit/app.pem
export GITHUB_APP_PRIVATE_KEY_FILE=/run/refit/app.pem
unset GITHUB_APP_PRIVATE_KEY

# shellcheck disable=SC2086
exec refit hosted serve --state /data/state --port 8080 ${REFIT_HOSTED_FLAGS:-}
