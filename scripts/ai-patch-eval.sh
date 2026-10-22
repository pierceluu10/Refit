#!/bin/bash
# Runs the frozen AI patch eval cases (docs/AI-PATCH-RELIABILITY.md) from a pinned Refit worktree:
# every Stripe case through `benchmark:stripe --ai --validate`, one repository at a time, then the
# private billing demo from a local git source. Score the output with `npm run eval:ai-patch`.
#
# Usage: scripts/ai-patch-eval.sh <pinned-refit-worktree> <cases-root> <output> <budget-directory> <env-file> <billing-demo-git-source>
#   <cases-root> comes from `node scripts/stripe-benchmark-setup.mjs --root <dir> --list docs/benchmarks/2026-10-22-ai-patch-cases.json`.
#   <env-file> supplies OPENAI_API_KEY; OPENAI_MODEL and REFIT_AI_BUDGET_USD set here win over it.
# A case directory is moved into <output> only when its run finishes, so a rerun resumes.
set -u
if [ $# -ne 6 ]; then
  sed -n '6,7p' "$0" >&2
  exit 2
fi
REFIT=$1 ROOT=$2 OUT=$3 LEDGER=$4 ENV=$5 DEMO=$6
CASES=$REFIT/docs/benchmarks/2026-10-22-ai-patch-cases.json
export OPENAI_MODEL=${OPENAI_MODEL:-gpt-5.6-luna} REFIT_AI_BUDGET_USD=${REFIT_AI_BUDGET_USD:-4}
export REFIT_AI_BUDGET_DIRECTORY=$LEDGER REFIT_DOCKER_IMAGE=${REFIT_DOCKER_IMAGE:-node:22-alpine}

# Parallel agents on one machine share Docker through this lock; a lock older than two hours is
# stale. Only a lock this process wrote is ever removed.
LOCK=/tmp/refit-docker.lock
OWNER="ai-patch-eval $$"
STALE_SECONDS=7200
WAIT_SECONDS=60
held=0
modified() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
lock() {
  while ! mkdir "$LOCK" 2>/dev/null; do
    if [ -f "$LOCK/owner" ] && [ $(($(date +%s) - $(modified "$LOCK/owner"))) -gt $STALE_SECONDS ]; then
      rm -rf "$LOCK"
      continue
    fi
    sleep $WAIT_SECONDS
  done
  echo "$OWNER $(date -u +%FT%TZ)" >"$LOCK/owner"
  held=1
}
unlock() {
  if [ "$held" = 1 ] && grep -q "^$OWNER " "$LOCK/owner" 2>/dev/null; then rm -rf "$LOCK"; fi
  held=0
}
trap unlock EXIT

mkdir -p "$OUT"
count=$(node -e 'console.log(require(process.argv[1]).length)' "$ROOT/selected.json")
for i in $(seq 0 $((count - 1))); do
  [ -e "$OUT/$i" ] && continue
  rm -rf "$OUT/.$i"
  lock
  echo "$(date -u +%T) case $i"
  (cd "$REFIT" && npx tsx pipeline/stripe-benchmark-cli.ts --root "$ROOT" --output "$OUT/.$i" --env "$ENV" --ai --validate --offset "$i" --limit 1) >"$OUT/$i.log" 2>&1
  unlock
  mv "$OUT/.$i" "$OUT/$i"
done

DEMO_ID=refit-billing-demo
if [ ! -e "$OUT/$DEMO_ID" ]; then
  commit=$(node -e 'const c = require(process.argv[1]).privateCases.find((e) => e.id === process.argv[2]); console.log(c.commit)' "$CASES" "$DEMO_ID")
  work=$(mktemp -d)
  git clone -q --no-checkout "$DEMO" "$work/demo" && git -C "$work/demo" checkout -q -B main "$commit"
  rm -rf "$OUT/.$DEMO_ID"
  lock
  echo "$(date -u +%T) $DEMO_ID"
  (cd "$work/demo" && node "$REFIT/bin/refit.mjs" run --env "$ENV" --output "$OUT/.$DEMO_ID" --ai-patch --repair-attempts 1 --quiet --json) >"$OUT/$DEMO_ID.log" 2>&1
  unlock
  mv "$OUT/.$DEMO_ID" "$OUT/$DEMO_ID"
  rm -rf "$work"
fi
echo "$(date -u +%T) done"
