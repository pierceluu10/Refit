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

## Rulings

Cases the guide did not foresee, each decided once and applied to every repository:

- A settings catalog that documents environment variables and their defaults for an admin UI (`config-catalog.data.ts`) is documentation; the site is the code constant the request reads.
- A DeepSeek, Groq or other non-OpenAI host reached through the `openai` client is recorded as `compatible` when its literal is visible, but the candidate search only looks for major-provider model shapes, so compatible sites are under-recorded. They are not scored.
- A model stored as a default configuration row (`aiConfiguration.create({ model: 'gpt-4o-mini' })`) and later sent counts as an indirect site.
- A model catalog entry marked as the default, or one the code resolves by a fixed alias for a background task, is a site; the other entries are a catalog.
- Model lists passed to agent CLIs (Codex, Gemini CLI, OpenCode) are not sites: the CLI makes the request, not this repository.
- A form or cookie default that only seeds a UI control is not a site; the server-side default the request falls back to is.
- A gateway's preference list that picks one of the models a key already has is a catalog; its hard fallback when none matches is a site. A remap table from an old ID to a new one is a catalog.
- Very large applications with provider catalogs (`vual/lobe-chat-pro`, `utter-one/bonsai`, `AnyVM-Tech/AnyGPT`) were labelled file by file: every candidate in settings, defaults, services and runtime code was read, and catalog files (model banks, provider model lists, pricing tables) were confirmed as catalogs by reading their structure, not every entry.
- Code the application ships as a string and runs elsewhere (a script uploaded to an E2B sandbox) is a site: it is the application's own request, sent from another process.
- Simulation and smoke harnesses inside `src` (`src/multi/sim/*`) are non-production.
- Folders named `experimental` with spike runners are non-production.
- In the six Claude Code source forks (`fazxes/Claude-code`, `kill136/claudecode`, `chenqinggang001/claude-code-build`, `wyh0626/claude-code-local`, `wk42worldworld/cybercode`, `OpenAisec/Miko`), the first-party entries of `src/utils/model/configs.ts` that the default resolution in `src/utils/model/model.ts` returns (`haiku45`, `sonnet45`, `sonnet46`, `opus46`) are sites, and the other entries are a catalog. Code a fork adds outside the shared Claude Code tree was read for defaults; provider alias maps for third-party OAuth proxies and browser-session providers (chatgpt.com and claude.ai web sessions, including `OpenAisec/Miko`'s ChatGPT sign-in models) are not API sites.
- A per-provider default in a preset table (`defaultProfiles`, media provider presets with `defaultModel`) is a site: it is sent when the user configures that provider without choosing a model. The other entries in the same preset are a catalog. Google image, video and speech models (Imagen, Veo) reached through Vertex are recorded under `gemini`, the Google provider.
- A model ID written into a system prompt as text (the Claude Code forks' `CLAUDE_4_5_OR_4_6_MODEL_IDS` in `src/constants/prompts.ts`) is documentation, not a site.
- Probe and diagnostic scripts in a `dev/` folder (`apps/api/dev/testModelLiveProbes.ts`) are non-production. A negative draw that lands on one is replaced.
- Model fields in an API response body (`meta.model` in a search response) and in a scripted fake response are not sites: nothing is sent to a provider.
- After all repositories were labelled and before the labels were committed, a second pass listed every model-shaped literal on a line with a default (`||`, `??`, `default`, `.get(`) that had no label, excluding comparisons. It found two OpenAI sites (`AnyVM-Tech/AnyGPT` semanticMemoryStore embeddings, `utter-one/bonsai` OpenAI TTS) and eight compatible sites; all are labelled.

## Labels

The labels were made by the AI agent (Claude) running this lane, not by a human, following the guide above. They were committed before detection ran on any sampled repository.

- 286 sites in the 65 sampled repositories: 92 SDK calls, 3 wrapper calls, 6 raw HTTP requests and 185 indirect sites (constants, defaults, settings and preset tables).
- OpenAI sample (40 repositories, 34 with a site): 179 sites. 91 send to OpenAI (23 of them registry models), 13 to Anthropic (5 registry), 50 to Gemini (none registry) and 25 to a compatible host.
- Anthropic sample (25 repositories, all with a site): 129 sites. 69 send to Anthropic (18 registry), 36 to OpenAI (5 registry), 20 to Gemini (none registry) and 4 to a compatible host.
- Six OpenAI-sample repositories have no site: `Dregen-Yor/auto-invoice`, `LangChat/langchat-slides`, `LeafYeeXYZ/PsychPen`, `LocalRouter/LocalRouter`, `Wing900/ManimCat` and `mcaupybugs/minimal-n8n`. Each takes its model from the user or from a router's configuration.
- Only 51 of the 257 non-compatible sites name a model that `data/deadlines.json` lists. That is the ceiling on what model-retirement detection can report. The registry recall below is scored over those 51 sites, and the all-site recall over all 257.

### Negative files

- `node scripts/ai-app-precision.mjs negatives --output <candidates>` prints the seeded draw order (seed `20261022`, `seededOrder`, over `repo file` strings).
- The labeller took files in that order, kept those with no site, and skipped a file that had a labelled site or was not production code. The labels file records every kept and skipped draw.
- OpenAI took 46 draws to keep 30. Four drawn files had sites not yet labelled (one OpenAI embedding default and three compatible hosts); they were labelled.
- Anthropic kept its first 30 draws. The draw is uniform over files, and the six Claude Code source forks hold most of the Anthropic sample's provider files, so 28 of its 30 negatives come from them. That set's negative-file result says more about Claude Code's own source than about typical applications.
