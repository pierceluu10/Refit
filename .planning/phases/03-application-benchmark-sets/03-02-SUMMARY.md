---
phase: 03-application-benchmark-sets
plan: 02
subsystem: benchmarks
tags: [model-id-labels, independent-grep, ai-assisted-labelling]
requires: [03-01]
provides:
  - scripts/ai-app-label-candidates.mjs independent quoted-model-ID grep and batching
  - scripts/ai-app-labels.mjs validating merge of per-batch labels
  - docs/benchmarks/2026-10-21-ai-app-labels.json (4679 labels, 377 live)
affects: [03-03, phase-4 benchmark]
status: complete
commits: 2
plan_head_before: d096762fe2151d1a99d816df2e32bc60c1ac9513
plan_head_after: 1845ccff2c2cdb005257534d5e2d8449d4625ef9
actuals:
  tokens: 40000
  tasks: 3
  commits: 2
key-files:
  created:
    - scripts/ai-app-helpers.mjs
    - scripts/ai-app-label-candidates.mjs
    - scripts/ai-app-labels.mjs
    - pipeline/ai-app-labels.test.ts
    - docs/benchmarks/2026-10-21-ai-app-labels.json
  modified:
    - docs/BENCHMARKS.md
key-decisions:
  - "Labels header states one AI-assisted pass by fresh-context agents, not hand labelling; reread is null until 03-03"
requirements-completed: [BENCH-02]
---

# Phase 3 Plan 02: Model-ID labels Summary

An independent grep over the 150 frozen repositories found 4,679 quoted registry model IDs; 37 batches were labelled by fresh-context agents and merged by a validating script into a committed labels file with 377 live pins (373 JS/TS).

## Results

- Candidates 4,679; live 377; not live 4,302; live JS/TS 373; generated 11.
- By via: sdk-text 261, sdk-non-text 58, wrapper:* 19, raw-http 17, other 22 (the current tracers do not follow wrapper:*, raw-http or other).
- Main non-live reasons: test 1,805, catalog 1,603, doc 376, comparison 213, other-endpoint 98.
- Merge script exit 0 on first run; no batch rejected. Task 3 verify passed; `npm test` 1700 passed, 79 skipped (109 files passed, 8 skipped); typecheck and format:check exit 0.

## Task 2 orchestrator dispatch (facts)

- 57 labelling agents in total; one was re-dispatched after a tooling failure. Every agent saw only its own batch or slice, `labels/RULES.md` and its checkout directories.
- Batches over 150 candidates (02, 11, 27, 33, 34) were split into contiguous slices of at most 150 under `labels/slices/`, each labelled by its own agent and concatenated by the orchestrator.
- The dispatch prompt was saved once as `labels/RULES.md` (the plan's prompt plus OUTPUT_PATH/BATCH_ID placeholders and a Tools section allowing read-only Bash grep/sed/cat/ls/find). Unused batch files were pretty-printed (same JSON) so Read could page them.
- Spot check: three checkouts (SymBot, OminiUI, seerrng) have empty `git status --porcelain`.

## Limitations

- Several agents labelled groups of obviously uniform candidates (locale catalogs, test fixtures) by file after spot checks, not one by one.
- Labels are one AI-assisted pass; the 10% independent re-read is plan 03-03. Aliases the registry does not name are out of scope.

## Deviations from Plan

None in my execution. The `git diff $START..HEAD -- pipeline/` verification line is not empty (`pipeline/model-parameters.ts`) because the START SHA predates the phase 2 merge into this branch (9b992fa came in with bb9b370); this plan's own commits touch only `pipeline/*.test.ts` there. The plan's commit count (2) is measured from its own base, d096762.

## Known Stubs

None.

## Self-Check: PASSED

Labels file, BENCHMARKS.md paragraph and commits ed1b4be and 1845ccf exist on the branch.
