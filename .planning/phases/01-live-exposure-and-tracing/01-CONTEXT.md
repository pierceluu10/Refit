# Phase 1: Live exposure and tracing - Context

**Gathered:** 2026-10-21
**Status:** Ready for planning

<domain>
## Phase Boundary

The deadline scan (`pipeline/deadline-exposure.ts`) stops counting model catalogs and prose as live exposure, and the model-replacement tracer (`pipeline/model-retirements.ts`) follows the indirect model sources real code uses, so a retiring OpenAI or Anthropic model ID that reaches a request is either replaced or stopped with a named reason, never left silent. Wrapper libraries (Vercel AI SDK, LangChain, Genkit) and the parameter-stop table (Phase 2) are outside this phase.

Evidence base: the 2026-10-20 npm-set runs left 45 OpenAI and 14 Anthropic exposed repositories silent (no replacement, no stop). Their 842 evidence lines were read at the frozen commits on 2026-10-21 (scratchpad, not committed). They fall into the groups below.

</domain>

<decisions>
## Implementation Decisions

### Catalog and prose classification (deadline-exposure.ts)
- **D-01:** Fix the model-keyed map rule so `"gpt-5.1-codex-mini": { id: "gpt-5.1-codex-mini", … } satisfies Model<…>` is a catalog: unwrap `satisfies`, `as`, parentheses and type assertions before testing for the object literal under a model-named key. This one bug covers the pi-derived model registries (BaseModelAI/base-context, LeanAndMean/scramjet, kolisachint/hoocode-ts, dmae97/omk, fleetagent/pi, ashx-j/lunR), hundreds of lines.
- **D-02:** A model ID that is the value of a descriptor key, `id`, `name`, `displayName`, `label`, `title` or `slug`, or an element of a `versions: [...]` array, is a catalog entry. These keys name a model; requests to OpenAI and Anthropic select one with `model`. Examples: TanStack/ai `const CODEX_MINI_LATEST = { name: 'codex-mini-latest', context_window, pricing… }`, genkit `openAIModelRef({ name: 'gpt-4.5-preview', info })`, `versions: ['gpt-4.5-preview']`, nexus-cortex `createClaudeModelConfig({ id: 'claude-3-5-sonnet-20241022', displayName, … })`. `model`, `modelName`, `modelId`, `version` (singular) and `default` stay live, because wrappers send them.
- **D-03:** For model providers (OpenAI, Anthropic) only, a model ID quoted inside a longer string literal, whose text is not exactly the model, is classified as `comment` (prose): descriptions such as `'Image model to use (e.g. "dall-e-3")'`, error messages, embedded markdown. Meta and Shopify URL and version matches inside strings are unchanged.
- **D-04:** Plain arrays keep the owner's `CATALOG_SIZE = 3` heuristic. Two-element lists such as promptfoo's `ANTHROPIC_COMPLETION_MODELS` stay live; do not change it in this phase.
- **D-05:** (EXPO-02) The 2026-10-20 results keys stay as they are. Benchmark results add per-repository non-live counts by use, plus a summary count of repositories that only mention a deadline model outside live code, so old and new totals can be compared side by side.

### Tracing (model-retirements.ts `modelSites` and request discovery)
- **D-06:** (TRAC-01) `model: this.<field>` resolves through the class: the property declaration's initializer, every `this.<field> = <expr>` assignment in the class, and constructor parameter properties. Each right-hand side is followed with the same recursion: fallbacks, parameters and so on. Constructor parameters are followed to `new <Class>(…)` callers, the way helper parameters are followed to call sites today.
- **D-07:** (TRAC-03) A property of a `const` object literal, with or without `as const` (`MODELS.GPT4`, `config.model`), resolves to its initializer, with the same single-use rule and stop message as constants.
- **D-08:** (TRAC-06) A `const` initializer that is not a plain literal is followed recursively: env fallbacks `process.env.X ?? 'gpt-4'` and `||`, and conditionals (both branches). A function or method called as the model (`getModel()`, `this.getDefaultModel()`) resolves through its `return` statements; nested functions are not followed. Destructuring defaults (`const { model = 'gpt-4' } = opts`, `function f({ model = 'gpt-4' })`) resolve to the default, and for parameters to callers' object-literal `model` property. Options-object parameters (`opts.model` where `opts` is a parameter) also resolve to callers' object-literal property.
- **D-09:** A constant, member, field or helper used more than once stays editable when every one of its uses is a site this proposal reaches from a traced request and every such request allows the edit. Today it stops whenever the use count is not 1. Otherwise it stops with the existing "used N times; change it by hand" reason. This is a precision improvement, not a relaxed safety gate: every use is checked. It is recorded in PROJECT.md Key Decisions.
- **D-10:** (TRAC-02, TRAC-04, TRAC-05) Cross-module constants, enum members, helper parameters with callers, and raw `fetch`, `axios.post` and `UrlFetchApp` requests already exist. This phase adds tests for each shape the success criteria name and fixes any gap a test exposes; it does not rewrite them.

### Non-text model calls (TRAC-07)
- **D-11:** Trace OpenAI `images.generate`, `images.edit`, `images.createVariation`, `audio.speech.create`, `audio.transcriptions.create`, `audio.translations.create`, `embeddings.create`, `moderations.create` and legacy `completions.create`, plus Anthropic legacy `completions.create`. A retiring model there always stops with a named reason, for example "`images.generate` is not a text-generation call; gpt-image-2 may change formats or parameters; change it by hand." These calls are never edited automatically, which keeps the existing rationale in `MODEL_CALLS`. Raw HTTP to the matching official endpoints (`/v1/images/…`, `/v1/audio/…`, `/v1/embeddings`, `/v1/moderations`, `/v1/completions`) stops the same way when the body is JSON.

### Definition used for measurement
- **D-12:** A labelled live pin is "traced" when its file and line appear as a replacement's `edited` location or a stop's `at` location in `refit deadlines --propose-model-fixes --json`. Phase 4 measures BENCH-04 with this definition. Stops count as traced; only fixes count toward BENCH-05.

### Resolutions after research (2026-10-21)
- **D-13:** The tsconfig alias gate is unchanged in Phase 1. Pins it blocks count as untraced and are reported as such.
- **D-14:** D-06..D-09 widen which uses are traced and replaced. Record this in AGENTS.md as a dated decision (2026-10-21, made by Otabek Alimov, pending the repository owner's review on the phase PR) next to the #120 model-fixes note, and in PROJECT.md Key Decisions.
- **D-15:** `value` is not a descriptor key. Picker `{ value, label }` objects stay as today.
- **D-16:** (D-11 breadth) every traced OpenAI or Anthropic SDK call outside `MODEL_CALLS` that sends a retiring model stops with a named reason (catch-all). Do not list only certain non-text methods. The Anthropic legacy raw endpoint is `POST /v1/complete`.
- **D-17:** Default-exported classes and functions get their callers followed (bug fix). Stop propagation for by-value helper uses must not depend on file order (bug fix). Both get a regression test.
- **D-18:** D-03's prose rule keeps a string that contains a `"model":` JSON key as live, so config embedded in JSON strings is not hidden.
- **D-20:** (amends D-03, 2026-10-21, Otabek Alimov) only a plain string literal or no-substitution template whose text is longer than the model ID counts as prose (`comment`). Template pieces with substitutions, `+` concatenation operands and JSX text stay live, because they may build the value that is sent. The classifier only reclassifies matches the scan already found; it never adds one. Error messages built from templates therefore stay live, which is the conservative choice.
- **D-19:** Request objects built by functions, unrecognized client shapes (`let client`, factories, typed parameters, DI) and benchmark timeouts are not in Phase 1. Phase 4 measures them on the application sets. If BENCH-04 falls short, a decimal phase is inserted for the largest measured gap.

### Claude's Discretion
- Exact helper names, recursion depth limits (current `depth > 4`) and how to share the uses-count logic.
- Whether to re-run `refit deadlines` on the already-fetched silent repositories as a smoke check during verification. That check is informative only; Phase 4 is the measurement.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `pipeline/deadline-exposure.ts` `literalUse()` / `isLiteralStructure()` / `propertyKey()` / `countModels()`: the classification rules to extend (D-01..D-04).
- `pipeline/model-retirements.ts` `sourceProgram()` (TypeScript program with `symbolOf`, `usesOf`, cross-file import resolution), `modelSites()` (const, enum member and parameter-to-caller recursion), `requestObject()`, `rawRequest()`, `RAW_ENDPOINTS`, `MODEL_CALLS`, `TRACERS`.
- `analyzeRepository()` (`pipeline/analyzer.ts`) gives `sdkCalls` (resource.method) and `clientMethodCalls`, with class-field clients already traced.

### Established Patterns
- Tests build throwaway repositories with `mkdtemp` and a `repository({...files})` helper (`pipeline/model-retirements.test.ts`, `pipeline/deadlines.test.ts`), and assert on `proposeModelReplacements` output and `scanDeadlines` uses keyed `'file:line model': 'use'`.
- Stops are `{ deadline, provider, file, line, call, at, model, reason }` with a human sentence that ends naming the replacement.
- Comments explain the why and cite provider pages with dates; code is TypeScript ESM run by tsx/vitest.

### Integration Points
- `refit deadlines --propose-model-fixes` (`pipeline/deadlines-cli.ts`), `refit serve --model-fixes` (`pipeline/model-fixes.ts`): both consume `proposeModelReplacements`. Their output shape must not change.
- `scripts/ai-model-benchmark.mjs` writes the results files (D-05).
- Docs to touch: `docs/DEADLINES.md` (classification and tracing rules).

</code_context>

<specifics>
## Specific Ideas

Real shapes from the 2026-10-20 silent exposures, to mirror in fixtures:
- `private model = "dall-e-3";` / `model = "gpt-3.5-turbo";` class fields (langchainjs)
- `this.model = opts.model ?? 'whisper-1';` (moxxy), `this.defaultModel = options.defaultModel ?? 'tts-1';` (happyvertical)
- `export const CODEX_DEFAULT_MODEL = "gpt-5-codex";`, `default_model: process.env.OPENAI_DEFAULT_MODEL || 'gpt-5.1'`
- `return "gpt-5.1-codex";` in option resolvers (steipete/oracle), `return 'claude-3-5-sonnet-20241022'` (multi-llm-ts)
- `GPT_5_4_NANO: "gpt-5.4-nano"` object members (visual-reasoning), `DALL_E_3: 'dall-e-3'` (oneringai)
- `model: params.model || "dall-e-3"` in image calls (graphai), `formData.append('model', 'whisper-1')`, which stays out of scope (not a JSON body)

</specifics>

<deferred>
## Deferred Ideas

- Wrapper libraries: Vercel AI SDK (`openai('gpt-4o')`, `anthropic(...)`), LangChain (`new ChatOpenAI({ model })`), Genkit. Phase 3 labels record pins that reach the API only through a wrapper with `via: wrapper`, so their volume is measured before any tracer is built.
- `let` variables reassigned at runtime, settings objects, UI state and CLI option defaults (v2 V2-01).
- Lowering `CATALOG_SIZE` or treating `version`/`modelId` as descriptor keys: would need evidence that it hides no live pins.

</deferred>
