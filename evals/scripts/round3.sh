#!/bin/sh
# One round-3 practice iteration (L1): screen every practice set (cached per repo and commit, so
# only the first iteration pays for it), run each set's green repos, then score.
#
#   ANTHROPIC_API_KEY=... sh evals/scripts/round3.sh <iteration> [sets] [concurrency per set]
#
# Run from the repo root on r3/integration, with Docker running. The key goes to this one command.
set -eu
iteration=${1:?iteration number}
sets=${2:-stripe-dev-30,openai-dev-30,anthropic-dev-30,gemini-dev-15,longtail-dev-20}
concurrency=${3:-2}
screen=evals/reports/round-3/screen
out=evals/reports/round-3/iter-$iteration
: "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY for this command}"
# Caps high enough that they never decide anything; the cap mechanism itself stays.
export REFIT_SANDBOX=docker REFIT_AI_BUDGET_USD=2000
# One memory store across iterations, written by this one process, so recipes carry over.
export REFIT_MEMORY_DIR=${REFIT_MEMORY_DIR:-$HOME/.refit-r3-memory}
mkdir -p "$out"
date -u +"started %Y-%m-%dT%H:%M:%SZ at $(git rev-parse --short HEAD)" | tee "$out/started.txt"
node evals/runner/cli.ts screen --sets "$sets" --budget-usd 300 --concurrency 6
# Every set in one process (each with its own cap), so the memory store has one writer.
node evals/runner/cli.ts run --set "$sets" --screen "$screen" --budget-usd 2000 \
  --concurrency "$concurrency" --out "$out" > "$out/run.log" 2>&1 || true
node evals/runner/cli.ts score3 --in "$out" --screen "$screen" --report "$out/score.md" --json "$out/score.json"
date -u +"finished %Y-%m-%dT%H:%M:%SZ" | tee -a "$out/started.txt"
