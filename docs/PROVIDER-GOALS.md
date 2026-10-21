# Provider goals

One goal per API provider, shaped like [the Stripe goal](STRIPE-PLAN.md#definition-of-done): a frozen benchmark of real public repositories, a share of affected repositories that end in a validated fix, zero wrong fixes on hand review, and every remaining stop named as an owner decision. Written 2026-10-20 from the files cited in each section. Nothing here claims support that [READINESS.md](READINESS.md) does not record. Doing the same outside TypeScript and JavaScript is covered in [Language goals](LANGUAGE-GOALS.md).

Rules that apply to every provider, from [AGENTS.md](../AGENTS.md):

- Breaking changes first. Non-breaking changes are recorded for review, never auto-fixed.
- Deterministic, explicitly configured rules first. AI only as a bounded assistant behind the evidence, budget, validation and review gates that exist today.
- Credentials, live vendor calls, paid model calls, sandbox changes and policy calls stop for the owner.
- A fact not confirmed from this repository is marked **unverified: check**. No URL below was invented; where none is cited, there is none to cite yet.

## How to read a goal

| Part | Meaning |
|---|---|
| Status today | What the repository records: catalog entry, adapter type, benchmark numbers, with the file |
| What breaks | How the provider versions and retires things, and where the official change sources are |
| SDK patterns | The official JS/TS packages and the call shapes the analyzer must trace |
| Definition of done | Measured on a frozen set; the same four measures for every provider |
| Milestones | Catalog entry → reviewed adapter → deterministic rules → deadline entries → frozen benchmark → validated fixes |
| Blockers | What needs the owner |
| Effort | S (days), M (a release or two), L (several releases, or a new contract format) |

The frozen set for a new provider follows the Shopify method ([SHOPIFY-BENCHMARK.md](SHOPIFY-BENCHMARK.md#method)): GitHub code search for the SDK, no forks or archived repositories, under 50 MB, pushed since 2024-01, the SDK declared in the root `package.json`, the most-starred kept, frozen with commits before any provider code is written. Sizes below are targets, not runs.

---

## Stripe (reference, for comparison)

Built-in agent, 531 benchmark repositories, **74 validated fixes of 234 affected**, all hand-reviewed, none wrong (source: docs/READINESS.md, 2026-10-16). The remaining stops are owner decisions recorded in [STRIPE-PAYMENT-METHOD-TYPES.md](STRIPE-PAYMENT-METHOD-TYPES.md) and [STRIPE-PLAN.md](STRIPE-PLAN.md#open-decisions). This is the bar for "done".

## OpenAI

**Status today.** In the catalog with a file adapter, `examples/openai.provider.json`, which maps `models.retrieve` → `Model`, `chat.completions.create` → `CreateChatCompletionResponse`, `responses.create` → `Response` and `embeddings.create` → `CreateEmbeddingResponse`, each with its operation ID, checked against OpenAI's published OpenAPI document (`openai/openai-openapi`, info.version 2.3.0) on 2026-10-20. `Response` is an `allOf`, which Refit merges into one object schema when the spec is loaded (source: pipeline/specifications.ts). A review-only model replacement proposal exists: `refit deadlines --propose-model-fixes` (source: docs/DEADLINES.md#propose-model-replacements, 2026-10-20). READINESS calls it a preview adapter; the OpenAI fixtures test invented renames, not announced changes (source: docs/READINESS.md, "provider detection and agent catalog"; pipeline/fixtures/openai/README.md). Numbers:

| Measure | Value | Source |
|---|---|---|
| Deadline registry entries | 27 shutdowns, 67 model IDs, checked 2026-10-15 | data/deadlines.json |
| Fresh Stripe repositories sending a model retired 2026-10-23 | 51 of 381 | docs/BENCHMARKS.md, 2026-10-16 |
| Labelled deadline repositories with a live 2026-10-23 model | 15 of 34 | docs/DEADLINE-BENCHMARK.md, 2026-10-16 |
| OpenAI line precision, live-only evidence | 83% (19/23) | docs/READINESS.md, "live-only deadline evidence" |
| Likely SDK calls traced on the 15-repository coverage set | 38 → 172 of 187 after class clients | docs/SDK-COVERAGE.md; docs/READINESS.md, 0.19.0 |
| Exposed deadline-benchmark repositories with a proposed replacement | 2 of 15 (6 sites, all correct on hand review), 4 more stopped for review with a reason | docs/benchmarks/2026-10-20-model-replacement-results.json |

**What breaks for its users.** Model shutdowns on published dates: a retired model stops serving requests (source: docs/DEADLINE-BENCHMARK.md). The registry source is `https://developers.openai.com/api/docs/deprecations` (source: data/deadlines.json). There is no dated API version to pin; `apiVersion: "1"` in the fixtures is a simulated contract, not an OpenAI release (source: docs/MULTIPLE-INTEGRATIONS.md). SDK major versions and endpoint migrations (Chat Completions → Responses): unverified: check. Machine-readable spec: an OpenAPI document for the public API, unverified: check. Refit's own AI calls use the Responses endpoint (source: pipeline/openai.ts).

**SDK patterns to trace.** Package `openai`, default import, named export `OpenAI` (source: examples/openai.provider.json). Call shapes in the fixtures and coverage set: `new OpenAI(...)`, `client.chat.completions.create({ model, messages })`, `client.models.retrieve(id)`; the `model` argument is where the retiring value lives. Real repositories hold the client in class fields, path-alias modules and factories (source: docs/SDK-COVERAGE.md). `client.responses.create` and `client.embeddings.create` are traced like the others (pipeline/model-retirements.test.ts). The v3 SDK's `openai.createChatCompletion` and `openai-edge` are traced too. On the deadline benchmark the remaining live pins sit in exported constants, helper parameters, UI state, configuration, raw `fetch` and other libraries (source: docs/benchmarks/2026-10-20-model-replacement-results.json).

**Definition of done.**

| Measure | Target |
|---|---|
| Frozen set | 100 repositories declaring `openai`, selected as above; 30 hand-labelled for live model pins and the correct replacement |
| Live model pins traced to a call argument | ≥ 90% of labelled pins |
| Affected repositories (live pin of a registry model) ending in a validated fix | ≥ 70% of those with runnable checks |
| Wrong fixes on hand review of every validated fix | 0 |
| Remaining stops | each a named owner decision (replacement model policy, catalogs, env fallbacks) |

**Milestones.** 1. Catalog entry exists. 2. **Done 2026-10-20:** the adapter maps `chat.completions.create`, `responses.create` and `embeddings.create`, written by hand from the published OpenAPI document, so no `adapter-suggest` budget was spent. 3. **Review-only rule done 2026-10-20:** `refit deadlines --propose-model-fixes` replaces a live literal model ID with the registry `replacement` (followed while it retires too), only in a traced text-generation call's `model` or a `??`/`||` default there, never in catalogs, tests or comparisons, and stops for review on sampling and length parameters, spread options and constants. `refit serve --model-fixes` applies it through validation and drafts in enrolled repositories (owner decision below); it is not part of `refit run`. Coverage since then: v3 SDK and `openai-edge` `createChatCompletion`, request objects held in a `const`, and model constants used by one call. Then cross-module constants and enum members, helper parameters with their callers, and raw HTTP requests to the official endpoints. Of the 15 exposed repositories, 9 now stop silently. Most of them hold the model in settings objects, UI state or CLI option defaults, which a person has to review. On this set the sampling-parameter stop is now the main limit: 3 of the 4 stopped repositories set `temperature` or `max_tokens`. Verifying which parameters the replacement models accept would turn those into fixes. 4. Deadline entries already exist; keep `checkedAt` current. 5. Freeze the 100-repository set and labels (needs a GitHub code search token; this session had none). 6. Run the fix benchmark with validation; publish per-repository results like the Stripe sets.

**Blockers and owner decisions.** Owner decision (2026-10-20): in enrolled repositories, `refit serve --model-fixes` (off by default) applies the registry `replacement` as-is, validates it with the approved checks and opens a draft pull request without asking first; it never merges. Uses the rule stops on stay for review. `adapter-suggest` spends OpenAI budget; the budget ledger decision in [STRIPE-PLAN.md](STRIPE-PLAN.md#open-decisions) applies. Any check that calls OpenAI live is out; validation stays offline.

**Effort: M.** Detection and the registry exist; the work is the adapter, one rule, and a benchmark.

## Anthropic

**Status today.** In the catalog with `adapter: null`, package `@anthropic-ai/sdk`, hostname `api.anthropic.com` (source: pipeline/agent-catalog.ts). 12 deadline entries, 2024-11-06 to 2026-11-30, from the official [model deprecations page](https://platform.claude.com/docs/en/about-claude/model-deprecations), checked 2026-10-20, with the same live, catalog, test and check classes as OpenAI (source: data/deadlines.json; docs/DEADLINES.md). A file adapter, `examples/anthropic.provider.json`, traces `messages` calls for the review-only model replacement proposal; it stays out of the catalog because Anthropic publishes no contract that `refit run` could compare (the SDK's `.stats.yml` names no OpenAPI URL, checked 2026-10-20). On the 15-repository coverage set, 28 then 32 of 61 likely calls were traced (source: docs/benchmarks/2026-10-14-class-client-coverage.md). No benchmark yet.

**What breaks for its users.** Model retirements with dates: "Requests to retired models will fail", with at least 60 days' notice, and the dates apply to the Claude API, Claude Platform on AWS and Microsoft Foundry; Amazon Bedrock and Google Cloud set their own (source: the model deprecations page, 2026-10-20). Parameter deprecations: `temperature`, `top_p` and `top_k` return a 400 when set to a non-default value on Claude 4.7 and later models (same page), which matters because most registry replacements are 4.7 or later. A dated `anthropic-version` request header and SDK majors: unverified: check. Machine-readable spec: none published that Refit could find. Official changelog: unverified: check.

**SDK patterns to trace.** Package `@anthropic-ai/sdk`, named export `Anthropic`, `new Anthropic(...)`, `client.messages.create({ model, max_tokens, messages })`, and `client.messages.stream(...)`: all three are traced, including class-field clients (pipeline/model-retirements.test.ts). The SDK's `messages.create` with `stream: true` returns a stream, not a `Message`, so the adapter's response mapping is only right without it. Same client-holding patterns as OpenAI (class fields, factories, path aliases).

**Definition of done.** Same table as OpenAI, on a frozen set of 50 repositories declaring `@anthropic-ai/sdk` (the SDK is less common than `openai` in code search; 50 keeps the set honest without padding): ≥ 90% of labelled live pins traced, ≥ 70% of affected repositories with runnable checks validated, 0 wrong fixes, every stop an owner decision.

**Milestones.** 1. Catalog entry exists. 2. **Done 2026-10-20:** `examples/anthropic.provider.json` maps `messages.create` → `Message` (schema name unverified, since no spec is published); `messages.stream` is traced but not mapped, because it returns a stream. Adding it to the catalog needs a contract source decision. 3. **Done 2026-10-20 (review-only):** the OpenAI rule covers Anthropic `messages` calls and stops on `temperature`, `top_p` and `top_k`. 4. **Done 2026-10-20:** 12 entries with `source` and `checkedAt`; matcher classes extended to Claude IDs. Only the `claude-sonnet-4-5` alias is listed; aliases of already retired models are not on any current Anthropic page. 5. Freeze 50 repositories (needs a GitHub code search token). 6. Run and publish.

**Blockers and owner decisions.** Replacement policy as for OpenAI. Whether `refit agents --add anthropic` should exist without a published contract (it would scaffold an integration that `refit run` cannot compare). No Anthropic credential is needed for any step.

**Effort: S once OpenAI's rule exists, M on its own.**

## Meta (Graph API)

**Status today.** In the catalog with `adapter: null`, package `facebook-nodejs-business-sdk`, hostname `graph.facebook.com` (source: pipeline/agent-catalog.ts). Deadline registry: 13 versions, v13.0 to v25.0, source `https://developers.facebook.com/docs/graph-api/changelog`, checked 2026-10-15 (source: data/deadlines.json). On the labelled deadline set, 11 of 11 Meta repositories were exposed, all past due on v13.0–v20.0, with 100% line precision (source: docs/DEADLINE-BENCHMARK.md). The matcher reads versioned URLs, quoted `'v20.0'` strings in Graph files, and the SDK version from manifests and lockfiles (source: docs/DEADLINES.md). Request detection (review only, 2026-10-20): `refit meta-graph` lists raw `graph.facebook.com` requests and business SDK resource-class calls with version, path, edge and literal fields. On the 33 Meta repositories of the deadline frame it reported 162 requests in live code, all real and with every reported value correct on hand review; fields were read for 113 and the version for 157 (the other 5 are unversioned). It found a request at 62 of the 63 labelled live Graph pins; the miss is `FB.init` (source: docs/META-GRAPH.md). Per-version change list (2026-10-20): `data/meta-graph-changes.json` with a strict validator (`npm run meta-graph:check`); v14.0 to v26.0 were read in full from developers.facebook.com on 2026-10-20 and are `reviewed`, with 281 changes from the Graph API and Marketing API sections (Instagram checked against the Instagram Platform changelog); v13.0 stays `unread`. WhatsApp and Messenger changelogs are not covered, so their requests always stop (source: docs/META-GRAPH.md). Review-only version moves (2026-10-20): `refit meta-graph --propose-version-moves --target <version>` moves a pin only when every request through it is fully known and every crossed changelog is reviewed with nothing those requests use. On the 33 repositories at target v25.0 it proposes 35 moves in 13 repositories with the reviewed list, each checked by hand; 113 pins stop with named reasons. The hypothetical upper bound with every changelog empty is 100 of 131 live pins (source: docs/META-GRAPH.md).

**What breaks for its users.** Dated major versions; a retired version is "defaulted to the next oldest, usable version" (source: docs/DEADLINE-BENCHMARK.md, citing `https://developers.facebook.com/docs/graph-api/guides/versioning`). So exposure means silently changed behaviour, not an outage. Each version's changelog lists removed fields and endpoints; there is one page per version, such as `https://developers.facebook.com/docs/graph-api/changelog/version19.0`. The pages are readable HTML; v14.0 to v26.0 were read in full on 2026-10-20. OpenAPI document: unverified: check (none is cited in the repository).

**SDK patterns to trace.** Most benchmark repositories call Graph through raw `fetch`/`axios` to `https://graph.facebook.com/v20.0/...` (source: docs/DEADLINE-BENCHMARK.md, search queries); 31 of the 33 Meta repositories do, and one declares the business SDK but only calls `FacebookAdsApi.init` (source: docs/META-GRAPH.md). SDK shape `FacebookAdsApi.init(token)` then resource classes such as `new AdAccount(id).getCampaigns(fields, params)`, checked against the generated classes of facebook-nodejs-business-sdk 24.0.1, whose methods map to edges in `data/meta-business-sdk-edges.json`. The browser `FB.init({ version })` is not read today (source: docs/DEADLINES.md).

**Definition of done.** Frozen set of 50 repositories using `graph.facebook.com` or the business SDK (the deadline frame already holds 33). Targets: ≥ 90% of versioned URL pins and SDK pins traced; ≥ 70% of affected repositories with runnable checks end in a validated version move; 0 wrong fixes; every field removal on a called edge stops as a named owner decision until a rule covers it.

**Milestones.** 1. Catalog entry exists. 2. Review-only request detection exists (`refit meta-graph`, 2026-10-20), and so does the change list, reviewed for v14.0 to v26.0 (281 changes, 2026-10-20); an adapter for raw versioned URLs (a new contract shape: path-and-version, not OpenAPI) and the business SDK's resource classes. 3. Deterministic rule: move the version segment in URLs and the SDK's declared version only when every called edge and read field exists on the target per the changelog; otherwise stop at the line. A review-only version of the URL rule exists (2026-10-20); the SDK version is not moved. 4. Deadline entries exist; keep them current. 5. Freeze 50 repositories. 6. Run and publish.

**Blockers and owner decisions.** The change source is a changelog page, not a contract; the owner decides whether a hand-maintained per-version removal list (like `data/deadlines.json`) is acceptable evidence for an automatic edit. Raw-URL migration is a new analyzer surface, not an adapter file. No Meta credential is needed.

**Effort: L.** No contract format exists, and the dominant usage is raw HTTP.

## Cloudflare

**Status today.** Not in the catalog; not started. The only mentions in the repository are Cloudflare Tunnels for local webhooks and repository names in benchmark lists (source: grep of docs/ and pipeline/, 2026-10-20).

**What breaks for its users.** The REST API is versioned by path (`/client/v4`), with per-endpoint deprecations announced with dates, and a published OpenAPI document: unverified: check both. The official Node SDK has had major rewrites: unverified: check. Workers also carry a `compatibility_date` in `wrangler` configuration that gates runtime behaviour: unverified: check whether Refit should treat it as a pin.

**SDK patterns to trace.** Package `cloudflare`: `new Cloudflare({ apiToken })`, then `client.<resource>.<method>(...)`, which is the `client.resource.method` shape `adapter-suggest` already inventories (source: docs/CLI.md). Raw `fetch('https://api.cloudflare.com/client/v4/...')`. Exact resource names: unverified: check.

**Definition of done.** Frozen set of 50 repositories declaring `cloudflare`. Targets as for OpenAI: ≥ 90% of likely SDK calls traced; ≥ 70% of affected repositories with runnable checks validated; 0 wrong fixes; every stop an owner decision.

**Milestones.** 1. Add a catalog entry with `adapter: null`, package `cloudflare`, hostname `api.cloudflare.com`. 2. If an OpenAPI document exists, `refit source-snapshot` it and build the adapter with `adapter-suggest`, then hand review. 3. Deterministic rules only for removals and renames the diff proves; endpoint replacements through `operationReplacements`. 4. Deadline entries for announced endpoint sunsets, if the provider publishes dates. 5. Freeze 50 repositories. 6. Run and publish.

**Blockers and owner decisions.** Whether the spec exists and is public HTTPS without redirects (a `source-snapshot` requirement, source: docs/CLI.md). `adapter-suggest` spend. Whether `compatibility_date` is in scope.

**Effort: M if the OpenAPI document exists, L otherwise.**

## Salesforce

**Status today.** Not in the catalog; not started. No mention anywhere in the repository (source: grep, 2026-10-20).

**What breaks for its users.** REST API versions in the URL (`/services/data/vNN.0/`), three releases a year, with old versions retired on announced dates: unverified: check. Official release notes and retirement schedule page: unverified: check. OpenAPI: unverified: check (Salesforce has several APIs; coverage may be partial).

**SDK patterns to trace.** The common package is community-maintained `jsforce`: `new jsforce.Connection({ version: '58.0', ... })`, `conn.query('SELECT ...')`, `conn.sobject('Account').find(...)/create(...)`. Official packages such as `@salesforce/core`: unverified: check which one real app code uses. SOQL strings and object names are the breaking surface, which Refit's analyzer does not parse today.

**Definition of done.** Frozen set of 30 repositories (public Salesforce integrations are rarer; if code search yields fewer eligible repositories, record the count). Targets: ≥ 90% of version pins traced; ≥ 70% of affected repositories with runnable checks validated; 0 wrong fixes; every stop an owner decision.

**Milestones.** 1. Catalog entry with `adapter: null`, package `jsforce`, hostnames from the login and instance domains. 2. Adapter for `Connection` and `sobject` calls. 3. Deterministic rule limited to moving the `version` pin when no called object or field changed, as Shopify does for pins. 4. Deadline entries for version retirements. 5. Freeze the set. 6. Run and publish.

**Blockers and owner decisions.** Whether a non-official SDK is in scope. Field-level breakage lives in SOQL strings and sObject metadata, which needs a new contract shape and an owner call on evidence. Sandboxes need credentials; Refit does not use them.

**Effort: L.**

## Shopify

**Status today.** Built-in agent, Admin GraphQL only, contracts as introspection snapshots (source: docs/SHOPIFY.md; pipeline/agent-catalog.ts). Numbers (source: docs/BENCHMARKS.md, 2026-10-16):

| Set | Repositories | With Admin usage | Validated fixes | Main stops |
|---|---|---|---|---|
| Fresh | 200 | 170 | 6 (13 patched) | 44 need an SDK upgrade, 32 use REST (39 before 7 raw GraphQL requests were told apart, 2026-10-20) |
| Original | 50 | 46 | 1 | 15 need an SDK upgrade |

24 of 200 fresh apps send a query that fails on every served version, each at an exact line (23 before callback tracing, 2026-10-20). Repeat runs matched 200 of 200. Deadline registry: 7 Admin versions, 2025-04 to 2026-10 (source: data/deadlines.json).

**What breaks for its users.** Quarterly dated versions, each supported for a year; an unsupported pin "falls forward" to the oldest supported version (source: docs/SHOPIFY.md, citing `https://shopify.dev/docs/api/usage/versioning`). Removed fields, arguments, enum values and types per version are provable from the schema. REST Admin calls have no published versioned contract (source: docs/SHOPIFY.md). The REST API's deprecation in favour of GraphQL: unverified: check the date and scope. `ApiVersion.October26` needs `@shopify/shopify-api` 14 (source: docs/SHOPIFY.md).

**SDK patterns to trace.** Already read: `admin.graphql(...)` from the Remix, React Router and Express packages, `createAdminApiClient(...).request(...)`, `shopify.clients.Graphql(...).request/query(...)`, and pins as `ApiVersion.<Month><YY>`, `apiVersion: 'YYYY-MM'`, versioned URLs and `LATEST_API_VERSION`; documents passed through helpers, callbacks, closure factories, re-exports, constant arrays and objects (2026-10-20) (source: docs/SHOPIFY.md). REST calls are reported with file, line, method and path where knowable (2026-10-20), never migrated. Not read: documents built at runtime, documents sent through class or object methods, raw `graphql.json` requests; `shopify-api-node` (source: docs/SHOPIFY.md, limits).

**Definition of done.** Measured on the frozen fresh 200 (`docs/benchmarks/2026-10-16-shopify-repos.json` and `-fresh-repos.json`):

| Measure | Today | Target |
|---|---|---|
| Admin apps ending in a validated version move | 6 of 170 | ≥ 70% of those with runnable checks, once the SDK-upgrade decision is made |
| Apps stopped on "SDK upgrade needed" | 44 | 0 without a named decision |
| Apps stopped on REST | 32, each REST call reported at its line with method and path where knowable (2026-10-20) | each reported with the exact REST calls; migration only under an owner-approved rule |
| Wrong fixes on hand review | 0 of 7 | 0 |
| Repeat-run agreement | 200/200 | 200/200 |

**Milestones.** 1. Catalog entry exists. 2. Adapter exists. 3. Rules: an `@shopify/shopify-api` major upgrade in the same patch as the pin move, modelled on the stripe-node upgrade in [DEPENDENCIES.md](DEPENDENCIES.md#stripe-node-upgrade-in-a-patch), if the owner allows a major bump; helper and closure document tracing (done 2026-10-20: traced documents 964 → 994 and unread Admin calls 90 → 76 across both frozen sets, one more already-broken query found; source: docs/SHOPIFY-BENCHMARK.md). 4. Deadline entries exist; add versions older than 2025-04 so older pins are reported. 5. Set is frozen. 6. Rerun and publish.

**Blockers and owner decisions.** A major SDK upgrade is a policy call (Stripe's upgrade was allowed as a minor-to-major bump only with the version literal). REST-to-GraphQL rewriting changes request and response shapes and is not a pin move; it needs an explicit decision and probably stays review-only. The target version is the newest the locked SDK can name, not always `2026-10` (source: docs/BENCHMARKS.md). The lab uses simulated responses only.

**Effort: M.** The pipeline and benchmark exist; the gap is one decision and tracing work.

## Gemini

**Status today.** Not in the catalog; not started. The only mention is a repository name in the deadline search frame (source: grep, 2026-10-20).

**What breaks for its users.** Model retirements with dates, like OpenAI's: unverified: check the official page. The SDK was replaced: `@google/generative-ai` superseded by `@google/genai`, with a support end date: unverified: check. API versions `v1` and `v1beta` in the client options: unverified: check. Machine-readable spec: unverified: check. Changelog: unverified: check.

**SDK patterns to trace.** Package `@google/genai`: `new GoogleGenAI({ apiKey })`, `ai.models.generateContent({ model, contents })`. Older package `@google/generative-ai`: `new GoogleGenerativeAI(key).getGenerativeModel({ model }).generateContent(...)`. Both are from memory: unverified: check the SDK READMEs. The Vertex AI path uses the same new package with different auth: unverified: check.

**Definition of done.** Frozen set of 50 repositories declaring either package. Targets as for OpenAI: ≥ 90% of labelled live model pins traced; ≥ 70% of affected repositories with runnable checks validated; 0 wrong fixes; every stop an owner decision, including the SDK replacement.

**Milestones.** 1. Catalog entry with `adapter: null`, both packages, hostname `generativelanguage.googleapis.com` (unverified: check). 2. File adapter for `models.generateContent` and `getGenerativeModel(...).generateContent`. 3. Reuse the model-retirement rule; the SDK swap stays review-only unless the owner approves a package-replacement rule. 4. Deadline entries with source and `checkedAt`. 5. Freeze 50. 6. Run and publish.

**Blockers and owner decisions.** Whether a package replacement (old SDK → new SDK, different call shapes) is ever automatic. Replacement model policy. No Google credential needed.

**Effort: M.** Shares the retirement rule with OpenAI and Anthropic; the SDK swap is the new part.

## Google (Cloud and Workspace APIs)

**Status today.** Not in the catalog; not started (source: grep, 2026-10-20).

**What breaks for its users.** Each API has its own version (`v3`, `v4`) and its own shutdown announcements with dates; a general deprecation policy page exists: unverified: check. Machine-readable contracts are Discovery documents, not OpenAPI: unverified: check whether a Discovery document can be converted or must become a third contract shape, after OpenAPI and GraphQL. Per-package SDK majors (`@google-cloud/*`): unverified: check.

**SDK patterns to trace.** Package `googleapis`: `google.sheets({ version: 'v4', auth })` then `sheets.spreadsheets.values.get({...})`; the `version` literal is the pin. Packages `@google-cloud/<service>`: `new Storage()`, `storage.bucket(name).file(path)`. Auth through `google-auth-library`. Shapes from memory: unverified: check.

**Definition of done.** Frozen set of 50 repositories declaring `googleapis`, limited to one or two APIs chosen from what the set actually uses (record the choice). Targets: ≥ 90% of version pins traced on those APIs; ≥ 70% of affected repositories with runnable checks validated; 0 wrong fixes; every other API reported as "not covered", never guessed.

**Milestones.** 1. Catalog entry with `adapter: null`, packages `googleapis` and `google-auth-library`, hostname `googleapis.com`. 2. Decide the contract shape (Discovery conversion or new reader) and build one adapter for one API. 3. Rules: move the `version` literal only when every called method and read field exists on the target. 4. Deadline entries per announced API shutdown. 5. Freeze 50. 6. Run and publish.

**Blockers and owner decisions.** The surface is dozens of APIs; the owner picks which two count as "Google" for the first goal. A Discovery reader is new pipeline code and an architecture decision. Credentials are never needed for contracts if Discovery documents are public: unverified: check.

**Effort: L.**

## Slack

**Status today.** Not in the catalog as a provider; not started. Slack appears in Refit only as a notification sink for run outcomes (source: docs/SLACK.md; pipeline/slack.ts). That code is unrelated to migrating customer Slack integrations.

**What breaks for its users.** Web API methods are deprecated and sunset by name with dates (for example `files.upload` → `files.uploadV2`): unverified: check the official changelog and the per-method deprecation notices. SDK majors for `@slack/web-api` and `@slack/bolt`: unverified: check. A Slack-published OpenAPI document existed at one time: unverified: check whether it is still maintained.

**SDK patterns to trace.** Packages `@slack/web-api` (`new WebClient(token)`, `client.chat.postMessage({ channel, text })`, `client.files.uploadV2(...)`), `@slack/bolt` (`app.client.<method>`, `say(...)` inside listeners), `@slack/webhook`. The `client.resource.method` shape fits `adapter-suggest`. Exact method lists: unverified: check.

**Definition of done.** Frozen set of 50 repositories declaring `@slack/web-api` or `@slack/bolt`. Targets: ≥ 90% of likely SDK calls traced; ≥ 70% of affected repositories with runnable checks end in a validated method replacement; 0 wrong fixes; every stop an owner decision.

**Milestones.** 1. Catalog entry with `adapter: null`, the three packages, hostname `slack.com/api`. 2. Adapter from the spec if one exists, otherwise hand-written for the top methods. 3. Rules through `operationReplacements` for named method sunsets only where request and response shapes are recorded ([ENDPOINT-MIGRATIONS.md](ENDPOINT-MIGRATIONS.md)). 4. Deadline entries per sunset method. 5. Freeze 50. 6. Run and publish.

**Blockers and owner decisions.** Whether a method replacement that changes the request shape (`files.upload` → `files.uploadV2`) is automatic or review-only. Bolt's `say` and `respond` hide the client, so coverage needs an owner call on what counts as traced. No Slack credential needed.

**Effort: M.**

## PayPal

**Status today.** In the catalog with `adapter: null`, packages `@paypal/paypal-server-sdk` and `@paypal/checkout-server-sdk`, hostnames `api-m.paypal.com` and `api-m.sandbox.paypal.com` (source: pipeline/agent-catalog.ts). Request detection (review only, 2026-10-21): `refit paypal` lists old-SDK request classes, new-SDK controller calls and raw REST calls with method, path, the published operation and the new-SDK method that makes the same request (source: docs/PAYPAL.md). The request map `data/paypal-requests.json` is generated from the packages' own sources and PayPal's published OpenAPI documents. On a frozen set of 22 repositories it reported 90 live requests, all correct on hand review, and traced 82 of 92 real SDK call lines in scanned repositories (89%) by a text heuristic (source: docs/PAYPAL.md#measured-on-a-frozen-set). No deadline entries.

**What breaks for its users.** Facts checked 2026-10-21:
- **Old SDK deprecated.** Every `@paypal/checkout-server-sdk` release (1.0.0-RC3-SNAPSHOT to 1.0.3; the last published 2021-09-21) carries npm's notice "Package no longer supported. The author suggests using the @paypal/paypal-server-sdk package instead" ([registry](https://registry.npmjs.org/@paypal%2fcheckout-server-sdk)). The date of the deprecation is not in the registry metadata. Whether the old package still works against PayPal's API: unverified, since nothing was called. Its GitHub repository, `paypal/Checkout-NodeJS-SDK`, could not be read (`raw.githubusercontent.com` answered 404 and `git clone` asked for credentials).
- **No call shape is shared.** The old SDK sends request objects through `client.execute(request)`; the new one has controller methods. The new SDK renamed every controller method in 0.7.0 (2025-03-20): `ordersCreate` became `createOrder`, from its 0.6.1 and 0.7.0 tarballs. Its [CHANGELOG](https://github.com/paypal/PayPal-TypeScript-Server-SDK/blob/b02a9b9c8f53418d6278928fa41b174803037277/CHANGELOG.md) covers 1.0.0 to 2.4.0, and 2.0.0 lists "several model renames" as breaking. Latest release 2.5.0 (2026-08-21).
- **Hosts.** The old SDK calls `api.paypal.com` and `api.sandbox.paypal.com`. The new SDK and every published OpenAPI document name `api-m.paypal.com` and `api-m.sandbox.paypal.com`. Whether the `api.` hosts are still served: unverified.
- **Machine-readable spec: yes.** [paypal/paypal-rest-api-specifications](https://github.com/paypal/paypal-rest-api-specifications) publishes 13 OpenAPI 3.0 documents (Orders v2, Payments v2, Subscriptions v1, Payment Method Tokens v3, Transaction Search v1, Disputes, Invoicing, Webhooks, Payouts and others), last commit `90e8041` on 2026-04-07. No operation in them is marked `deprecated`. They do not cover `/v1/oauth2/token`, `/v1/identity/*` or `GET /v1/billing/subscriptions`, though the new SDK calls two of those.
- **Versioning.** Paths carry `/v1`, `/v2` or `/v3` per API in both the documents and the SDKs. Per-API deprecation dates, PayPal's REST versioning policy and official release notes: unverified. `developer.paypal.com` is blocked by this environment's network policy, so none of its pages could be read.

**SDK patterns to trace.** Shapes confirmed against the packages (source: docs/PAYPAL.md):
- **Old.** `new paypal.core.SandboxEnvironment(clientId, clientSecret)`, `new paypal.core.PayPalHttpClient(environment)`, then `client.execute(new paypal.orders.OrdersCreateRequest())` with `request.requestBody({...})`. This is the README of `@paypal/checkout-server-sdk` 1.0.3 on npm.
- **New.** `new Client({ clientCredentialsAuthCredentials: { oAuthClientId, oAuthClientSecret }, environment: Environment.Sandbox })` (README of `@paypal/paypal-server-sdk` 2.5.0), then `new OrdersController(client)` and `ordersController.createOrder({ body })` ([doc/controllers/orders.md](https://github.com/paypal/PayPal-TypeScript-Server-SDK/blob/2.5.0/doc/controllers/orders.md)).
- **Raw.** `fetch` and `axios` to `https://api-m.paypal.com/v2/checkout/orders`, often through a live-or-sandbox conditional base.
- **Not traced yet.** Controllers returned from another file's getter, and axios instances created with a PayPal `baseURL`.

**Definition of done.** Frozen set of 50 repositories declaring either package; npm search found 22 on 2026-10-21, so a larger set needs GitHub code search. Targets: ≥ 90% of likely SDK calls traced; ≥ 70% of affected repositories with runnable checks validated; 0 wrong fixes; the package replacement is a named owner decision until a rule covers it.

**Milestones.**
1. Catalog entry exists.
2. Review-only request detection exists (`refit paypal`, 2026-10-21). An adapter for the new SDK's controllers can be written by hand from `data/paypal-requests.json` and the published documents, without `adapter-suggest` spend. Not done: each response-schema mapping still needs checking against the document.
3. Rules for removals and renames the diff proves. The SDK replacement stays review-only.
4. Deadline entries for the old SDK's end of support and any API retirement, once a PayPal page with a date can be read.
5. Freeze 50 (22 frozen).
6. Run and publish (done for the 22, detection only).

**Blockers and owner decisions.** Package replacement policy: whether the old-to-new SDK swap, or the new SDK's 0.6 to 0.7 rename, is ever automatic. `adapter-suggest` spend, if a hand-written adapter is not preferred. Sandbox credentials are never used; validation stays offline with simulated responses, as for Stripe. Network access to `developer.paypal.com`, to verify deprecation dates and release notes.

**Effort: M.**

---

## OpenAI and Anthropic: progress checklist (2026-10-20)

Ten items per provider, taken from each goal's definition of done, worth 10% each.

| # | Item | OpenAI | Anthropic |
|---|---|---|---|
| 1 | Catalog entry | Yes | Yes (`adapter: null`, see its blockers) |
| 2 | Reviewed adapter for the calls real code makes | Yes (`chat.completions`, `responses`, `embeddings`) | Yes (`messages`) |
| 3 | Deadline entries with `source` and `checkedAt` | Yes | Yes, kept current by `refit deadlines --sync anthropic` |
| 4 | Deterministic replacement rule with named stops | Yes | Yes |
| 5 | Automatic validated draft pull requests (`refit serve --model-fixes`) | Yes | Yes |
| 6 | Frozen benchmark set | Yes, 100 repositories | Yes, 50 repositories |
| 7 | Hand-labelled live pins | No | No |
| 8 | At least 90% of labelled pins traced | No | No |
| 9 | At least 70% of affected repositories with runnable checks validated | No: 0 of 47 exposed | No: 1 of 17 exposed |
| 10 | No wrong fix on hand review | Yes: 1 of 1 | Yes: 6 of 6 sites, one parameter unverified |
| | **Done** | **70%** | **70%** |

Both sets came from npm search (`scripts/ai-sdk-select.mjs`), because GitHub code search was unavailable. npm returns published packages: mostly SDK wrappers, provider plugins and model catalogs, not applications. Results are in [`benchmarks/2026-10-20-openai-results.json`](benchmarks/2026-10-20-openai-results.json) and [`benchmarks/2026-10-20-anthropic-results.json`](benchmarks/2026-10-20-anthropic-results.json).

| | OpenAI | Anthropic |
|---|---|---|
| Repositories | 100 | 50 |
| Not scanned (over scan limits, or over the 2-minute cap) | 16 | 17 |
| Live exposure to a registry deadline | 47 | 17 |
| A replacement proposed | 1 | 1 (6 sites) |
| Stopped for review with a reason | 1 | 2 |
| Not traced | 45 | 14 |
| Validated in offline Docker | 0 (the one candidate exceeds the 50 MiB archive limit) | 1 (`vitest` passed before and after) |

Most untraced exposures are not requests an application makes. They are entries in model catalogs (`name: 'codex-mini-latest'` in model metadata, `versions: ['gpt-4.5-preview']`), which the deadline scanner still counts as live, or library defaults in class fields (`model = "gpt-3.5-turbo-instruct"`) that reach the request as `model: this.model`. In that order, the next work is:
1. Classify object-shaped model catalogs as non-live.
2. Follow `this.model` to a class field default.
3. Rebuild the frozen sets from application repositories once GitHub code search is available.

Item 9 cannot reach 70% on a set of libraries, so the fix-rate target needs an application set to measure against.

## PayPal: progress checklist (2026-10-21)

The same ten items as the OpenAI and Anthropic checklist, worth 10% each.

| # | Item | PayPal |
|---|---|---|
| 1 | Catalog entry | Yes (`adapter: null`) |
| 2 | Reviewed adapter for the calls real code makes | No. Request map only: `data/paypal-requests.json`, review-only `refit paypal` |
| 3 | Deadline entries with `source` and `checkedAt` | No. No dated end of support found on a page readable from here |
| 4 | Deterministic replacement rule with named stops | No. The SDK replacement is an owner decision |
| 5 | Automatic validated draft pull requests | No |
| 6 | Frozen benchmark set | Partial: 22 of 50 repositories (npm search found no more) |
| 7 | Hand-labelled live requests | Partial: all 90 reported requests reviewed; missed calls are counted by a text heuristic, not labels |
| 8 | At least 90% of likely SDK calls traced | No: 82 of 92 (89%) in scanned repositories |
| 9 | At least 70% of affected repositories with runnable checks validated | No: no fix is proposed |
| 10 | No wrong fix on hand review | n/a: no fix is proposed |
| | **Done** | **10%** |

Partial items count as not done. Also done, outside the ten: the facts in [What breaks](#paypal) were checked against the npm registry, both packages' sources and PayPal's published OpenAPI documents. Next, in order:
1. Trace controllers returned from getters and axios instances with a PayPal `baseURL`, the two misses on the set.
2. Hand-write a new-SDK adapter from the request map, checking each response schema against the published documents.
3. Rebuild the set from application repositories once GitHub code search is available.

## Priority order

| # | Provider | Reason |
|---|---|---|
| 1 | Shopify | Built-in agent and a 200-app frozen set exist; one owner decision (SDK major upgrade) unblocks up to 44 apps |
| 2 | OpenAI | Adapter and registry exist; 51 of 381 fresh Stripe repositories hit a shutdown on 2026-10-23, three days from this writing |
| 3 | Anthropic | Same SDK shape and the same retirement rule as OpenAI; already in the coverage set; cheapest second AI provider |
| 4 | Meta Graph | Registry exists and matched at 100% line precision; all labelled repositories are past due, so the pain is real; but raw-URL migration is new work |
| 5 | PayPal | In the catalog, a deprecated SDK forces real migrations, PayPal publishes OpenAPI documents (checked 2026-10-21), and review-only detection exists |
| 6 | Gemini | Reuses the retirement rule; the SDK replacement is the only new piece |
| 7 | Slack | Common in app code with named method sunsets; a spec may exist (unverified) |
| 8 | Cloudflare | Likely OpenAPI and a `client.resource.method` SDK, but no evidence yet of how often it breaks users |
| 9 | Google | Largest surface and a non-OpenAPI contract format; needs an architecture decision first |
| 10 | Salesforce | Community SDK, breakage inside SOQL strings, few public repositories |

The order weighs reuse of existing work, how common the SDK is in public repositories, how often the provider breaks users, and whether a machine-readable contract exists. Counts of how common each SDK is come only from Refit's own sets for Stripe, Shopify, OpenAI, Anthropic and Meta; for the others the ranking is a judgement to confirm with a code search before freezing a set.

## Shared work

Capabilities several providers need, in the order the priorities above reach them:

1. **Model-retirement rule** (OpenAI, Anthropic, Gemini): review-only proposals exist for OpenAI and Anthropic (`refit deadlines --propose-model-fixes`, 2026-10-20). `refit serve --model-fixes` applies them through validation and drafts in enrolled repositories (owner decision, 2026-10-20).
2. **Deadline registry entries** for Gemini, PayPal, Slack, Cloudflare, Google and Salesforce, each with a verified `source` and `checkedAt`, and matcher rules per provider (today OpenAI and Anthropic have catalog, test and comparison classes).
3. **Factory and lazy clients** (every provider): the active-teams set shows `getStripe()`-style factories as the main tracing gap (source: docs/READINESS.md, 2026-10-16). Fixing it once lifts every adapter.
4. **Versioned-URL pin moves** (Meta, Shopify REST, Salesforce, Google): one rule that moves a version segment in a URL or a `version` option when the per-version change list proves nothing the code touches changed. Needs a contract shape for "list of removals per version" that is not OpenAPI. Meta has a review-only, Graph-specific version (`pipeline/meta-graph-moves.ts`, 2026-10-20); it is not wired into `refit run`.
5. **Non-OpenAPI change sources** (Meta changelog, Google Discovery, Slack method notices): a reader per shape, or a hand-maintained JSON list like `data/deadlines.json`, with an owner decision on whether a hand list is evidence enough for an edit. Meta has the hand-maintained list (`data/meta-graph-changes.json`), reviewed for v14.0 to v26.0 with 281 changes on 2026-10-20; WhatsApp and Messenger changelogs are not covered yet.
6. **SDK major and package replacement in the same patch** (Shopify 14, PayPal, Gemini): generalise the stripe-node lockfile upgrade so a pin move and its required SDK bump ship together, behind an owner policy per provider.
7. **REST-to-SDK and raw-HTTP detection** (Shopify, Meta, PayPal, Cloudflare): report raw calls by hostname and path with the exact line, as the catalog's hostname evidence already does, before any migration of them is considered. Meta has it (`refit meta-graph`, 2026-10-20, review only); its URL reading in `pipeline/meta-graph-calls.ts` is Graph-specific so far. Shopify has it for REST Admin calls (`shopify.restCalls` in the report, 2026-10-20, review only). PayPal has it for its REST hosts (`refit paypal`, 2026-10-21, review only), matched to the published OpenAPI documents.
8. **`adapter-suggest` runs** (PayPal, Cloudflare, Slack, OpenAI): each spends budget and needs hand review; batch them under one approved budget.
