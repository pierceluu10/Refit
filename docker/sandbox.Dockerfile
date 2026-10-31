# Refit's validation sandbox: node:22-alpine, Refit's default check image, plus Python 3 with pip and
# venv, so a repository whose own checks need python3 (node-gyp builds, scripts that shell out) and a
# Python repository's tests and mypy run offline like the Node checks (pipeline/python-validation.ts).
# Base pinned by digest: Docker Hub multi-arch index of node:22-alpine (Alpine 3.24), read 2026-10-31.
# Python follows Alpine 3.24's 3.14 series; pip is Alpine's py3-pip. Nothing else is added.
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
RUN apk add --no-cache 'python3~3.14' py3-pip \
  && python3 -m venv /tmp/refit-venv-check \
  && /tmp/refit-venv-check/bin/python -m pip --version \
  && rm -rf /tmp/refit-venv-check
LABEL dev.refit.sandbox="node22-python3"
