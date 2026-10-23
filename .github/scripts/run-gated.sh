#!/usr/bin/env bash
# Runs every pipeline test file that reads one of the named environment variables, so a new gated
# test is picked up without editing the workflow. The variables themselves come from the job.
# Usage: run-gated.sh REFIT_DOCKER_IMAGE [REFIT_NPM_PREPARE ...]
set -euo pipefail
variables="$*"
pattern="process\.env\.($(IFS='|'; echo "$*"))([^A-Z_]|$)"
files="$(grep -lE "$pattern" pipeline/*.test.ts || true)"
if [ -z "$files" ]; then
  echo "No test file reads $variables." >&2
  exit 1
fi
# Test file names have no spaces, so word splitting is safe here.
# shellcheck disable=SC2086
set -- $files
echo "Test files reading $variables:"
printf '  %s\n' "$@"
npx vitest run "$@"
