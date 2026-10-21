---
phase: 02-sourced-parameter-stops
plan: 02
subsystem: model-retirements
tags: [model-parameters, replacement-rule, docs]
requires: [02-01]
provides:
  - parameterVerdict and parameterReason (pipeline/model-parameters.ts)
  - table-driven sensitive-parameter decision with numericLiteral (pipeline/model-retirements.ts)
  - parameters argument through deadlines-cli (--parameters), model-fixes, local-service, ai-model-validation-cli
affects: [03]
key-files:
  modified:
    - pipeline/model-parameters.ts
    - pipeline/model-retirements.ts
    - pipeline/deadlines-cli.ts
    - pipeline/model-fixes.ts
    - pipeline/local-service.ts
    - pipeline/ai-model-validation-cli.ts
    - pipeline/model-retirements.test.ts
    - pipeline/model-parameters.test.ts
    - pipeline/model-fixes.test.ts
    - pipeline/model-fixes-service.test.ts
    - AGENTS.md
    - docs/DEADLINES.md
    - docs/READINESS.md
    - .planning/PROJECT.md
decisions:
  - "Sourced parameter stops recorded in AGENTS.md (2026-10-21, made by Otabek Alimov, pending the repository owner's review on the phase PR)"
metrics:
  completed: 2026-10-21
status: complete
actuals:
  tasks: 3
  commits: 3
plan_head_before: 6630862ab92646e5e7c91f594141c902b86aebe1
plan_head_after: dd068ff43d621b685c64a73710eaad0c8c0b36bf
commits: 3
---

# Phase 2 Plan 02: Table-driven parameter stops Summary

The replacement rule now continues past a sampling or length stop only where the sourced table proves the final replacement accepts that parameter with a numeric literal written in the request, and every caller loads the shipped table.

## Commits

- 40b357b feat(02-02): decide sensitive parameters from the sourced table
- 9a9e7aa feat(02-02): load the sourced table in serve model fixes and test both outcomes
- dd068ff docs(02-02): record the sourced parameter stops decision and update the guides

## What changed

- `parameterVerdict` / `parameterReason` (pure, `Object.hasOwn` lookup so `__proto__` and similar give "unproven").
- `numericLiteral`: only a direct, optionally signed numeric literal that is finite. No constants followed.
- With no table entry for `resolved.to`, the old `rejectsSampling` filter and the legacy sentence are byte-identical. With an entry, each parameter is verified separately and the stop names only the failing ones. Spread, non-text, base-URL, limit and shared-use stops still come first.
- Serve (`local-service`) loads the table in the same try block as the registry, so a load failure skips model fixes with the existing message. The CLI and validation CLI fail on a bad table. `refit deadlines --propose-model-fixes` accepts `--parameters <path>`.
- No request text is rewritten, renamed parameters included. No table entry was added.

## Deviations from Plan

**1. [Rule 3 - Blocking] `pipeline/model-fixes-service.test.ts` clock.** The shipped table has `checkedAt: 2026-10-21`, so with that test's fixed clock of 2026-10-20 the table is rejected as dated in the future (fail closed, which is the intended behavior) and model fixes were skipped. Changed that test's `now` to 2026-10-21T12:00:00Z. This is the only pre-existing expectation changed. No `deadlines.test.ts` or `model-retirements.test.ts` pre-existing expectation changed.

**2. [Process] Task 2 tests largely passed on first run** because Task 1 already carried the rule; no separate RED step was possible for them. `local-service.ts` wiring was committed with Task 2 rather than Task 1.

`.planning/ROADMAP.md` carried an unrelated uncommitted modification from the orchestrator; it was not staged.

## Verification (run at dd068ff)

- Default: `npm test`: 107 files passed, 8 skipped; 1667 tests passed, 79 skipped.
- Gated (run alone): `REFIT_DOCKER_IMAGE=node:22-alpine npx vitest run pipeline/model-fixes-docker.test.ts`: 1 file passed, 1 test passed (Docker available).
- `npm run typecheck`: passed. `npm run format:check`: passed. `npm run build`: passed. `npm run model-parameters:check`: valid (2 models).
- Task 1 CLI end-to-end against the shipped table: PASS (line 4 `temperature: 1` proposed; line 5 `temperature: 0.2` stops with the non-default sentence for claude-sonnet-5-5).
- No live provider was called; all rule evidence is fixture tests plus the pages read in 02-01.

## Known Stubs

None.

## Self-Check: PASSED

Commits 40b357b, 9a9e7aa, dd068ff exist on feat/ai-agents-phase-2.
