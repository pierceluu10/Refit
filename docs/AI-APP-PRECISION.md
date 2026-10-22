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

- A site belongs to its repository, not to a set. Nine repositories are in both frozen lists. Three of them (`backenly/backenly`, `utter-one/bonsai`, `vual/lobe-chat-pro`) are in both samples, so their sites count in both sets.
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

### Rulings added while labelling the remaining repositories

These cases first appeared outside the sample, and none of them changes a sample label. The Claude Code fork ruling above also covers the six forks in the remainder: `DdogezD/claudium`, `Doriandarko/kimi-2-6-code`, `JrCx7scC/claude-code-source`, `txl16095/MiniClaude`, `TaGoat/claude_code_cli` and `andforce/Openclaude`. `DdogezD/claudium` removed the built-in default, so it has no such site, and `txl16095/MiniClaude`'s getters return three entries, not four.

- In a model catalog whose selection defaults to the first model with a configured key (`getAvailableModels().at(0)`), the first entry of each provider is a site: it is sent without a choice when that is the only key set.
- A plain string model ID passed to the Vercel AI SDK (`model: 'openai/gpt-5-mini'`) is resolved by the Vercel AI Gateway, a third-party host, so it is recorded as `compatible`. A model passed through a provider package (`openai('gpt-4o-mini')` from `@ai-sdk/openai`) goes to the provider and is a `wrapper` site.
- Azure OpenAI deployments are recorded as `compatible`: Microsoft, not OpenAI, retires them, and the value is a deployment name. Folders whose name ends in `examples` (`other-examples/`) and evaluation harness files (`server/eval-framework.ts`) are non-production. Model IDs inside a commented example config are documentation.
- An alias resolver that maps a family name to a current model ID (`ShinChven/remix-studio` `google.ts`, `if (id.includes('3.5-flash')) return 'gemini-3.5-flash'`) is a remap table, so a catalog; its default parameter is a site.
- A provider-prefixed ID that the application's own gateway splits before the request (`'anthropic:claude-haiku-4-5'`, `'anthropic/claude-sonnet-4-6'` in `inbrainfun/inbrain`) is recorded with its bare model ID. The candidate search does not list the colon form; it was found with a separate search for `provider:model` literals, and only `inbrainfun/inbrain` uses it. Evaluation harnesses under `src/core/*-eval/` and `src/commands/eval-*.ts`, and recipe folders of sample code, are non-production.

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

## Results

Detection ran from the clean commit `8cd9a44` (the labels commit, with detection code identical to `main` at `7b2c86a`), on the 62 distinct repositories of both samples, each at its frozen commit. No repository failed to scan. No labelled site fell beyond the evidence limit of 20 per deadline.

- Results: [`benchmarks/2026-10-22-ai-app-model-site-results.json`](benchmarks/2026-10-22-ai-app-model-site-results.json).
- Score, with the corrected labels: [`benchmarks/2026-10-22-ai-app-model-site-score.json`](benchmarks/2026-10-22-ai-app-model-site-score.json).
- Reproduce with `node scripts/ai-app-precision.mjs run --root <checkouts> --results <file>` and `node scripts/ai-app-precision.mjs score --results <file>`.

| Set                         | Precision                        | Registry recall           | All-site recall            | False positives in negative files |
| --------------------------- | -------------------------------- | ------------------------- | -------------------------- | --------------------------------- |
| OpenAI (40 repositories)    | 45.5% (30/66), 95% CI 34.0–57.4% | 96.8% (30/31), 83.8–99.4% | 18.8% (30/160), 13.5–25.5% | 1 of 30 files                     |
| Anthropic (25 repositories) | 29.9% (20/67), 20.2–41.7%        | 76.9% (20/26), 57.9–89.0% | 15.3% (20/131), 10.1–22.4% | 0 of 30 files                     |

- **Precision:** a reported site counts as true when a label has the same file, line and model.
- **Registry recall:** over labelled sites whose model `data/deadlines.json` lists.
- **All-site recall:** over every labelled OpenAI, Anthropic and Gemini site. Most models in use (`gpt-5`, `claude-sonnet-4-6`, every Gemini model) have no announced retirement yet, so Refit is right not to report them. This number is the ceiling, not a target.
- **Compatible sites:** three reports landed on them (`aihubmix.ts:6` in both sets, Raycast AI in the Anthropic set). They are kept out of precision.

Refit finds nearly every registry model an OpenAI-set application sends. Two things hold precision down: model IDs it reports as live outside requests, and, in the Anthropic set, one shared Claude Code source tree counted six times.

### Repository-level view

- The six Claude Code forks contribute 34 of the Anthropic set's 47 false positives, all six of its misses, and none of its true positives. Each fork has the same three false positives and the same miss. `wk42worldworld/cybercode` and `OpenAisec/Miko` each add 8 false positives of their own, in code they added to the shared tree.
- Without the forks, the Anthropic set has 19 repositories: precision 60.6% (20/33) and registry recall 100% (20/20).
- In each fork, Refit reports the right deadline (Claude Sonnet 4.5) at the wrong lines. It marks the cross-platform ID table in `src/utils/model/configs.ts` as a catalog, and instead reports two name-mapping helpers.

### How the score moved

| Stage                                 | OpenAI precision | OpenAI recall | Anthropic precision | Anthropic recall |
| ------------------------------------- | ---------------- | ------------- | ------------------- | ---------------- |
| As first scored (labels as committed) | 36.5% (27/74)    | 96.4% (27/28) | 22.1% (17/77)       | 73.9% (17/23)    |
| Scorer fixed (`dfb5e02`)              | 40.3% (27/67)    | 96.4% (27/28) | 24.6% (17/69)       | 73.9% (17/23)    |
| Labels corrected (`b642b81`)          | 45.5% (30/66)    | 96.8% (30/31) | 29.9% (20/67)       | 76.9% (20/26)    |

- **Scorer fix:**
  - The first score counted Meta Graph API-version exposures (`graph.facebook.com/v17.0` in `utter-one/bonsai`, `kgoedecke/doop` and `backenly/backenly`). They are outside this benchmark and are now excluded.
  - It also counted reports at labelled compatible sites as false positives, but the guide keeps those out of the scores.
  - The run itself was not repeated, since detection code did not change.
- **Label corrections, all found by reading Refit's reports:**
  - `nextai-translator/raycast-openai-translator`: three default-model labels sat on the `name:` line. The `id:` line one above is what is sent, and the labels moved there. Refit reports both lines, so the two `name:` reports are now false positives.
  - `vual/lobe-chat-pro`: the DALL-E tool payload (`src/services/textToImage.ts:17`), the painting palette default (`src/store/palette/initialState.ts:18`) and the providers' connection-check models (`checkModel` for OpenAI, Anthropic, Google and Vertex AI) were missed. The connection checks follow the same ruling as `OpenCoworkAI/open-cowork`'s diagnostics model. AiHubMix and Bedrock connection checks were added as compatible sites.

## False positives by cause

All 83 false positives (75 distinct sites, since three repositories are in both samples) were read in full. The full list is in the appendix.

| Cause                                                                                                                                                           | OpenAI | Anthropic | Where                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: | --------: | ------------------------------------------------------------------------------------- |
| Catalog or remap table: `[id, label]` tuples, `add('…')` builder calls, model-bank `id:` entries, identity remaps, cross-platform tables                        |      8 |        15 | AnyGPT, lobe-chat-pro, charmonator, cybercode, Miko                                   |
| UI option, label or form default: `<SelectItem value>`, JSX `label={'tts-1'}`, Angular settings form defaults, cookie and `localStorage` seeds, a picker button |     16 |         4 | visual-journal, lobe-chat-pro, three Goofish forks, dalle-3-ui, PsychPen, charmonator |
| Name-normalising helper that returns a short model name and sends nothing (`if (name.includes('sonnet-4-5')) return 'claude-sonnet-4-5'`)                       |      0 |        12 | six Claude Code forks                                                                 |
| Non-production file: `dev/` probes, `scripts/`, `server/db/seed.ts`, `website/` demos, `.i18nrc.js`                                                             |     10 |         1 | AnyGPT, charmonator, GhazelleChat, LocalRouter, lobe-chat-pro                         |
| Model ID inside prompt or documentation text in a string                                                                                                        |      0 |         7 | six Claude Code forks, Siftly                                                         |
| ChatGPT sign-in models (chatgpt.com backend), not API sites by ruling                                                                                           |      0 |         3 | Miko                                                                                  |
| Display name beside the default model `id:` that is sent                                                                                                        |      0 |         2 | raycast-openai-translator                                                             |
| Display or cost-accounting fallback, not a request                                                                                                              |      0 |         2 | tycono                                                                                |
| Default model ID used as a lookup key (the labelled site is the entry's `apiModel`)                                                                             |      1 |         0 | GhazelleChat                                                                          |
| Placeholder group config in a client-side list transform                                                                                                        |      1 |         1 | lobe-chat-pro                                                                         |
| **Total**                                                                                                                                                       | **36** |    **47** |                                                                                       |

The one false positive in a negative file is `LeafYeeXYZ/PsychPen` `src/components/data/ConfigAI.tsx:264`: a button that sets the model to `gpt-5.1` when the user clicks it.

## False negatives by cause

- **Six Anthropic misses, one cause.** `src/utils/model/configs.ts` in each Claude Code fork maps one model to its ID on every platform (`firstParty`, `bedrock`, `vertex`, `foundry`). Refit's cross-platform table rule marks the whole object as a catalog. The `firstParty` value of `CLAUDE_SONNET_4_5_CONFIG` is what `getDefaultSonnetModel()` returns on third-party platforms, so it is sent.
- **One OpenAI miss.** `badhri17/GhazelleChat` `lib/models/registry.ts:27` is the `apiModel` of the default entry in a model registry array, also marked as a catalog. Refit reports the default's lookup key at line 3 instead, a false positive one hop from the real site. A user fixing that report would still find the right entry.

## Requests for other lanes

Ranked by the sites each fix would recover in this sample: false positives removed plus misses found. Counts are per set (OpenAI + Anthropic), so a repository in both samples counts twice. No detection code is changed here.

**FG9 (model-retirement wedge):**

1. **Model-name normalisers are checks, not uses (12 sites).** A model literal returned from a branch whose condition tests the same family with `includes` or `startsWith` (`if (name.includes('sonnet-4-5')) return 'claude-sonnet-4-5'`) is a `check`. All 12 are in the six Claude Code forks.
2. **Cross-platform ID tables: report the first-party value when a default resolver reads it (6 misses recovered; 5 false positives in the same table form).** Today the whole `{ firstParty, bedrock, vertex, foundry }` object is a catalog. A first-party value reached through a property read (`getModelStrings().sonnet45`) should be live. A table that repeats one ID under every key (`OpenAisec/Miko` `configs.ts:106-110`, a ChatGPT sign-in model) should stay a catalog.
3. **More catalog shapes (18 sites):**
   - `[id, label]` tuple arrays (8, `cybercode` `webSessionProviders.ts` and `mediaProviders.ts`);
   - `add('model')` calls that build a model list (4, AnyGPT);
   - `id:` entries in an array of model objects under `model-bank` or `aiModels` (4, lobe-chat-pro, both sets);
   - identity remap objects (`{ 'gpt-4': 'gpt-4' }`, 2, charmonator).
4. **UI options and labels (20 sites):**
   - `<SelectItem value=…>` and similar option components (6);
   - JSX `label={'…'}` and option `value` in settings constant files (8, lobe-chat-pro, both sets);
   - Angular `frontend/` form defaults (3);
   - cookie and `localStorage` seeds (2);
   - a click handler that sets a model (1).

   The `<option>` rule already exists, so this widens it to component libraries.

5. **Non-production paths (11 sites):** `dev/` folders (5, AnyGPT), `scripts/` and `website/` demo folders inside a workspace (3), `server/db/seed.ts` (1) and the `.i18nrc.js` translation tool config (2, both sets).
6. **Model IDs in prompt and documentation strings (7 sites):** a model ID inside a template literal of prompt text, or inside a `//` comment that sits in a string (`statuslineSetup.ts:42`).
7. **Display names (2 sites):** in a `{ id: 'm', name: 'm' }` default-model object, report the `id:` line only.

**FP3 (AI wrapper SDKs):** this sample gives FP3 no recall signal. Only 3 of 295 sites go through a wrapper SDK:

- `adrianhajdin/job_pilot` Stagehand `modelName: "openai/gpt-4o"`;
- `OpenCoworkAI/open-cowork` `getModel('google', 'gemini-2.5-flash')`;
- `sanidhyy/meet-ai` `@inngest/agent-kit` `openai({ model: 'gpt-5-nano' })`.

None names a registry model. When one does, the `openai/` prefix in Stagehand-style IDs will need stripping before the registry match. This is not measured here.

**Side finding, for whichever lane owns Meta Graph detection:** in `utter-one/bonsai`, Refit lists `tests/e2e/alert-notifiers-p4-02.test.ts:213` and `tests/unit/monitoring/p4-02-notifiers.test.ts:444` as live evidence for Graph API v17.0. Both are test files, so they should be `test` use. This was seen while excluding Meta Graph from this score and was not measured.

**Needs owner decision:** whether models sent through ChatGPT sign-in (the `chatgpt.com/backend-api/codex` endpoint `OpenAisec/Miko` uses) count as OpenAI API sites. OpenAI retiring `gpt-5.3-codex` would break them, but the API deprecation pages may not cover that endpoint. The labels follow the ruling and count them as not API sites (3 false positives).

## Limits

- **One labeller.** The labeller is an AI agent, and a second labeller was not used. The twelve label changes in the correction (three moved, nine added) came only from Refit's reports. Misses that Refit also missed stay invisible, so all-site recall is an upper bound on what the labels cover.
- **Clustered repositories.** The six Claude Code forks share one source tree. They dominate the Anthropic set's errors, and they make up 28 of its 30 negative files.
- **What the candidate search can see.** It reads model-shaped literals of major providers. Compatible sites (DeepSeek, Groq, Qwen and the like) are under-recorded, which does not affect the scores.
- **Small denominators.** Registry recall rests on 31 and 26 sites, with the intervals shown.
- **Scope.** JavaScript, TypeScript and Python files were labelled. Refit's model scan reads JavaScript and TypeScript, and no labelled site is in a Python file in this sample.

## Appendix

### Every false positive

Each is listed once; "both" marks a repository in both samples, counted in each set.

- **Catalog or remap table (21):**
  - `AnyVM-Tech/AnyGPT` `apps/api/modules/modelUpdater.ts:920` `gpt-4o-mini-transcribe` (openai)
  - `AnyVM-Tech/AnyGPT` `apps/api/modules/modelUpdater.ts:923` `gpt-4o-transcribe` (openai)
  - `AnyVM-Tech/AnyGPT` `apps/langgraph-control-plane/src/workflow.ts:3116` `gpt-4o-mini-transcribe` (openai)
  - `AnyVM-Tech/AnyGPT` `apps/langgraph-control-plane/src/workflow.ts:3119` `gpt-4o-transcribe` (openai)
  - `vual/lobe-chat-pro` `packages/model-bank/src/aiModels/azure.ts:1215` `dall-e-3` (both)
  - `vual/lobe-chat-pro` `packages/model-bank/src/aiModels/azure.ts:1201` `gpt-image-1` (both)
  - `CHARM-BDF/charmonator` `lib/config.mjs:214` `gpt-3.5-turbo` (openai)
  - `CHARM-BDF/charmonator` `lib/config.mjs:215` `gpt-4` (openai)
  - `wk42worldworld/cybercode` `src/shared/webSessionProviders.ts:185` `gpt-4-turbo` (anthropic)
  - `wk42worldworld/cybercode` `src/shared/webSessionProviders.ts:186` `gpt-4` (anthropic)
  - `wk42worldworld/cybercode` `src/shared/webSessionProviders.ts:336` `gpt-4-turbo` (anthropic)
  - `wk42worldworld/cybercode` `src/shared/webSessionProviders.ts:457` `claude-sonnet-4-5` (anthropic)
  - `wk42worldworld/cybercode` `src/shared/mediaProviders.ts:316` `gpt-image-1.5` (anthropic)
  - `wk42worldworld/cybercode` `src/shared/mediaProviders.ts:317` `gpt-image-1-mini` (anthropic)
  - `wk42worldworld/cybercode` `src/shared/mediaProviders.ts:1206` `tts-1-hd` (anthropic)
  - `wk42worldworld/cybercode` `src/shared/mediaProviders.ts:1208` `whisper-1` (anthropic)
  - `OpenAisec/Miko` `src/utils/model/configs.ts:106` `gpt-5.3-codex` (anthropic)
  - `OpenAisec/Miko` `src/utils/model/configs.ts:107` `gpt-5.3-codex` (anthropic)
  - `OpenAisec/Miko` `src/utils/model/configs.ts:108` `gpt-5.3-codex` (anthropic)
  - `OpenAisec/Miko` `src/utils/model/configs.ts:109` `gpt-5.3-codex` (anthropic)
  - `OpenAisec/Miko` `src/utils/model/configs.ts:110` `gpt-5.3-codex` (anthropic)
- **UI option, label or form default (16):**
  - `keegandonley/dalle-3-ui` `src/components/Prompt/index.tsx:95` `gpt-image-1` (openai)
  - `YiZhanSuDaShui/GoofishCredentialsBot` `frontend/src/app/views/system-setting/system-setting.component.ts:26` `gpt-3.5-turbo` (openai)
  - `MisonL/visual-journal` `src/components/editing-form.tsx:1455` `gpt-image-1` (openai)
  - `MisonL/visual-journal` `src/components/generation-form.tsx:1021` `gpt-image-1` (openai)
  - `MisonL/visual-journal` `src/components/editing-form.tsx:1454` `gpt-image-1.5` (openai)
  - `MisonL/visual-journal` `src/components/editing-form.tsx:1456` `gpt-image-1-mini` (openai)
  - `MisonL/visual-journal` `src/components/generation-form.tsx:1020` `gpt-image-1.5` (openai)
  - `MisonL/visual-journal` `src/components/generation-form.tsx:1022` `gpt-image-1-mini` (openai)
  - `vual/lobe-chat-pro` `src/app/[variants]/(main)/settings/tts/features/const.tsx:12` `tts-1` (both)
  - `vual/lobe-chat-pro` `src/app/[variants]/(main)/settings/tts/features/const.tsx:16` `tts-1-hd` (both)
  - `vual/lobe-chat-pro` `src/app/[variants]/(main)/settings/tts/features/const.tsx:23` `whisper-1` (both)
  - `vual/lobe-chat-pro` `src/app/[variants]/(main)/settings/tts/features/const.tsx:24` `whisper-1` (both)
  - `Jay-Bosco/GoofishCredentialsBot` `frontend/src/app/views/system-setting/system-setting.component.ts:26` `gpt-3.5-turbo` (openai)
  - `LeafYeeXYZ/PsychPen` `src/components/data/ConfigAI.tsx:264` `gpt-5.1` (openai, negative file)
  - `lrzy8/Goofish` `frontend/src/app/views/system-setting/system-setting.component.ts:30` `gpt-3.5-turbo` (openai)
  - `CHARM-BDF/charmonator` `public/script.js:118` `o1` (openai)
- **Name-normalising helper (returns a short name, sends nothing) (12):**
  - `fazxes/Claude-code` `src/utils/commitAttribution.ts:161` `claude-sonnet-4-5` (anthropic)
  - `fazxes/Claude-code` `src/utils/model/model.ts:237` `claude-sonnet-4-5` (anthropic)
  - `wk42worldworld/cybercode` `src/utils/commitAttribution.ts:165` `claude-sonnet-4-5` (anthropic)
  - `wk42worldworld/cybercode` `src/utils/model/model.ts:243` `claude-sonnet-4-5` (anthropic)
  - `OpenAisec/Miko` `src/utils/commitAttribution.ts:161` `claude-sonnet-4-5` (anthropic)
  - `OpenAisec/Miko` `src/utils/model/model.ts:259` `claude-sonnet-4-5` (anthropic)
  - `kill136/claudecode` `src/utils/commitAttribution.ts:161` `claude-sonnet-4-5` (anthropic)
  - `kill136/claudecode` `src/utils/model/model.ts:237` `claude-sonnet-4-5` (anthropic)
  - `chenqinggang001/claude-code-build` `src/utils/commitAttribution.ts:161` `claude-sonnet-4-5` (anthropic)
  - `chenqinggang001/claude-code-build` `src/utils/model/model.ts:237` `claude-sonnet-4-5` (anthropic)
  - `wyh0626/claude-code-local` `src/utils/commitAttribution.ts:161` `claude-sonnet-4-5` (anthropic)
  - `wyh0626/claude-code-local` `src/utils/model/model.ts:237` `claude-sonnet-4-5` (anthropic)
- **Non-production file (dev probe, script, seed, website demo or i18n tool config) (10):**
  - `AnyVM-Tech/AnyGPT` `apps/api/dev/testApi.ts:162` `gpt-3.5-turbo` (openai)
  - `AnyVM-Tech/AnyGPT` `apps/api/dev/testOpenAISdk.ts:224` `gpt-3.5-turbo` (openai)
  - `AnyVM-Tech/AnyGPT` `apps/api/dev/testWs.ts:41` `gpt-3.5-turbo` (openai)
  - `AnyVM-Tech/AnyGPT` `apps/api/dev/testWs.ts:49` `gpt-3.5-turbo` (openai)
  - `AnyVM-Tech/AnyGPT` `apps/api/dev/removeModelFromProviders.ts:19` `chatgpt-image-latest` (openai)
  - `badhri17/GhazelleChat` `server/db/seed.ts:71` `gpt-5-mini-2025-08-07` (openai)
  - `LocalRouter/LocalRouter` `website/src/components/GuardrailApprovalDemo.tsx:36` `claude-3-5-sonnet-20241022` (openai)
  - `LocalRouter/LocalRouter` `website/src/components/demo/TauriMockSetup.ts:5279` `gpt-4` (openai)
  - `vual/lobe-chat-pro` `.i18nrc.js:28` `chatgpt-4o-latest` (both)
  - `CHARM-BDF/charmonator` `scripts/generate-example-config.js:52` `gpt-3.5-turbo` (openai)
- **Model ID inside prompt or documentation text (7):**
  - `fazxes/Claude-code` `src/tools/AgentTool/built-in/statuslineSetup.ts:42` `claude-3-5-sonnet-20241022` (anthropic)
  - `wk42worldworld/cybercode` `src/tools/AgentTool/built-in/statuslineSetup.ts:42` `claude-3-5-sonnet-20241022` (anthropic)
  - `viperrcrypto/Siftly` `lib/vision-analyzer.ts:68` `gpt-4` (anthropic)
  - `OpenAisec/Miko` `src/tools/AgentTool/built-in/statuslineSetup.ts:42` `claude-3-5-sonnet-20241022` (anthropic)
  - `kill136/claudecode` `src/tools/AgentTool/built-in/statuslineSetup.ts:42` `claude-3-5-sonnet-20241022` (anthropic)
  - `chenqinggang001/claude-code-build` `src/tools/AgentTool/built-in/statuslineSetup.ts:42` `claude-3-5-sonnet-20241022` (anthropic)
  - `wyh0626/claude-code-local` `src/tools/AgentTool/built-in/statuslineSetup.ts:42` `claude-3-5-sonnet-20241022` (anthropic)
- **ChatGPT sign-in (chatgpt.com) model, not an API site by ruling (3):**
  - `OpenAisec/Miko` `desktop/src/constants/openaiOfficialProvider.ts:4` `gpt-5.3-codex` (anthropic)
  - `OpenAisec/Miko` `src/server/api/models.ts:241` `gpt-5.3-codex` (anthropic)
  - `OpenAisec/Miko` `src/services/openaiAuth/models.ts:1` `gpt-5.3-codex` (anthropic)
- **Display name beside the default model id that is sent (2):**
  - `nextai-translator/raycast-openai-translator` `src/providers/claude/config.ts:7` `claude-3-haiku-20240307` (anthropic)
  - `nextai-translator/raycast-openai-translator` `src/providers/openai/config.ts:9` `gpt-3.5-turbo` (anthropic)
- **Display or cost-accounting fallback, not a request (2):**
  - `seongsu-kang/tycono` `packages/server/src/api/src/routes/execute.ts:903` `claude-sonnet-4-5` (anthropic)
  - `seongsu-kang/tycono` `packages/server/src/api/src/routes/execute.ts:1272` `claude-sonnet-4-5` (anthropic)
- **Default model ID key; the labelled site is its entry's apiModel (1):**
  - `badhri17/GhazelleChat` `lib/models/registry.ts:3` `gpt-5-mini-2025-08-07` (openai)
- **Placeholder config in a client-side list transform (1):**
  - `vual/lobe-chat-pro` `src/store/session/slices/session/action.ts:271` `gpt-4` (both)

### Every false negative

- `badhri17/GhazelleChat` `lib/models/registry.ts:27` `gpt-5-mini-2025-08-07` (openai)
- `fazxes/Claude-code` `src/utils/model/configs.ts:45` `claude-sonnet-4-5-20250929` (anthropic)
- `wk42worldworld/cybercode` `src/utils/model/configs.ts:45` `claude-sonnet-4-5-20250929` (anthropic)
- `OpenAisec/Miko` `src/utils/model/configs.ts:50` `claude-sonnet-4-5-20250929` (anthropic)
- `kill136/claudecode` `src/utils/model/configs.ts:45` `claude-sonnet-4-5-20250929` (anthropic)
- `chenqinggang001/claude-code-build` `src/utils/model/configs.ts:45` `claude-sonnet-4-5-20250929` (anthropic)
- `wyh0626/claude-code-local` `src/utils/model/configs.ts:45` `claude-sonnet-4-5-20250929` (anthropic)
