---
phase: 03-application-benchmark-sets
verified: 2026-10-21T00:00:00Z
status: passed
score: 3/3 must-haves verified
covered_files: [".planning/phases/03-application-benchmark-sets/03-01-PLAN.md", ".planning/phases/03-application-benchmark-sets/03-01-SUMMARY.md", ".planning/phases/03-application-benchmark-sets/03-02-PLAN.md", ".planning/phases/03-application-benchmark-sets/03-02-SUMMARY.md", ".planning/phases/03-application-benchmark-sets/03-03-PLAN.md", ".planning/phases/03-application-benchmark-sets/03-03-SUMMARY.md", "docs/BENCHMARKS.md", "docs/benchmarks/2026-10-21-ai-app-labels.json", "docs/benchmarks/2026-10-21-anthropic-app-repos.json", "docs/benchmarks/2026-10-21-openai-app-repos.json", "scripts/ai-app-helpers.mjs", "scripts/ai-app-label-candidates.mjs", "scripts/ai-app-labels.mjs", "scripts/ai-app-select.mjs"]
covered_digest: "v3:sha256:de2c99e825f16b431b830c3da96501d8dc4250b493dc9eada066c8dbe61c6d73"
behavior_unverified: 0
---

# Phase 3: Application benchmark sets Verification Report

**Goal:** Frozen sets of real application repositories plus a labelled list of their live model pins exist.
**Status:** passed (initial verification)

| # | Success criterion | Status | Evidence |
|---|---|---|---|
| 1 | Selector + frozen 100 OpenAI / 50 Anthropic lists with query, date, commits | VERIFIED | openai-app-repos.json: 100 repos, anthropic: 50; no duplicates; all 40-hex commits; all committedAt >= 2025-10-21; all required fields present; `queries` (11 / 7 with pages and collected counts), `selectedAt` 2026-10-21, `cutoff`, `method`, `filters` recorded; no `shortfall`. scripts/ai-app-select.mjs exists with helpers + tests (pipeline/ai-app-helpers.test.ts). 9 repos appear in both lists (allowed by D-04). |
| 2 | 2026-10-20 npm sets unchanged, labelled library baselines | VERIFIED | `git diff feat/ai-agents-phase-2 HEAD -- docs/benchmarks` shows only the 3 new files; no change to 2026-10-20 files. docs/BENCHMARKS.md:197 calls them library baselines. |
| 3 | Labels file records every live pin with file, line, replacement; states single AI-assisted pass, not hand labelling | VERIFIED | 150 repos, 4679 candidates, 374 live, 0 live labels missing file/line/replacement. Method header: "one AI-assisted reading pass ... Not hand labelling"; independent grep (not Refit tracer; label scripts import nothing from pipeline/); seeded 10% re-read (468 sampled, 460/468 live agreement) with adjudications recorded. Notes are prose, max 138 chars, no code markers; no code text committed. |

## Requirements
- BENCH-01: SATISFIED (criteria 1, 2)
- BENCH-02: SATISFIED (criterion 3)
- No orphaned requirements (BENCH-03..06 map to Phase 4).

## Checks run
- `npm test`: 1703 passed, 79 skipped (109 files passed, 8 skipped); gated suites skip by default.
- `npm run typecheck`: pass.
- `npm run format:check`: pass.
- Phase diff vs phase 2 touches only two new test files under pipeline/; no non-test pipeline changes.

## Caveats (not blockers)
- Frozen list reproducibility is cache replay, not a guaranteed fresh search (the index moves); the frozen file and docs state this.
- Labels are AI-assisted with a 10% re-read; 8/468 live disagreements were adjudicated. Not exhaustive human ground truth, as documented.
- Probe execution and anti-pattern scan: none applicable (no probes declared; data/script phase).

_Verifier: Claude (gsd-verifier)_
