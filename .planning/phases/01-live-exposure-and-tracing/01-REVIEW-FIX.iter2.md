---
phase: 01-live-exposure-and-tracing
fixed_at: 2026-10-21T08:25:00Z
review_path: /Users/otabekalimov/OalimovProj/Refit/.planning/phases/01-live-exposure-and-tracing/01-REVIEW.md
iteration: 1
findings_in_scope: 7
fixed: 7
skipped: 0
status: all_fixed
---

# Phase 1: Code Review Fix Report

**Fixed at:** 2026-10-21
**Source review:** /Users/otabekalimov/OalimovProj/Refit/.planning/phases/01-live-exposure-and-tracing/01-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 7 (CR-01, WR-01..WR-06; Info findings out of scope)
- Fixed: 7
- Skipped: 0

Verification ran in the main checkout (`workflow.use_worktrees` is `false`), on branch `feat/ai-agents-phase-1`. After the last commit: `npm test` passed (106 files passed, 8 skipped; 1609 tests passed, 79 skipped by environment gates), `npm run typecheck` clean, `npm run format:check` clean.

All logic fixes make the tracer stricter (more stops, no new edits), so they are marked requires human verification for semantics beyond the regression tests.

## Fixed Issues

### CR-01: D-09 shared-use check cannot see uses under a different name

**Files modified:** `pipeline/model-retirements.ts`, `pipeline/model-retirements.test.ts`
**Commit:** f435c5a
**Status:** fixed: requires human verification
**Applied fix:** `indexOf` now grows the set of scanned names to a fixpoint over every `import { a as b }` / `export { a as b }`, `export default X` and `import { default as Y }`. Uses are still attributed by the checker's aliased symbol, so a renamed use counts and blocks the edit. Tests cover a renamed import, a renamed re-export and a default import under another name.

### WR-01: Other reads of a parameter are never checked

**Files modified:** `pipeline/model-retirements.ts`, `pipeline/model-retirements.test.ts`
**Commit:** f771f92
**Status:** fixed: requires human verification
**Applied fix:** Parameters and destructured bindings now create a `Pass` (kinds `parameter` and `binding`), so `sharedUse` requires every other read to be a traced request. For an options object, reads of a different property (`options.label`) are ignored; any other read (`console.log(options)`) stops. Tests: default with another read, caller literal, destructuring default, leaked options object, and an options object that still edits.

### WR-02: Overrides, abstract methods, subclass fields, `super(...)`

**Files modified:** `pipeline/model-retirements.ts`, `pipeline/model-retirements.test.ts`
**Commit:** 4e71dc7
**Status:** fixed: requires human verification
**Applied fix:** Added class-tree helpers (`relatives`, `subclasses`). A resolved method or field with a same-named member elsewhere in its inheritance tree follows every override and marks all reached literals with a stop ("...cannot be traced through class inheritance; change it by hand to <to>."). A constructor parameter also follows each subclass's `super(...)` arguments, or `new Subclass(...)` when the subclass has no constructor, and stops. `extends X` no longer produces the generic "passed as a value" reason. Tests cover all three reviewer shapes plus an overridden concrete method and an inherited constructor.

### WR-03: Prose rule hides live model strings

**Files modified:** `pipeline/deadline-exposure.ts`, `pipeline/deadlines.test.ts`
**Commits:** 97f7cbf, 8070c59 (formatting)
**Applied fix:** `MODEL_KEY` replaced by three patterns: any name ending in `model` (optionally `id`/`name`, any case or separator) before `:` or `=`; the `--...model`/`-m` flags; an upper-case name ending in `MODEL`. A bare word `model` followed only by whitespace stays prose (existing test B). Tests added for the three reviewer examples, `-m`, and a prose case. Note: the scan only matches quoted model IDs, so an unquoted `--model gpt-4` is not matched at all; this is unchanged behavior.

### WR-04: Custom `baseURL`, proxy and Azure clients

**Files modified:** `pipeline/model-retirements.ts`, `pipeline/model-retirements.test.ts`
**Commit:** b159302
**Status:** fixed: requires human verification
**Applied fix:** Added an `AzureOpenAI` tracer whose requests always stop, and a repository-wide `customEndpoint` check (any `new X({... baseURL | baseUrl | basePath ...})` or any `AzureOpenAI` identifier) that turns every SDK request into a stop with the required reason. Raw HTTP requests to official hosts are unaffected. Limit: a base URL set only through an environment variable is not seen (documented).

### WR-05: `exposedSilent` counted failed proposals

**Files modified:** `scripts/ai-model-benchmark-summary.mjs`, `scripts/ai-model-benchmark-summary.d.mts`, `pipeline/ai-model-benchmark-summary.test.ts`
**Commit:** f42c9e1
**Applied fix:** `exposedSilent` excludes rows with `error`; new additive key `exposedErrored` (last in key order). All existing key names kept. The existing test now pins the errored exposed row (silent 2 to 1, errored 1).

### WR-06: Overstated guarantees in docs

**Files modified:** `AGENTS.md`, `docs/DEADLINES.md`, `docs/READINESS.md`
**Commit:** d523eaa
**Applied fix:** Wording now matches the implementation: symbol-based use matching, parameter reads, inheritance stops, custom base URL/Azure stops, the exact `model` key/flag rule, and the limits (CommonJS `require` destructuring and `module.exports` uses are not attributed; env-var base URLs not seen). Prettier re-aligned two Markdown tables in `docs/DEADLINES.md` and `docs/READINESS.md`, so the diff there is wider than the edited sentences.

## Skipped Issues

None.

---

_Fixed: 2026-10-21_
_Fixer: gsd-code-fixer_
_Iteration: 1_
