---
phase: 03-application-benchmark-sets
fixed_at: 2026-10-21T00:00:00Z
review_path: /Users/otabekalimov/OalimovProj/Refit-phase3/.planning/phases/03-application-benchmark-sets/03-REVIEW.md
iteration: 1
findings_in_scope: 5
fixed: 5
skipped: 0
status: all_fixed
---

# Phase 3: Code Review Fix Report

**Fixed at:** 2026-10-21
**Source review:** 03-REVIEW.md
**Iteration:** 1
**Verification ran in:** the main checkout of the phase-3 worktree (/Users/otabekalimov/OalimovProj/Refit-phase3), no temporary worktree.

**Summary:**

- Findings in scope: 5 (Critical 0, Warning 5; Info excluded)
- Fixed: 5
- Skipped: 0

Final gates: `npm test` 1709 passed, 79 skipped (109 files passed, 8 skipped); `npm run typecheck` clean; `npm run format:check` clean.

## Fixed Issues

### WR-01: The merge never checks that every candidate received a label

**Files modified:** `scripts/ai-app-labels.mjs`, `pipeline/ai-app-labels.test.ts`
**Commit:** 6f4e180
**Applied fix:** The merge counts labels per key across batches and exits 1 with nothing written unless every candidate has exactly one label and every label has a candidate. Regression test skews candidates.json and expects exit 1 and no output file. Committed labels were not regenerated.

### WR-02: Label identity fields can override the candidate's and change type

**Files modified:** `scripts/ai-app-helpers.mjs`, `scripts/ai-app-labels.mjs`, `pipeline/ai-app-helpers.test.ts`, `pipeline/ai-app-labels.test.ts`
**Commit:** 57e9f15
**Applied fix:** `validateLabels` rejects non-object labels (`label-shape`) and requires string repo/provider/file/model and integer line/column (`identity-type`). The merge now spreads `{ ...label, ...candidate }` so candidate identity fields win. Tests cover both.

### WR-03: The notes leak guard only matches the exact full source line

**Files modified:** `scripts/ai-app-helpers.mjs`, `scripts/ai-app-helpers.d.mts`, `scripts/ai-app-labels.mjs`, `pipeline/ai-app-helpers.test.ts`, `docs/benchmarks/2026-10-21-ai-app-labels.json`
**Commits:** c6782c7 (guard), 58c5673 (data)
**Applied fix:** New exported `noteLeaksCode(notes, context)` rejects notes with a backtick, brace, angle bracket, `=>`, `==`, `${`, a call-like `word(` or `a.b(`, the whole matched line (3+ chars), or any 20-character run of the matched, before or after lines. Validation now receives the full `{before, line, after}` context in both the label merge and the re-read paths, and adjudication notes are checked too.
**Guard run over the committed labels file:** 251 of 4,679 notes failed (195 code-like fragments such as `complete()`, 55 context runs such as API method paths and function names, 1 both). Almost all are identifier names in prose, not leaked code or secrets. Those 251 notes were rewritten, in a separate data commit, to fixed plain-prose sentences derived only from each label's own live/via/reason (for example "Display or pricing table entry that no request reads."). A rerun of the guard now reports 0 failures. Only `notes` changed (251 lines); counts untouched. The per-label detail in those 251 notes is lost by design.

### WR-04: Adjudication changes live/via/reason but leaves the first label's notes

**Files modified:** `scripts/ai-app-labels.mjs`, `pipeline/ai-app-labels.test.ts`, `docs/benchmarks/2026-10-21-ai-app-labels.json`
**Commits:** 14e754b (script), 3809735 (data)
**Applied fix:** `--reread-merge` now sets `label.notes` to the adjudication note whenever the adjudicated verdict differs from the first label's. The committed file was patched directly from /Users/otabekalimov/Repos/refit-ai-app-bench/reread/adjudications.json for the 7 labels whose verdict changed (of 12 disagreements, the other 5 had the first label confirmed, so their notes already agree). Live/via/reason unchanged; counts verified at 4679 candidates / 374 live / 370 JS/TS; the guard still reports 0 failures.

### WR-05: The selector aborts on one bad repo and caches transient failures permanently

**Files modified:** `scripts/ai-app-select.mjs`, `scripts/ai-app-helpers.mjs`, `scripts/ai-app-helpers.d.mts`, `pipeline/ai-app-helpers.test.ts`
**Commit:** ce7a62c
**Applied fix:** New `classifyGhError`: retry only for rate-limit text or 429/502/503/504; a plain 403 now fails immediately. 404/409/451 per repository return an `unreachable` verdict (counted in `rejected.unreachable`) instead of aborting. `checkoutFailed` is no longer written to the cache. `shallowCheckout` runs `git rev-parse HEAD` on an existing checkout and removes and refetches when it is not the expected SHA. The selection was not re-run; frozen lists unchanged.

---

_Fixed: 2026-10-21_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
