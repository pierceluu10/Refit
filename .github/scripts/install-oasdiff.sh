#!/usr/bin/env bash
# Installs the pinned oasdiff release for Linux x86-64 into /usr/local/bin after checking its
# SHA-256 against the value the workflow pins. Usage: install-oasdiff.sh <version> <sha256>
set -euo pipefail
version="$1"
expected="$2"
archive="$(mktemp)"
curl -fsSL -o "$archive" \
  "https://github.com/oasdiff/oasdiff/releases/download/v${version}/oasdiff_${version}_linux_amd64.tar.gz"
echo "${expected}  ${archive}" | sha256sum --check --strict
sudo tar -xzf "$archive" -C /usr/local/bin oasdiff
rm -f "$archive"
oasdiff --version
