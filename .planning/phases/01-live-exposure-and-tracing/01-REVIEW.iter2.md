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
  warning: 6
  info: 4
  total: 11
status: issues_found
---

# Phase 1: Code Review Report

**Reviewed:** 2026-10-21
**Depth:** deep
**Files Reviewed:** 12
**Status:** issues_found

## Summary

The three suites for these files pass (48 tests) and `tsc --noEmit` is clean. Every claim below that says "verified" was reproduced by running `proposeModelReplacements` or `scanDeadlines` on a throwaway repository (scratch script in the session scratchpad, nothing in the repo changed).

The main defect is in the D-09 shared-use check. The docs, READINESS and AGENTS.md say a shared source is edited only when every use is a traced request. That is false for uses written under another name (aliased imports, `export { X as Y }`) and for other uses of a parameter whose default or argument is edited. Both produce an edit with no stop. Several live pins are also dropped with neither a replacement nor a stop (abstract or overridden methods, subclass field overrides, `super(...)` arguments). The prose rule hides some live model strings (CLI flags, `OPENAI_MODEL="..."`, `model_id`) that the docs say are kept live.

## Critical Issues

### CR-01: D-09 shared-use check cannot see uses written under a different name, so a shared constant is edited with an unchecked use (verified)

**File:** `pipeline/model-retirements.ts:273-318` (`indexOf`), `:643-651` (`sharedUse`)
**Issue:** `indexOf` finds uses of a symbol by scanning identifiers whose text equals the symbol's own name (`names = new Set([name])`). A use written under another name never enters `uses`, so `sharedUse` never sees it. Two common shapes:
- `import { MODEL as LEGACY } from './c'` and later uses of `LEGACY`.
- `export { MODEL as DEFAULT_MODEL } from './c'` and imports of `DEFAULT_MODEL`.

Reproduction (verified output: `replacements ['c.ts:1 gpt-4->gpt-5.6-sol']`, `stops []`):
```ts
// c.ts
export const MODEL = 'gpt-4';
// a.ts: openai.chat.completions.create({ model: MODEL, ... })   (the only counted use)
// b.ts
import { MODEL as LEGACY } from './c';
if (LEGACY === 'gpt-4') console.log(1);
export const label = 'Using ' + LEGACY;
```
Refit edits `c.ts`, which changes the comparison and the label in `b.ts`. This is exactly what D-09 says it prevents ("every use is checked"), and a use count of 1 reached this behavior before the phase too, but D-09 now widens how often it applies and the docs state it as a guarantee. The `import * as c` form is handled correctly (it stops), so the gap is specific to renames. The same hole applies to `export default MODEL` imported under another local name.

**Fix:** When building the index for a symbol, also collect the local alias names of every import specifier and export specifier that resolves to it, and scan for those too. Smallest version: in `indexOf`, for each file, collect `ImportSpecifier`/`ExportSpecifier` with `propertyName?.text === name` and add `name.text` to `names`. Or, conservatively, stop whenever any import or export specifier with a `propertyName` resolves to the pass symbol. Add a regression test for both shapes.

## Warnings

### WR-01: Other uses of a parameter are never checked when its default or a caller's literal is edited (verified)

**File:** `pipeline/model-retirements.ts:841-893` (`parameterValues`), `:797-821` (`bindingValues`)
**Issue:** Constants, fields and functions get a `Pass` and so a D-09 check. Parameters do not: no `Pass` is created for the parameter itself, so its other uses in the function body are not examined. Verified:
```ts
export function ask(m, model = 'gpt-4') {
  if (model === 'gpt-4') console.log('legacy');
  return openai.chat.completions.create({ model, messages: [] });
}
```
yields a replacement of the default with no stop; the `legacy` branch changes behavior. The same applies to a literal a caller passes, and now also to the new destructuring-default and options-object paths (D-08), which widen this surface. Helper parameters existed before the phase (D-10), but the docs and AGENTS.md present the new rule as covering "every use".
**Fix:** Create a `Pass` of kind `parameter` (symbol = the parameter or binding-element symbol, `use` = the reference identifier) in `parameterValues` and `bindingValues`, so `sharedUse` checks that every read of the parameter is a reached request. Until then, narrow the wording in DEADLINES.md, READINESS.md and AGENTS.md.

### WR-02: Live pins silently dropped for overridden or abstract methods, subclass field overrides and `super(...)` arguments (verified)

**File:** `pipeline/model-retirements.ts:896-954` (`callValues`), `:736-793` (`declarationValues`), `:841-893` (`parameterValues`)
**Issue:** These are within D-06/D-08 scope, so silence here is not covered by D-19. Verified, all give `replacements []`, `stops []`:
- `abstract class Base { abstract getModel(): string; run() { create({ model: this.getModel() }) } }` with `class Impl extends Base { getModel() { return 'gpt-4' } }`: `this.getModel()` resolves to the bodiless base declaration, `returnsOf` returns `[]`, and the override's literal is never reached.
- `class Base { model = 'gpt-3.5'; run() { create({ model: this.model }) } }` with `class Impl extends Base { model = 'gpt-4' }`: the override is a different symbol.
- `class Base { constructor(private model: string) {} ... }` with `class Impl extends Base { constructor() { super('gpt-4') } }`: `super(...)` is not a use of the class name. The `extends Base` use does set the "passed as a value" stop for other sources, but the literal in `super(...)` is dropped entirely.

DEADLINES.md lists getters, computed access and `let` as untraced, but not these three.
**Fix:** In `callValues`/`declarationValues`, when the resolved declaration is abstract, bodiless or has an overriding member in a derived class, return a stop-only terminal (or follow the overrides). In `parameterValues`, treat `super(...)` calls of a derived class as callers of the base constructor. At minimum, document these as untraced.

### WR-03: The prose rule hides live model strings the docs say stay live (verified)

**File:** `pipeline/deadline-exposure.ts:233-241` (`MODEL_KEY`, `isProse`)
**Issue:** `MODEL_KEY = /\bmodel(?:Id|Name)?["'\s]*[:=]\s*$/i` only recognizes `model`, `modelId` and `modelName` followed by `:` or `=`. Verified, each is classified `comment` (not live, no exposure):
- `execSync('codex --model "gpt-4" run')` (a CLI flag; separator is a space).
- `fs.writeFileSync('.env', 'OPENAI_MODEL="gpt-4"\n')` (`\b` fails because `_` is a word character).
- `'{"model_id": "gpt-4", "x": 1}'` (`_id` is not `Id`).

`'{"model": "gpt-4"}'` stays live, as intended. DEADLINES.md says "text that sets a `model` key, such as embedded JSON, stay live", which implies broader coverage. A repository whose only pin is one of these shapes becomes "mentioned only" and drops out of exposure, which is the opposite of the project's zero-silent requirement. D-03 and D-18 accept some hiding, but not this kind of config text.
**Fix:** Widen the key test to snake and kebab case and flags, for example `/(?:^|[^a-z0-9])(?:[a-z0-9]+[_-])*model(?:[_-]?(?:id|name))?["'\s]*[:=\s]\s*$/i`, or classify as prose only when the surrounding string contains whitespace-separated words on both sides and no key-value punctuation immediately before the ID. Add tests for the three shapes.

### WR-04: Custom `baseURL`, proxy and Azure deployments are edited or silently skipped without any check

**File:** `pipeline/model-retirements.ts:1140-1171`
**Issue:** Verified: `new OpenAI({ baseURL: 'https://my-proxy.example/v1' })` with `model: 'gpt-4'` is replaced with `gpt-5.6-sol`. A proxy or OpenAI-compatible server may not serve that ID, and for Azure the `model` is a deployment name (an `AzureOpenAI` client produced neither a replacement nor a stop; the client is not recognized, so it is silent). The edit is "the model sent to the traced request" but not provably a model OpenAI retires. DEADLINES.md acknowledges the matching side ("A model ID sent to another provider's OpenAI-compatible endpoint matches the OpenAI deadline") but the replacement side takes no gate.
**Fix:** When the client construction (or any `new OpenAI({...})` in the repository) sets `baseURL`/`baseUrl`, or the client is `AzureOpenAI`, turn the request into a stop with a named reason instead of an edit. Cheapest version: a repository-wide check for `baseURL` or `AzureOpenAI` next to the SDK import that downgrades every OpenAI replacement to a stop.

### WR-05: `exposedSilent` counts failed proposals as silent

**File:** `scripts/ai-model-benchmark-summary.mjs:28-33`, `scripts/ai-model-benchmark.mjs:97-122`
**Issue:** When the proposal step errors or times out, the result row has `error` set, `exposures` populated, and `replacements` and `stops` empty. `benchmarkSummary` counts it in `exposed` and `exposedSilent`. The new `mentionedOnly` correctly excludes errored rows, but the older keys do not, so the figure used for the BENCH-04 comparison (silent exposed repositories) is inflated by timeouts. D-19 says benchmark timeouts are out of Phase 1, but the new summary function is where the inconsistency now lives and its test does not cover an errored exposed row.
**Fix:** Count `exposed` rows with `item.error` separately (`exposedErrored`) and exclude them from `exposedSilent`, or at least add a test pinning the intended behavior.

### WR-06: Overstated guarantees in AGENTS.md, DEADLINES.md and READINESS.md

**File:** `AGENTS.md:57`, `docs/READINESS.md` (October 21 checkpoint, Tracing bullet), `docs/DEADLINES.md` (replacement conditions, "used more than once" bullet)
**Issue:** All three say a shared source is edited only when every use is a traced request that allows it. CR-01 and WR-01 show two classes of use that are not checked. The "text that sets a `model` key" claim in DEADLINES.md is broader than the implementation (WR-03). AGENTS.md is the file future agents are told to follow ("Do not widen which uses are replaced without a new decision"), so an inaccurate guarantee there matters.
**Fix:** Fix the code (CR-01, WR-01, WR-03) or soften the wording and add "uses under another name and other uses of a parameter are not checked" and "the model key test covers `model`, `modelId` and `modelName` only" to the limits list in DEADLINES.md.

## Info

### IN-01: Stop location can point at a request that is not the blocking one

**File:** `pipeline/model-retirements.ts:1286-1302`
**Issue:** `base` takes `file`, `line` and `call` from `decision.requests[0]`, while `reason` comes from `decision.reasons.find(Boolean)`, which may belong to a later request. The reason text then describes a different call from the one named in the stop. `at` (the literal's location, used for D-12) is unaffected.
**Fix:** Keep the index of the first non-empty reason and use that request for `base`.

### IN-02: Shared-use message counts type-position uses the check ignores

**File:** `pipeline/model-retirements.ts:645-648`
**Issue:** `uses` is filtered with `inType`, but the message prints `all.length`. A constant with one value use and two `typeof X` type uses reports "used 3 times" when it stops for another reason.
**Fix:** Print `uses.length`, or say "N uses".

### IN-03: Descriptor-key rule hides a `{ provider, name }` model config shape

**File:** `pipeline/deadline-exposure.ts:141, 206-220`
**Issue:** Some frameworks take the model as an object whose `name` or `id` is what is sent (for example an agent config `model: { provider: 'OPEN_AI', name: 'gpt-4o' }`). D-02 accepts the trade-off for `id`, `name` and so on, so this is not a defect, but DEADLINES.md describes the rule only as catalog entries. I did not verify any specific library, so confirm against the benchmark sets before relying on it.
**Fix:** Optionally keep the descriptor rule off when the enclosing object also has a `provider` key, or list the shape under known limits.

### IN-04: Raw endpoint pattern is not host-anchored; declarations in files with syntax errors are still edited

**File:** `pipeline/model-retirements.ts:189-203, 236-240`
**Issue:** `api\.openai\.com\/v1\/...` matches anywhere in the URL text, for example `https://proxy.example/?u=api.openai.com/v1/responses`. Separately, `files` drops syntactically broken files from request discovery, but `symbolOf` still resolves into them, so a literal in a file with parse errors can be reached and edited from a position computed on recovered syntax. Both are low probability.
**Fix:** Anchor the host with `(?:^|[/.@])api\.openai\.com` after the scheme, and refuse to edit a literal whose source file is not in `files`.

---

_Reviewed: 2026-10-21_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
