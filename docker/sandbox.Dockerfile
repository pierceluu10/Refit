# Refit's validation sandboxes, two targets:
#
# - `python` (`--target python`): Python repositories' checks (pipeline/python/validation.ts). Debian
#   (glibc), because most Python packages publish manylinux wheels only; on Alpine (musl) pins such as
#   contourpy 1.1.1 or sqlite-vec have no wheel at all. Base: the node:22-bookworm-slim digest the
#   hosted worker's Dockerfile pins (read 2026-10-22), plus Debian bookworm's python3 (3.11), venv and
#   pip. Older or newer interpreters come from uv's managed builds during preparation.
# - the default target (last stage): node:22-alpine, Refit's Node check image, plus Alpine 3.24's
#   Python 3.14 and pip, so a Node repository whose checks call python3 (node-gyp builds, scripts that
#   shell out) finds it. Node checks otherwise behave as on node:22-alpine. Base pinned by digest:
#   Docker Hub multi-arch index of node:22-alpine, the digest CI pulls (read 2026-10-31).
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS python
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv python3-pip ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /tmp/refit-venv-check \
  && /tmp/refit-venv-check/bin/python -m pip --version \
  && rm -rf /tmp/refit-venv-check
LABEL dev.refit.sandbox="python-glibc"

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS node
RUN apk add --no-cache 'python3~3.14' py3-pip \
  && python3 -m venv /tmp/refit-venv-check \
  && /tmp/refit-venv-check/bin/python -m pip --version \
  && rm -rf /tmp/refit-venv-check
LABEL dev.refit.sandbox="node22-python3"
