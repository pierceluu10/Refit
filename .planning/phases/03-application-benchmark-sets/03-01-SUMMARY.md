---
phase: 03-application-benchmark-sets
plan: 01
subsystem: benchmarks
tags: [github-code-search, gh-api, benchmark, openai, anthropic]
requires: []
provides:
  - scripts/ai-app-select.mjs staged, cached GitHub code-search selector
  - scripts/ai-app-helpers.mjs tested D-02 predicates, validators and ranking
  - frozen lists of 100 OpenAI and 50 Anthropic applications (2026-10-21)
affects: [03-02, 03-03, phase-4 benchmark]
status: complete
commits: 3
plan_head_before: 4c31bd5022597d5644017ddd52f6df305d02bc0d
plan_head_after: 17a8992834e18049334dff7cc956f4d6940bcbe0
actuals:
  tokens: 60000
  tasks: 3
  commits: 3
tech-stack:
  added: []
  patterns: [plain-JS scripts module tested from pipeline/, per-stage resume cache outside the repo]
key-files:
  created:
    - scripts/ai-app-helpers.mjs
    - scripts/ai-app-helpers.d.mts
    - pipeline/ai-app-helpers.test.ts
    - scripts/ai-app-select.mjs
    - docs/benchmarks/2026-10-21-openai-app-repos.json
    - docs/benchmarks/2026-10-21-anthropic-app-repos.json
  modified:
    - docs/BENCHMARKS.md
    - AGENTS.md
key-decisions:
  - "No shortfall: both targets reached with no filter loosened and no extra queries added"
  - "A passing repository keeps its checkout under the bench root for plan 03-02; rejected ones are deleted"
requirements-completed: [BENCH-01]
---

# Phase 3 Plan 01: Application benchmark sets Summary

A `gh api`-only code-search selector froze 100 OpenAI and 50 Anthropic application repositories, ranked by stars within the retrievable pool, with queries, date, filters and pinned commits recorded in each file.

START (plan-start SHA): `4c31bd5022597d5644017ddd52f6df305d02bc0d`.

## Tasks

1. Tracer: helpers, 14 tests and the selector, proven on a 3-repository Anthropic dry run (7 queries, 3 entries) - `49d0847`
2. Full selection for both providers, frozen lists, cache replay - `d2ad752`
3. BENCHMARKS.md section with the library-baseline note, AGENTS.md frozen lists - `17a8992`

## Results

| | OpenAI | Anthropic |
|---|---|---|
| Selected / target | 100 / 100 | 50 / 50 |
| Shortfall | none | none |
| Pool after dedupe (`poolSize`) | 8,990 | 4,807 |
| Duplicates removed | 2,006 | 2,193 |
| `hasChecks: true` | 95 | 45 |
| Workspace entries | 2 | 0 |
| Deeper manifests not read | 251 | 68 |

Repositories in both lists: 9. Rejected counts (examined repositories only after the cheap filters, in rank order):

- OpenAI: alreadyFrozen 35, old 4,215, excludedName 132, scanLimits 18, noDependency 180, library 39, noModelCall 26; invalidName, unreachable, noCommit, fork, archived, badManifest, checkoutFailed 0.
- Anthropic: alreadyFrozen 26, old 656, excludedName 70, scanLimits 5, badManifest 3, noDependency 21, library 40, checkoutFailed 1, noModelCall 11; the rest 0.

Every other frozen list was excluded (12 lists recorded under `excludedLists`, including both 2026-10-20 npm lists). The 2026-10-20 npm list files are byte-identical to the plan start.

## Cache replay

Re-running both commands unchanged against the same `--work` caches rewrote both frozen files byte for byte (`cmp` silent). This proves cache replay only. It does not prove that a fresh search against the moving code-search index reproduces the lists; the frozen files and the `$BENCH/work` caches are the record.

## Verification

- `npx vitest run pipeline/ai-app-helpers.test.ts`: 14 passed.
- `npm run typecheck`: exit 0. `npm run format:check`: exit 0.
- `npm test` (default, gated suites skipped): 1691 passed, 1 failed, 79 skipped (1771). The failure is `pipeline/model-retirements.test.ts` "parameter table: continues for a sourced literal and edits only the model" (a temperature stop for claude-sonnet-5-5). It comes from Phase 2 work, this plan touches no pipeline code, and it is logged in `.planning/phases/03-application-benchmark-sets/deferred-items.md`. Not fixed (out of scope).
- `grep -Ec "auth token|GITHUB_TOKEN" scripts/ai-app-select.mjs`: 0.
- `git diff --name-only 4c31bd5..HEAD -- pipeline/ ':!pipeline/*.test.ts'`: empty.

## Deviations from Plan

None - plan executed as written. The tracer gate re-ran the dry-run verification end to end before expanding.

## Known Stubs

None.

## Notes for later plans

- Cache and checkouts live under `/Users/otabekalimov/Repos/refit-ai-app-bench` (`work/openai`, `work/anthropic`, `checkouts`). The `dry` directory was deleted. Search ran through `gh` only; no token was read or printed.
- Stars ordering is within the retrievable code-search pool, not across GitHub. Exposure was never used for selection.

## Self-Check: PASSED

Created files exist, commits `49d0847`, `d2ad752`, `17a8992` are ancestors of HEAD.
