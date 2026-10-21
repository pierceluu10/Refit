---
phase: 01-live-exposure-and-tracing
reviewed: 2026-10-21T00:00:00Z
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
  critical: 1
  warning: 4
  info: 4
  total: 9
status: issues_found
---

# Phase 1: Code Review Report (iteration 2)

**Reviewed:** 2026-10-21
**Depth:** deep
**Files Reviewed:** 12

## Summary

Verified each earlier fix against adversarial variants by running `proposeModelReplacements` and `scanDeadlines` on scratch repositories (outside the repo, nothing in the tree changed).

Held up: CR-01 renamed imports, renamed re-exports, `export *`, `export * as`, `import * as ns` and default imports under another name all stop. WR-01 reads of a parameter in nested closures, a second request in a closure, a leaked options object and a shared const options object all stop. WR-02 static field overrides stop. WR-05 is correct.

Did not hold, or the fix introduced a gap:
- The shared-use check cannot see uses that go through a dynamic `import()`, a `require()` in a TypeScript file, or a namespace accessed by computed key. Verified wrong edit: an embeddings model gets the chat replacement (CR-01).
- The custom base URL stop is bypassed by a const options object, a spread, `client.baseURL = ...`, and `.withOptions({ baseURL })`, and an env-only base URL is invisible (WR-01).
- Class inheritance detection misses mixins, class expressions and aliased bases, so the stop never fires and the subclass pin stays silent. Getter/abstract getter models are silent (WR-02).
- The D-18 prose rule hides a retiring model in a JSON string that does contain a `"model"` key (WR-03).
- Several shapes are silent, not stopped (WR-04). DEADLINES.md lists some as limits but not all.

## Critical Issues

### CR-01: Uses reached through dynamic `import()`, TypeScript `require()` or computed namespace access are not attributed, so a shared constant is edited (wrong edit)

**File:** `pipeline/model-retirements.ts:319-375` (`indexOf`), `pipeline/model-retirements.ts:749-766` (`sharedUse`)
**Issue:** `sharedUse` trusts `usesOf(symbol)`, which comes from the type checker. The program runs with `noLib: true`, so `await import('./models')` has no usable type and `m.MODEL` resolves to no symbol. A `require('./models')` in a `.ts` file behaves the same way, and `import * as m` with `(m as any)[key]` has no symbol for the member at all. Reproduced with `models.ts` `export const MODEL = 'gpt-4'`, a chat request using `MODEL` in `a.ts`, and in `b.ts` one of:
- `const m = await import('./models'); c.embeddings.create({ model: m.MODEL, ... })`
- `const m = require('./models'); c.embeddings.create({ model: m.MODEL, ... })`
- `import('./models.js').then(m => c.embeddings.create({ model: m.MODEL }))` (JS)
- `import * as m from './models'; c.embeddings.create({ model: (m as any)[k] })`

All four produced a replacement of `models.ts:1` to `gpt-5.6-sol` with no stop, which also changes the embeddings model. This is a wrong edit, the invariant the phase must hold. DEADLINES.md says only CommonJS `require` uses are not attributed; dynamic `import()` and computed namespace access are not mentioned, and in JS files `require` happens to work, so the documented limit understates the TS case.
**Fix:** Treat any module that something loads in a way the checker cannot follow as having unknown uses of every export. Collect, once, the resolved paths of `import(...)` and `require(...)` call arguments (using the existing `createSourceImportResolver`), and any `import * as ns` namespace whose uses include a non-property-access read or an element access. In `sharedUse`, return the "used N times" stop when `pass.node`'s source file is in that set:

```ts
// in sourceProgram: paths loaded dynamically or by require, plus namespaces used by computed key
const opaqueModules = new Set<string>();
// in sharedUse, per pass:
if (program.opaque(pass.node.getSourceFile().fileName)) return `...used by code Refit cannot trace; change it by hand to`;
```

Over-stopping is acceptable here.

## Warnings

### WR-01: Custom base URL stop is bypassed by common construction shapes

**File:** `pipeline/model-retirements.ts:1198-1220` (`customEndpoint`)
**Issue:** The check only looks for a `baseURL`/`baseUrl`/`basePath` property written inside the argument subtree of a `new X(...)` expression. Verified edits (replacement proposed, no stop) with a proxy or Ollama endpoint for:
- `const opts = { baseURL: 'http://localhost:11434/v1' }; new OpenAI(opts)`
- `new OpenAI({ ...base, apiKey })` where `base` holds `baseURL`
- `const c = new OpenAI(); c.baseURL = 'http://x'`
- `new OpenAI({ apiKey: process.env.KEY })` with the endpoint set by `OPENAI_BASE_URL` (source text such as `process.env.OPENAI_BASE_URL` is not looked at either)

`new OpenAI().withOptions({ baseURL })` yields neither edit nor stop (the client is not recognized), so that pin is silent. The doc only admits the env-variable case, and only for a variable that never appears in source.
**Fix:** Make the check textual and repository-wide: any source file that contains `baseURL`, `baseUrl`, `base_url`, `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `ANTHROPIC_BASE_URL` or `withOptions` as an identifier, property name or `process.env` key puts every SDK request in the stop path. This also covers the const and spread forms without tracing them.

### WR-02: Inheritance detection misses mixins, class expressions and aliased bases; accessor models are silent

**File:** `pipeline/model-retirements.ts:376-396` (`classes`), `pipeline/model-retirements.ts:826-841` (`valuesOf`), `pipeline/model-retirements.ts:1072-1101`
**Issue:** `classes()` links a class to its base only when the `extends` expression resolves to a class declaration. Verified silent or wrong results:
- `const Mix = (B) => class extends B {}; class B2 extends Mix(A) { model = 'gpt-3.5-turbo' }`: `A.model` is edited, `B2`'s retiring literal produces nothing, and no inheritance stop fires.
- `const A = class { model = 'gpt-4'; run() {...} }; class B extends A { model = 'gpt-3.5-turbo' }`: same.
- `const Base = A; class B2 extends Base`: same.
- `abstract get model(): string` in `A` with `get model() { return 'gpt-4' }` in `B`, and a plain `get model() { return 'gpt-4' }`: `valuesOf` has no accessor branch, so `this.model` resolves to nothing; no edit and no stop. An object literal getter (`{ get model() {...} }`) is the same.

The accessor case is listed in DEADLINES.md under "Not traced", but a live pin in a traced request is dropped without a stop, which the phase invariant forbids.
**Fix:** In `classes()`, when a class has an `extends` clause whose expression does not resolve to a class declaration (call expression, parameter, variable, unresolved import), record it as "unknown base" and make `relatedMembers`/`subclasses` report a stop for every member that could be overridden (treat an unknown-base class as related to everything of the same member name). For accessors, add `ts.isGetAccessorDeclaration` to the declaration kinds in `valuesOf` and follow its `return` statements through `returnsOf`; stop on abstract ones.

### WR-03: D-18 is not implemented: a retiring model in a JSON string that contains a `"model"` key is hidden as prose

**File:** `pipeline/deadline-exposure.ts:236-250` (`MODEL_KEYS`, `isProse`), `pipeline/deadline-exposure.ts:363-364`
**Issue:** D-18 says a string that contains a `"model":` JSON key stays live. `isProse` only tests the 40 characters directly before the match. Verified with a scan of `const a = '{"model": "gpt-4", "fallback": "gpt-3.5-turbo"}'`: `gpt-4` is live but `gpt-3.5-turbo` is classified `comment`, so its deadline is not an exposure at all. Same for `'{"models": ["gpt-3.5-turbo"]}'` and `JSON.parse('{"engine":"gpt-3.5-turbo"}')`. A hidden live pin means the repository is reported clean for that deadline.
**Fix:** In `isProse`, also return false when the whole string text matches `/["']?\bmodel\w*["']?\s*[:=]/i` or looks like JSON (starts with `{` or `[` after trimming), instead of testing only the preceding window:

```ts
return node.text !== version
  && !MODEL_KEYS.some((key) => key.test(before))
  && !/^\s*[{[]/.test(node.text)
  && !/["']?model\w*["']?\s*[:=]/i.test(node.text)
  && !concatenated(node);
```

### WR-04: Silent shapes the tracer can reach but does not follow

**File:** `pipeline/model-retirements.ts:826-849`, `pipeline/model-retirements.ts:868-902`
**Issue:** Verified no edit and no stop for: `export default 'gpt-4'` imported and sent as `model` (the default export's declaration is an `ExportAssignment`, which `declarationValues` ignores); `export default { chat: 'gpt-4' }` read as `M.chat`; `MODELS['fast']` with a string-literal element access on a const object (`ElementAccessExpression` is not handled although it is statically identical to `MODELS.fast`); a `let` model; `['gpt-4'].forEach(f)`. DEADLINES.md names getters, computed access and `let` as not traced, but a retiring model written in a statically resolvable form (`MODELS['fast']`, default export of a literal) is a likely real-world shape and is dropped silently.
**Fix:** Handle `ts.isElementAccessExpression` with a string-literal argument like the property access branch; handle `ExportAssignment` with a non-identifier expression in `declarationValues` (follow `expression`); and add a final fallback in `valuesOf`: when an identifier or member resolves to a declaration that is not followed and the sweep finds a retiring literal, stop rather than return `[]`.

## Info

### IN-01: Stop location can point at a request that is not the blocking one

**File:** `pipeline/model-retirements.ts:1549-1563`
**Issue:** Still present. `base` takes `file`, `line` and `call` from `decision.requests[0]`, while `reason` comes from `decision.reasons.find(Boolean)`, which may belong to a later request.
**Fix:** Keep the index of the first non-empty reason and take `base` from that request.

### IN-02: Shared-use message counts type-position uses the check ignores

**File:** `pipeline/model-retirements.ts:752-763`
**Issue:** Still present. The message prints `all.length` although `uses` is filtered with `inType`.
**Fix:** Print `uses.length`.

### IN-03: Descriptor-key rule hides a `{ provider, name }` model config shape

**File:** `pipeline/deadline-exposure.ts:141, 206-220`
**Issue:** Still present. A config such as `model: { provider: 'OPEN_AI', name: 'gpt-4o' }` is classified as catalog. Accepted by D-02, so only a documentation point.
**Fix:** List the shape under known limits, or keep the rule off when the object also has a `provider` key.

### IN-04: Raw endpoint pattern is not host-anchored; literals in files with syntax errors can still be edited

**File:** `pipeline/model-retirements.ts:198-212, 245-249`
**Issue:** Still present. `api\.openai\.com\/v1\/...` matches anywhere in the URL text, and `symbolOf` resolves into files that `files` dropped for syntax errors.
**Fix:** Anchor the host after the scheme, and refuse to edit a literal whose source file is not in `files`.

---

_Reviewed: 2026-10-21_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
