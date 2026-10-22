# Hosted Refit worker for Fly.io Machines. Built from the release tarball so the deployed worker
# runs exactly the packaged CLI.
FROM node:22-bookworm-slim AS package
WORKDIR /source
COPY . .
RUN npm ci --ignore-scripts && npm run package:cli -- --output /package

FROM node:22-bookworm-slim
ARG OASDIFF_VERSION=1.33.0
ARG TARGETARCH=amd64
# The VM runs its own Docker daemon for offline validation; git fetches App-managed checkouts.
RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io iptables git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL "https://github.com/oasdiff/oasdiff/releases/download/v${OASDIFF_VERSION}/oasdiff_${OASDIFF_VERSION}_linux_${TARGETARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin oasdiff
COPY --from=package /package /package
RUN npm install --global /package/*.tgz && rm -rf /package
COPY scripts/hosted-entrypoint.sh /usr/local/bin/refit-hosted-entrypoint
ENTRYPOINT ["refit-hosted-entrypoint"]
