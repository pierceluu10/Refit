# Pinned by digest: Docker Hub multi-arch index of node:22-alpine, read 2026-10-22.
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
WORKDIR /opt/billing
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && chmod -R a+rX /opt/billing
COPY billing-pagination.mjs /opt/refit-checks/billing-pagination.mjs
