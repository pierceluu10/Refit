# Deadline benchmark, October 22, 2026

This refreshes the [deadline benchmark](DEADLINE-BENCHMARK.md) against today's registry (`data/deadlines.json`, 60 entries) and adds a second, fresh blind sample. It covers two samples and one comparison:

1. **The 100-repository set** ([`2026-10-16-deadline-repos.json`](benchmarks/2026-10-16-deadline-repos.json)), rerun with the October 16 code and with today's.
2. **The October 16 fresh sets** (Shopify 200, Stripe 381), rescanned and compared line by line with [`2026-10-16-deadline-fresh-results.json`](benchmarks/2026-10-16-deadline-fresh-results.json).
3. **A fresh blind sample** of 100 public JS/TS applications in no existing frozen list. Every loose-search line was labelled before Refit ran on any of them.

No matcher code is changed here; fixes are listed under [Requests for other lanes](#requests-for-other-lanes). No repository code was installed or run, no vendor API was called, and no scanned repository was contacted. Scans ran from clean, pinned worktrees: `0e911e5` (October 16, live-only evidence) and `7b2c86a` (`main` today).

## Summary

- **The registry grew by 13 entries since October 16:** 12 Anthropic model retirements (October 20) and the end of support for Gemini's `@google/generative-ai` (October 21). No OpenAI, Meta or Shopify entry changed.
- **The 100-repository set:**
  - Every change since October 16 is explained by those 13 entries, or by one matcher change: model records are now read as catalogs.
  - Scores on the 32 labelled repositories are unchanged: 28/28 repository precision and recall.
  - 15 of the 34 OpenAI repositories still send a model OpenAI retires tomorrow (2026-10-23) from a live path.
- **The October 16 fresh sets:**
  - Live exposure rose from 62 to 63 Shopify apps and from 65 to 90 Stripe apps.
  - All 50 added (repository, deadline) pairs are the new Anthropic and Gemini entries. Nothing was added or removed for the old providers.
- **The fresh blind sample (100 applications, 2,135 labelled lines):**
  - 64 are exposed to a registry deadline from live code.
  - Refit flags 62 of them (repository recall 96.9%), with 80.5% repository precision.
  - It finds 96.4% of the live lines, but only half the lines it reports as live are live (50.6%). Model catalogs, UI options, preset masks and API-version test files make up most of the rest.
- **Test and comment use:**
  - Every line Refit marks as test is a test (254/254).
  - It marks 77.9% of the labelled test lines that name a model as a literal as test.
  - Comment classification is 81.1% precise with 76.9% recall. 7 commented-out lines are reported as live.
- **OpenAI's 2026-10-23 shutdown, fresh sample:**
  - 11 of the 100 fresh applications (11%, 95% CI 6.3–18.6%) send a model retired that day from a live path.
  - Refit flags all 11, plus 8 that only list such a model (flag precision 11/19).
- **New providers (Keep going):**
  - **Anthropic:** in the fresh sample, repository recall is 100% (13/13) but precision 59.1% (13/22).
  - **Gemini's SDK end of support:** 90.9% precision and recall (10/11).

## 1. The 100-repository set, rerun

Following the original Reproduce section, `scripts/deadline-benchmark-setup.mjs` rebuilt the clones at their pinned commits and scanned them twice:

- from `0e911e5`, the October 16 "classified" run;
- from `main` at `7b2c86a`.

[Results](benchmarks/2026-10-22-deadline-rerun-results.json).

- **Both scans match October 16.** The rebuilt `0e911e5` scan flags 87 of 100, as published.
- **`ozzyonfire/shopify-next-app`** still exceeds the scan limits and counts as not flagged.
- **`Ramtx/Bouno`** first failed to check out, because the clone ran without git-lfs. It was re-cloned with the LFS filter off and scanned normally. Its October 16 result (not flagged) is unchanged in the `0e911e5` scan.

| Labelled subset (32), as of 2026-10-22 | October 16 code (`0e911e5`) | Today (`7b2c86a`) |
|---|---|---|
| Repository precision | 28/28, 100% | 28/28, 100% |
| Repository recall | 28/28, 100% | 28/28, 100% |
| Repository × deadline recall | 36/37, 97.3% | 36/37, 97.3% |
| Line precision, OpenAI / Meta / Shopify lines | 81/89, 91.0% | 81/89, 91.0% |
| Line recall | 96/107, 89.7% | 96/107, 89.7% |
| Flagged, all 100 | 87 | 87 |
| OpenAI repositories flagged for 2026-10-23 | 20 | 19 |
| Live call path uses a 2026-10-23 model | 15/34, 44.1% (28.9–60.5) | 15/34, 44.1% (28.9–60.5) |
| Precision of the 2026-10-23 flag | 15/20, 75% | **15/19, 78.9%** (56.7–91.5) |

The original scorer counts today's 3 new Anthropic lines in labelled repositories as unlabelled. That makes its line precision read 81/92. They are scored below with their own labels.

### False positives and misses on the labelled 32, today

These are the same lines October 16 reported. The matcher changes since then touched none of them.

- **8 lines reported as live that are not live:**
  - 4 entries of an unused model map in `hervekom37/Ani-Code-CLI` `src/utils/openai-models.ts` (lines 23, 25, 30, 31). The same map in `src/core/agent.ts` is live, so only tracing imports could tell them apart.
  - The GraphQL codegen config `.graphqlrc.ts:11` in `cdolan04/gc-ai-demo` and in `ProofPulse7/push-eagle`.
  - Two lines of a store seeding script (`cdolan04/gc-ai-demo` `scripts/seed-store.ts:27`, `:501`). Shopify gets no `test` class.
- **11 missed live lines:**
  - 10 are Shopify Admin API versions held in constants or env-var fallbacks, which Refit does not read. They are 9 in `ProofPulse7/push-eagle` (`shopify-billing.server.ts:147` and eight more) and `abaziqendrim435-lang/rootx.app` `lib/shopify-api.ts:211`.
  - The 11th is the Meta JS SDK's `FB.init` version in `shreevalikushe/facebook-test` `src/Facebook.tsx:14`.
  - Each of those repositories is still flagged through another line. The `FB.init` miss is also the one (repository, deadline) miss.

### Every change since October 16

| Change | Repositories |
|---|---|
| **New Anthropic and Gemini entries: 13 live exposures** | `hervekom37/Ani-Code-CLI`, `vual/ChatGPT-Next-Web-Pro` (5), `Ramtx/Bouno`, `fahd09/openharness` (2), `khatrikrish630/new-fb-ai-agent`, `cdolan04/gc-ai-demo`, `abaziqendrim435-lang/rootx.app` (Anthropic), and `LakshAgrawal28/CreatorOS` (Gemini SDK) |
| **New entries: 30 mentions** (named only outside live code) | `chinmaymk/aikit` (9), `vual/ChatGPT-Next-Web-Pro` (5), `hervekom37/Ani-Code-CLI` (4), `AQComputerKing/protoforge` (3), and six others with 1–2 each |
| **Newly flagged** | `Ramtx/Bouno`, for Claude Sonnet 4 (2026-06-15) in its default settings |
| **Model records read as catalogs** (`5e5b6dc`, `24cf764`) | `xavidop/genkitx-github`: 5 OpenAI exposures became mentions, so it is no longer flagged. October 16 listed it as a false 2026-10-23 flag. `lianginx/chatgpt-nuxt`: `server/api/models.get.ts` lines 39 and 45 became catalog, so its `gpt-4` exposure is now a mention; its two live `gpt-3.5-turbo` lines in `stores/chat.ts` are unchanged |

Nothing else changed: no other OpenAI, Meta or Shopify exposure, evidence line or mention.

### New providers in the 100-repository set (Keep going)

These labels are **not blind**: they were made after both runs, from the loose search, which now reads Anthropic models and SDK manifests too ([labels](benchmarks/2026-10-22-deadline-new-provider-labels.json), 121 lines in 16 repositories).

| 100-repository set | Anthropic | Gemini SDK |
|---|---|---|
| Repositories with a live use | 6 | 1 |
| Repository precision | 6/7, 85.7% | 1/1 |
| Repository recall | 6/6 | 1/1 |
| Line precision | 6/14, 42.9% | 1/1 |
| Line recall | 6/6 | 1/1 |
| Comment lines listed as comment | 11/17 | |

Anthropic line precision is low for two reasons:

- **Commented-out code:** six commented-out lines in `vual/ChatGPT-Next-Web-Pro` (`//   name: "claude-instant-1.2",`) are reported as live.
- **An alias map:** `fahd09/openharness`'s `ANTHROPIC_ALIASES` map is reported as live. That is by design; October 16 already recorded the same map as a false 2026-10-23 flag.

`chamath-shanaka/heurista-demo` declares `@google/generative-ai` but never imports it, and Refit correctly leaves it unflagged.

## 2. The October 16 fresh sets, rescanned

The same command as October 16 (`refit deadlines --repository <clone> --json`) ran over both fresh sets from `7b2c86a` ([results](benchmarks/2026-10-22-deadline-fresh-sets-results.json), in the October 16 format). The same 2 Shopify and 4 Stripe repositories exceed the scan limits on both dates.

| Live exposure | October 16 (`5f94ab4`) | Today (`7b2c86a`) | Added pairs |
|---|---|---|---|
| Fresh Shopify 200 | 62 | 63 | 5: 3 Anthropic, 2 Gemini SDK, in 5 apps |
| Fresh Stripe 381 | 65 | 90 | 45: 24 Anthropic in 14 apps, 21 Gemini SDK in 21 apps |

- **Every added pair is a new entry.** No exposure to an OpenAI, Meta or Shopify deadline was added or removed in either set, so the catalog-record change did not touch them.
- **The 25 newly exposed Stripe apps** are 18 apps on the old Gemini SDK, and 7 whose only registry exposure is an Anthropic model.

## 3. A fresh blind sample

### Drawing it

`scripts/deadline-benchmark-sample.mjs` now takes a query file, a list of frozen lists to exclude, and an application check. With those, it drew 100 applications ([list](benchmarks/2026-10-22-deadline-fresh-repos.json), [frame](benchmarks/2026-10-22-deadline-fresh-frame.json)).

- **Queries.** There were 18 `gh search code` queries on 2026-10-22 at 10:28 UTC, each keeping its first 100 hits. Each query names a registry version, in TypeScript or JavaScript:
  - **OpenAI:** `o3-mini`, `"gpt-4-turbo"`, `dall-e-3`, `whisper-1`, `gpt-4.1-nano`, `gpt-image-1`.
  - **Anthropic:** `claude-3-5-sonnet-20241022`, `claude-3-haiku-20240307`, `claude-sonnet-4-20250514`, `claude-3-7-sonnet-20250219`.
  - **Meta:** `graph.facebook.com/v21.0`, `/v22.0`, `/v17.0`.
  - **Shopify:** `admin/api/2025-04`, `/2026-01`, `/2025-07`.
  - **Gemini:** `"@google/generative-ai"` in TypeScript and in JavaScript.
- **Frame.** 485 OpenAI, 318 Anthropic, 267 Meta, 131 Shopify and 192 Gemini repositories.
- **Draw.** Each provider's repositories were sorted, then shuffled with mulberry32 seeded from `refit-deadlines-fresh-2026-10-22:<provider>`. They were taken in that order until the quota was met: 35 OpenAI, 25 Anthropic, 15 Meta, 15 Shopify and 10 Gemini.
- **Filters.** A repository had to:
  - not be archived or a fork;
  - have been pushed since 2025-07-01;
  - be under 50 MB;
  - have a root `package.json` that looks like an application: private, no package entry point, or an app framework dependency.
- **Exclusions.** Every repository in a frozen list under `docs/benchmarks/` was excluded, as was OG1's inventory list (PR #172).
- **What was examined.** 238 repositories were examined and 138 rejected:
  - 78 not pushed since July;
  - 21 libraries;
  - 14 too large;
  - 16 without a (root) `package.json`;
  - 7 already in a frozen list;
  - 2 with an unreadable manifest.
- **Pins.** Commits are pinned. The median repository has 6 stars, and 32 have none.

### Labelling it

The labels were made by the AI agent (Claude) running this lane, not a human ([labels](benchmarks/2026-10-22-deadline-fresh-labels.json)).

1. **Clone only.** The repositories were cloned with `deadline-benchmark-setup.mjs --clone-only`, which reads nothing with Refit.
2. **Loose search.** `scripts/deadline-benchmark-grep.mjs` found every line naming a registry version, quoted or not, in code or comments. It now also reads Anthropic model IDs and SDK names in `package.json` ([output](benchmarks/2026-10-22-deadline-fresh-grep.json)).
3. **Labels.** Each of its 2,134 lines got one label:
   - **live:** a pin on a live path, meaning a request argument, a default, a setting fallback, or a dependency production code imports;
   - **catalog:** an entry in a model list, picker, type union, price or context table, remap, or preset the user picks;
   - **test:** tests, mocks, examples, demos, docs, seed data, and maintenance or build scripts;
   - **comment:** inside a comment;
   - **other:** a match that selects nothing at the provider. That covers checks and regexes, help and UI text, placeholders, tokenizer arguments, records, declared-but-unused dependencies, and IDs sent to another host (OpenRouter, OpenClaw, the ChatGPT Codex backend).
4. **How lines were labelled.** Path rules proposed `test` for 902 lines, and a comment rule proposed `comment` for 134. Every other line (1,098) was read in context, file by file. The proposals were then checked:
   - A tool whose whole job is a script was relabelled live (`a787825/shopify-content-sync`).
   - 44 `comment` proposals were read again, because they were on lines that do not start with a comment marker: the block-comment rule misfires on strings containing `/*`. 35 became `catalog`, 6 `other` and 1 `live` (later corrected back to `comment`), and 2 were confirmed.
5. **Rulings, decided once:**
   - An SDK end-of-support entry is labelled at the manifest dependency line, when production code imports the package. Import lines are `other`. One app that imports the SDK without declaring it has its import labelled live.
   - The ChatGPT Codex backend, OpenRouter IDs and Vercel AI Gateway string IDs are `other`, not OpenAI.
   - A model the Codex or Claude CLI sends is the CLI's request, not the repository's.
   - Default model IDs that seed a settings form are `catalog`.
   - Meta and Shopify calls in test routes and scripts are `test`.
6. **Order.** The labels were committed (`a7924c7`) before Refit ran on any fresh repository.
7. **Correction.** One correction, found by reading Refit's reports, is in its own commit (`b2eaa2f`):
   - `SailedApple1991/greenlaw-ai` `app/api/chat/route.ts:167` was relabelled live → comment. The call sits inside a block comment, and Refit was right.
   - `hcassar93/meta-ads-cli` `package.json:50` was added as `other`. Its Meta Business SDK dependency is declared but never imported, and the loose search does not read that dependency.

   Before the correction, repository and line scores differ by at most one line: line precision 239/471, line recall 239/249.

### Results

Scanned from `7b2c86a` with `scripts/deadline-fresh-score.mjs` ([results](benchmarks/2026-10-22-deadline-fresh-sample-results.json), [score](benchmarks/2026-10-22-deadline-fresh-sample-score.json)). All 100 scanned.

| Fresh sample | All | OpenAI | Anthropic | Meta | Shopify | Gemini SDK |
|---|---|---|---|---|---|---|
| Repositories with a live use | 64 | 21 | 13 | 16 | 13 | 11 |
| Repository precision | 62/77, 80.5% (70.3–87.8) | 20/27, 74.1% | 13/22, 59.1% | 16/18, 88.9% | 13/15, 86.7% | 10/11, 90.9% |
| Repository recall | 62/64, 96.9% (89.3–99.1) | 20/21 | 13/13 | 16/16 | 13/13 | 10/11 |
| (Repository, deadline) precision | 89/145, 61.4% | 32/55 | 16/42 | 18/21 | 13/16 | 10/11 |
| (Repository, deadline) recall | 89/91, 97.8% | 32/33 | 16/16 | 18/18 | 13/13 | 10/11 |
| Live line precision | 239/472, 50.6% (46.1–55.1) | 48/158, 30.4% | 59/145, 40.7% | 91/118, 77.1% | 31/40, 77.5% | 10/11 |
| Live line recall | 239/248, 96.4% (93.2–98.1) | 48/49 | 59/60 | 91/92 | 31/36, 86.1% | 10/11 |

**Use classification:** for each labelled line Refit lists, its use compared with the label.

| | Precision | Recall |
|---|---|---|
| Test | 254/254, 100% (98.5–100) | 254/326, 77.9% (73.1–82.1) |
| Comment | 30/37, 81.1% (65.8–90.5) | 30/39, 76.9% (61.7–87.4) |
| Catalog | 420/444, 94.6% (92.1–96.3) | 420/563, 74.6% (70.8–78.0) |

- **Excluded from recall:**
  - 251 labelled lines of deadlines whose listed evidence was cut at the 20-line limit.
  - 583 lines that name a model only in prose, such as a test title (`'should parse reasoning content (o1 model)'`), a sentence or a comment word. Refit's matcher reads string tokens, so it never lists these by design.
  - This prose rule (`namesLiteral` in `scripts/deadline-fresh-helpers.mjs`) was added after the first score, once the unlisted test lines turned out to be mostly prose. With prose counted, recall was 254/762 (33.3%) for test, 29/75 for comment and 420/604 for catalog. Precision and live-line scores are the same either way.
- **Most missed test lines are reported as live:** 55 test lines are reported live. 34 are Meta and Shopify calls in test routes and scripts: API-version providers get only comment, tokenizer and check classes, so their tests count as live by design.
- **OpenAI test lines** are classified well: 166/166 precision, 98.2% recall.

### OpenAI's 2026-10-23 shutdown

| Fresh sample (100) | |
|---|---|
| Live call path uses a 2026-10-23 model | **11, 11%** (6.3–18.6) |
| Flagged by Refit for a 2026-10-23 model | 19 |
| Exposed and flagged | 11/11 |
| Flag precision | 11/19, 57.9% (36.3–76.9) |

The 11 exposed applications are:

- `0xnyn/cruso`, `357929231/jtt`, `Cavedragon13/Dragonart_2026`;
- `Kronova-Intelligent-Systems/asset-intel-orchestration-engine`, `Rockstar100/commerce-insights-agent`;
- `Scale3-Labs/langtrace`, `Velonova-AI/LLMAdmin`, `anarayan05/ZipFinder`;
- `bhoomik-codes/ragify`, `hkniberg/egbert` and `mikecann/decorate-with-convex`.

The models they send are `gpt-3.5-turbo`, `gpt-4`, `gpt-4-turbo`, `gpt-4.1-nano`, `gpt-image-1` and `o3-mini`.

This is lower than the 100-repository set's 44%. That sample was drawn from code-search hits for exactly these model names; this one spreads its queries over five providers and newer models.

### Every false positive, by cause

All 233 lines reported as live that are not live were read. The full list, with each label's note, is in the score file under `lineFalsePositives`.

| Cause | Lines |
|---|---:|
| Model lists, type unions and catalogs (`marketAgent`'s LLM lists, NextChat's type lists, `ReignsAgent`'s catalog, LLMAdmin's enum) | 44 |
| Test routes and scripts of an API-version provider (Meta, Shopify), which have no test class by design | 34 |
| UI options and form seeds (`<SelectItem>` lists, budget and voice tabs, edit-form defaults) | 33 |
| Preset masks and templates the user picks (NextChat's masks, `mj-studio`'s model-type defaults, prompt templates) | 31 |
| A `demo/` folder of sample traces, not treated as test (`opensearch-project/agent-health` `cli/demo/sampleTraces.ts`) | 20 |
| Price and token tables | 15 |
| Commented-out code reported as live (NextChat `platforms/anthropic.ts` ×6, `marketAgent`) | 7 |
| Models a CLI agent or another backend sends (Codex CLI templates, the ChatGPT Codex backend) | 9 |
| Records and migrations that send nothing (exported session files, usage tracking, a stored-setting rename) | 12 |
| Tokenizer and token-counting defaults | 7 |
| Snippets, help, error and UI text, placeholders | 13 |
| Dead code and unused dependencies (constants nothing reads, a commented-out import, an unused SDK) | 4 |
| Other configuration (a per-model field-ignore list, a codegen config, a tutorial step) | 4 |
| **Total** | **233** |

At repository level, 15 flagged applications have no live use:

- **Five through catalogs and records alone:** `shellus/mj-studio`, `Sisyphe42/ReignsAgent`, `RealMikeChong/ultra-mcp`, `sysread/page-summarizer`, `liwala/session-porter`.
- **Four through test or script files only:** `opensearch-project/agent-health`, `nadeemk2050/SeoAgent`, `PatoJAD/website`, `Windy3f3f3f3f/claude-code-from-scratch`.
- **Two Shopify apps** whose only pin is in a maintenance script: `azsxdc12705/thehyun-inventory`, `hieuthunhat/avada-search-tool`.
- **Four others:**
  - `OpenAgentPlatform/Dive`, through a field-ignore list;
  - `zhanghengg/codexpool`, through the ChatGPT Codex backend;
  - `smarth-tech/claudetrack`, through snippets and usage records;
  - `nogitankit/ai-chef-frontend`, through an SDK whose only import is commented out.

### Every false negative

| Missed live line | Cause |
|---|---|
| `mullafaiz666-spec/Veloraskart-agent` `src/app/api/shopify/connect/route.ts:1`, `src/lib/sync.ts:305` (`process.env.SHOPIFY_API_VERSION \|\| "2026-01"`) | Shopify version env fallbacks are not read (known since October 16) |
| `carlosarizap/elizabethpeper` `promotion-runner.ts:4`, `order-sync.ts:15` (`SHOPIFY_API_VERSION = '2026-01'`) | Shopify version constants are not read |
| `paulboutin/Aegis` `src/orchestrator/oauth-connectors.ts:522` (`?? "2026-01"`) | Same |
| `quocbahuynh/ViqiumAI` `frontend/src/app/layout.tsx:90` (`FB.init` `version: 'v22.0'`) | The Meta JS SDK's `FB.init` is not read (known) |
| `TheChimaeraCo/synapse` `lib/providers.ts:65` (`defaultModel: "claude-sonnet-4-20250514"`) | A provider preset's `defaultModel` is read as catalog |
| `NitroRCr/AIaW` `src/stores/user-perfs.ts:61` (`models.find(m => m.name === 'gpt-5.4-nano')`) | A default chosen by an equality lookup is read as a check |
| `ansonwong815/language-learner` `main.ts:1` | An SDK imported without a `package.json` declaration has no manifest line to report |

Only two repositories are missed outright. `NitroRCr/AIaW` has no other live pin. `ansonwong815/language-learner` uses the old Gemini SDK without declaring it. Every Shopify and Meta repository with a missed line is still flagged through another line.

## Requests for other lanes

No matcher code is changed here. Ranked by lines fixed in the fresh sample:

1. **Catalog shapes (FG9, and the deadline matcher's owner): 123 lines.** Model lists and type unions (44), UI options and form seeds (33), preset masks and templates (31) and price tables (15) are still reported as live.
   - In particular: `<SelectItem value>` and similar option components, arrays of `{ id, name }` model records, NextChat-style `masks/*.ts` presets, and model-keyed price tables.
   - OG7's AI-application benchmark found the same shapes.
2. **Test files and scripts of API-version providers: 34 lines (needs owner decision).**
   - Meta and Shopify matches count as live in test files, because those providers get no `test` class.
   - 14 of the lines are on `TEST_PATH` (`app/api/test/`, `tests/`, `*.test.ts`). A test class for these providers would fix them.
   - The other 20 are in maintenance scripts (`scripts/`, `deploy_*.cjs`, `lib/testMetaAPI.ts`), which `TEST_PATH` does not cover. They cause 4 repository-level false flags. Treating `scripts/` as non-production would fix them, but some tools ship their entry point there (`a787825/shopify-content-sync`).
3. **`demo/` folders as test: 20 lines.** `TEST_PATH` covers `examples/` and `stories/`, but not `demo/` or `demos/`.
4. **Commented-out code: 7 fresh lines and 6 in the 100-repository set.** Lines like `//   name: "claude-instant-1.2",` inside a commented-out block, and `//   "gpt-4-1106-preview") as LLMID,`, are reported as live, in `.ts` and `.tsx` files alike. The 2026-10-16 fix says comments no longer count, so this looks like a regression or an uncovered path.
5. **Shopify version constants and env fallbacks: 5 missed lines.** This has been open since October 16.
6. **Defaults read as catalogs or checks: 2 missed lines.**
   - A provider preset's `defaultModel` is read as catalog. OG7 asks for the same.
   - A default chosen with `models.find(m => m.name === '…')` is read as a check.
7. **Declared-but-unused SDKs: 2 false flags.** An SDK end of support should need an import in production code, as `heurista-demo` already shows Refit can check. The two that are flagged anyway are `nogitankit/ai-chef-frontend`, whose only import is commented out, and `hcassar93/meta-ads-cli`'s Meta Business SDK.
8. **Hosts that are not the provider: 9 lines.** These are models sent through the ChatGPT Codex backend and CLI agents. Needs owner decision, as in OG7.

## Limits

- **One labeller.** The labels come from one AI labeller and have not been checked by a human.
- **Proposed labels.** 902 `test` and 134 `comment` labels were proposed by path and comment rules, and spot-checked rather than each read.
- **What the frame is.** As in October, it is code-search hits for chosen strings. The rates describe these applications, not GitHub at large.
- **The loose search's reach.**
  - It reads JS/TS sources and `package.json`.
  - It does not read the Meta Business SDK version, `FB.init`-style calls it cannot match as text, or values built at runtime.
  - It finds prose mentions, which are counted apart.
- **The 100-repository set's new-provider labels** were made after the runs and are not blind.
- **Small groups.** Small per-provider groups (11 to 22 repositories) give wide intervals.

## Reproduce

```sh
# The 100-repository set, from two pinned worktrees (each with `npm ci`).
git worktree add --detach <oct16> 0e911e5 && git worktree add --detach <main> 7b2c86a
node scripts/deadline-benchmark-setup.mjs --root <dir> --refit <oct16> --output classified.json
node scripts/deadline-benchmark-setup.mjs --root <dir> --refit <main> --output current.json
node scripts/deadline-benchmark-grep.mjs --root <dir>
node scripts/deadline-benchmark-score.mjs --root <dir> --runs classified,current --as-of 2026-10-22
node scripts/deadline-fresh-score.mjs --results <dir>/current.json --list docs/benchmarks/2026-10-16-deadline-repos.json \
  --labels docs/benchmarks/2026-10-22-deadline-new-provider-labels.json --providers anthropic,gemini --grep <dir>/grep.json

# The fresh sets: the same setup script with --list.
node scripts/deadline-benchmark-setup.mjs --root <dir2> --list docs/benchmarks/2026-10-16-stripe-fresh-repos.json --refit <main> --output current.json

# The fresh sample: draw (reuses the saved frame), clone for labelling, then scan and score.
node scripts/deadline-benchmark-sample.mjs --frame docs/benchmarks/2026-10-22-deadline-fresh-frame.json \
  --seed refit-deadlines-fresh-2026-10-22 --per openai=35,anthropic=25,meta-graph=15,shopify=15,gemini=10 \
  --pushed-since 2025-07-01 --applications --exclude <every frozen list> --output <new>.json
node scripts/deadline-benchmark-setup.mjs --root <dir3> --list docs/benchmarks/2026-10-22-deadline-fresh-repos.json --clone-only
node scripts/deadline-benchmark-grep.mjs --root <dir3> --list docs/benchmarks/2026-10-22-deadline-fresh-repos.json
node scripts/deadline-benchmark-setup.mjs --root <dir3> --list docs/benchmarks/2026-10-22-deadline-fresh-repos.json --refit <main> --output current.json
node scripts/deadline-fresh-score.mjs --results <dir3>/current.json --grep <dir3>/grep.json
```

Repositories that declare a Git LFS filter need `GIT_CONFIG_COUNT=3 GIT_CONFIG_KEY_0=filter.lfs.process GIT_CONFIG_VALUE_0= GIT_CONFIG_KEY_1=filter.lfs.smudge GIT_CONFIG_VALUE_1= GIT_CONFIG_KEY_2=filter.lfs.required GIT_CONFIG_VALUE_2=false` without git-lfs installed.
