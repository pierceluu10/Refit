---
phase: 01-live-exposure-and-tracing
plan: 03
subsystem: model-retirement-tracer
tags: [typescript, model-retirements, resolver, vitest]

requires: [01-02]
provides:
  - "valuesOf resolver: class fields, constructor parameters, this assignments, imported constants, enum and object members, fallbacks, conditionals, returned literals, destructuring defaults"
  - "assignmentsOf(symbol) index beside usesOf, private fields included"
  - "Per-request memo, depth 10, 2,000-step budget, cut record on the trace"
affects: [01-04, 01-05]

actuals:
  tokens: 9500 # chars/4 over the changes under pipeline/ (approximate)
  tasks: 2
  commits: 2
commits: 2
plan_head_before: 61933df2613f58bf24029270867bcc4e3d7b082b
plan_head_after: 9c2adec1f2adaa1af17ef2ce13eaf1b5d05ed2f2

key-files:
  modified:
    - pipeline/model-retirements.ts
    - pipeline/model-retirements.test.ts

key-decisions:
  - "Passes are relative: each declaration returns terminals carrying its own pass, so results can be memoized by declaration and keys and cloned for the caller"
  - "A literal reached through a followed call's arguments is tagged with that call context and loses the function's pass, so pick('gpt-4') belongs to that call only"
  - "Fields are resolved from the field symbol (initializer, constructor parameter property, assignmentsOf); the field context is cleared so it is object-wide"

requirements-completed: [TRAC-01, TRAC-02, TRAC-03, TRAC-06]

status: complete
completed: 2026-10-21
---

# Phase 1 Plan 3: Resolver rewrite Summary

**`modelSites` now runs a memoized, bounded `valuesOf` resolver, so a retiring model behind a class field, imported constant, enum or object member, env fallback, returned literal or destructuring default is edited at its literal or stopped with a named reason.**

## Accomplishments

- `valuesOf(program, expression, trace, keys)` with `Pass`, `Terminal`, `Trace` and `CallContext`. Existing const, enum, `??`/`||` and parameter branches ported; every pre-existing test passes unchanged.
- Fields (D-06): property initializer, constructor parameter properties, every `x.name = value` (including `#private`, JS), constructor parameters followed to `new Class(...)` callers; `new C()` keeps the default.
- Members (D-07): const object literal properties, with or without `as const`; enum members.
- D-08: both sides of `??`/`||` and conditionals, `await`, calls resolved through their own `return` statements (nested functions and classes skipped), destructuring defaults, options-object parameters resolved to callers' object-literal property.
- D-10: ESM imports and CommonJS destructured `require` constants tests pass without resolver changes.
- Limits: depth 10, 2,000 steps per request; `modelSites` returns `{ sites, cut }` (`cut` consumed by plan 01-04).
- The shared-use rule is kept: a pass whose symbol is used other than once stops with the existing sentence, now also for `field` and `function`.

## Task Commits

1. Task 1 (tracer): `c7e1782` (feat). CLI check printed `PASS gpt-5.6-sol`.
2. Task 2 tests: `9c2adec` (test).

## Deviations from Plan

**1. [Process] Task 2 implementation landed in the Task 1 commit.** The resolver was written in one pass, so the Task 2 behavior tests passed on first run after fixing my own line-number expectations. No separate RED evidence exists.

**2. [Naming] `Site` keeps the field name `literal` (the plan sketched `node`)** to avoid touching the decision loop. `Site` gained `passes`; the exported proposal shapes are unchanged.

**3. [Scope] `usesOf` keys on `ts.MemberName`; `declarationName` takes `MemberName`** and a small `assignmentTarget` helper was extracted from it. Uses in type positions (`ts.isTypeReferenceNode`) are not counted as "passed as a value" when following constructor callers.

## Verification

- `npx vitest run pipeline/model-retirements.test.ts`: 16 passed.
- `npm test` (default, gated suites skipped): exit 0. 106 files passed, 8 skipped. 1600 tests passed, 79 skipped (1679). Before: 1594 passed; +6 new.
- `npm run typecheck`: exit 0. `npm run format:check`: all files use Prettier code style.
- Tracer CLI command printed `PASS`.
- `grep -c valuesOf` = 19, `grep -c assignmentsOf` = 4.
- Not done: gated Docker/real-SDK suites; no mutation checks on the limit branches (depth/budget `cut` is set but not asserted by a test, it is consumed in 01-04).

## Known Stubs

None.

## Known limits

- CommonJS namespace members (`models.DEFAULT`, `exports.X`), `MODELS[k]` computed access, getters and `let` variables stay untraced (as flagged in the plan).
- A static or non-call use of a class (`Chat.create()`, `extends Chat`) counts as "passed as a value" and stops its constructor-default site; conservative by design.

## Threat Flags

None. T-01-07 (shared sources stop), T-01-08 (call-context literal test `pick`) and T-01-09 (memo, depth 10, budget 2,000) mitigated.

## Self-Check: PASSED

- `pipeline/model-retirements.ts`, `pipeline/model-retirements.test.ts` exist and are modified.
- Commits `c7e1782` and `9c2adec` are ancestors of HEAD.
