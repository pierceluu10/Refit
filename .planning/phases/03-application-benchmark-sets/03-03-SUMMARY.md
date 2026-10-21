---
phase: 03-application-benchmark-sets
plan: 03
subsystem: benchmarks
tags: [model-id-labels, independent-reread, agreement, adjudication]
requires: [03-02]
provides:
  - seededSample and agreement helpers in scripts/ai-app-helpers.mjs
  - scripts/ai-app-labels.mjs --reread-sample and --reread-merge
  - docs/benchmarks/2026-10-21-ai-app-labels.json with the reread header filled (374 live after adjudication)
affects: [phase-4 benchmark]
status: complete
commits: 2
plan_head_before: 0841dab8e78734092634fdc69bde750f299cd759
plan_head_after: 938a7d2557f75c4ab45db0e9ba1f00825817cf81
actuals:
  tokens: 45000
  tasks: 3
  commits: 2
key-files:
  created: []
  modified:
    - scripts/ai-app-helpers.mjs
    - scripts/ai-app-helpers.d.mts
    - pipeline/ai-app-helpers.test.ts
    - scripts/ai-app-labels.mjs
    - pipeline/ai-app-labels.test.ts
    - docs/benchmarks/2026-10-21-ai-app-labels.json
    - docs/BENCHMARKS.md
key-decisions:
  - "Re-read sample seed 20261021, fraction 0.1, 468 of 4,679 candidates, drawn from candidate keys alone"
  - "Reader recorded as four separate fresh-context agents, one per contiguous slice of 117, each given only its slice and the rules"
requirements-completed: [BENCH-02]
---

# Phase 3 Plan 03: Independent re-read Summary

A seeded 10% of the label candidates (468 of 4,679, seed 20261021) was re-labelled by separate fresh-context agents that never saw the first labels. `live` agreed on 460 of 468 and `via` on 456 of 468. All 12 disagreements were adjudicated by re-reading the code, 7 labels changed, and the result is recorded in the labels header.

START = 0841dab8e78734092634fdc69bde750f299cd759

## Results

- Agreement over the whole sample: `live` 460/468, `via` 456/468.
- Agreement on the 38 candidates that either pass called live: `live` 30/38, `via` 26/38.
- Adjudications (12): 5 kept the first label, 4 took the re-read's value, 3 took neither value. In two of those three both passes said live but named the wrong `via`. In the third, the re-read's live verdict was right but its reason was not.
- 7 first labels changed: 1 not-live became live (o1-mini in a lobe-chat provider card is selectable in the default client-only edition). 4 live became not-live (Claude Code forks: per-model config keys that are only compared, never sent). 2 kept live with a corrected `via` (wrapper:@office-ai/aioncli-core).
- Counts after adjudication: live 374 (was 377), JS/TS live 370 (was 373). By via: sdk-text 258, sdk-non-text 58, wrapper:* 21, raw-http 17, other 20. Comparison 217, catalog 1,602.
- Re-read sha256 bb4d954098985b0c0cd6bcf80025f0c3bde7e2fe64718f9aef82acdc270a4858. It was frozen in `reread.sha256` before the merge, and `shasum -c` passed both before and after the merge.
- Task 3 verify passed. `npm test`: 1703 passed, 79 skipped (109 files passed, 8 skipped). Typecheck and format:check exit 0. Gated suites were not run.
- `git diff --name-only START..HEAD -- pipeline/ ':!pipeline/*.test.ts'` is empty. Nothing under `$BENCH` is committed.

## Task 2 orchestrator dispatch (facts)

- The orchestrator split the 468-candidate sample into 4 contiguous slices of 117. A separate fresh-context agent re-labelled each slice. Each agent received only its slice, `reread/RULES-REREAD.md` (the plan's dispatch prompt with an OUTPUT_PATH placeholder and a read-only Tools section) and its checkout directories. None saw the first labels, the batches, the summaries or the docs. The orchestrator concatenated the 4 outputs into `reread.json`.
- Task 2's verify passed: 468 labels, one per sampled key, none extra or repeated.

## Adjudication method

Every disagreement was settled by reading the checkout with read and search tools only. Nothing was run in any checkout. The deciding facts:
- Which provider field a config value sits in (azureOpenAI or firstParty).
- Whether a model key is read anywhere other than display, cost or Bedrock profile matching.
- Which edition's model list the selector uses.
- Which imported package runs the conversation.

Notes are one line each with no code text. They are recorded in `reread.disagreements` and in `$BENCH/reread/adjudications.json`.

## Deviations from Plan

**1. [Orchestrator] Four re-read agents instead of one.** The orchestrator dispatched one agent per slice of 117 instead of a single agent. To match what happened, I edited the `reader` string and the method sentence in `scripts/ai-app-labels.mjs` before the merge ran. The reader now reads "separate fresh-context agents (4, one per slice) given only the sample and the labelling rules". The method sentence still contains "re-read by a separate fresh-context agent" (for each of 4 contiguous slices) and "Not hand labelling". Committed in 938a7d2.

**2. Script re-run caveat (not a change).** `--reread-merge` reads its first labels from `--labels`. Running it again on the regenerated file would therefore take the adjudicated labels as the first pass. It ran successfully once, on the pre-adjudication file.

## Known Stubs

None.

## Self-Check: PASSED

- docs/benchmarks/2026-10-21-ai-app-labels.json has `reread` with seed 20261021, a sha256 that matches the frozen file, and 12 adjudicated disagreements.
- Commits a72d2ae and 938a7d2 are on HEAD.
