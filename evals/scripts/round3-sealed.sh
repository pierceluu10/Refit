#!/bin/sh
# Round 3's one sealed run (L1), after practice stops: the same screen, then every green repo of
# the sealed set for each provider practised on, then the score. Nothing is tuned after this opens.
#
#   ANTHROPIC_API_KEY=... sh evals/scripts/round3-sealed.sh [concurrency]
set -eu
concurrency=${1:-2}
sets=sealed:stripe,sealed:openai,sealed:anthropic,sealed:gemini
screen=evals/reports/round-3/sealed/screen
out=evals/reports/round-3/sealed/results
: "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY for this command}"
export APTITUDE_SANDBOX=docker APTITUDE_AI_BUDGET_USD=2000
export APTITUDE_MEMORY_DIR=${APTITUDE_MEMORY_DIR:-$HOME/.aptitude-r3-memory}
mkdir -p "$out"
date -u +"started %Y-%m-%dT%H:%M:%SZ at $(git rev-parse --short HEAD)" | tee "$out/started.txt"
node evals/runner/cli.ts screen --sets "$sets" --budget-usd 500 --concurrency 6 --out "$screen" \
  --exclusions evals/reports/round-3/sealed/exclusions.json
node evals/runner/cli.ts run --set "$sets" --screen "$screen" --budget-usd 3000 \
  --concurrency "$concurrency" --out "$out" > "$out/run.log" 2>&1 || true
node evals/runner/cli.ts score3 --in "$out" --screen "$screen" --report "$out/score.md" --json "$out/score.json"
date -u +"finished %Y-%m-%dT%H:%M:%SZ" | tee -a "$out/started.txt"
