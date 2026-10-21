---
phase: 01-live-exposure-and-tracing
reviewed: 2026-10-21T12:00:00Z
depth: deep
files_reviewed: 12
files_reviewed_list:
  - AGENTS.md
  - docs/DEADLINES.md
  - docs/READINESS.md
  - pipeline/ai-model-benchmark-summary.test.ts
  - pipeline/deadline-exposure.ts
  - pipeline/deadlines-cli.ts
  - pipeline/deadlines.test.ts
  - pipeline/model-retirements.test.ts
  - pipeline/model-retirements.ts
  - scripts/ai-model-benchmark-summary.d.mts
  - scripts/ai-model-benchmark-summary.mjs
  - scripts/ai-model-benchmark.mjs
findings:
  critical: 0
  warning: 3
  info: 1
  total: 4
status: issues_found
---

# Phase 1: Code Review Report (iteration 3, final)

**Reviewed:** 2026-10-21
**Depth:** deep
**Files Reviewed:** 12
**Status:** issues_found

## Summary

Scope was the four classes you named: reproducible wrong edit, silent traced live pin not in Limits, crash or hang, docs contradicted by behavior. About 150 scratch repositories were run through `proposeModelReplacements` (and some through `scanDeadlines`), all built in the OS temp directory and outside the project. The harness is in the session scratchpad.

Held up: module escape, endpoint text, inheritance trees, accessors, JSON-shaped strings, CRLF, BOM, emoji offsets, quote kinds, cyclic constants, imports, re-exports and classes. None crashed or hung. The one crash found (about 2,000 chained `+` terms) is a stack overflow in `pipeline/mutations.ts`, which is not in scope and not new.

No critical findings. Three warnings remain, all reproduced.

## Warnings

### WR-01: Whole-container reads of an enum or a class do not count as shared uses, so the edit changes what they see

**File:** `pipeline/model-retirements.ts:1004-1062` (`valuesOf` and `declarationValues`, enum member and class field branches)
**Issue:** For a `const` object, any whole-object read (spread, destructuring, `Object.values`, `JSON.stringify`, an alias) stops the edit through the shared-use check. An enum member and a class field are followed through `E.A` and `this.m` only, so reads of the container itself are never seen. The docs say a constant, enum or object member with a use the trace does not reach stops, naming `Object.values` as an example. Each case below edited (reproduced):

```ts
enum E { A = 'gpt-4', B = 'gpt-3' }
export const choices = Object.values(E);            // also: const X = E; for (k in E); E[k]
await openai.chat.completions.create({ model: E.A, messages: [] });
// -> gpt-4 becomes gpt-5.6-sol in the enum, and `choices` changes with it

class C { m = 'gpt-4'; go() { return openai.chat.completions.create({ model: this.m, messages: [] }); } }
const { m } = new C();                              // also: Object.entries(c), JSON.stringify(c)
```

The edit is the literal the request sends, but other code reads the same value. Enums imported from another file behave the same: `Object.values(E)` or `E[k]` in a second file does not stop the edit (`e.ts` is edited).
**Fix:** In the shared-use check, treat any reference to the enum or class symbol (or to an instance of the class) that is not `E.member` or `E['member']` as an unreached use of every member, and stop. Add tests for `Object.values(E)`, `const X = E`, `E[k]`, and for class fields read by destructuring, `Object.entries` and `JSON.stringify`.

### WR-02: Traced live pins reach neither an edit nor a stop in shapes Limits does not list

**File:** `pipeline/model-retirements.ts:931-1000` (`valuesOf`, `requestObject`), `docs/DEADLINES.md:268`
**Issue:** The Limits bullet says it lists the untraced shapes "in full". These shapes, each with a retiring model on a traced call, produce no replacement and no stop (reproduced), and none is in Limits:

- Numeric-literal element access: `const L = ['gpt-4']; create({ model: L[0] })`. Limits says only non-literal keys go untraced, which implies literal keys are followed.
- Array destructuring: `const [A] = ['gpt-4']`. Object destructuring (`const { A } = { A: 'gpt-4' }`) is followed.
- Rest parameters and `arguments`: `function ask(...args) { create({ model: args[1] }) }; ask('x', 'gpt-4')`, and `arguments[0]`.
- `this` in an object-literal method or a function: `const o = { m: 'gpt-4', go() { create({ model: this.m }) } }`, and `go.call({ m: 'gpt-4' })`.
- A model spread into the request from a `const` object: `const base = { model: 'gpt-4' }; create({ ...base, messages, temperature: 1 })`. A spread next to a literal `model` stops; a spread that carries the model is invisible.
- `&&`: `model: flag && 'gpt-4'`.

`refit deadlines` still reports these lines as live exposure, so the proposal and the scan disagree without saying why.
**Fix:** Either follow or stop on these shapes (the simplest safe rule: an unresolved `model` value whose expression contains a retiring literal reachable by a sweep stops), or add each shape to the Limits bullet. At minimum, change "listed in full" and the literal-key wording.

### WR-03: A literal that is overwritten before the request is edited

**File:** `pipeline/model-retirements.ts:1001-1020` (property access with `assignmentsOf`)
**Issue:** An unconditional later assignment is not treated as a different source (reproduced):

```ts
const o = { M: 'gpt-4' };
o.M = 'other';
await openai.chat.completions.create({ model: o.M, messages: [] });
```

The patch rewrites `gpt-4` to `gpt-5.6-sol`, while the request sends `other`. The draft then claims a fix for a request that never sent the retiring model. It is harmless to run but wrong evidence, and the same applies to `C.M = 'x'` on a static field. Conditional overrides such as `if (env) o.M = env.X` are fine to leave, since the literal stays the fallback.
**Fix:** When a property of a followed object is assigned anywhere, stop with the shared-use reason, the way `Object.assign(o, …)` already does (`mutateProp` stops).

## Info

### IN-01: A custom `fetch` on the client does not count as an endpoint override

**File:** `pipeline/model-retirements.ts:1405`
**Issue:** `new OpenAI({ fetch: (u, i) => fetch('https://other.example' + u.pathname, i) })` is not matched by `ENDPOINT_TEXT`, so requests are edited. It is unusual (a `fetch` option normally logs or adds headers), so this is only a note. `OPENAI_API_HOST` and similar variables are not read by the SDKs, so they need no rule.
**Fix:** Optionally add `fetch:` inside a client constructor to the stop list, or list it in Limits.

---

_Reviewed: 2026-10-21_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
