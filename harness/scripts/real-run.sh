#!/bin/sh
# The one real run: openai SDK v3 -> v4 on RomanHotsiy/commitgpt, capped at $5 by the ledger.
# Clones into a temp dir outside this repo and runs it in the Docker sandbox. Nothing is pushed or opened.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/aptitude-real-run-XXXXXX")
git clone -q https://github.com/RomanHotsiy/commitgpt.git "$work/repo"
git -C "$work/repo" checkout -q dfbe1eb215b4c7a7ff2b10451a56ca10b5266748
APTITUDE_AI_BUDGET_USD=5 APTITUDE_SANDBOX=docker \
  node "$here/run-task.ts" "$here/commitgpt-task.json" "$work/repo" "$work/out"
echo "Outputs: $work/out"
