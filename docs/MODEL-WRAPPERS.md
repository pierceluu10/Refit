# AI wrapper SDKs: Vercel AI SDK, LangChain JS, LlamaIndex TS (2026-10-22)

Lane FP3. Many AI applications never import `openai` or `@anthropic-ai/sdk`: they call a model through a wrapper SDK. This page records what Refit now detects there, how it was measured, and what it still misses.

Detection is report-only. Nothing here edits a wrapper call, and no provider was contacted: repositories were read at frozen commits, with nothing installed or run.

## What is detected

`pipeline/model-wrappers.ts` (`modelWrapperSites`) maps each wrapper call to the provider, the model string as written, the registry ID it names, and the file and line of both the string and the call.

| Wrapper                            | Calls                                                                                                                                                                                                                                                                                                                                                              | Provider         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| Vercel AI SDK                      | `openai('gpt-4o')`, `openai.chat/.responses/.languageModel(…)`, `anthropic('claude-…')`, `anthropic.messages(…)`, `google('gemini-…')`, and the same on `createOpenAI(…)`, `createAnthropic(…)` and `createGoogleGenerativeAI(…)` instances, including a `let` assigned later. Embeddings, images, transcription and speech methods are found and marked non-text. | From the package |
| Vercel AI SDK gateway and registry | `gateway('openai/gpt-4o')`, `generateText({ model: 'anthropic/claude-…' })` and the other `ai` calls with a `model` option, `registry.languageModel('openai:gpt-4o')`                                                                                                                                                                                              | From the prefix  |
| LangChain JS                       | `new ChatOpenAI({ model })`, `new AzureChatOpenAI`, `new OpenAIEmbeddings`, `new ChatAnthropic({ modelName })`, `new ChatGoogleGenerativeAI`, the legacy `langchain/chat_models/openai` entry points, and `initChatModel('openai:gpt-4o')` or `initChatModel('gpt-4o', { modelProvider })`                                                                         | From the class   |
| LlamaIndex TS                      | `new OpenAI({ model })`, `new Anthropic`, `new Gemini`, `new OpenAIEmbedding` from `llamaindex`, `@llamaindex/openai`, `@llamaindex/anthropic` and `@llamaindex/google`, and the `openai({ model })` and `anthropic({ model })` functions                                                                                                                          | From the class   |

The model value is followed through a string literal, `||`, `??` and conditionals, `const` variables and object members (also imported from another file), a `let` through each assignment, and what a repository function returns. A string reached only through a function's `return` counts only when it is shaped like the call's provider's (`claude-…` for Anthropic, `gemini-…` for Gemini, `gpt-…`, `o3`, `text-embedding-…` and the like for OpenAI), so a shared helper's Bedrock or Grok IDs are not reported as Anthropic models. Imports may be static, `require`, or a destructured `await import('@ai-sdk/…')`; type-only imports do not count.

A provider pointed at another endpoint is a named stop, not a match: an AI SDK factory with `baseURL`, a provider from `@ai-sdk/openai-compatible`, or a LangChain class with `configuration.baseURL`. The stop says so: "… on a provider set to another endpoint by `baseURL` (src/ai.ts:4), such as an OpenAI-compatible host (Groq, Together, Fireworks), so it may not be this provider's model; Refit reports it but does not match or edit it."

### Where it shows up

- `refit deadlines` and the hosted inventory, through `scanDeadlines`. Every wrapper match carries `via` (the call, such as `@ai-sdk/openai openai()`) in its evidence. Gateway and registry IDs (`'openai/gpt-4o'`, `'anthropic:claude-…'`), which the exact-string matcher cannot see, now count as exposure to the bare ID, unless the provider is set to another endpoint.
- `refit deadlines --propose-model-fixes` and `refit serve --model-fixes`, through FG9's report-only hook (`ReportOnlySource` in `pipeline/model-retirements.ts`). A wrapper site is a stop with its call and reason, never an edit: "The model is sent through @ai-sdk/openai openai() (src/ai.ts:3), a Vercel AI SDK call Refit reports but does not edit; change it by hand." Before this, those sites were unresolved ("No file imports `openai`…, so the model may reach the API through another library or a wrapper"), and gateway IDs were not reported at all.

Shared files touched, additively: `pipeline/deadline-exposure.ts` (one block and an optional `via` field) and `pipeline/model-retirements.ts` (the hook entry, plus gateway IDs counted when the rule checks whether a repository quotes a retiring model).

## Sample

[`benchmarks/2026-10-22-model-wrapper-app-repos.json`](benchmarks/2026-10-22-model-wrapper-app-repos.json): 61 public application repositories, frozen at their default-branch commits on 2026-10-22. They were selected by `scripts/ai-app-select.mjs` with one run per wrapper and merged by `scripts/model-wrapper-sample.mjs`; a repository chosen by several lists is kept once, under the first. Each list's GitHub code-search queries, size buckets, filters and rejection counts are kept in the file.

| List                  | Queries                                                                                                                                                                                                           | Selected | Kept |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---- |
| `ai-sdk-openai`       | `"@ai-sdk/openai" filename:package.json extension:json path:/` in three size buckets (`<1500`, `1500..2999`, `>=3000`), plus `"from '@ai-sdk/openai'" language:TypeScript` under `app`, `src`, `lib` and `server` | 25       | 25   |
| `ai-sdk-anthropic`    | the same for `@ai-sdk/anthropic`                                                                                                                                                                                  | 12       | 5    |
| `langchain-openai`    | the same for `@langchain/openai`                                                                                                                                                                                  | 15       | 15   |
| `langchain-anthropic` | the same for `@langchain/anthropic`                                                                                                                                                                               | 8        | 6    |
| `llamaindex`          | the same for `llamaindex`                                                                                                                                                                                         | 10       | 10   |

The selector's own filters apply: commit on or after 2025-10-21, not a fork, archived or a library, within the scan limits, and a non-test file that imports the wrapper and makes a model call. Search reads three pages per query (`--pages 3`), so the pool is the most relevant results GitHub returned, ranked by stars. The lists share one checkout root, and a later list deleted one repository it rejected (`e2b-dev/fragments`). It was fetched again at the same commit before scoring; use one root per list next time.

## Confirming the gap

Both runs read the 61 repositories at their frozen commits with `scripts/ai-model-benchmark.mjs` (which now accepts a list with no single provider), from detached worktrees: main `7b2c86a` and this branch at `bd4155e`. Results: [`benchmarks/2026-10-22-model-wrapper-app-results.json`](benchmarks/2026-10-22-model-wrapper-app-results.json), with main as its baseline.

|                                                                    | main    | this branch |
| ------------------------------------------------------------------ | ------- | ----------- |
| Repositories (unreadable)                                          | 61 (1)  | 61 (1)      |
| Exposed: live use of a registry model                              | 30      | 30          |
| Exposed with evidence naming the wrapper call (`via`)              | 0       | 16          |
| A replacement proposed (direct SDK calls in the same repositories) | 2       | 2           |
| Stopped for review only, with a reason                             | 4       | 18          |
| Unresolved only                                                    | 24      | 10          |
| Stops / unresolved lines                                           | 5 / 131 | 76 / 61     |

So Refit already counted these repositories as exposed (the exact-string matcher sees a bare `'gpt-4'` wherever it is written), but it could not say which call sends the model: on main, 24 of the 30 exposed repositories ended with nothing but "No file imports `openai`… the model may reach the API through another library or a wrapper". Now 18 end in named stops, with the wrapper call and line, and 10 still have only unresolved lines (models in settings, tables or class state; see below). No gateway or registry ID in this sample names a retiring model, so the new gateway matching adds no exposure here; it is covered by tests.

**Announced retirements:** 30 of the 61 sample repositories send at least one model from a live line that the registry lists as retiring or retired. In 14 of them the date has already passed, and in 21 at least one date falls within the next 90 days (2026-10-23 to 2027-01-20). The most common are `gpt-3.5-turbo` and `gpt-4` (9 repositories each, retiring 2026-10-23), `claude-sonnet-4-5` (8, 2026-11-30), `whisper-1` (7) and `claude-sonnet-4` (6, retired 2026-06-15).

## Precision and recall

Labels: [`benchmarks/2026-10-22-model-wrapper-labels.json`](benchmarks/2026-10-22-model-wrapper-labels.json), scored by `scripts/model-wrapper-score.mjs` through `pipeline/model-wrapper-score-cli.ts`:

```sh
npx tsx pipeline/model-wrapper-score-cli.ts --labels docs/benchmarks/2026-10-22-model-wrapper-labels.json --root <checkouts> --output <score.json>
```

The labels are blind: each labelled repository was labelled before the detector was run on it. An independent grep listed candidate lines (model-shaped strings in files that import a wrapper), and every candidate and the calls around it were read by hand. A site is a model ID written in the repository that a wrapper call sends. A model that reaches a wrapper only through a request, user settings or a model table is not a site; the labels say so under `dynamic`. Test and example files are left out on both sides, and so are sites on a provider set to another endpoint (they are stops, not matches; counted apart). A site matches on file, line, the string as written and the provider.

One labeller, one pass: there is no second reader, so label errors are not measured. The LangChain repositories were chosen by hand among the smaller ones for time, which may favour simpler code there.

Two sets. The **tuned** set (40 repositories, 203 sites) is the one the detector was developed against: after a first score, the misses it showed were fixed (gateway calls, helper returns, `let` assignments, dynamic imports, late providers, the provider-shape rule). Its "after" number is therefore optimistic. The **held-out** set (the 10 AI SDK OpenAI repositories ranked 16 to 25, 32 sites) was labelled after that tuning and before the detector was run on it, so it is the honest estimate.

| Set               | Detector                 | Precision          | Recall             | Endpoint stops (not counted) |
| ----------------- | ------------------------ | ------------------ | ------------------ | ---------------------------- |
| Tuned (39 scored) | first version, `bf8485b` | 99.4% (169 of 170) | 83.3% (169 of 203) | 14                           |
| Tuned (39 scored) | this branch              | 100% (189 of 189)  | 93.1% (189 of 203) | 19                           |
| Held-out (10)     | first version, `bf8485b` | 100% (11 of 11)    | 34.4% (11 of 32)   | 4                            |
| Held-out (10)     | this branch              | 92.3% (12 of 13)   | 37.5% (12 of 32)   | 6                            |

`hotovo/aider-desk` is labelled but not scored: Refit cannot read it (a template `package.json` that is not valid JSON makes `readRepository` throw), which also fails `refit deadlines` there.

By wrapper, tuned set, this branch: AI SDK 100% precision and 94.4% recall (170 of 180), LangChain 100% and 80% (8 of 10), LlamaIndex 100% and 84.6% (11 of 13). The held-out set is AI SDK only.

## What it misses

Every false negative and false positive, by cause, this branch. Tuned set: 14 misses, no false positives. Held-out set: 20 misses and 1 false positive.

| Cause                                                                                                                                                                                  | Tuned | Held-out | Repositories                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------- | ---------------------------------------------------------------------------------- |
| Found, but as a named endpoint stop (the provider has a `baseURL` or `configuration` option), which the score leaves out                                                               | 4     | 3        | open-lovable, InnoClaw, tinykit, bilibili-mcp-js; grills, slurm-node-dashboard (2) |
| The model reaches the call through a class field or constructor config (`this.modelName`, `new LLMService({ model })`), or the provider is held on `this`                              | 0     | 15       | esinecan/skynet-agent                                                              |
| A function parameter or a returned object (`normalizeModelName(DEFAULT_MODEL)`, `createChatbot({ model })`, `resolveModel()` returning `{ client, model }`)                            | 2     | 1        | inbound, ottehr; ai-smart-draw                                                     |
| A lookup table indexed at runtime, and a template split at runtime (`defaults[provider]`, `` `openai:${…}` ``)                                                                         | 4     | 0        | deep-research-mcp                                                                  |
| A static getter's returned object (`Config.OPENAI_NANO_LLM.MODEL`)                                                                                                                     | 2     | 0        | telegram-gpt-bot                                                                   |
| A provider made in a verification script from a dynamic import and passed around                                                                                                       | 2     | 0        | OpenChatCut                                                                        |
| A `let` provider assigned different factories per branch: the last assignment wins, so one case gets the wrong provider (the false positive is an OpenRouter model reported as Gemini) | 0     | 1 + 1 FP | grills                                                                             |

The largest gap is models carried in objects and class state, the same shape that limits the SDK tracer (`docs/MODEL-WEDGE.md`). Following them would need the full resolver in `pipeline/model-retirements.ts`; that is the next step if wrapper recall matters more than these numbers suggest.

## Requests for other lanes

- **FG9 / `model-retirements.ts`:** the resolver there already follows class fields, members and parameters. Exposing it (one exported function taking a model expression) would let this detector reuse it instead of its own shallower trace.
- **`pipeline/repository.ts` (shared):** one invalid `package.json` under a template directory makes `readRepository` throw for the whole repository, so `refit deadlines` fails there (`hotovo/aider-desk`).
- **`scripts/ai-app-select.mjs` callers:** give each list its own `--root`; a shared root lets one list delete another's checkout.
- **PP10:** add the AI wrapper sample to `docs/BENCHMARKS.md` and the wrapper line to `docs/READINESS.md`.

## Not verified

- Labels have one reader and no agreement check.
- Gemini has no model entries in the registry, so Gemini wrapper sites are found and scored here but never show up as exposure.
- Python wrappers (LangChain Python, LlamaIndex Python) are out of scope.
- CI did not run (GitHub Actions billing); all checks ran locally.
