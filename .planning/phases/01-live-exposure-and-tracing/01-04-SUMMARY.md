---
phase: 01-live-exposure-and-tracing
plan: 04
subsystem: model-retirement-tracer
tags: [typescript, model-retirements, resolver, vitest]

requires: [01-03]
provides:
  - "D-09: a shared constant, member, field or helper is edited when every non-type use is a traced non-test request that allows it"
  - "Method, default-export function and default-export class callers followed (TRAC-04, D-17)"
  - "Order-independent by-value and spread helper stops (D-17)"
  - "Limit stop with a bounded context-insensitive sweep, never silent when a retiring model can be named"
affects: [01-05]

actuals:
  tokens: 9000 # chars/4 over the changes under pipeline/ (approximate)
  tasks: 3
  commits: 3
commits: 3
plan_head_before: 0105f0911d374443cd1ecaa8c0c4335d68877b88
plan_head_after: 38fc02fb98543ae3d5a32699e272d07f2b7814f8

key-files:
  modified:
    - pipeline/model-retirements.ts
    - pipeline/model-retirements.test.ts

key-decisions:
  - "Pass gained `use` (the identifier that read the symbol); the shared-use sentence moved from the resolver to the decision loop and keeps the full use count N, so existing wording is byte-identical"
  - "Passes of a literal reached by several paths are merged in modelSites; the innermost failing pass reports"
  - "Default exports are indexed by their local declaration name plus every default-import binding name"

requirements-completed: [TRAC-01, TRAC-03, TRAC-04, TRAC-06]

status: complete
completed: 2026-10-21
---

# Phase 1 Plan 4: D-09, callers and limits Summary

**A constant, enum or object member, field or helper shared by several traced requests is now edited once when every use is a reached request; helper, method and default-export callers are followed in any file order; a trace cut by the depth or work limit stops with the limit named instead of being silent.**

## Accomplishments

- D-09 (own commit `926ccf6`): `through` no longer stops on a use count. `proposeModelReplacements` runs a first pass over non-test requests that records every pass `use` in `reached` (blocked requests included, test-file requests excluded), then `sharedUse` stops a site when a non-type use of any pass symbol is not in `reached`. `inType` skips `typeof X` and type references but keeps `extends`.
- TRAC-04 / D-17: method callers (`this.run('x')`) already worked and are now tested. Default exports (`export default function`, `export default class`, with `new`) are found by indexing identifiers under the declaration name and default-import names. Two caller literals on one line are both edited and the patch applies; a helper with no callers keeps only its default.
- D-17 order: a by-value or spread use records one stop that is applied to every terminal of the parameter after the caller loop.
- Limits: when `trace.cut` is set, every retiring literal of that request stops with "Tracing this model stopped at the work budget of 2,000 steps | depth limit of 10, so not every source and use could be checked; change it by hand to <to>." The reason sits after the registry and non-text checks and before the helper and shared-use stops. `sweepLiterals` (one visit per declaration, 20,000 expression cap) adds retiring literals the cut hid; they stop too.

## Task Commits

1. Task 1 (tracer, D-09 isolated): `926ccf6` `feat(01-04): D-09 edit a shared model source only when every use is a traced request that allows it` (touches only the two files). CLI check printed `PASS`.
2. Task 2: `1a88734` (fix). RED observed for the default-export and file-order tests before the fix.
3. Task 3: `38fc02f` (fix). Tests were written first; the self-reference test passed immediately (see deviation 2).

## Deviations from Plan

**1. [Intended behavior change, not named in the plan] Existing test expectation updated.** In "stops non-text ... calls", a literal shared by a text call and an embeddings call used to stop with "used 2 times". Under D-09 both uses are reached requests, so the sentence no longer applies; the merged decision now stops with the embeddings non-text reason. The literal is still never edited. Only that one expectation changed.

**2. [Plan wording] Self-referencing assignment.** `this.model = fields?.model ?? fields?.modelName ?? this.model;` terminates and is deterministic, but the field's own read inside the assignment is a use no request reaches, so the field still stops with "used 2 times" instead of being edited. This is conservative. The test asserts that stop. Recording the in-progress memo hit as a reached pass would let it edit; not done.

**3. [Safety fix, as the plan intends] By-value stops no longer depend on use order.** A replacement that was emitted before when the by-value use came after the caller is now a stop.

**4. [Process] Test for file order uses one file** with the by-value use before or after the caller. Cross-file layouts do not vary the order because the compiler visits imported files first.

## Verification

- `npm test` (default, gated suites skipped): exit 0. 106 files passed, 8 skipped. 1605 passed, 79 skipped (1684). Before this plan: 1600 passed; +5 new tests.
- `npm run typecheck`: exit 0. `npm run format:check`: all files use Prettier code style.
- Task 1 CLI command printed `PASS`.
- The 2,500-caller fan-out test is not slow: the whole "limit named" test took about 150 ms.
- `grep -cF "so not every source and use could be checked"` = 1.
- Not done: gated Docker/real-SDK suites; no mutation checks on the sweep's branches (constructor callers, binding elements, assignments); `export default function () {}` (anonymous) still gets no callers.

## Known Stubs

None.

## Known limits (for plan 01-05)

- A cut trace with no retiring literal found by the sweep (or the sweep cap reached first) emits nothing.
- The sweep ignores property keys, so it may stop on a retiring literal in a sibling property of an object that reaches the model (over-stops, never edits).
- `MODELS['X']`, `{ ...this }` and `const { model } = this` reads stay unseen by the use check (T-01-13, accepted).

## Threat Flags

None. T-01-10 (use check over `reached`, negative tests for log, comparison, `Object.values`, temperature and test-file request), T-01-11 (order-independent stop) and T-01-12 (cut never edits; bounded sweep) mitigated.

## Self-Check: PASSED

- `pipeline/model-retirements.ts`, `pipeline/model-retirements.test.ts` exist and are modified.
- Task commits are ancestors of HEAD; `git rev-list --count` from `plan_head_before` is 3.
