# AI application model sites: precision and recall

This document measures how well Refit's model-retirement detection finds the places where an application chooses a model. It uses the frozen AI application sets: OpenAI ([`2026-10-21-openai-app-repos.json`](benchmarks/2026-10-21-openai-app-repos.json), 100 repositories) and Anthropic ([`2026-10-21-anthropic-app-repos.json`](benchmarks/2026-10-21-anthropic-app-repos.json), 50).

The detection measured is `refit deadlines --json`: its live exposures, and the evidence file and line of each. The run is static: no Docker, no install, no repository code run, no model request.

- Labels: [`benchmarks/2026-10-22-ai-app-model-sites.json`](benchmarks/2026-10-22-ai-app-model-sites.json), beside the frozen lists.
- Scripts:
  - `scripts/ai-app-precision.mjs`: sample, candidate search, detection run and score.
  - `scripts/ai-app-precision-summary.mjs`: the pure scoring functions, modelled on `scripts/ai-model-benchmark-summary.mjs` and tested by `pipeline/ai-app-precision-summary.test.ts`.

## Labelling guide

This guide was written before any repository in the sample was read. Cases it did not foresee are decided once, added under "Rulings", and applied everywhere.

### What a model site is

A **model site** is one place in production code where the repository writes the model identifier that a request to a model provider sends. It is the string literal (or the literal default of an environment variable or setting) that ends up in the request's `model` field, or in the model path segment of the request URL. It counts:

- in an SDK call (`client.chat.completions.create({ model: 'gpt-4o' })`, `anthropic.messages.create`, `genAI.getGenerativeModel({ model })`);
- in a wrapper SDK (`openai('gpt-4o')` from `@ai-sdk/openai`, `new ChatOpenAI({ model })`, `new ChatAnthropic`);
- in a raw HTTP request to the provider's API;
- one hop away: a constant, a default parameter, a config object or a `process.env.MODEL ?? 'gpt-4o-mini'` default whose value reaches such a request. The site is the line with the literal, not the call.

It does not count when the literal is:

- a model list or picker option the user chooses from (a catalog), unless it is also the default that is sent without a choice;
- a price, token-limit or context-window table entry;
- a comparison or prefix check (`model.startsWith('o1')`);
- a tokenizer argument, a comment, documentation, a test, a fixture, an example or a seed script;
- a label shown in the UI;
- a model sent to a self-hosted or third-party OpenAI-compatible server (Ollama, LM Studio, OpenRouter, Groq and the like). It is recorded as `compatible` and kept out of the OpenAI and Anthropic scores, because the provider that retires the model is not OpenAI or Anthropic.

### What a label records

```json
{
  "repo": "owner/name",
  "file": "src/lib/ai.ts",
  "line": 12,
  "model": "gpt-4o-mini",
  "provider": "openai",
  "via": "sdk",
  "registry": true,
  "notes": "chat completion default"
}
```

- A site belongs to its repository, not to a set. Two repositories (`vual/lobe-chat-pro`, `utter-one/bonsai`) are in both frozen lists and both samples, so their sites count in both sets.
- `provider` is the provider whose API receives the request: `openai`, `anthropic`, `gemini`, or `compatible` for another host.
- `via` is `sdk`, `wrapper`, `raw-http` or `indirect` (a constant, default or config one hop or more away from the call).
- `registry` is filled in after labelling, by rule: `true` when the model is listed in `data/deadlines.json` at the scored commit. Model-retirement detection only reports registry models, so recall is scored over registry sites and reported separately for all sites.

### Negative files

Each set also gets 30 production source files from the sampled repositories where a quick read finds no model site. They are drawn at random, with the seed recorded, from files that import the set's SDK or mention its API host. A drawn file that turns out to have a site is labelled as a site and replaced by the next draw. Refit reporting a live exposure in a negative file is a false positive. The negatives measure precision where it matters most: in files that talk to the provider but do not choose a model.

### Blind procedure

1. Draw the sample with the seed (below) before reading any repository.
2. For each sampled repository, read the output of the independent candidate search (`scripts/ai-app-precision.mjs candidates`). It lists every string literal shaped like a model ID and every `model` property, argument or environment default in production JS/TS and Python, with file and line. It imports no Refit pipeline code. Then read the code and label each site by this guide.
3. Commit all labels before running detection on any sampled repository.
4. Run detection, then read every reported site in the sampled repositories:
   - A reported site with no label is either a false positive (with its cause) or a labelling miss.
   - A miss is corrected in a separate commit, listed under "Label corrections", and scored both before and after.

## Sample

- Seed `20261022`, `seededSample` from `scripts/ai-app-helpers.mjs` (names sorted, then a mulberry32 Fisher-Yates shuffle).
- 40 of the 100 OpenAI repositories (fraction 0.4) and 25 of the 50 Anthropic repositories (fraction 0.5).
- The labels file records both lists.
