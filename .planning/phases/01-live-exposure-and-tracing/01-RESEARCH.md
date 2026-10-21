# Phase 1: Live exposure and tracing - Research

**Researched:** 2026-10-21
**Domain:** Static analysis of untrusted JavaScript/TypeScript repositories with the TypeScript compiler API: the deadline scan (`pipeline/deadline-exposure.ts`) and the model-replacement tracer (`pipeline/model-retirements.ts`)
**Confidence:** HIGH for code-level findings and fixes (read in this session, prototyped, and tested); MEDIUM for real-world yield (one 50-repository sample, session-local, evidence capped at 20 lines per deadline)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- D-01: Fix the model-keyed map rule so `"gpt-5.1-codex-mini": { id: "gpt-5.1-codex-mini", … } satisfies Model<…>` is a catalog: unwrap `satisfies`, `as`, parentheses and type assertions before testing for the object literal under a model-named key. This one bug covers the pi-derived model registries (BaseModelAI/base-context, LeanAndMean/scramjet, kolisachint/hoocode-ts, dmae97/omk, fleetagent/pi, ashx-j/lunR), hundreds of lines.
- D-02: A model ID that is the value of a descriptor key, `id`, `name`, `displayName`, `label`, `title` or `slug`, or an element of a `versions: [...]` array, is a catalog entry. These keys name a model; requests to OpenAI and Anthropic select one with `model`. Examples: TanStack/ai `const CODEX_MINI_LATEST = { name: 'codex-mini-latest', context_window, pricing… }`, genkit `openAIModelRef({ name: 'gpt-4.5-preview', info })`, `versions: ['gpt-4.5-preview']`, nexus-cortex `createClaudeModelConfig({ id: 'claude-3-5-sonnet-20241022', displayName, … })`. `model`, `modelName`, `modelId`, `version` (singular) and `default` stay live, because wrappers send them.
- D-03: For model providers (OpenAI, Anthropic) only, a model ID quoted inside a longer string literal, whose text is not exactly the model, is classified as `comment` (prose): descriptions such as `'Image model to use (e.g. "dall-e-3")'`, error messages, embedded markdown. Meta and Shopify URL and version matches inside strings are unchanged.
- D-04: Plain arrays keep the owner's `CATALOG_SIZE = 3` heuristic. Two-element lists such as promptfoo's `ANTHROPIC_COMPLETION_MODELS` stay live; do not change it in this phase.
- D-05 (EXPO-02): The 2026-10-20 results keys stay as they are. Benchmark results add per-repository non-live counts by use, plus a summary count of repositories that only mention a deadline model outside live code, so old and new totals can be compared side by side.
- D-06 (TRAC-01): `model: this.<field>` resolves through the class: the property declaration's initializer, every `this.<field> = <expr>` assignment in the class, and constructor parameter properties. Each right-hand side is followed with the same recursion: fallbacks, parameters and so on. Constructor parameters are followed to `new <Class>(…)` callers, the way helper parameters are followed to call sites today.
- D-07 (TRAC-03): A property of a `const` object literal, with or without `as const` (`MODELS.GPT4`, `config.model`), resolves to its initializer, with the same single-use rule and stop message as constants.
- D-08 (TRAC-06): A `const` initializer that is not a plain literal is followed recursively: env fallbacks `process.env.X ?? 'gpt-4'` and `||`, and conditionals (both branches). A function or method called as the model (`getModel()`, `this.getDefaultModel()`) resolves through its `return` statements; nested functions are not followed. Destructuring defaults (`const { model = 'gpt-4' } = opts`, `function f({ model = 'gpt-4' })`) resolve to the default, and for parameters to callers' object-literal `model` property. Options-object parameters (`opts.model` where `opts` is a parameter) also resolve to callers' object-literal property.
- D-09: A constant, member, field or helper used more than once stays editable when every one of its uses is a site this proposal reaches from a traced request and every such request allows the edit. Today it stops whenever the use count is not 1. Otherwise it stops with the existing "used N times; change it by hand" reason. This is a precision improvement, not a relaxed safety gate: every use is checked. It is recorded in PROJECT.md Key Decisions.
- D-10 (TRAC-02, TRAC-04, TRAC-05): Cross-module constants, enum members, helper parameters with callers, and raw `fetch`, `axios.post` and `UrlFetchApp` requests already exist. This phase adds tests for each shape the success criteria name and fixes any gap a test exposes; it does not rewrite them.
- D-11: Trace OpenAI `images.generate`, `images.edit`, `images.createVariation`, `audio.speech.create`, `audio.transcriptions.create`, `audio.translations.create`, `embeddings.create`, `moderations.create` and legacy `completions.create`, plus Anthropic legacy `completions.create`. A retiring model there always stops with a named reason, for example "`images.generate` is not a text-generation call; gpt-image-2 may change formats or parameters; change it by hand." These calls are never edited automatically, which keeps the existing rationale in `MODEL_CALLS`. Raw HTTP to the matching official endpoints (`/v1/images/…`, `/v1/audio/…`, `/v1/embeddings`, `/v1/moderations`, `/v1/completions`) stops the same way when the body is JSON.
- D-12: A labelled live pin is "traced" when its file and line appear as a replacement's `edited` location or a stop's `at` location in `refit deadlines --propose-model-fixes --json`. Phase 4 measures BENCH-04 with this definition. Stops count as traced; only fixes count toward BENCH-05.

### Claude's Discretion

- Exact helper names, recursion depth limits (current `depth > 4`) and how to share the uses-count logic.
- Whether to re-run `refit deadlines` on the already-fetched silent repositories as a smoke check during verification. That check is informative only; Phase 4 is the measurement.

### Deferred Ideas (OUT OF SCOPE)

- Wrapper libraries: Vercel AI SDK (`openai('gpt-4o')`, `anthropic(...)`), LangChain (`new ChatOpenAI({ model })`), Genkit. Phase 3 labels record pins that reach the API only through a wrapper with `via: wrapper`, so their volume is measured before any tracer is built.
- `let` variables reassigned at runtime, settings objects, UI state and CLI option defaults (v2 V2-01).
- Lowering `CATALOG_SIZE` or treating `version`/`modelId` as descriptor keys: would need evidence that it hides no live pins.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| EXPO-01 | Deadline scan classifies object-shaped model catalogs (model metadata objects, `versions: [...]` lists, model option arrays) as non-live, with a test per shape | D-02 descriptor-key and `versions` rule at `deadline-exposure.ts:199`; option arrays of 3+ models are already catalog via `CATALOG_SIZE` (line 131, test `PICKER`); candidate test `D-02` passes on the prototype |
| EXPO-02 | Reports and benchmark results show catalog matches separately from live exposures, so counts stay comparable to the 2026-10-20 runs | The CLI JSON already carries `nonLive`/`mentions` (capped at 20); add an exact per-use count and the D-05 fields in `scripts/ai-model-benchmark.mjs` (see "D-05") |
| EXPO-03 | A model ID quoted inside a longer string is not live, and a model-keyed map entry stays a catalog when wrapped in `satisfies`/`as` | D-01 fix at `deadline-exposure.ts:208`; D-03 prose rule in `tokenUses` (lines 247-263), applied last and only to otherwise-live matches |
| TRAC-01 | `model: this.model` resolves to the class field initializer or constructor parameter default | `fieldValues` over `symbol.declarations` + a new assignment index; parameter properties already resolve by accident today (see Pitfall 8) |
| TRAC-02 | A model constant exported from one module and used in another resolves to its literal | Already works (ESM, CJS destructured `require`, default-exported const object); add tests; known gap: default-exported class/function callers and CJS `exports.X` namespaces |
| TRAC-03 | An enum member or `as const` object member used as `model` resolves to its literal | Enum members work today; object members via `valuesOf` on the owner object (works for `as const`, `Object.freeze`, `Record<…>` annotations) |
| TRAC-04 | A helper's `model` parameter resolves to the literal its callers pass (each caller site reported) | Already works for named functions (`modelSites`, lines 494-534); generalized to methods and constructors |
| TRAC-05 | Raw `fetch`/`axios` requests to the official hosts with a literal `model` in the body are reported at the exact line and eligible for the same rule | Already works for `fetch`+`JSON.stringify`, `axios.post(url, object)` and `UrlFetchApp`; probed gaps listed in "D-10" |
| TRAC-06 | Env-fallback consts, functions returning a literal, and destructuring defaults resolve to their literal | `valuesOf` cases for `??`/`||`, conditionals, `return` statements, `BindingElement` defaults |
| TRAC-07 | Non-text OpenAI and Anthropic calls are traced and stop with a named reason | `NON_TEXT_CALLS` + raw endpoints; the analyzer already reports all of them (verified, see "D-11") |
</phase_requirements>

## Project Constraints (from AGENTS.md and CLAUDE.md)

`./.claude/CLAUDE.md` holds only GSD boilerplate; the binding rules are in `./AGENTS.md` and the user's global `CLAUDE.md`. Treat them as locked:

- **Run `npm test`, typecheck (`npm run typecheck`) and formatting (`npm run format:check`) after TypeScript changes; report gated and default counts separately.** [VERIFIED: AGENTS.md "Repository workflow"]
- **Retiring AI models (owner decision, 2026-10-20, #120): `refit serve --model-fixes`... "uses the rule stops on (sampling parameters, spreads, shared constants, tests) stay for review. Do not widen which uses are replaced without a new decision."** D-06..D-09 widen which uses are replaced and D-09 narrows the "shared constants" stop. The plan must include a task that records the decision in AGENTS.md (as Phase 2 does for RULE-03) and flag it for owner confirmation. [VERIFIED: AGENTS.md, last bullets]
- Output shape of `proposeModelReplacements` must not change; `refit deadlines --propose-model-fixes` and `refit serve --model-fixes` consume it. [VERIFIED: 01-CONTEXT.md "Integration Points"]
- Update the relevant user-facing guide (`docs/DEADLINES.md`) when supported behavior changes; keep README short. Preserve honest evidence boundaries: never claim a simulated test exercised a live provider. [VERIFIED: AGENTS.md]
- Recorded lockfile fixtures stay byte-exact (`.prettierignore`). Conventional commits; no co-author trailers; no AI attribution anywhere; no pushes or PRs unless asked. [VERIFIED: AGENTS.md; global CLAUDE.md; project memory]
- Comments explain why and cite provider pages with dates; hardcoded data carries a source and date (global CLAUDE.md). Apply to the new `NON_TEXT_CALLS` table and raw endpoint patterns.
- Prettier: `singleQuote: true`, `printWidth: 100`, `trailingComma: "all"`. Test files must sit directly in `pipeline/` (vitest includes `pipeline/*.test.ts` only). [VERIFIED: `.prettierrc`, `vite.config.ts`]
- Never run a live vendor operation or paid model call. Everything in this phase is file reads and the TypeScript parser. [VERIFIED: AGENTS.md "Product boundaries"]

## Summary

Phase 1 touches two source files, their tests, one benchmark script and one guide. No package is added. Every decision D-01..D-12 is implementable with the compiler API the repo already uses (`typescript-compiler`, an npm alias of typescript 5.9.3). I built a throwaway prototype of all of it (scratch, not in the repo) and ran it: it typechecks under the repo's strict flags, 9 candidate tests fail on the current code and pass on the prototype, and the full vitest suite run in a scratch copy of the repo with the prototype applied has exactly two failures attributable to it, the two tests that assert the old "embeddings are ignored" behavior, which D-11 changes on purpose (1,580 passed, 79 skipped; the 8 `watch.test.ts` failures in that copy also occur on an unmodified copy and come from the copy's location and git state, not from the prototype).

**What the 50 fetched repositories show (this changes how the plan should talk about success).** The 842 silent evidence lines sit in 59 repository-provider pairs across 50 distinct repositories (CONTEXT says 49). D-01..D-03 re-classify 511 of the 842 lines (61%) as non-live and take 10 of the 59 pairs (9 OpenAI, 1 Anthropic) out of the exposed set. The full tracing prototype (D-06..D-09, D-11) adds only **2** more traced lines on these repositories, both `images.generate` stops. The other 47 pairs are not blocked by how the model is written but by things D-01..D-12 do not touch: no calls recognized while the analyzer reports an unverified `tsconfig` (12 pairs in 10 repositories; relaxing that gate reveals requests in only 2 of them), SDK clients the analyzer does not recognize (15), no SDK import at all (3), and repositories where the retiring literal is a library constant, mock or catalog that never reaches a traced request (17). Phase 1 will meet its success criteria on fixtures. It will not, by itself, raise the traced fraction on npm-sourced library sets, and Phase 4's 90% target depends on the discovery limits in Open Questions 1, 5 and 6 (alias gate, request objects built elsewhere, unrecognized client shapes).

**Primary recommendation:** Implement D-01..D-12 as one memoized resolver (`valuesOf`) that returns literals plus the references each one was reached through ("passes"), do the D-09 check at decision time against the set of all passes, keep `ModelReplacement`/`ModelReplacementStop` unchanged, apply the D-03 prose rule last and only to otherwise-live matches with a `"model":` guard, update the two D-11-affected tests, record the D-09 narrowing and the new traced shapes in AGENTS.md, and take the discovery limits (Open Questions 1, 5, 6) to the owner before Phase 4.

## Architectural Responsibility Map

This is a CLI/analysis pipeline, so "tiers" are its layers.

| Capability | Primary layer | Secondary layer | Rationale |
|------------|---------------|-----------------|-----------|
| What counts as live (catalog, prose, test, check) | Scan: `pipeline/deadline-exposure.ts` | Docs: `docs/DEADLINES.md` | Pure syntax classification of each quoted match; no symbol resolution needed |
| Per-use non-live counts | Scan (exact counts before the 20-item cap) | Benchmark script `scripts/ai-model-benchmark.mjs` | The cap in `scanDeadlines` truncates lists; counts must be taken before it |
| Which calls are model-bearing requests | Analyzer: `pipeline/analyzer.ts` (`sdkCalls`, `clientMethodCalls`) | Tracer `TRACERS` tables | The analyzer reports every `client.a.b.method()`; the tracer decides which are text, non-text or ignored |
| Where a request's `model` literal is written | Tracer: `pipeline/model-retirements.ts` (`valuesOf`, `modelSites`) | `sourceProgram` indexes (`symbolOf`, `usesOf`, new `assignmentsOf`) | Needs the TypeScript checker for symbols across files |
| Whether editing a shared literal is safe (D-09) | Tracer decision step in `proposeModelReplacements` | `usesOf` index | Must see every request first, so it runs after request discovery |
| Non-text stop reasons | Tracer decision step | `data/deadlines.json` replacement | Reason names the registry replacement, like existing stops |
| Output contract | `ModelReplacement` / `ModelReplacementStop` / patch | `deadlines-cli.ts`, `model-fixes.ts` | Must not change shape |
| Measurement definition (D-12) | Phase 4 | `--json` output | Reads `edited`/`at` only |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `typescript-compiler` | 5.9.3 | Parser, program and checker for scan and tracer | The repo's programmatic TypeScript API is an npm alias: `"typescript-compiler": "npm:typescript@^5.9.3"`; `typescript` ^7.0.2 is used only for `tsc -b` [VERIFIED: package.json; node_modules/typescript-compiler/package.json] |
| `vitest` | 4.1.11 | Test runner (`pipeline/*.test.ts`) | Existing [VERIFIED: node_modules] |
| `tsx` | 4.23.15 | Runs `.ts` for scripts and the CLI | Existing [VERIFIED: node_modules] |
| `prettier` | 3.9.9 | Formatting gate | Existing [VERIFIED: node_modules] |
| Node | v24.14.0 here; engines `^22.12.0 \|\| >=24.0.0` | Runtime | CI runs 22 and 24 [VERIFIED: `node --version`, package.json] |

### Supporting / Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| One resolver `valuesOf` for strings and objects | Separate `modelSites` and `objectSources` | Two functions follow the same references and drift; one resolver gives D-07, D-08 options objects and `this.options.model` for free |
| Per-request memoization of declarations | Depth limit only | Depth 8 without memoization did 3,319 steps median and more than 100,000 on one real repository; memoized it did 230 median and 1,483 max (see Pitfall 4) |
| Resolve `MODELS.GPT4` through the property symbol | Resolve through the owner object literal | The checker returns no property symbol for `Record<string,string>`-annotated consts and the owner approach also catches destructuring and iteration of the owner |

**Installation:** none. **Version verification:** versions read from `node_modules/*/package.json` this session; no `npm view` needed because nothing is installed.

## Package Legitimacy Audit

No external packages are installed or recommended in this phase. `slopcheck`/`package-legitimacy` not run: nothing to check. All APIs used (`ts.isSatisfiesExpression`, `ts.isAsExpression`, `ts.isTypeAssertionExpression`, `ts.isPrivateIdentifier`, `checker.getSymbolAtLocation`) exist in the pinned 5.9.3 build and are already used in the repo or exercised by the prototype.

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
repository files (read only, never executed)
   |
   +--> readRepository()  (limits: 10,000 files, 2 MiB/file, 50 MiB total)
   |
   +--> scanDeadlines()                              proposeModelReplacements()
        |  sourceMatches(): quoted-string regexes      |  quoted(provider)? no -> return empty
        |  tokenUses(): offset -> leaf token           |  sourceProgram(): TS program (noLib, allowJs)
        |  literalUse(): live|catalog|test|check|...   |     symbolOf, usesOf, assignmentsOf (NEW)
        |    + D-01 unwrap, D-02 descriptor keys       |  per TRACER: analyzeRepository() -> sdkCalls
        |  prose (D-03) -> 'comment'  (last, live only)|     text calls + NON_TEXT_CALLS (NEW)
        v                                              |  raw HTTP requests (+ non-text endpoints NEW)
   exposures / mentions (evidence cap 20,              |  requestObject() -> `model` property
   nonLive cap 20, + exact counts NEW)                 |  valuesOf() NEW, memoized per request
        |                                              |     literals + passes (consts, members, fields, calls)
        v                                              |  decisions per literal; reached-set check (D-09)
   deadlines-cli, deadline-alerts,                     v
   ai-model-benchmark.mjs (D-05)               replacements | stops | patch
                                                       |
                                                       v
                                  deadlines-cli --propose-model-fixes, model-fixes.ts
                                  (validation in offline Docker, draft PR)
```

### Recommended file touch list

```
pipeline/deadline-exposure.ts        D-01, D-02, D-03, exact non-live counts
pipeline/model-retirements.ts        valuesOf family, NON_TEXT_CALLS, raw non-text endpoints, assignmentsOf
pipeline/deadlines.test.ts           D-01..D-03 shapes (+ keep the 'Two models are not yet a list' guard)
pipeline/model-retirements.test.ts   TRAC-01..07 shapes; update the 2 D-11-affected expectations
scripts/ai-model-benchmark.mjs       D-05 fields
docs/DEADLINES.md                    classification table, propose section, limits
AGENTS.md                            owner-decision record for D-09 and the new traced shapes
.planning/PROJECT.md                 Key Decisions outcome for the D-09 row (already listed as Pending)
```

Suggested slicing for a coarse plan: (1) exposure classification + counts + benchmark fields + their tests; (2) tracer: `valuesOf`, D-09, D-11, tests, the two test updates; (3) docs, AGENTS.md record, full verification (`npm test`, typecheck, format, one gated Docker run, optional smoke re-run on the 50 repositories).

### Pattern 1: One resolver, literals plus passes (D-06, D-07, D-08, D-09)

**What:** `valuesOf(program, expression, trace)` returns every string or object literal an expression may hold, each with the list of references ("passes": a constant, enum member, field or function) it travelled through. `modelSites` filters string literals and de-duplicates them. D-09 is then a decision-time check: for each pass of a literal, every non-type use of its symbol must be a pass node recorded by some traced request.

**When to use:** every `model` value read from a request object.

**Key mechanics (all exercised by the prototype):**

- `Terminal { node, passes, stop? }`, `Pass { symbol, node, kind, name, at }`, `Trace { depth, budget, memo, passes, calls }`.
- `expanded(trace, declaration, prefix, compute)` memoizes a declaration once per request; cached terminals carry only the passes found below the declaration, and the caller prefixes the passes that led to it. Inside a followed call (`trace.calls.size > 0`) results depend on that call's arguments and are not shared.
- A literal passed as a call argument into a function whose return value is followed belongs to that call alone, so the function's pass is dropped from terminals that sit outside the function body (otherwise `pick('gpt-4')` would stop because `pick('o1-mini')` exists elsewhere).
- Parameters inside a followed call resolve to that call's argument only (context-sensitive); everywhere else they resolve to every caller's argument, with the existing "also passed as a value" and "spread arguments" stops.
- Stops from by-value or spread callers must apply to **all** terminals of the parameter, not only those collected before the offending use (existing order-dependent behavior at `model-retirements.ts:517-528`; see Pitfall 9).

### Pattern 2: Two-pass decisions

Build `reached` (every pass node of every traced request, including requests whose literals are not retiring, excluding requests in test files) in a first pass over all requests, then build decisions in a second pass and evaluate the shared-use check at the position where `site.stop` is evaluated today. Today's per-request reason chain is: registry has no concrete replacement, helper stop (`site.stop`, which also carries the "used N times" sentence), request-object shared, spread options, sensitive parameter [VERIFIED: `model-retirements.ts:672-682`]. Insert the non-text reason right after the registry check and keep the shared-use sentence where `site.stop` sits, so a request that has both a shared constant and, say, `temperature` keeps today's message. The prototype evaluates the shared check after the request reasons (lowest precedence); that passes every existing test but changes the message in that mixed case, so prefer the two-pass placement.

### Pattern 3: Non-text calls are a deny-list beside the text allow-list

`MODEL_CALLS` (lines 17-36) stays the text allow-list. Add `NON_TEXT_CALLS` per provider and give `requests` a `text: boolean`. A decision for a non-text request always has a blocking reason, so it can never produce an edit, even when the literal is also reached by a text request (then the merged decision stops, naming the non-text call).

### Anti-Patterns to Avoid

- **Resolving `MODELS.GPT4` through the property symbol only.** `Record<string,string>`-annotated consts and `Object.freeze({…})` give no property symbol, an object-type annotation gives a `PropertySignature` (noLib has no `Record` or `Object`; verified), and the owner's other uses (`Object.values(MODELS)`, `const { GPT4 } = MODELS`) stay invisible. Resolve through the owner object literal and treat bare uses of the owner as shared.
- **Counting `typeof MODELS` as a use.** Skip identifiers inside type nodes (`inType`), but keep `extends X` as a value use.
- **Gating tracing on the scan's classification.** The scan marks `{ id: 'gpt-4' }` catalog (D-02), but `model: MODEL.id` must still be traced and replaced. Verified: the prototype replaces it. The two layers are independent by design.
- **Raising the depth limit alone.** Callers fan out; use memoization and a work budget.
- **Changing `CATALOG_SIZE`, `DeadlineUse`, or the shape of `ModelReplacement`/`ModelReplacementStop`.**

## D-by-D implementation guide

### D-01: unwrap before the object test (answers Q1)

`literalUse` (`deadline-exposure.ts:178-218`) climbs from the literal. For `"gpt-x": { id: "gpt-x" } satisfies Model<…>` the climb works: `isLiteralStructure` (lines 144-156) includes `ts.isSatisfiesExpression`, `ts.isAsExpression`, `ts.isParenthesizedExpression` and `ts.isTypeAssertionExpression`, so `current` becomes the `SatisfiesExpression`. What fails is the model-keyed-map test at lines 205-212:

```ts
      ts.isPropertyAssignment(up) &&
      up.initializer === current &&
      ts.isObjectLiteralExpression(current) &&
      ts.isStringLiteralLike(up.name) &&
      isModel(up.name.text)
```

`current` is the wrapper, not the object literal, so line 208 is false and the inner `id: "gpt-x"` stays live. The key string itself was already catalog (line 198, `propertyKey`). **Minimal fix:** test the unwrapped node.

```ts
function unwrapDown(node: ts.Node): ts.Node {
  while (
    ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) ||
    ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)
  ) node = node.expression;
  return node;
}
// line 208
ts.isObjectLiteralExpression(unwrapDown(current)) &&
```

`model-retirements.ts:166-175` has a similar `unwrap` that lacks `ts.isTypeAssertionExpression`; do not change it (not needed). Test (fails on current code, passes on prototype): `{ 'gpt-4': { model: 'gpt-4', context: 8192 } satisfies Model<'x'> }` plus `as const`, parenthesized and `<Model>{…}` variants all `catalog`; `{ chat: { model: 'gpt-4' } satisfies Model }` stays `live`. Use a non-descriptor inner key (`model:`) so the test exercises D-01 and not D-02. On the 842 silent lines D-01 alone re-classifies 382; on this sample D-02 covers every line D-01 does, so D-01's own coverage only shows on shapes without a descriptor key. [VERIFIED: scratch runs]

### D-02: descriptor keys and `versions` arrays (answers Q2, first half)

Insert after the `propertyKey`/element-access checks (`deadline-exposure.ts:198-199`), which are after the `if (!model) return 'live'` guard (line 190). That guard keeps Meta and Shopify out: they return before any new rule runs.

```ts
const DESCRIPTOR_KEYS = new Set(['id', 'name', 'displayName', 'label', 'title', 'slug']);
function descriptor(node: ts.Node) {
  const value = unwrapUp(node);               // climb As/Satisfies/Parenthesized/Assertion/NonNull parents
  const holder = value.parent;
  if (ts.isPropertyAssignment(holder) && holder.initializer === value) {
    const key = ts.isIdentifier(holder.name) || ts.isStringLiteralLike(holder.name) ? holder.name.text : undefined;
    return key !== undefined && DESCRIPTOR_KEYS.has(key);
  }
  if (ts.isArrayLiteralExpression(holder)) {  // versions: [...]
    const list = unwrapUp(holder), owner = list.parent;
    return ts.isPropertyAssignment(owner) && owner.initializer === list &&
      (ts.isIdentifier(owner.name) || ts.isStringLiteralLike(owner.name)) && owner.name.text === 'versions';
  }
  return false;
}
// after line 199:  if (descriptor(node)) return 'catalog';
// unwrapUp is the mirror of unwrapDown (D-01): climb while node.parent is an As/Satisfies/Parenthesized/Assertion/NonNull wrapper
```

Kept live (tested): `model`, `modelName`, `modelId`, `version`, `default`, `versions: 'gpt-4'` (not an array), `id: cond ? 'gpt-4' : 'o1'`. Sample effect: D-02 alone takes 502 of 842 lines and 9 pairs out of live (base-context x2, scramjet, dreb, lunR, omk, pi, hoocode-ts, multi-llm-ts). All demoted contexts read as catalogs (model-keyed registries, `allModels.push({ id })`, `openAIModelRef({ name })`, `createClaudeModelConfig({ id })`, `versions` arrays). [VERIFIED: scratch classification of the demoted lines]

**Hidden-pin check:** a descriptor-keyed literal that a traced request reads, such as `const MODEL = { id: 'gpt-4' }` with `model: MODEL.id`, is classified catalog by the scan but is still found and replaced by the tracer. Add that as a test so the two layers stay independent.

**Not decided:** `value` (as in `{ value: 'claude-opus-4-1-20250805', label: 'Anthropic Claude 4.1 Opus' }`, promptfoo `constants.ts:75-77`) is not a descriptor key under D-02, so two-entry UI option arrays stay live. See Open Question 3.

### D-03: prose inside longer strings (answers Q2, second half)

`tokenUses` builds `ranges` of every leaf token (lines 233-245) and binary-searches the offset (lines 247-263). `scanDeadlines` passes `offset + match.column`, where `column` is where the *version* starts (line 335). A match inside a longer string is detectable by `node.text !== version`: the regex at line 104 only matches a quote pair hugging the ID, so an exact literal always has `text === version`.

Three details the decision text does not mention:

1. **Template pieces and JSX text skip `literalUse` today.** Line 257 is `ts.isStringLiteralLike(node) ? literalUse(...) : 'live'`; `TemplateHead/Middle/Tail` and `JsxText` are leaf tokens that are not string-literal-like, so they are always `live`, even in test files (`steipete/oracle` `tests/oracle/streaming.pty.test.ts:72` is a `LastTemplateToken` and stays live today). The prose rule must cover these kinds or most embedded-code strings are missed. Optionally also route them through the `TEST_PATH` check.
2. **Order.** Apply prose last, only when the result so far is `live`, after the existing `<option>` rule (line 259). Applying it first breaks the existing test fixture ``const html = `<option value="gpt-4">GPT-4</option>`;`` (expected `catalog`), which fails on the prototype if prose runs first. [VERIFIED: scratch run]
3. **Guard JSON and config text.** `kiso` `apps/cli/src/index.ts:120` is `chatgpt: '{"model":"codex","models":{"codex":{"kind":"openai-responses","model":"gpt-5-codex",…}}}'`, a live config pin; unguarded D-03 would hide the repository's only exposure. Recommended guard: keep `live` when the text just before the opening quote ends with a `model` key (`/\bmodel(?:Id|Name)?["'\s]*[:=]\s*$/i` over the preceding 40 characters). This deviates from the literal wording of D-03, so flag it as a planner/owner confirmation (Assumption A3). Effect on the sample: guarded D-03 re-classifies 9 lines (1 pair: n8n-nodes-openai-langfuse); unguarded 14 lines (2 pairs, adding kiso).

Signature change: `useAt(offset, provider, line, version)` (callback at line 247, call at line 335). `model` is `MODEL_PROVIDERS.has(provider)` (line 256), so Meta/Shopify are untouched. Verified by the existing `'leaves Meta and Shopify matching as it was…'` test and a new `https://graph.facebook.com/v21.0/me` fixture.

### D-04: no change

Keep `CATALOG_SIZE = 3` (line 131). The existing `'Two models are not yet a list'` fixture (`deadlines.test.ts:264-265`) and `unsupportedModels = ['tts-1','tts-1-hd']` style arrays stay live. Do not add a test that changes this.

### D-05: counts for comparing old and new totals (EXPO-02)

`scripts/ai-model-benchmark.mjs` already reads `deadlines.result.exposures` and writes `exposed`, `exposedWithReplacement`, `exposedStoppedOnly`, `exposedSilent` (lines 119-131). `refit deadlines --json` already carries each exposure's `nonLive` and a top-level `mentions` array, but `nonLive` is capped at 20 per deadline (`MAX_EVIDENCE = 20`, line 12) and `nonLiveMore` has no per-use breakdown, so counts from the lists alone undercount big catalogs.

Recommended: add an optional, additive `nonLiveCounts?: Partial<Record<DeadlineUse, number>>` to `DeadlineExposure`, computed in the final loop of `scanDeadlines` (lines 365-376) from `rest` before slicing. Optional, so the hand-built `DeadlineExposure` object in `deadlines.test.ts:859-882` still typechecks. Then:

```js
// per repository, this provider only; exposures and mentions both carry nonLiveCounts
const nonLive = {};
for (const group of [...(deadlines.result?.exposures ?? []), ...(deadlines.result?.mentions ?? [])])
  if (group.deadline.provider === frozen.provider)
    for (const [use, count] of Object.entries(group.nonLiveCounts ?? {})) nonLive[use] = (nonLive[use] ?? 0) + count;
// summary: repositories with a mention and no live exposure for this provider
mentionedOnly: results.filter((r) => !r.exposures?.length && Object.keys(r.nonLive ?? {}).length).length,
```

Existing keys stay as they are; new keys are `nonLive` per repository and `mentionedOnly` in `summary`. Also print the counts in `printNonLive` (`deadlines-cli.ts:287-302`) so "deadline reports" show the separate count (success criterion 2). Do not change the alert text in `deadline-alerts.ts:139`; `deadlines.test.ts:896-898` asserts it. The script is top-level code with no test harness; validate it by a network-free run: it reuses a checkout directory that already has `.git` (line 35), so a three-entry list pointing at `owner__repo` directories works. [VERIFIED: script source]

### D-06..D-08: the resolver (answers Q3)

Verified checker behavior in a noLib, allowJs program like `sourceProgram` (`model-retirements.ts:196-277`):

| Expression | `symbolOf(name)` valueDeclaration | Notes |
|------------|-----------------------------------|-------|
| `this.model`, class field in `.ts/.tsx/.js/.jsx/.mjs/.cjs` | `PropertyDeclaration` | `this` resolves with no `lib.d.ts`; works for static fields (`Gen.DEFAULT`) and private `#model` |
| `this.m2`, constructor `private m2 = 'x'` | `Parameter` (parent `Constructor`) | Today this works by accident: the `ts.isParameter` branch (line 494) treats the constructor as a helper, takes the default, finds no name, returns (`model-retirements.ts:494-509`) |
| JS `this.fallback = …` in a constructor or method | `BinaryExpression` (the first assignment); `declarations` lists every assignment | |
| `MODELS.GPT4`, `config.model` (inferred type) | `PropertyAssignment` | `undefined` for a `Record<string,string>`-annotated const and for `Object.freeze({…})` (noLib has no `Record` or `Object`); `PropertySignature` for a const annotated with an object type |
| `opts.model` with `opts: any` or untyped | `undefined` | Must be resolved through the object literals `opts` may hold |
| `opts.model` with `opts: Options` | `PropertySignature` | Same |
| `this.getModel()` | `MethodDeclaration`; getter `get model()` is `GetAccessor` | Getter support is optional |

**Assignments:** `usesOf` deliberately excludes `x.name = value` targets (`declarationName`, lines 295-300), so assignments need their own index. Extend the same lazy per-name builder (lines 242-267) with a `writes` map, and accept `PrivateIdentifier` (`this.#model` is not an `Identifier`; the prototype changed the index key type to `ts.MemberName`). Declaration lookups in `declarationName`/`moduleBinding` take `ts.MemberName` too.

**Constructor callers:** `callable(program, owner)` maps a `ConstructorDeclaration` to its class name symbol; callers are `usesOf(classSymbol)` where `use.parent` is a `NewExpression` whose `expression` is the use (or the `ns.Class` property-access form). `arguments` may be `undefined` (`new Gen`). `extends Gen`, `[Gen]`, `instanceof` and spread arguments produce the existing "also passed as a value" / "spread arguments" stop with noun `class`. Identifiers in type positions are skipped (`inType`). Anonymous or default-exported classes get no callers (Pitfall 7).

**Return statements:** `returnedExpressions(fn)` walks the body, does not descend into nested function-likes or class-likes, and uses the expression body for arrows. Resolve callee symbols to `FunctionDeclaration`, `MethodDeclaration`, or a `const` holding an arrow/function expression. `await` is unwrapped, `Object.freeze(x)` is treated as `x`.

**Destructuring:** `BindingElement` default is a site; the pattern's source is the callers' object literals (parameter) or the declaration's initializer (const). `propertyName ?? name` is the key. Array patterns and rest elements are skipped.

**D-08 options objects:** `opts.model` falls back to `valuesOf(opts)` object literals then `objectProperty(object, 'model')`. The prototype applies this to any property name, not only `model` (for example `model.id`); it is broader than D-08's wording but every edit it makes is a literal at a call site that really flows into the parameter. Note the broader reach when sizing tests.

### D-09: shared constants, fields, members and helpers (answers Q4)

`usesOf(symbol).length` today: `byName` caches, per symbol *name*, a map from resolved symbol to identifier nodes (`model-retirements.ts:242-267`). For each file whose text includes the name it visits every `Identifier` with that text, skips `declarationName(node)` (declaration names and assignment targets, lines 280-301) and `moduleBinding(node)` (import/export specifiers, `export =`, `module.exports = { x }`, lines 304-331), resolves `symbolOf(node)` (alias chains up to 8 hops, shorthand properties via `getShorthandAssignmentValueSymbol`, lines 230-238) and groups by resolved symbol. Shorthand `{ MODEL }`, `typeof MODEL` and type references all count as uses today. Files with syntactic errors are excluded from the index (`files`, lines 225-229), so a use in such a file is invisible.

Design (prototype, passes the old messages byte-for-byte):

1. First pass over all non-test requests: `modelSites(...)` returns sites with `passes`; add every `pass.node` to one global `reached` set.
2. Second pass, per literal decision: for each pass of any site that reached the literal, take `uses = usesOf(pass.symbol).filter(use => !inType(use))`. If `!uses.includes(pass.node)` (cannot verify) or any use is not in `reached`, produce the existing sentence: `The model comes from the ${kind} ${name} (${at}), which is used ${uses.length} times; change it by hand to ${to}.` with `kind` in `constant`, `enum member`, `field`, `function`. Old tests expect exactly "constant MODEL" and "constant LABEL_MODEL (src/models.ts:3)…used 2 times". [VERIFIED: `model-retirements.test.ts:208`, `:401`]
3. Requests in test files are skipped before their passes are recorded, so a constant also used by a test request stays a stop, which matches today and is right (editing it would change test behavior).
4. A request with a blocking reason still records its passes, and the decision merge (`decision.reasons.find(Boolean)`) stops the literal. Verified: a constant shared by two requests where one sets `temperature` stops with the temperature reason.
5. A const object property (D-07) uses the owner's passes: every non-type use of the owner object must be a pass. A read of a *different* property of the same owner is a use that is reached only if some traced request passes through it. This is slightly more conservative than property-level counting (a `console.log(MODELS.OTHER)` makes `MODELS.A` stop). Refinement, if wanted: ignore uses whose parent is `owner.<other>`.

Request objects (`requestObject`, lines 424-449, "request object X used N times") are not in D-09's list (constant, member, field, helper). Leave that rule unchanged.

### D-10: shapes that already exist, and gaps their tests exposed

Run a test for each success-criterion shape and keep the existing ones. Gaps found by probing (baseline and prototype behave the same):

| Shape | Result | Action |
|-------|--------|--------|
| Default-exported class or function with callers (`export default function ask(m, model = 'gpt-4')`, `import ask from './ask'; ask([], 'o1-mini')`) | Callers silently missed; the default is replaced, the caller literal is not | `usesOf` prefilters by `symbol.name`, which is `'default'` for default exports, so no identifier matches. Verified on unmodified code. Fix by also scanning the import bindings that alias the export, or document as a limit |
| `axios.post(url, JSON.stringify({...}))`, `axios({ url, data })`, `axios.request({...})`, `got.post(url, { json })` | Silent | Optional cheap additions for `rawRequest`; the success criterion names `fetch` and `axios` generally |
| URL built as `` `${BASE}/chat/completions` `` | Silent (`urlText` reads only the template head) | Document |
| CJS namespace exports (`exports.MODEL = …`, `module.exports = { DEFAULT }` read as `models.DEFAULT`) | Silent | Document; `const { MODEL } = require('./models')` works |
| `fetch`+`JSON.stringify(const)`, `axios.post(url, obj, cfg)`, `client.post` from `axios.create`, env fallback in body, Anthropic fetch/axios | Work | Test |

### D-11: non-text calls (answers Q5)

The analyzer reports every `client.<resource.path>.<method>(…)` call; the adapter's `operations` do not limit `sdkCalls`. `sdkCalls` is filled from `sdkCall()` (`analyzer.ts:306-327`, `validSdkResourcePath` against `SDK_RESOURCE_PATH` at `providers.ts:80`), and only `calls` consults `provider.operations`. [VERIFIED: analyzer experiment this session]

Exact `resource.method` strings reported for a v4/v5-style `OpenAI` client with `examples/openai.provider.json`: `images.generate`, `images.edit`, `images.createVariation`, `audio.speech.create`, `audio.transcriptions.create`, `audio.translations.create`, `embeddings.create`, `moderations.create`, `completions.create`; also reported, not in D-11: `beta.assistants.create`, `beta.threads.runs.create`, `fineTuning.jobs.create`, `responses.compact`, `batches.create`, `realtime.sessions.create`. For an `Anthropic` client with `examples/anthropic.provider.json`: `completions.create` (legacy; the method exists in the SDK [CITED: github.com/anthropics/anthropic-sdk-typescript `src/resources/completions.ts`]), plus `messages.batches.create`, `beta.messages.batches.create`. The OpenAI v3 `OpenAIApi` client reports `clientMethodCalls` `createCompletion`, `createImage`, `createEmbedding`, `createTranscription`, `createModeration`, `createEdit` (D-11 as written does not list them; adding the request-object ones is cheap through `TRACERS[].clientCalls`).

Implementation: `NON_TEXT_CALLS` per provider (the nine OpenAI strings, Anthropic `completions.create`), `.filter(sdk => resourceCalls.has(call) || nonTextCalls.has(call))`, `text = !nonTextCalls.has(call)`. Reason (placed right after the registry-has-no-replacement check):

```ts
`\`${request.call}\` is not a text-generation call; ${resolved.to} may change formats or parameters; change it by hand.`
```

Raw endpoints, from the OpenAI OpenAPI document (`openai/openai-openapi` `openapi.yaml`, info.version 2.3.0, server `https://api.openai.com/v1`) [VERIFIED: file read this session]: `/audio/speech`, `/audio/transcriptions`, `/audio/translations`, `/completions`, `/embeddings`, `/images/edits`, `/images/generations`, `/images/variations`, `/moderations`. Request body is JSON only for `/images/generations`, `/audio/speech`, `/embeddings`, `/moderations`, `/completions`; `/images/edits` accepts JSON or multipart; `/images/variations`, `/audio/transcriptions`, `/audio/translations` are multipart, so the JSON-body raw rule never sees them (`formData.append('model','whisper-1')` stays out of scope, as CONTEXT says).

**The Anthropic legacy endpoint is `POST /v1/complete`, not `/v1/completions`** [CITED: https://platform.claude.com/docs/en/api/completions/create, "POST /v1/complete", marked Deprecated]. D-11 lists `/v1/completions` generically; for Anthropic the pattern must be `api\.anthropic\.com\/v1\/complete(?![\w/-])`. Add a `text: boolean` to `RAW_ENDPOINTS` entries; the call label (`fetch /v1/images/generations`, `post /v1/complete`) comes from the existing `/\/v1\/[\w/]+/` match at line 412.

Two existing tests assert the old behavior and need new expectations: `model-retirements.test.ts:182` (`openai.embeddings.create({ model: 'gpt-4', input: 'x' })`, comment "Not a text-generation call… no proposal") now yields a stop at line 12, and `:371` (`fetch('https://api.openai.com/v1/embeddings', …)`) now yields a `fetch /v1/embeddings` stop at `src/raw.ts:16`. The v3 test (`createCompletion`, line 255) is unchanged unless v3 non-text is added. Effect outside tests: in `runModelFixes` (`model-fixes.ts:186-192`) a repository whose only retiring uses are non-text moves from `no-change` to `needs-review` ("No model can be replaced safely; N uses left for review."), and the draft PR body lists the stops under "Left for review". `fixKey` is built from replacements only, so stops do not trigger re-runs. [VERIFIED: model-fixes.ts]

Optional broadening (needs a planner decision, beyond D-11's list): stop for any traced call that is not in `MODEL_CALLS` and whose request object has a `model` property, instead of enumerating. It would also catch `beta.assistants.create`, `beta.threads.runs.create`, `fineTuning.jobs.create`, `videos.create`, `realtime`.

### D-12: no code

A pin is traced when `file:line` equals some `replacement.edited` or `stop.at`. Notes for Phase 4: several literals can share a line (the prototype's `MODELS = { A: 'gpt-4', B: 'o1-mini' }` produces two edits on line 1 and the patch applies cleanly); a stop for "registry names no concrete replacement" or for a non-text call counts as traced under this definition.

### Docs to update (`docs/DEADLINES.md`, per AGENTS.md)

| Where | Change |
|-------|--------|
| Table row `catalog` (line 77) | Add: model-keyed map entries wrapped in `satisfies`/`as`; values of `id`, `name`, `displayName`, `label`, `title`, `slug`; elements of a `versions: [...]` array |
| Table row `comment` (line 81) | Add: for OpenAI and Anthropic, a model ID quoted inside a longer string (descriptions, error messages, embedded markdown), except text that sets a `model` key (if the guard is kept) |
| Line 85 (terminal output) and `--json` list (lines 89-95) | Per-use counts and `nonLiveCounts`; the benchmark's new fields stay in the benchmark docs |
| "Propose model replacements" eligibility list (lines 188-196) | Add class fields (initializer, `this.x = …` assignments, constructor parameters followed to `new` callers), properties of `const` object literals, env fallbacks and conditionals, functions and methods that return a literal, destructuring defaults, options-object parameters |
| Stop list, "used more than once" bullet (line 202) | Rewrite: a shared constant, member, field or helper is edited when every use is a traced request that allows it, otherwise it stops; add the non-text stop |
| Line 206 ("Embeddings, images, audio and moderation calls are never proposed…") | Replace: these calls stop with a named reason and are never edited; list the calls, raw endpoints and the Anthropic `/v1/complete` endpoint |
| Limits (line 250) | `modelRef({ … })`-style catalogs are now partly classified (descriptor keys inside the call); arrays passed to a call (`modelsWithCost(['gpt-4'], …)`) are still live; add the discovery limits (unverified `tsconfig`, clients the analyzer does not recognize, request objects built by functions, default-exported callers) |
| `deadlines-cli.ts` `USAGE` (lines 38-40) | Optional: mention prose and the non-text stop |

Do not touch `docs/READINESS.md` or `docs/PROVIDER-GOALS.md` in this phase unless the plan chooses to; their dated checkpoint and checklist belong to DOCS-01 in Phase 4.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Symbol resolution across files and aliases | Name-matching heuristics | Existing `sourceProgram` (`symbolOf`, `usesOf`) | Handles import aliases, shorthand properties, CJS destructured requires |
| Dataflow engine / call graph | A second analysis framework | `valuesOf` with memoization over the same program | The repo needs a bounded, explainable resolver, not general dataflow |
| tsconfig path/extends handling | Own parser | `source-configurations.ts` / `source-imports.ts` as they are | Safety-relevant, already tested |
| Patch generation | String splicing | `renderPatch(repository, edits)` | Verified clean `git apply` with two edits on one line |
| Terminal-safe output | Raw strings | `terminalText()` in the CLI | Stop reasons now embed repository identifiers |

**Key insight:** every edit must be a literal at a place that provably flows into a traced request's `model`; anything not provable must stop or stay silent, never guess.

## Common Pitfalls

### Pitfall 1: the scan and the tracer are independent layers
**What goes wrong:** treating a catalog classification as "not a request". **Why:** `{ id: 'gpt-4' }` is catalog (D-02) but `model: MODEL.id` is a real request value. **Avoid:** keep both layers; test `MODEL.id` is still replaced. **Warning sign:** a plan task that filters tracer sites by scan classification.

### Pitfall 2: template pieces and JSX text are always `live` today
**Evidence:** `deadline-exposure.ts:257`. **Effect:** embedded code in template literals (n8n expressions, test fixtures that spawn scripts) counts as live even in test files. **Avoid:** apply prose to `TemplateHead/Middle/Tail/NoSubstitution/JsxText` and optionally run them through `TEST_PATH`.

### Pitfall 3: order of the prose rule
Apply it last and only to `live` results; otherwise `<option>`-in-template, `check` and `test` classifications regress (existing fixture fails).

### Pitfall 4: unbounded recursion fan-out
**What goes wrong:** helper parameters and constructor callers multiply. Unmemoized depth-8 tracing on `nbonamy/multi-llm-ts` took median 3,319, p90 22,046 and over 100,000 steps per request; with per-request memoization median 230, p90 406, max 1,483 (identical results on all fixtures). Self-referencing assignments are real: langchainjs `dalle.ts` has `this.model = fields?.model ?? fields?.modelName ?? this.model;`. **Avoid:** memoize declarations per request, cap work (suggest 2,000 steps, depth 10), de-duplicate sites by literal node. Partial results are safe: found literals are real, and unrecorded passes only make the shared check stricter. [VERIFIED: scratch runs]

### Pitfall 5: parameters inside a followed call
A function that returns its parameter must use that call's argument, not every caller's, or `pick('o1-mini')` used for a tokenizer would be edited as a model. Drop the function's own pass from argument-sourced terminals.

### Pitfall 6: type-position uses and `extends`
`usesOf` counts `typeof MODELS` and type references. Skip identifiers inside type nodes in the D-09 check and in caller discovery, but keep heritage `extends X` as a value use. Without this every `as const` model object that has a derived type stops.

### Pitfall 7: default exports are invisible to `usesOf`
Default-exported classes and functions have symbol name `default`; the index looks for identifiers named `default`. Callers imported as `import G from './x'` are never found. Pre-existing; surface it in tests and docs.

### Pitfall 8: parameter properties already half-work
`constructor(private model = 'gpt-4')` is replaced today only because the helper-parameter branch accepts any `Parameter`. After the rewrite keep a test for it so the accidental behavior becomes deliberate.

### Pitfall 9: stop propagation order for parameters
At `model-retirements.ts:517-528` the stop is applied to `sites` collected so far, so the result depends on file order. Verified on unmodified code with `ask(messages, model = 'gpt-4')`, a by-value use `export const handlers = [ask]` and a caller `ask([], 'o1-mini')`: when the by-value file sorts first (`src/a.ts` before `src/b.ts`) the default stops but the caller literal is still replaced; when it sorts last (`src/c.ts`) both stop. Apply the stop to every terminal of the parameter after the loop (the prototype does) so the output no longer depends on file names, and add the fixture. This is a small behavior change (fewer replacements in the first case); say so in the plan.

### Pitfall 10: output order in tests
Replacement and stop arrays follow request-discovery order (SDK tracers, then raw HTTP in file order). New tests should sort the mapped strings.

### Pitfall 11: malformed-tsconfig gate hides requests (see Open Question 1)
`createSourceImportResolver` marks files under a `tsconfig` with an unreadable `extends` (npm package), unavailable project references, `rootDirs`, `moduleSuffixes`, `noResolve` or invalid `paths` as unverified; `sdkConstructors` then refuses to treat `import … from 'openai'` as the SDK (`sdk-constructors.ts:13`, `source-imports.ts:169-176`). `proposeModelReplacements` ignores `sourceWarnings`, so such packages produce no requests and no stop. Measured effect on the 50 repositories is small (requests appear in 2 of 10 affected repositories when the gate is relaxed), but it hits CONTEXT's first example.

## Code Examples

Verified patterns from the scratch prototype (6 candidate tracing tests, 3 candidate exposure tests, and the existing deadlines/model-fixes tests pass; typechecks under the repo's `strict`, `noUnusedLocals`, `verbatimModuleSyntax`). Full prototype: `/private/tmp/claude-501/-Users-otabekalimov--claude-spares-spare-cBtksf/3e1d2e06-9f40-40aa-ba1a-03af6ecbc927/scratchpad/prototype-for-planner/` (diffs against the current files plus the two candidate test files; session-local, drop the `DIAG`, `OFF`, `PROSE_GUARD` and `RELAX_ALIAS` env switches).

### Resolver core (condensed)

```ts
interface Pass { symbol: ts.Symbol; node: ts.Node; kind: 'constant' | 'enum member' | 'field' | 'function'; name: string; at: string }
interface Terminal { node: ts.Expression; passes: Pass[]; stop?: string }
interface Trace {
  depth: number; budget: { left: number }; memo: Map<ts.Node, Terminal[]>;
  passes: Pass[]; calls: Map<ts.Node, ts.CallExpression | ts.NewExpression>;
}

function valuesOf(program: SourceProgram, expression: ts.Expression, trace: Trace): Terminal[] {
  if (trace.depth > MAX_DEPTH || (trace.budget.left -= 1) < 0) return [];
  const value = unwrap(expression), next = { ...trace, depth: trace.depth + 1 };
  if (ts.isStringLiteralLike(value) || ts.isObjectLiteralExpression(value)) return [{ node: value, passes: trace.passes }];
  if (ts.isConditionalExpression(value)) return [...valuesOf(program, value.whenTrue, next), ...valuesOf(program, value.whenFalse, next)];
  if (ts.isBinaryExpression(value) && [QuestionQuestionToken, BarBarToken].includes(value.operatorToken.kind))
    return [...valuesOf(program, value.left, next), ...valuesOf(program, value.right, next)];
  if (ts.isAwaitExpression(value)) return valuesOf(program, value.expression, next);
  if (ts.isCallExpression(value)) return callValues(program, value, next);          // returns, Object.freeze(x)
  if (ts.isPropertyAccessExpression(value)) return propertyValues(program, value, next);
  if (ts.isIdentifier(value)) return identifierValues(program, value, next);        // const, enum member, parameter, binding
  return [];
}

// field: initializer + constructor parameter property + JS `this.x =` declarations + every `x.name = value`
function fieldValues(program, name: ts.MemberName, symbol: ts.Symbol, trace: Trace) {
  const first = symbol.valueDeclaration!;
  const pass: Pass = { symbol, node: name, kind: 'field', name: name.text, at: location(program, first) };
  return expanded(trace, first, [pass], (inner) => { /* declarations, then program.assignmentsOf(symbol) */ });
}
```

### Decision-time shared check (D-09)

```ts
const reached = new Set<ts.Node>();                       // filled in the first pass over all non-test requests
// second pass, where site.stop is evaluated today:
const shared = decision.passes.find((pass) => {
  const uses = program.usesOf(pass.symbol).filter((use) => !inType(use));
  return !uses.includes(pass.node as ts.MemberName) || uses.some((use) => !reached.has(use));
});
```

### Index of assignments (extends `usesOf`'s lazy builder)

```ts
function assignmentOf(node: ts.MemberName) {   // `x.name = value`
  const parent = node.parent;
  return ts.isPropertyAccessExpression(parent) && parent.name === node &&
    ts.isBinaryExpression(parent.parent) && parent.parent.left === parent &&
    parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken ? parent.parent : undefined;
}
// in the per-name visit: accept ts.isPrivateIdentifier(node); if assignmentOf(node) -> writes map, else the old uses path
```

### Test shapes and expected results (all verified on the prototype)

| Success criterion | Fixture (file contents abbreviated) | Expected |
|-------------------|-------------------------------------|----------|
| 1, 5 (EXPO-01/03) | `{ 'gpt-4': { model: 'gpt-4' } satisfies Model }`, `as const`, `( … )`, `<Model>{ … }` | `catalog` |
| 1 | `{ name: 'gpt-4' }`, `openAIModelRef({ name })`, `{ id, displayName }`, `{ versions: ['gpt-4'] }`, `createClaudeModelConfig({ id })` | `catalog` |
| 1 | `{ model }`, `{ modelName }`, `{ modelId }`, `{ version }`, `{ default }`, `versions: 'gpt-4'` | `live` |
| 5 | `'Image model to use (e.g. "dall-e-3")'`, `` `Model "gpt-4" only…` ``, `` `…"gpt-4-0613" failed for ${user}` `` | `comment` |
| 5 (guard) | `'{"model":"gpt-4","messages":[]}'`, `` `{ "model": "gpt-4-0613", "stream": ${s} }` `` | `live` |
| 3 (TRAC-01) | field initializer; `constructor(private model = 'o1-mini')` + `new B('gpt-4')`; `this.model = opts.model ?? 'gpt-4'` + `new C({ model: 'o1-mini' })`; JS `this.model = opts.model \|\| "gpt-4"` + `reset() { this.model = "o1-mini" }`; `#model` | replacements at the literal lines, caller literals separately |
| 3 (TRAC-03) | `MODELS = { GPT4, FAST } as const`, `config = { model }` read by three requests | three fixes, no stops |
| 3 (TRAC-04) | helper default plus callers (existing test), method `run(model = 'gpt-4')` + `this.run('o1-mini')` | each caller site reported |
| 5 (TRAC-06) | `process.env.MODEL ?? 'gpt-4'` const; ternary const; `getModel()`; `this.getDefaultModel()`; `function run({ model = 'gpt-4' })`; `const { model = 'gpt-4' } = opts`; `opts.model ?? 'o1-mini'` + `run({ model: 'gpt-4' })`; `this.options.model` | fixes |
| D-09 | const used by two traced requests | fix |
| D-09 | const also in `console.log(MODEL)`; field also compared elsewhere; `MODELS` also in `Object.values(MODELS)`; two requests, one with `temperature` | stops (existing sentence; field uses "field model") |
| 5 (TRAC-07) | `images.generate`, `audio.speech.create`, `audio.transcriptions.create`, `embeddings.create`, `completions.create`, Anthropic `completions.create`, raw `/v1/images/generations`, `/v1/embeddings`, `post /v1/complete` | stops, no edits; multipart `formData` body: nothing |
| unknowable | class that is extended or passed by value; `let model`; function returning a nested function; `MODELS[k]` | stop (class) or silent |
| call context | `pick('gpt-4')` in a request and `encodingForModel(pick('o1-mini'))` elsewhere | the request's literal is fixed, the other is untouched |

## Real-world validation (answers Q7)

Method: 50 repositories under `scratchpad/repos` (files only; the TypeScript parser read them, nothing was run inside them). Baseline and prototype `scanDeadlines` and `proposeModelReplacements` ran as separate processes per repository; the survey ran `analyzeRepository` for both adapters. The baseline scan reproduces all 842 listed silent lines as `live` (842/842). Evidence is capped at 20 live lines per deadline, so "pairs left exposed" counts are exact but line counts are lower bounds. [VERIFIED: scratch runs 2026-10-21]

### Evidence lines (842)

| Step | Lines no longer live | Cumulative |
|------|----------------------|------------|
| D-01 alone | 382 | |
| D-02 alone | 502 (covers every D-01 line on this sample) | |
| D-03 alone, guarded | 9 (8 + 1 beyond the cap) | |
| D-01 + D-02 + D-03 | 511 (61%) | 331 still live |
| Tracing prototype (D-06..D-09, D-11) on those 331 | +2 traced (both `images.generate` stops: happyvertical `packages/ai/src/shared/providers/openai.ts:723`, graphai `llm_agents/openai_agent/src/openai_image_agent.ts:41`) | 329 untraced |

### Repository-provider pairs (59)

| Outcome | Pairs | Which |
|---------|-------|-------|
| Non-exposed after D-01..D-03 | 10 | base-context (OpenAI, Anthropic), scramjet, dreb, lunR, omk, fleetagent/pi, hoocode-ts, multi-llm-ts, n8n-nodes-openai-langfuse (D-03). Per rule alone: D-01 2, D-02 9, D-03 1 |
| Newly traced (D-11 stop) | 2 | happyvertical/sdk, receptron/graphai (OpenAI) |
| No SDK import (wrapper, raw HTTP or other) | 3 | grafana/agento11y (Anthropic), mcp-evals, natureco-cli |
| No calls recognized, and the analyzer reports an unverified `tsconfig` | 12 (10 repositories) | TanStack/ai (Anthropic), genkit (both), langchainjs (both), promptfoo (Anthropic), micdrop, core-ai, livekit, moxxy, nlux, nuxt-chatgpt. With the gate relaxed (scratch switch), requests appear only in langchainjs (8, one retiring `dall-e-3` stop) and nuxt-chatgpt (4, none retiring); the other 8 stay empty for other reasons |
| SDK imported, no client or call recognized | 15 | oracle (`instance = new OpenAI(…)` assigned in an if/else, not a `const` initializer), talon (`return new OpenAI(…)` from a factory), openfn/adaptors (assigns a module-level `client`), ensemble, ezcoder, callLLM, AIGNE, visual-reasoning, senpi (both), Sayknow (both), promptbook (Anthropic), azure-foundry plugin, enterprise |
| Calls recognized, no retiring model reaches a request | 17 | promptfoo (`...modelsWithCost(['gpt-4'], {…})` x 102 lines), oneringai (library `Model`/`ImageModel` constants), canonry, TanStack/ai (OpenAI), calliope-cli, nexus-cortex, genkit-plugins, mnemora, llm-api, kiso, mcp-rubber-duck, others |

### The 331 remaining live lines by literal shape x discovery state (340 matches)

| Shape | no SDK import | no calls + unverified tsconfig | imported, no calls | calls recognized | total |
|-------|---|---|---|---|---|
| catalog built by a call, `...modelsWithCost(['x'], {…})` (promptfoo; D-04/out of scope) | 0 | 8 | 0 | 84 | 92 |
| `model:` property of an object or call argument | 4 | 3 | 15 | 29 | 51 |
| object member (`GPT_5_4_NANO: 'gpt-5.4-nano'`, `Model.DALL_E_3`) | 1 | 5 | 5 | 40 | 51 |
| `const NAME = 'x'` | 0 | 15 | 7 | 19 | 41 |
| wrapper call (`anthropic.model('…')`, `openAI.model('…')`, `models.getModel(…)`) | 1 | 25 | 1 | 1 | 28 |
| fallback `x ?? 'y'` / `x \|\| 'y'` | 0 | 6 | 4 | 11 | 21 |
| small array (<3 models) | 3 | 2 | 7 | 9 | 21 |
| return / class field / other | 4 | 11 | 12 | 8 | 35 |
| **total** | **13** | **75** | **51** | **201** | **340** |

CONTEXT's labelled shapes behave as follows: `private model = "dall-e-3"` (langchainjs) is traced only if the alias gate is relaxed (relaxing it for model tracing on all 10 gated repositories reveals requests in two and exactly 1 more stop: `dalle.ts`); `this.model = opts.model ?? 'whisper-1'` (moxxy) and `this.defaultModel = options.defaultModel ?? 'tts-1'` (happyvertical speech adapter) sit in gated or non-SDK code; `return "gpt-5.1-codex"` (oracle) is in a CLI option resolver, not a request; `GPT_5_4_NANO` and `DALL_E_3` are library constant tables; `model: params.model || "dall-e-3"` (graphai) is traced as a stop; `formData.append('model','whisper-1')` stays out of scope.

### Request-shape census (130 non-test requests discovered in 49 repositories; senpi crashed at baseline)

106 OpenAI + 24 Anthropic requests (requests in test paths are skipped before they are counted, which is why promptfoo, anvia and openai-partial-stream show none). 86 (66%) have a `model` expression, of which 59 resolve to at least one literal and 16 reach a retiring model. 32 (25%) pass a request object that is not a literal or a `const` literal (29 identifiers: `let params = buildParams(...)`, parameters; 3 builder-call results) and 12 (9%) have no `model` property. Following request objects through consts and builder-function returns with `valuesOf` is a natural extension: in 5 sampled repositories (scramjet, canonry, calliope-cli, oneringai, multi-llm-ts) 11 of the 21 such requests resolve to an object literal with a `model` property, and 2 of those repositories (calliope-cli, multi-llm-ts) then reach registry models (some only through test-only callers, which the decision step discards). It is outside D-06..D-12; see Open Question 5.

### Performance

`analyzeRepository` dominates `proposeModelReplacements` (OpenAI adapter on TanStack/ai: 63 s while other jobs ran; Anthropic adapter 18 s; happy 18-20 s each). The prototype tracing adds about 0% (total over 49 repositories 1,130 s vs 1,135 s baseline). In the 2026-10-20 results 9 of 45 silent OpenAI pairs and 8 of 14 silent Anthropic pairs had `error: "timed out after 120 s"` on the proposal step, so their silence was not a tracing result. Re-run without a timeout, the current code finishes 49 of 50 repositories (TanStack/ai 126 s, Sayknow 124 s) and `code-yeongyu/senpi` aborts out of memory (exit 134, 87 s); none of the previously timed-out pairs produces a result when allowed to finish. [VERIFIED: `docs/benchmarks/2026-10-20-*-results.json` `error` fields; scratch runs]

## Test strategy (answers Q6)

- **Helpers.** `model-retirements.test.ts`: `repository(files)` (lines 20-35) writes `package.json` declaring `openai` and `@anthropic-ai/sdk`, `entry()`/`registry` (lines 37-88) and `NOW`; call `proposeModelReplacements(root, registry, NOW)` and assert on `replacements`, `stops`, `patch`; apply the patch with `git init` + `git apply` as the existing tests do. `deadlines.test.ts`: `repository(files)` (lines 80-91), `entry()`, `registry`, `classifying` (lines 241-247) and `uses(files)` (lines 249-256) which returns `'file:line version' -> use`. Add model IDs the fixtures need to `classifying` (for example `dall-e-3`, a Claude ID) or use a local registry.
- **No separate Validation Architecture section:** `workflow.nyquist_validation` is `false` in `.planning/config.json`, and the tests above are the validation. [VERIFIED: config read this session]
- **One test per shape**, grouped by requirement as in the table above. Sort mapped arrays to avoid order coupling. Keep the existing assertions of the old messages (`MODEL`, `LABEL_MODEL`, `request`, `ask`) byte-identical; they pass on the prototype.
- **Speed.** `npm test`: 17.7 s Vitest duration, 18.05 s wall on this 14-core machine; 105 files passed, 8 skipped; 1,581 tests passed, 79 skipped. `deadlines.test.ts` (17 tests) and `model-retirements.test.ts` (7) run in under a second each. `npm run typecheck` 0.7 s incremental; `npm run format:check` 2.5 s. [VERIFIED: baseline run]
- **Gated suites** skip unless an environment variable is set: `REFIT_DOCKER_IMAGE`, `REFIT_NPM_PREPARE`, `REFIT_STRIPE_SDK`, `REFIT_OPENAI_SDK`, `REFIT_OASDIFF`, `REFIT_BILLING_REPOSITORY` (20 files carry gated tests). The only gated suite on this code path is `model-fixes-docker.test.ts`; it passes at baseline with `REFIT_DOCKER_IMAGE=node:22-alpine npx vitest run pipeline/model-fixes-docker.test.ts` (1 test; Docker daemon and the image are present here). Report it separately from the default count.
- **Smoke check on the fetched repositories** (informative, Claude's discretion): `node bin/refit.mjs deadlines --repository <dir> --json` and `--propose-model-fixes`, with the repository path passed as an argument and the working directory kept at the Refit checkout. Expected from this research: 10 of the 59 pairs have no live evidence left; 2 further OpenAI pairs gain a stop; replacements and stops elsewhere unchanged. Do not run package scripts inside those directories.

## Risks and guards (answers Q8)

| Risk | Could hide a pin or edit wrongly | Guard |
|------|-------------------------------------|-------|
| D-02 treats a request-bearing `id`/`name` as catalog | Hides a live pin from the scan | Tracer is independent: test `MODEL.id` is replaced; descriptor keys are the published list only; `value`, `model*`, `version` stay live |
| D-03 hides JSON, config or generated text | Hides a pin (kiso) | Apply last, live-only, `"model":` guard; tests for `'{"model":"gpt-4"}'` and a template body |
| D-03 order | Regresses `<option>`, test, check classes | Existing `deadlines.test.ts` stays green; prose only upgrades `live` to `comment` |
| D-06 field read elsewhere | Wrong edit | D-09 check; tests for extra read, comparison, subclass assignment |
| Field read by destructuring or spread of the instance (`const { model } = this`, `{ ...this }`, `JSON.stringify(this)`) | Wrong edit, not detectable from named reads | Known limit; document it; optionally add a stop for object spread of `this` in the class |
| D-07 owner object iterated or destructured | Wrong edit | Bare uses of the owner are unreached uses, so they stop |
| D-08 returned parameters | Edits a literal that feeds something else | Call-context arguments only; test `pick('gpt-4')` vs `encodingForModel(pick('o1-mini'))` |
| D-08 broad `X.prop` reach | Over-approximation | Every edit is a literal at a call site that flows into the parameter; keep tests for `model.id`-style reads |
| Helper or class passed by value or extended | Unknown callers | Stop with the existing sentences (nouns `helper`, `method`, `class`) |
| Exponential recursion on adversarial repositories | Denial of service | Per-request memoization, work budget, depth limit |
| D-09 global `reached` set | A use reached by a blocked request | Decisions merge request reasons; tested with `temperature` |
| Request in a test file shares a constant | Edit changes test behavior | Test requests record no passes, so the constant stops (matches today) |
| D-11 stops turn `no-change` into `needs-review` | Status text changes in service state | Documented; no notification is sent on this status [VERIFIED: `local-service.ts:350-420`] |
| Existing tests asserting embeddings are ignored | Test failures | Update the two expectations (`model-retirements.test.ts:182`, `:371`) |

## State of the Art

| Old approach | Current approach | When changed | Impact |
|--------------|------------------|--------------|--------|
| Anthropic Text Completions (`POST /v1/complete`, `client.completions.create`) | Messages API | Deprecated; docs say future models will not be compatible [CITED: platform.claude.com completions page] | Retiring models here stop with a named reason, never an edit |
| Sampling parameters accepted on all models | Anthropic rejects non-default `temperature`/`top_p`/`top_k` on models after Opus 4.6 [CITED: same page] | Existing rule (`SENSITIVE_PARAMETERS`, `rejectsSampling`) | Phase 2, not this phase |

The repository intentionally uses the compiler API from `typescript-compiler` (5.9.3) while `tsc -b` runs the native TypeScript 7; do not switch imports to `typescript`.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The discuss-phase decisions D-06..D-09 count as the "new decision" that AGENTS.md requires before widening which uses are replaced, and the user is the owner for AGENTS.md purposes | Project Constraints | Plan ships a widened rule without the record; needs owner confirmation and an AGENTS.md entry |
| A2 | `value` is not a descriptor key and two-entry option arrays may stay live | D-02 | Two promptfoo option rows stay silent |
| A3 | The `"model":` guard on D-03 is acceptable though it narrows D-03's literal wording | D-03 | If rejected, kiso's JSON config pin is hidden (1 pair on the sample) |
| A4 | Work budget 2,000 and depth 10 are adequate | Pitfall 4 | Measured on one pathological repository (memoized max 1,483 steps); too low a cap silently drops sites |
| A5 | Yield figures from 50 npm-sourced, library-heavy repositories predict little about application repositories | Real-world validation | Phase 3/4 application sets could behave very differently |
| A6 | The Docker daemon stays available for the gated run | Test strategy | Gated verification skipped; report as such |

## Open Questions (RESOLVED)

1. **Request discovery is off under an unverified `tsconfig`; should model tracing relax it?** **RESOLVED: D-13 (gate unchanged; blocked pins count as untraced) in 01-CONTEXT.md.**
   - What we know: the CONTEXT's first example (langchainjs `private model = "dall-e-3"`) sits under a `tsconfig` that extends an npm package; `source-configurations.ts:154-167` marks it unverified and `sdk-constructors.ts:13` then ignores the SDK import. `proposeModelReplacements` discards `sourceWarnings`, so the result is silence, not a stop. 12 of 59 pairs (10 repositories) have no recognized calls and an unverified-`tsconfig` warning, but relaxing the gate for the tracer reveals requests in only two of those repositories (langchainjs, nuxt-chatgpt) and one more stop (`dalle.ts`). Heuristic caveat: the warning can come from an unrelated package's `tsconfig`, so "gated" is an upper bound.
   - What's unclear: whether the owner will accept an import being treated as the official SDK when alias resolution cannot be verified (AGENTS.md forbids relaxing a stop without a decision).
   - Recommendation: do not change the gate in Phase 1; ask the owner before Phase 4; until then Phase 4 must list gate-blocked pins as untraced with that reason. Do not emit stops for them, because a stop that names no request would count as "traced" under D-12.
2. **Record D-09 and the new traced shapes in AGENTS.md.** Add a dated bullet next to the #120 decision and update the `.planning/PROJECT.md` Key Decisions row; confirm with the owner (A1). **RESOLVED: D-14 in 01-CONTEXT.md.**
3. **`value` as a descriptor key / UI option arrays** (2 promptfoo lines): leave as is, or add `value` only when the same object has `label`. **RESOLVED: D-15 (no) in 01-CONTEXT.md.**
4. **D-11 breadth.** Add the OpenAI v3 request-object methods (`createCompletion`, `createEmbedding`, `createEdit`, `createModeration`) and/or a catch-all stop for any traced call outside `MODEL_CALLS` whose request has `model`. **RESOLVED: D-16 (catch-all stop) in 01-CONTEXT.md.**
5. **Request objects built elsewhere** (25% of discovered requests, for example `let params = buildParams(...)`): out of D-06..D-12; D-10 says "does not rewrite". Decide whether a follow-up belongs in this phase or Phase 4's untraced list. **RESOLVED: D-19 (Phase 4 measures; decimal phase if short) in 01-CONTEXT.md.**
6. **Client shapes the analyzer does not recognize** (`let client = new OpenAI()`, factories returning the client, typed-parameter clients, DI): 15 pairs. Same question as 5. **RESOLVED: D-19 in 01-CONTEXT.md.**
7. **Benchmark timeouts.** `SCAN_TIMEOUT_MS = 120_000` (script line 13) is exceeded by the analyzer alone on a few repositories. Phase 4 should record "timed out" and "crashed" as their own buckets and consider a longer timeout. **RESOLVED: D-19 (Phase 4) in 01-CONTEXT.md.**
8. **Default-exported classes and functions** (Pitfall 7): fix or document. **RESOLVED: D-17 (fix with regression test) in 01-CONTEXT.md.**

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | everything | yes | v24.14.0 | CI also runs 22 |
| npm, tsx, vitest, prettier | tests, formatting | yes | see Standard Stack | none |
| git | patch-apply tests | yes | system | none |
| Docker + `node:22-alpine` | gated `model-fixes-docker` run | yes (image listed) | client 29.8.2 | skip and report as skipped |
| `gh` | only to refresh spec evidence while researching | yes | 2.100.0 | not needed to execute |

No missing dependency blocks execution. Phase 1 needs no network access.

## Security Domain

`security_enforcement` is enabled (ASVS level 1, block on `high`). [VERIFIED: `.planning/config.json`]

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input validation | yes | Repository files are untrusted; parse only (TypeScript parser), existing read limits in `readRepository` (10,000 files, 2 MiB per file, 50 MiB total [VERIFIED: `repository.ts:30-32`]); bound tracing work (memo, budget, depth) |
| V12 Files and resources | yes | Read files only; never `require`, `eval` or run scripts from fetched repositories; pass paths as arguments |
| V2/V3/V4/V6 | no | No authentication, sessions, access control or cryptography in this phase |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Adversarial code makes the resolver explode | Denial of service | Memoization, work budget, depth limit (Pitfall 4) |
| Crafted flow makes Refit edit an unrelated literal | Tampering | Only literals proven to flow into a traced `model`; D-09 use check; deterministic rule; validation in offline Docker; human-reviewed draft PR |
| Repository identifiers in stop reasons rendered into a Markdown PR body (`model-fixes.ts:119-122` inserts `item.reason` unescaped) | Tampering / spoofing | New reasons embed field, constant and function names; the CLI already passes through `terminalText`. Low severity (identifier characters are limited) but consider wrapping names in backticks when touching the sentences |
| A script or test reads an untrusted checkout and executes it | Elevation | Keep verification scripts outside the checkout; no install, no run |

## Sources

### Primary (HIGH confidence, read this session)
- `pipeline/deadline-exposure.ts`, `pipeline/model-retirements.ts`, `pipeline/deadlines.test.ts`, `pipeline/model-retirements.test.ts`, `pipeline/analyzer.ts` (lines 150-330, 675-704, 1777-1822), `pipeline/providers.ts` (lines 78-120), `pipeline/sdk-constructors.ts`, `pipeline/source-imports.ts`, `pipeline/source-configurations.ts`, `pipeline/repository.ts`, `pipeline/deadlines-cli.ts`, `pipeline/model-fixes.ts`, `pipeline/local-service.ts` (350-420), `scripts/ai-model-benchmark.mjs`, `docs/DEADLINES.md`, `examples/openai.provider.json`, `examples/anthropic.provider.json`, `AGENTS.md`, `.planning/*`, `vite.config.ts`, `tsconfig.json`, `package.json`
- Scratch experiments and measurements under `/private/tmp/claude-501/-Users-otabekalimov--claude-spares-spare-cBtksf/3e1d2e06-9f40-40aa-ba1a-03af6ecbc927/scratchpad/exp/` (survey, baseline and prototype runs, shape tests); prototype and candidate tests under `scratchpad/prototype-for-planner/`
- `openai/openai-openapi` `openapi.yaml` (info.version 2.3.0), fetched with `gh api`: paths and request content types listed in D-11
- https://platform.claude.com/docs/en/api/completions/create: `POST /v1/complete`, deprecated legacy Text Completions
- github.com/anthropics/anthropic-sdk-typescript `src/resources/completions.ts` (class `Completions`, method `create`); github.com/openai/openai-node `src/resources` listing (audio, images, embeddings, moderations, completions, videos, realtime…)

### Secondary (MEDIUM)
- `docs/benchmarks/2026-10-20-openai-results.json`, `…-anthropic-results.json` (summary keys, timeout errors)

### Tertiary (LOW / not available)
- https://platform.openai.com/docs/api-reference returned HTTP 403 and developers.openai.com reference pages returned 404; the OpenAPI document above replaced them

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH, no new dependency; versions read from `node_modules`.
- Architecture: HIGH, prototype runs and candidate tests (fail on current code, pass on prototype), existing suites green except the two D-11-intended changes.
- Pitfalls: HIGH for 1-10 (reproduced); MEDIUM for 11 and for the yield numbers (one sample).

**Research date:** 2026-10-21
**Valid until:** 2026-11-20 for code-level findings (the two source files change often; re-check line numbers before editing); the registry-dependent counts change whenever `data/deadlines.json` changes.
