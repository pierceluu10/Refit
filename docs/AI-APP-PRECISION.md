# AI application model sites: precision and recall

This document measures how well Refit's model-retirement detection finds the places where an application chooses a model. It uses the frozen AI application sets: OpenAI ([`2026-10-21-openai-app-repos.json`](benchmarks/2026-10-21-openai-app-repos.json), 100 repositories) and Anthropic ([`2026-10-21-anthropic-app-repos.json`](benchmarks/2026-10-21-anthropic-app-repos.json), 38).

**Removed copies.** The Anthropic set was frozen with 50 repositories. On 2026-10-22 we removed 12 copies of leaked proprietary source: 12 repositories that share one leaked Claude Code source tree. Their labels, negative files and results were removed, and every number on this page was recomputed on the remaining 38 from the committed labels and results. Nothing was rerun. The earlier scoring stages were rescored at their own commits without them.

The detection measured is `refit deadlines --json`: its live exposures, and the evidence file and line of each. The run is static: no Docker, no install, no repository code run, no model request.

`main` already held Refit's output for all 150 repositories (`2026-10-21-openai-app-results.json`, `2026-10-21-anthropic-app-results.json`) and earlier AI-assisted labels. The scripts here do not read them; whether the labeller read them was not recorded.

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
- 40 of the 100 OpenAI repositories (fraction 0.4) and 25 of the 50 Anthropic repositories (fraction 0.5). 6 of the 25 Anthropic draws were among the removed copies, so 19 remain.
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
- A per-provider default in a preset table (`defaultProfiles`, media provider presets with `defaultModel`) is a site: it is sent when the user configures that provider without choosing a model. The other entries in the same preset are a catalog. Google image, video and speech models (Imagen, Veo) reached through Vertex are recorded under `gemini`, the Google provider.
- A model ID written into a system prompt as text is documentation, not a site.
- Probe and diagnostic scripts in a `dev/` folder (`apps/api/dev/testModelLiveProbes.ts`) are non-production. A negative draw that lands on one is replaced.
- Model fields in an API response body (`meta.model` in a search response) and in a scripted fake response are not sites: nothing is sent to a provider.
- After all repositories were labelled and before the labels were committed, a second pass listed every model-shaped literal on a line with a default (`||`, `??`, `default`, `.get(`) that had no label, excluding comparisons. It found two OpenAI sites (`AnyVM-Tech/AnyGPT` semanticMemoryStore embeddings, `utter-one/bonsai` OpenAI TTS) and eight compatible sites; all are labelled.

### Rulings added while labelling the remaining repositories

These cases first appeared outside the sample, and none of them changes a sample label.

- In a model catalog whose selection defaults to the first model with a configured key (`getAvailableModels().at(0)`), the first entry of each provider is a site: it is sent without a choice when that is the only key set.
- A plain string model ID passed to the Vercel AI SDK (`model: 'openai/gpt-5-mini'`) is resolved by the Vercel AI Gateway, a third-party host, so it is recorded as `compatible`. A model passed through a provider package (`openai('gpt-4o-mini')` from `@ai-sdk/openai`) goes to the provider and is a `wrapper` site.
- Azure OpenAI deployments are recorded as `compatible`: Microsoft, not OpenAI, retires them, and the value is a deployment name. Folders whose name ends in `examples` (`other-examples/`) and evaluation harness files (`server/eval-framework.ts`) are non-production. Model IDs inside a commented example config are documentation.
- An alias resolver that maps a family name to a current model ID (`ShinChven/remix-studio` `google.ts`, `if (id.includes('3.5-flash')) return 'gemini-3.5-flash'`) is a remap table, so a catalog; its default parameter is a site.
- A provider-prefixed ID that the application's own gateway splits before the request (`'anthropic:claude-haiku-4-5'`, `'anthropic/claude-sonnet-4-6'` in `inbrainfun/inbrain`) is recorded with its bare model ID. The candidate search does not list the colon form; it was found with a separate search for `provider:model` literals, and only `inbrainfun/inbrain` uses it. Evaluation harnesses under `src/core/*-eval/` and `src/commands/eval-*.ts`, and recipe folders of sample code, are non-production.

## Labels

The labels were made by the AI agent (Claude) running this lane, not by a human, following the guide above. They were committed before detection ran on any sampled repository.

- 252 sites in the 59 sampled repositories: 92 SDK calls, 3 wrapper calls, 6 raw HTTP requests and 151 indirect sites (constants, defaults, settings and preset tables).
- OpenAI sample (40 repositories, 34 with a site): 179 sites. 91 send to OpenAI (23 of them registry models), 13 to Anthropic (5 registry), 50 to Gemini (none registry) and 25 to a compatible host.
- Anthropic sample (19 repositories, all with a site): 95 sites. 41 send to Anthropic (12 registry), 34 to OpenAI (5 registry), 17 to Gemini (none registry) and 3 to a compatible host.
- Six OpenAI-sample repositories have no site: `Dregen-Yor/auto-invoice`, `LangChat/langchat-slides`, `LeafYeeXYZ/PsychPen`, `LocalRouter/LocalRouter`, `Wing900/ManimCat` and `mcaupybugs/minimal-n8n`. Each takes its model from the user or from a router's configuration.
- Only 45 of the 246 non-compatible sites (counted per set; 41 distinct) name a model that `data/deadlines.json` lists. That is the ceiling on what model-retirement detection can report. The registry recall below is scored over those 45 sites, and the all-site recall over all 246.

### Negative files

- `node scripts/ai-app-precision.mjs negatives --output <candidates>` prints the seeded draw order (seed `20261022`, `seededOrder`, over `repo file` strings).
- The labeller took files in that order, kept those with no site, and skipped a file that had a labelled site or was not production code. The labels file records every kept and skipped draw.
- OpenAI took 46 draws to keep 30. Four drawn files had sites not yet labelled (one OpenAI embedding default and three compatible hosts); they were labelled.
- Anthropic kept its first 30 draws. The draw is uniform over files, and 28 of the 30 came from the six sampled copies of the leaked Claude Code tree, so they were removed with them. Only 2 Anthropic negative files remain: too few to say anything about false positives in negative files for that set. Drawing more would need new labelling, which was not done.

## Results

Detection ran from the clean commit `8cd9a44` (the labels commit, with detection code identical to `main` at `7b2c86a`), on the 62 distinct repositories of both samples (56 after the removal), each at its frozen commit. No repository failed to scan. No labelled site fell beyond the evidence limit of 20 per deadline.

- Results: [`benchmarks/2026-10-22-ai-app-model-site-results.json`](benchmarks/2026-10-22-ai-app-model-site-results.json).
- Score, with the corrected labels: [`benchmarks/2026-10-22-ai-app-model-site-score.json`](benchmarks/2026-10-22-ai-app-model-site-score.json).
- Reproduce with `node scripts/ai-app-precision.mjs run --root <checkouts> --results <file>` and `node scripts/ai-app-precision.mjs score --results <file>`.

| Set                         | Precision                        | Registry recall           | All-site recall            | False positives in negative files |
| --------------------------- | -------------------------------- | ------------------------- | -------------------------- | --------------------------------- |
| OpenAI (40 repositories)    | 45.5% (30/66), 95% CI 34.0–57.4% | 96.8% (30/31), 83.8–99.4% | 18.8% (30/160), 13.5–25.5% | 1 of 30 files                     |
| Anthropic (19 repositories) | 60.6% (20/33), 43.7–75.3%        | 100% (20/20), 83.9–100%   | 20.4% (20/98), 13.6–29.4%  | 0 of 2 files                      |

- **Precision:** a reported site counts as true when a label has the same file, line and model.
- **Registry recall:** over labelled sites whose model `data/deadlines.json` lists.
- **All-site recall:** over every labelled OpenAI, Anthropic and Gemini site. Most models in use (`gpt-5`, `claude-sonnet-4-6`, every Gemini model) have no announced retirement yet, so Refit is right not to report them. This number is the ceiling, not a target.
- **Compatible sites:** three reports landed on them (`aihubmix.ts:6` in both sets, Raycast AI in the Anthropic set). They are kept out of precision.

Refit finds nearly every registry model an application in either set sends. What holds precision down is model IDs it reports as live outside requests.

### How the score moved

| Stage                                 | OpenAI precision | OpenAI recall | Anthropic precision | Anthropic recall |
| ------------------------------------- | ---------------- | ------------- | ------------------- | ---------------- |
| As first scored (labels as committed) | 36.5% (27/74)    | 96.4% (27/28) | 39.5% (17/43)       | 100% (17/17)     |
| Scorer fixed (`dfb5e02`)              | 40.3% (27/67)    | 96.4% (27/28) | 48.6% (17/35)       | 100% (17/17)     |
| Labels corrected (`b642b81`)          | 45.5% (30/66)    | 96.8% (30/31) | 60.6% (20/33)       | 100% (20/20)     |

Each Anthropic stage was rescored without the copies, with the scorer, labels and registry of its commit.

- **Scorer fix:**
  - The first score counted Meta Graph API-version exposures (`graph.facebook.com/v17.0` in `utter-one/bonsai`, `kgoedecke/doop` and `backenly/backenly`). They are outside this benchmark and are now excluded.
  - It also counted reports at labelled compatible sites as false positives, but the guide keeps those out of the scores.
  - The run itself was not repeated, since detection code did not change.
- **Label corrections, all found by reading Refit's reports:**
  - `nextai-translator/raycast-openai-translator`: three default-model labels sat on the `name:` line. The `id:` line one above is what is sent, and the labels moved there. Refit reports both lines, so the two `name:` reports are now false positives.
  - `vual/lobe-chat-pro`: the DALL-E tool payload (`src/services/textToImage.ts:17`), the painting palette default (`src/store/palette/initialState.ts:18`) and the providers' connection-check models (`checkModel` for OpenAI, Anthropic, Google and Vertex AI) were missed. The connection checks follow the same ruling as `OpenCoworkAI/open-cowork`'s diagnostics model. AiHubMix and Bedrock connection checks were added as compatible sites.

## False positives by cause

All 49 false positives (41 distinct sites, since three repositories are in both samples) were read in full. The appendix lists them with the rest of the repositories, each sample repository marked.

| Cause                                                                                                                                                           | OpenAI | Anthropic | Where                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: | --------: | ------------------------------------------------------------------------------------- |
| Catalog or remap table: `add('…')` builder calls, model-bank `id:` entries, identity remaps                                                                     |      8 |         2 | AnyGPT, lobe-chat-pro, charmonator                                                    |
| UI option, label or form default: `<SelectItem value>`, JSX `label={'tts-1'}`, Angular settings form defaults, cookie and `localStorage` seeds, a picker button |     16 |         4 | visual-journal, lobe-chat-pro, three Goofish forks, dalle-3-ui, PsychPen, charmonator |
| Non-production file: `dev/` probes, `scripts/`, `server/db/seed.ts`, `website/` demos, `.i18nrc.js`                                                             |     10 |         1 | AnyGPT, charmonator, GhazelleChat, LocalRouter, lobe-chat-pro                         |
| Model ID inside prompt or documentation text in a string                                                                                                        |      0 |         1 | Siftly                                                                                |
| Display name beside the default model `id:` that is sent                                                                                                        |      0 |         2 | raycast-openai-translator                                                             |
| Display or cost-accounting fallback, not a request                                                                                                              |      0 |         2 | tycono                                                                                |
| Default model ID used as a lookup key (the labelled site is the entry's `apiModel`)                                                                             |      1 |         0 | GhazelleChat                                                                          |
| Placeholder group config in a client-side list transform                                                                                                        |      1 |         1 | lobe-chat-pro                                                                         |
| **Total**                                                                                                                                                       | **36** |    **13** |                                                                                       |

The one false positive in a negative file is `LeafYeeXYZ/PsychPen` `src/components/data/ConfigAI.tsx:264`: a button that sets the model to `gpt-5.1` when the user clicks it.

## False negatives by cause

- **No Anthropic misses.** All six earlier misses were in the removed copies.
- **One OpenAI miss.** `badhri17/GhazelleChat` `lib/models/registry.ts:27` is the `apiModel` of the default entry in a model registry array, marked as a catalog. Refit reports the default's lookup key at line 3 instead, a false positive one hop from the real site. A user fixing that report would still find the right entry.

## All repositories

Keep going: the 79 repositories outside the sample were then labelled the same way, in the same seeded order (73 after the removal). Their labels were committed (`af3f5e4`) before detection ran on them. [`benchmarks/2026-10-22-ai-app-model-sites-all.json`](benchmarks/2026-10-22-ai-app-model-sites-all.json) holds all 625 sites over the 129 distinct repositories of both lists:

- 211 SDK calls, 17 wrapper calls, 15 raw HTTP requests and 382 indirect sites;
- 60 of the sites go to compatible hosts.

The negative files are the sample's 32 (30 OpenAI, 2 Anthropic). Detection ran from the clean `af3f5e4`. Results: [`benchmarks/2026-10-22-ai-app-model-site-all-results.json`](benchmarks/2026-10-22-ai-app-model-site-all-results.json); score: [`benchmarks/2026-10-22-ai-app-model-site-score-all.json`](benchmarks/2026-10-22-ai-app-model-site-score-all.json).

| Set                                             | Precision                  | Registry recall           | All-site recall            |
| ----------------------------------------------- | -------------------------- | ------------------------- | -------------------------- |
| OpenAI (100 repositories)                       | 62.1% (82/132), 53.6–69.9% | 96.5% (82/85), 90.1–98.8% | 20.1% (82/407), 16.5–24.3% |
| Anthropic (38 repositories)                     | 71.2% (42/59), 58.6–81.2%  | 95.5% (42/44), 84.9–98.7% | 19.3% (42/218), 14.6–25.0% |

- **Not fully blind.** The 56 sample repositories in this table carry the 12 label corrections made after reading Refit's output (`b642b81`). Only the 73 remaining repositories are blind. Scored on those 73 alone, as rescored from the committed results and labels: OpenAI 76.7% (46/60) precision and 95.8% (46/48) registry recall; Anthropic 84.0% (21/25) and 91.3% (21/23).
- Reading every new report in the remainder found no labelling miss, so no correction was needed.

False positives in all repositories, by cause:

| Cause                                                                                                               | OpenAI | Anthropic |
| ------------------------------------------------------------------------------------------------------------------- | -----: | --------: |
| Catalog or remap table                                                                                              |      8 |         2 |
| UI option, label or form default                                                                                    |     21 |         4 |
| Non-production file (`dev/`, `scripts/`, examples, recipes, eval harness constants, seed, `website/`, `.i18nrc.js`) |     15 |         5 |
| Model ID inside prompt or documentation text                                                                        |      0 |         1 |
| Display or cost-accounting fallback                                                                                 |      1 |         2 |
| Tokenizer default (`TiktokenModel = 'gpt-3.5-turbo'`)                                                               |      2 |         0 |
| Display name beside the sent `id:`                                                                                  |      0 |         2 |
| Default model ID used as a lookup key                                                                               |      1 |         0 |
| Placeholder group config                                                                                            |      1 |         1 |
| A string that only looks like a model ID (an avatar named `o1`)                                                     |      1 |         0 |
| **Total**                                                                                                           | **50** |    **17** |

Misses in all repositories, by cause:

- **`defaultModel:` inside a provider preset table (3):** `Koifman/LUMEN` `llmService.ts:55` and `:65`, and `joeseesun/qiaomu-blog-opensource` `ai-image-provider-presets.ts:35`. Refit takes the preset object as a catalog, but the code sends its `defaultModel` when the user picks no model.
- **The first entry of a provider's model list, used as the default (1):** `kaieye/Livo` `types/ai.ts:190`.
- **The `apiModel` of a registry entry (1):** `badhri17/GhazelleChat`, as in the sample.

## Requests for other lanes

Ranked by the sites each fix would recover across all 129 repositories: false positives removed plus misses found. Each total is followed by the sample's count. Counts are per set (OpenAI + Anthropic), so a repository in both lists counts twice. No detection code is changed here.

**FG9 (model-retirement wedge):**

1. **UI options and labels (25 sites; sample 20):** `<SelectItem value=…>` and similar option components; JSX `label={'…'}` and option `value` in settings constant files; Angular `frontend/` form defaults; settings-page default objects; cookie and `localStorage` seeds; click handlers that set a model. The `<option>` rule already exists, so this widens it to component libraries.
2. **Non-production paths (20 sites; sample 11):**
   - `dev/` folders (5, AnyGPT);
   - `scripts/` folders, including `app/scripts/` (3);
   - folders named `examples`, `other-examples` or `recipes` (3);
   - `website/` demo folders (2);
   - eval-harness constants (4, `beatrix-ha/beatrix` in both sets);
   - `server/db/seed.ts` (1);
   - the `.i18nrc.js` translation tool config (2, both sets).
3. **More catalog shapes (10 sites; sample 10):**
   - `add('model')` calls that build a model list (4, AnyGPT);
   - `id:` entries in an array of model objects under `model-bank` or `aiModels` (4, lobe-chat-pro, both sets);
   - identity remap objects (`{ 'gpt-4': 'gpt-4' }`, 2, charmonator).
4. **Smaller fixes (7 sites):**
   - `TiktokenModel` default parameters are tokenizer use (2);
   - in a `{ id: 'm', name: 'm' }` default-model object, report the `id:` line only (2);
   - usage and cost-accounting fields (`usage_model: 'whisper-1'`) are not requests (3).
5. **`defaultModel:` in a provider preset table is live (3 misses; sample 0)**, and so is the first entry of a provider's list when the code picks `models[0]` as the default (1 miss).
6. **Model IDs in prompt text (1 site; sample 1):** a model ID inside a template literal of prompt text (`viperrcrypto/Siftly`).

**FP3 (AI wrapper SDKs):**

- Across all repositories, 17 of 625 sites go through a wrapper SDK: `@ai-sdk/openai` and `@ai-sdk/anthropic` providers, Stagehand, `@inngest/agent-kit` and pi-ai's `getModel`.
- Only one names a registry model, `hugodemenez/deltalytix` `openai("gpt-4o-mini-2024-07-18")`, and Refit finds it. So wrapper recall is not a gap this benchmark can show.
- A larger risk for FP3 is the 13 Vercel AI SDK string IDs in deltalytix (`model: 'openai/gpt-5-mini'`). They go to the Vercel AI Gateway, and Refit should not credit them to OpenAI if it starts matching provider-prefixed IDs.

**Side finding, for whichever lane owns Meta Graph detection:** in `utter-one/bonsai`, Refit lists `tests/e2e/alert-notifiers-p4-02.test.ts:213` and `tests/unit/monitoring/p4-02-notifiers.test.ts:444` as live evidence for Graph API v17.0. Both are test files, so they should be `test` use. This was seen while excluding Meta Graph from this score and was not measured.

**Needs owner decision:** whether models sent through ChatGPT sign-in (the `chatgpt.com/backend-api/codex` endpoint) count as OpenAI API sites. OpenAI retiring `gpt-5.3-codex` would break them, but the API deprecation pages may not cover that endpoint. The case arose only in repositories since removed, so no current label depends on it.

## Limits

- **One labeller.** The labeller is an AI agent, and a second labeller was not used. The twelve label changes in the correction (three moved, nine added) came only from Refit's reports. Misses that Refit also missed stay invisible, so all-site recall is an upper bound on what the labels cover.
- **Removed copies.** The 12 removed repositories (six in the sample) shared one leaked Claude Code source tree and had dominated the Anthropic set's errors. With them went 28 of its 30 negative files.
- **What the candidate search can see.** It reads model-shaped literals of major providers. Compatible sites (DeepSeek, Groq, Qwen and the like) are under-recorded, which does not affect the scores.
- **Small denominators.** In the sample, registry recall rests on 31 and 20 sites, and across all repositories on 85 and 44, with the intervals shown.
- **Scope.** JavaScript, TypeScript and Python files were labelled. Refit's model scan reads JavaScript and TypeScript, and no labelled site is in a Python file in this sample.

## Appendix

### Every false positive

All repositories. Each is listed once; "both" marks a repository in both lists, counted in each set, and "sample" marks a repository in the seeded sample.

- **Catalog or remap table (8):**
  - `AnyVM-Tech/AnyGPT` `apps/api/modules/modelUpdater.ts:920` `gpt-4o-mini-transcribe` (openai, sample)
  - `AnyVM-Tech/AnyGPT` `apps/api/modules/modelUpdater.ts:923` `gpt-4o-transcribe` (openai, sample)
  - `AnyVM-Tech/AnyGPT` `apps/langgraph-control-plane/src/workflow.ts:3116` `gpt-4o-mini-transcribe` (openai, sample)
  - `AnyVM-Tech/AnyGPT` `apps/langgraph-control-plane/src/workflow.ts:3119` `gpt-4o-transcribe` (openai, sample)
  - `vual/lobe-chat-pro` `packages/model-bank/src/aiModels/azure.ts:1215` `dall-e-3` (both, sample)
  - `vual/lobe-chat-pro` `packages/model-bank/src/aiModels/azure.ts:1201` `gpt-image-1` (both, sample)
  - `CHARM-BDF/charmonator` `lib/config.mjs:214` `gpt-3.5-turbo` (openai, sample)
  - `CHARM-BDF/charmonator` `lib/config.mjs:215` `gpt-4` (openai, sample)
- **UI option, label or form default (20):**
  - `keegandonley/dalle-3-ui` `src/components/Prompt/index.tsx:95` `gpt-image-1` (openai, sample)
  - `YiZhanSuDaShui/GoofishCredentialsBot` `frontend/src/app/views/system-setting/system-setting.component.ts:26` `gpt-3.5-turbo` (openai, sample)
  - `MisonL/visual-journal` `src/components/editing-form.tsx:1455` `gpt-image-1` (openai, sample)
  - `MisonL/visual-journal` `src/components/generation-form.tsx:1021` `gpt-image-1` (openai, sample)
  - `MisonL/visual-journal` `src/components/editing-form.tsx:1454` `gpt-image-1.5` (openai, sample)
  - `MisonL/visual-journal` `src/components/editing-form.tsx:1456` `gpt-image-1-mini` (openai, sample)
  - `MisonL/visual-journal` `src/components/generation-form.tsx:1020` `gpt-image-1.5` (openai, sample)
  - `MisonL/visual-journal` `src/components/generation-form.tsx:1022` `gpt-image-1-mini` (openai, sample)
  - `vual/lobe-chat-pro` `src/app/[variants]/(main)/settings/tts/features/const.tsx:12` `tts-1` (both, sample)
  - `vual/lobe-chat-pro` `src/app/[variants]/(main)/settings/tts/features/const.tsx:16` `tts-1-hd` (both, sample)
  - `vual/lobe-chat-pro` `src/app/[variants]/(main)/settings/tts/features/const.tsx:23` `whisper-1` (both, sample)
  - `vual/lobe-chat-pro` `src/app/[variants]/(main)/settings/tts/features/const.tsx:24` `whisper-1` (both, sample)
  - `Jay-Bosco/GoofishCredentialsBot` `frontend/src/app/views/system-setting/system-setting.component.ts:26` `gpt-3.5-turbo` (openai, sample)
  - `LeafYeeXYZ/PsychPen` `src/components/data/ConfigAI.tsx:264` `gpt-5.1` (openai, sample, negative file)
  - `lrzy8/Goofish` `frontend/src/app/views/system-setting/system-setting.component.ts:30` `gpt-3.5-turbo` (openai, sample)
  - `CHARM-BDF/charmonator` `public/script.js:118` `o1` (openai, sample)
  - `hyunwookshin/iodine` `client/src/components/right/CodingAssistant.tsx:22` `tts-1-hd` (openai)
  - `JaleelB/readium-x` `app/account/settings/text-to-speech/page.tsx:102` `tts-1` (openai)
  - `JaleelB/readium-x` `app/account/settings/text-to-speech/page.tsx:155` `tts-1` (openai)
  - `JaleelB/readium-x` `app/account/settings/text-to-speech/page.tsx:479` `tts-1` (openai)
- **Non-production file (dev probe, script, seed, website demo or i18n tool config) (17):**
  - `AnyVM-Tech/AnyGPT` `apps/api/dev/testApi.ts:162` `gpt-3.5-turbo` (openai, sample)
  - `AnyVM-Tech/AnyGPT` `apps/api/dev/testOpenAISdk.ts:224` `gpt-3.5-turbo` (openai, sample)
  - `AnyVM-Tech/AnyGPT` `apps/api/dev/testWs.ts:41` `gpt-3.5-turbo` (openai, sample)
  - `AnyVM-Tech/AnyGPT` `apps/api/dev/testWs.ts:49` `gpt-3.5-turbo` (openai, sample)
  - `AnyVM-Tech/AnyGPT` `apps/api/dev/removeModelFromProviders.ts:19` `chatgpt-image-latest` (openai, sample)
  - `badhri17/GhazelleChat` `server/db/seed.ts:71` `gpt-5-mini-2025-08-07` (openai, sample)
  - `LocalRouter/LocalRouter` `website/src/components/GuardrailApprovalDemo.tsx:36` `claude-3-5-sonnet-20241022` (openai, sample)
  - `LocalRouter/LocalRouter` `website/src/components/demo/TauriMockSetup.ts:5279` `gpt-4` (openai, sample)
  - `vual/lobe-chat-pro` `.i18nrc.js:28` `chatgpt-4o-latest` (both, sample)
  - `CHARM-BDF/charmonator` `scripts/generate-example-config.js:52` `gpt-3.5-turbo` (openai, sample)
  - `thereactfoundation/react.foundation` `scripts/generate-collection-images.mjs:338` `gpt-image-1` (openai)
  - `projectshft/mini-rag` `app/scripts/upload-training-data.ts:69` `gpt-4o-mini-2024-07-18` (openai)
  - `beatrix-ha/beatrix` `server/anthropic.ts:25` `claude-3-7-sonnet-20250219` (both)
  - `beatrix-ha/beatrix` `server/openai.ts:29` `gpt-4-turbo` (both)
  - `membranehq/ai-agent-example` `other-examples/claude-sdk.ts:26` `claude-3-5-sonnet-20241022` (openai)
  - `inbrainfun/inbrain` `recipes/agent-voice/code/server.mjs:47` `gpt-4o-realtime-preview` (anthropic)
  - `inbrainfun/inbrain` `recipes/agent-voice/code/pipeline.mjs:303` `tts-1` (anthropic)
- **Model ID inside prompt or documentation text (1):**
  - `viperrcrypto/Siftly` `lib/vision-analyzer.ts:68` `gpt-4` (anthropic, sample)
- **Display or cost-accounting fallback, not a request (3):**
  - `kirill-markin/chatgpt-telegram-bot-telegraf` `src/database/database.ts:362` `whisper-1` (openai)
  - `seongsu-kang/tycono` `packages/server/src/api/src/routes/execute.ts:903` `claude-sonnet-4-5` (anthropic, sample)
  - `seongsu-kang/tycono` `packages/server/src/api/src/routes/execute.ts:1272` `claude-sonnet-4-5` (anthropic, sample)
- **Tokenizer default (2):**
  - `kirill-markin/chatgpt-telegram-bot-telegraf` `src/utils/encodingUtils.ts:3` `gpt-3.5-turbo` (openai)
  - `kirill-markin/chatgpt-telegram-bot-telegraf` `src/utils/encodingUtils.ts:14` `gpt-3.5-turbo` (openai)
- **Display name beside the default model id that is sent (2):**
  - `nextai-translator/raycast-openai-translator` `src/providers/claude/config.ts:7` `claude-3-haiku-20240307` (anthropic, sample)
  - `nextai-translator/raycast-openai-translator` `src/providers/openai/config.ts:9` `gpt-3.5-turbo` (anthropic, sample)
- **Default model ID key; the labelled site is its entry's apiModel (1):**
  - `badhri17/GhazelleChat` `lib/models/registry.ts:3` `gpt-5-mini-2025-08-07` (openai, sample)
- **Placeholder config in a client-side list transform (1):**
  - `vual/lobe-chat-pro` `src/store/session/slices/session/action.ts:271` `gpt-4` (both, sample)
- **String that only looks like a model ID (an avatar name) (1):**
  - `Emanuele-Sgroi/emanuelesgroi.com` `src/components/DiscussionsPage/DiscussionSideBar.js:184` `o1` (openai)

### Every false negative

- `badhri17/GhazelleChat` `lib/models/registry.ts:27` `gpt-5-mini-2025-08-07` (openai, sample)
- `joeseesun/qiaomu-blog-opensource` `lib/ai-image-provider-presets.ts:35` `gpt-image-1` (openai)
- `kaieye/Livo` `src/shared/types/ai.ts:190` `claude-sonnet-4-20250514` (openai)
- `Koifman/LUMEN` `src/lib/llm/llmService.ts:55` `gpt-5.1` (anthropic)
- `Koifman/LUMEN` `src/lib/llm/llmService.ts:65` `claude-sonnet-4-5` (anthropic)
