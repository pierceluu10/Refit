---
phase: 02
fixed_at: 2026-10-21T00:00:00Z
review_path: /Users/otabekalimov/OalimovProj/Refit/.planning/phases/02-sourced-parameter-stops/02-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 6
skipped: 0
status: all_fixed
---

# Phase 02: Code Review Fix Report

**Fixed at:** 2026-10-21
**Source review:** 02-REVIEW.md
**Iteration:** 1
**Verification ran in:** main checkout (`workflow.use_worktrees` is false), branch feat/ai-agents-phase-2.

**Summary:**
- Findings in scope: 6
- Fixed: 6
- Skipped: 0

## Fixed Issues

### CR-01: Computed property key bypasses parameter stops

**Files modified:** `pipeline/model-retirements.ts`, `pipeline/model-retirements.test.ts`
**Commit:** 173419d
**Applied fix:** Any computed property name in a traced request stops with a named reason, in both tabled and legacy paths. Tests cover `['temperature']`, `` [`top_k`] ``, `['max_tokens']`, `[k]` (tabled) and Haiku/`gpt-4.1-nano` (no entry). Status: fixed, requires human verification (logic change).

### WR-01: `accepts` validated through `String()`, verdict fails open

**Files modified:** `pipeline/model-parameters.ts`, `pipeline/model-parameters.test.ts`
**Commits:** e922def, then a follow-up
**Applied fix:** Strict `accepts` literal comparison, `typeof` check for `provider`, `parameterVerdict` ends fail-closed for any unrecognized spec. Tests for array, number, object `accepts` and array `provider`. The follow-up commit corrects the first version, which wrongly stopped a `default-only` literal at its default (caught by the full test run). Status: fixed, requires human verification.

### WR-02: Docs overstate which parameters stop

**Files modified:** `AGENTS.md`, `docs/DEADLINES.md`, `docs/READINESS.md`
**Commit:** 0b7cac2
**Applied fix:** Statements scoped to replacements with a table entry; replacements without one keep the unchanged heuristic (Claude 4.7+ stops on temperature/top_p/top_k, Haiku 4.5 continues, OpenAI stops on sensitive parameters).

### IN-01: `runModelFixes` silently defaults to an empty table

**Files modified:** `pipeline/model-fixes.ts`, `pipeline/model-fixes.test.ts`, `pipeline/model-fixes-docker.test.ts`
**Commit:** 319777f
**Applied fix:** `parameters` is required in the type; test callers pass `EMPTY_MODEL_PARAMETERS`. Production callers already passed a loaded table. `proposeModelReplacements` keeps its library default (D-13).

### IN-02: Dead code in the reason chain

**Files modified:** `pipeline/model-retirements.ts`
**Commit:** 173419d (same lines as CR-01)
**Applied fix:** Removed the dead `tabled ||` term and repeated non-null assertions.

### IN-03: Whitespace in `model`; root-path source URLs

**Files modified:** `pipeline/model-parameters.ts`, `pipeline/model-parameters.test.ts`
**Commit:** e922def (with WR-01)
**Applied fix:** `model` must equal its trimmed value. The non-root-path requirement for source URLs was left as is, per instruction.

---

_Fixed: 2026-10-21_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
