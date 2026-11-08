# One Refit app server. The stores and the sandbox's Docker data live on the volume mounted at /data.
FROM node:22-bookworm-slim

# git clones repos; the VM runs its own Docker daemon, the only place repo code runs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io iptables git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN npm ci --omit=dev

# REFIT_SANDBOX is pinned so a daemon that is down fails the job instead of running repo code on the host.
ENV HOST=0.0.0.0 \
  REFIT_SANDBOX=docker \
  REFIT_QUEUE_FILE=/data/state/queue.json \
  REFIT_MEMORY_DIR=/data/state/memory \
  REFIT_AUDIT_DIR=/data/state/audit \
  REFIT_NOTIFY_STATE_FILE=/data/state/notified.json \
  REFIT_CACHE_DIR=/data/state/cache \
  REFIT_WATCH_CACHE_DIR=/data/state/watch-cache \
  TMPDIR=/data/tmp

EXPOSE 3000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
