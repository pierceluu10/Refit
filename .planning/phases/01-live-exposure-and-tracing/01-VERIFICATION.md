---
phase: 01-live-exposure-and-tracing
verified: 2026-10-21T12:50:00Z
status: passed
score: 6/6 must-haves verified
covered_files:
  - ".planning/phases/01-live-exposure-and-tracing/01-01-PLAN.md"
  - ".planning/phases/01-live-exposure-and-tracing/01-01-SUMMARY.md"
  - ".planning/phases/01-live-exposure-and-tracing/01-02-PLAN.md"
  - ".planning/phases/01-live-exposure-and-tracing/01-02-SUMMARY.md"
  - ".planning/phases/01-live-exposure-and-tracing/01-03-PLAN.md"
  - ".planning/phases/01-live-exposure-and-tracing/01-03-SUMMARY.md"
  - ".planning/phases/01-live-exposure-and-tracing/01-04-PLAN.md"
  - ".planning/phases/01-live-exposure-and-tracing/01-04-SUMMARY.md"
  - ".planning/phases/01-live-exposure-and-tracing/01-05-PLAN.md"
  - ".planning/phases/01-live-exposure-and-tracing/01-05-SUMMARY.md"
  - "pipeline/deadline-exposure.ts"
  - "pipeline/deadlines-cli.ts"
  - "pipeline/model-retirements.ts"
  - "scripts/ai-model-benchmark-summary.mjs"
covered_digest: "v3:sha256:cdce90fd9811466e8f5cd4feaed9800eeb16757ee137d464562be05275d64293"
behavior_unverified: 0
---

# Phase 1: Live exposure and tracing Verification Report

**Phase Goal:** A retiring model ID that reaches an OpenAI or Anthropic request, directly or through common indirection, is traced to the exact call argument, and catalog entries no longer count as live exposure
**Verified:** 2026-10-21
**Status:** passed
**Re-verification:** No (initial), run against the final code after the 3-iteration review-fix loop (HEAD 2878f84)

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Model metadata objects, `versions: [...]` lists and option arrays report as catalog, not live, each with a passing test | VERIFIED | Throwaway repo: `{id,name,contextWindow}` object, `versions: [...]` (2 elements), `satisfies` map were counted `Not live catalog 4 (catalog.ts:2,5,5,6)` and absent from live evidence. Tests in `pipeline/deadlines.test.ts` pass. Note: `{ value, label }` stays live by documented design (`value` is a live key, docs/DEADLINES.md line 77); my own fixture line 3 hit this, so it is not a defect. |
| 2 | Reports and benchmark results show catalog matches in a separate count | VERIFIED | CLI prints `Not live catalog N file:lines`; `--json` carries `nonLive` and `nonLiveCounts` per exposure and mention. `scripts/ai-model-benchmark-summary.mjs` aggregates `nonLive`/`nonLiveTotal`/`mentionedOnly`, with a pure function and test. |
| 3 | `this.model` (field initializer and ctor default), imported constant, enum / `as const` member, helper parameter resolve to the literal; helper reports each caller | VERIFIED | `--propose-model-fixes` on fixture: `Replace gpt-4 ... at live.ts:5` (field), `gpt-4-0613 at live.ts:6` (ctor default), `consts.ts:1` (import), `consts.ts:2` (enum), `consts.ts:3` (`as const`), helper reports both callers `live.ts:14` and `live.ts:15`. The generated patch applies cleanly with `git apply` and edits only the literal lines. |
| 4 | Raw `fetch`/`axios` to api.openai.com / api.anthropic.com with literal `model` is reported at exact line and gets the same proposal and stops | VERIFIED | `raw.ts:3` (fetch body, OpenAI) and `raw.ts:6` (axios.post, Anthropic) both reported live at exact line and proposed `gpt-5.6-sol` / `claude-opus-4-8`. |
| 5 | Prose quoted ID and `satisfies` map are non-live; env fallback, returned literal, destructuring default resolve; image/audio/embedding/moderation/legacy-completion stop with named reason | VERIFIED | Prose strings (plain and no-substitution template) absent from live list, classed `comment` in tests (`deadlines.test.ts:418`); concatenation `'try ' + 'gpt-4'` stays live as specified. Fixture: env fallback `live.ts:16`, `pick()` `live.ts:18`, destructuring default `live.ts:20` all proposed. `images.generate`, `embeddings.create` and Anthropic `completions.create` stop with "is not a call Refit edits". |
| 6 | `npm test`, typecheck, formatting pass; gated suites reported separately | VERIFIED | Run now: `npm test` 106 files passed / 8 skipped, 1615 tests passed / 79 skipped by env gates; `npm run typecheck` clean; `npm run format:check` clean; `npm run build` succeeds. Gated counts are reported separately (REVIEW-FIX.md and plan summaries). |

**Score:** 6/6 truths verified (0 behavior-unverified)

### Review-fix behavior (final code)

Spot-checks of loop-added stops on throwaway repos: a repo whose client sets `baseURL` stops every SDK edit with a named reason; whole-container read of an enum (`Object.values(E)`) stops. Both stop rather than edit, consistent with REVIEW-FIX.md claims. All changes add stops or follow one more static shape; none loosens a gate.

### Requirements Coverage

| Requirement | Status | Evidence |
|-------------|--------|----------|
| EXPO-01 | SATISFIED | Catalog classification of object/`versions`/option shapes; tests |
| EXPO-02 | SATISFIED | `nonLiveCounts` in CLI/JSON and benchmark summary |
| EXPO-03 | SATISFIED | Prose and `satisfies` rule; D-20 template/concat stay live, confirmed |
| TRAC-01 to TRAC-04 | SATISFIED | Fixture proposals above |
| TRAC-05 | SATISFIED | Raw fetch/axios at exact line |
| TRAC-06 | SATISFIED | Env fallback, returned literal, destructuring default |
| TRAC-07 | SATISFIED | Non-text calls stop with named reason |

All 10 IDs appear in ROADMAP Phase 1 and REQUIREMENTS.md (marked Complete); no orphaned requirements.

### Anti-Patterns / Gaps

No blockers. AGENTS.md carries the D-14 decision (line 57, "pending the repository owner's review on the phase PR"), recorded as owner review on the PR and not treated as a gate.

### Observations (non-blocking)

- Prose matches are classified `comment`, which the CLI does not list or count (same as pre-existing comment handling), so SC5's "reported as non-live" holds at scan/test level, not as a visible CLI line.
- The CLI's printed proposal diff shows whole files as removed and re-added in my runs, but the same patch applies with `git apply` and yields a minimal line diff, so it is cosmetic in display only (not compared against main).
- `refit deadlines --repository /nonexistent` exits 1 (expected error path).
- Documented untraced shapes (`let`/`var`, array iteration, etc.) remain silent by design and are listed in docs/DEADLINES.md Limits.

---

_Verified: 2026-10-21_
_Verifier: Claude (gsd-verifier)_
