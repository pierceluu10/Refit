# Hosted Refit worker for Fly.io Machines. Built from the release tarball so the deployed worker
# runs exactly the packaged CLI.
# Base image pinned by digest: Docker Hub multi-arch index of node:22-bookworm-slim, read 2026-10-22.
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS package
WORKDIR /source
COPY . .
RUN npm ci --ignore-scripts && npm run package:cli -- --output /package

FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
ARG OASDIFF_VERSION=1.33.0
ARG TARGETARCH=amd64
# Release archive digests from oasdiff's v1.33.0 checksums.txt, checked against the downloads on
# 2026-10-22. Changing OASDIFF_VERSION requires replacing both.
ARG OASDIFF_SHA256_AMD64=43a4e328e2d13ba1552d760aa68d2485c75c5621f309f6ff64ae895188345247
ARG OASDIFF_SHA256_ARM64=4ae3c362d6074d919aada2dea82d0ee84366591600384455d0bdc658ddf8f7ae
# The VM runs its own Docker daemon for offline validation; git fetches App-managed checkouts.
RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io iptables git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && case "$TARGETARCH" in \
    amd64) checksum="$OASDIFF_SHA256_AMD64" ;; \
    arm64) checksum="$OASDIFF_SHA256_ARM64" ;; \
    *) echo "No oasdiff checksum for $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && curl -fsSL -o /tmp/oasdiff.tar.gz \
    "https://github.com/oasdiff/oasdiff/releases/download/v${OASDIFF_VERSION}/oasdiff_${OASDIFF_VERSION}_linux_${TARGETARCH}.tar.gz" \
  && echo "$checksum  /tmp/oasdiff.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/oasdiff.tar.gz -C /usr/local/bin oasdiff \
  && rm /tmp/oasdiff.tar.gz
COPY --from=package /package /package
# Dependency lifecycle scripts never run; the CLI works without them (pipeline/packaging.test.ts).
RUN npm install --global --ignore-scripts /package/*.tgz && rm -rf /package
COPY scripts/hosted-entrypoint.sh /usr/local/bin/refit-hosted-entrypoint
ENTRYPOINT ["refit-hosted-entrypoint"]
