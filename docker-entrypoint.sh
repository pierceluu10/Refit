#!/bin/sh
# Starts the Docker daemon the sandbox needs, then runs the app as an unprivileged user.
set -eu

DOCKER_READY_SECONDS=60
DOCKER_MTU=1400 # below Fly's network MTU, or large downloads inside a sandbox hang
DATA_ROOT=/data/docker
STATE_DIR=/data/state

mkdir -p "$DATA_ROOT" "$STATE_DIR"
# Checkouts and sandbox copies live on the volume, not the 8 GB root disk; none outlives a boot.
rm -rf "$TMPDIR"
mkdir -p "$TMPDIR"
chown -R node:node "$STATE_DIR" "$TMPDIR"
rm -f /var/run/docker.pid # left by a killed container, it would stop dockerd starting

# env -i keeps the app's secrets out of the daemon's environment.
env -i PATH="$PATH" dockerd --data-root="$DATA_ROOT" --group=node --mtu="$DOCKER_MTU" --log-level=warn &

waited=0
until docker info >/dev/null 2>&1; do
  waited=$((waited + 1))
  if [ "$waited" -ge "$DOCKER_READY_SECONDS" ]; then
    echo "Docker daemon did not start within ${DOCKER_READY_SECONDS}s" >&2
    exit 1
  fi
  sleep 1
done

export HOME=/home/node
exec setpriv --reuid=node --regid=node --init-groups node --experimental-strip-types app/main.ts
