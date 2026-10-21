---
phase: 01-live-exposure-and-tracing
fixed_at: 2026-10-21T08:45:00Z
review_path: /Users/otabekalimov/OalimovProj/Refit/.planning/phases/01-live-exposure-and-tracing/01-REVIEW.md
iteration: 3
findings_in_scope: 3
fixed: 3
skipped: 0
status: all_fixed
---

# Phase 1: Code Review Fix Report (iteration 3)

**Fixed at:** 2026-10-21
**Source review:** /Users/otabekalimov/OalimovProj/Refit/.planning/phases/01-live-exposure-and-tracing/01-REVIEW.md
**Iteration:** 3

**Summary:**
- Findings in scope: 3 (WR-01, WR-02, WR-03; IN-01 handled as a docs limit, as instructed)
- Fixed: 3
- Skipped: 0

Verification ran in the main checkout (`workflow.use_worktrees` is `false`) on `feat/ai-agents-phase-1`, after the last commit:
- `npm test`: 106 files passed, 8 skipped; 1615 tests passed, 79 skipped by environment gates.
- `npm run typecheck`: clean.
- `npm run format:check`: clean.

All changes add stops or follow one more statically resolvable shape; none loosens an existing stop. They are logic changes, so they are marked requires human verification beyond the regression tests.

## Fixed Issues

### WR-01: Whole-container reads of an enum or class

**Files modified:** `pipeline/model-retirements.ts`, `pipeline/model-retirements.test.ts`
**Commit:** aa1ea53
**Status:** fixed: requires human verification
**Applied fix:** New `containerEscape` check in `sharedUse` for enum member and class field passes. An enum stops unless every reference to it is a plain `E.member` or `E['literal']` read (not assigned, deleted or incremented; `ns.E` is handled). A class (and its subclasses) stops when `this` is used as anything but `this.member` or `this['literal']`, when the class identifier is used as anything but `new C()`, `extends C`, a type or a plain member read, when an anonymous class or unresolved symbol is involved, or when an instance is not a dropped `new C();`, a direct `new C().member`, or a variable all of whose uses are plain member reads. Reason: "The model comes from the <enum member|field> <name> (<place>), and its <enum|class> is also used as a whole, so a change shows up elsewhere; change it by hand to <to>." Tests: `Object.values(E)`, `const X = E`, `E[k]`, `for…in E`, an enum read in another file, a destructured instance, `Object.entries(instance)`, `JSON.stringify(instance)`, an instance passed on, the class as a value, `this` as a value, plus a control that plain reads still edit.

### WR-03: Writes before a request

**Files modified:** `pipeline/model-retirements.ts`, `pipeline/model-retirements.test.ts`
**Commit:** aa1ea53
**Status:** fixed: requires human verification
**Applied fix:** A member reached through the field path stops when it is an object-literal member or a static field with any assignment, or an instance field assigned through a receiver other than `this` ("The <name> member is also assigned to elsewhere, so a request may send another value; change it by hand to <to>."). `this.field = value` inside a class stays a traced source (existing tests depend on it). `o['M'] = …`, `Object.assign(o, …)` and `delete o.M` stop through the existing const-object use check; enum and static writes also stop through the container check. Tests cover each shape.

### WR-02: Silent shapes

**Files modified:** `pipeline/model-retirements.ts`, `pipeline/model-retirements.test.ts`, `docs/DEADLINES.md`, `docs/READINESS.md`, `AGENTS.md`
**Commits:** aa1ea53 (code), 6cdc32b (docs)
**Applied fix:** `flag && 'literal'` is followed (right side is the site). docs/DEADLINES.md Limits now lists the remaining shapes: `let`/`var`, array iteration and callbacks, numeric index access, array destructuring, rest parameters and `arguments`, `this` in object-literal methods or `.call`/`.apply`/`.bind` functions, a model spread in from a const object, getters read other than as `obj.name`, computed non-literal keys, `export =`/`module.exports` via `require`, and a custom `fetch` client option (IN-01). A test pins each of those shapes as silent. The docs also describe the new whole-container and write stops, and the AGENTS.md and READINESS.md wording matches.

## Skipped Issues

None.

---

_Fixed: 2026-10-21_
_Fixer: gsd-code-fixer_
_Iteration: 3_
