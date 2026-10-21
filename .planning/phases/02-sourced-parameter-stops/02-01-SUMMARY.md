---
phase: 02-sourced-parameter-stops
plan: 01
subsystem: model-retirements
tags: [model-parameters, validator, data]
requires: []
provides:
  - data/model-parameters.json sourced table (claude-sonnet-5-5, o3)
  - checkModelParameters / loadModelParameters
  - refit deadlines --check-parameters, npm run model-parameters:check
affects: [02-02]
key-files:
  created:
    - pipeline/model-parameters.ts
    - pipeline/model-parameters.test.ts
    - data/model-parameters.json
  modified:
    - pipeline/deadlines-cli.ts
    - pipeline/deadline-registry.ts
    - package.json
    - docs/CLI.md
decisions:
  - "Table holds exactly two entries; no top_p, Opus 4.8, Haiku 4.5, GPT-6 or OpenAI acceptance entries (D-11, D-14, D-16..D-19)"
metrics:
  duration: ~15 min
  completed: 2026-10-21
status: complete
actuals:
  tasks: 3
  commits: 3
plan_head_before: 811ed3dfad30d3074aef33482afb57b73e879006
plan_head_after: 3ed81d20e6d5fb86e5720ec389f1dc6492be9623
commits: 3
---

# Phase 2 Plan 01: Sourced parameter table Summary

A strict, whole-file-rejecting validator and a two-entry sourced table (Sonnet 5.5 `temperature` default-only 1 and `top_k` none; o3 `max_tokens` renamed), checked by `npm run model-parameters:check` and by `npm test`.

## Pages re-read (2026-10-21, via curl; WebFetch was not available)

- https://platform.claude.com/docs/en/models/sonnet-5-5/overview.md: titled "Claude Sonnet 5.5"; says "Setting `temperature`, `top_p`, or `top_k` to a non-default value returns a 400 error."
- https://platform.claude.com/docs/en/api/messages.md: temperature "Defaults to `1.0`." (it also says models after Opus 4.6 accept 1.0 only; no `top_p` entry written, per D-16).
- https://developers.openai.com/api/reference/resources/chat: `max_tokens` "is now deprecated in favor of max_completion_tokens, and is not compatible with o-series models". Confirmed on the rendered page text (HTML tags stripped).

All three confirmed; both entries were written.

## Deviations from Plan

- **[Process]** Task 1 contained the full validator rather than the minimal one, so Task 2's tests passed on first run with no RED step. All 32 rejection cases still ran against it. The o3 entry was held back to the Task 3 commit as planned.
- Sonnet entry's `checkedAt` and the o3 entry's are both 2026-10-21.

## Verification

- `npm test`: 107 files passed, 8 skipped; 1650 tests passed, 79 skipped (default count; gated suites not run).
- `npm run typecheck`: passed. `npm run format:check`: passed.
- `npm run model-parameters:check`: valid (2 models). Look-alike host file exits 1 with a non-empty `errors` array.

## Known Stubs

None. Nothing reads the table until plan 02-02.

## Self-Check: PASSED

Files and commits f1e6c37, fa28be9, 3ed81d2 exist.
