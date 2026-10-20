# Provider goals

One goal per API provider, shaped like [the Stripe goal](STRIPE-PLAN.md#definition-of-done): a frozen benchmark of real public repositories, a share of affected repositories that end in a validated fix, zero wrong fixes on hand review, and every remaining stop named as an owner decision. Written 2026-10-20 from the files cited in each section. Nothing here claims support that [READINESS.md](READINESS.md) does not record.

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

**Status today.** In the catalog with a file adapter, `examples/openai.provider.json`, which maps `models.retrieve` → `Model`, `chat.completions.create` → `CreateChatCompletionResponse` and `embeddings.create` → `CreateEmbeddingResponse`, each with its operation ID, checked against OpenAI's published OpenAPI document (`openai/openai-openapi`, info.version 2.3.0) on 2026-10-20. `responses.create` is traced but not mapped: its `Response` schema is an `allOf`, which adapter mappings do not support yet. A review-only model replacement proposal exists: `refit deadlines --propose-model-fixes` (source: docs/DEADLINES.md#propose-model-replacements, 2026-10-20). READINESS calls it a preview adapter; the OpenAI fixtures test invented renames, not announced changes (source: docs/READINESS.md, "provider detection and agent catalog"; pipeline/fixtures/openai/README.md). Numbers:

| Measure | Value | Source |
|---|---|---|
| Deadline registry entries | 27 shutdowns, 67 model IDs, checked 2026-10-15 | data/deadlines.json |
| Fresh Stripe repositories sending a model retired 2026-10-23 | 51 of 381 | docs/BENCHMARKS.md, 2026-10-16 |
| Labelled deadline repositories with a live 2026-10-23 model | 15 of 34 | docs/DEADLINE-BENCHMARK.md, 2026-10-16 |
| OpenAI line precision, live-only evidence | 83% (19/23) | docs/READINESS.md, "live-only deadline evidence" |
| Likely SDK calls traced on the 15-repository coverage set | 38 → 172 of 187 after class clients | docs/SDK-COVERAGE.md; docs/READINESS.md, 0.19.0 |
| Exposed deadline-benchmark repositories with a proposed replacement | 1 of 15 (2 sites, both correct on hand review), 1 more stopped for review | docs/benchmarks/2026-10-20-model-replacement-results.json |

**What breaks for its users.** Model shutdowns on published dates: a retired model stops serving requests (source: docs/DEADLINE-BENCHMARK.md). The registry source is `https://developers.openai.com/api/docs/deprecations` (source: data/deadlines.json). There is no dated API version to pin; `apiVersion: "1"` in the fixtures is a simulated contract, not an OpenAI release (source: docs/MULTIPLE-INTEGRATIONS.md). SDK major versions and endpoint migrations (Chat Completions → Responses): unverified: check. Machine-readable spec: an OpenAPI document for the public API, unverified: check. Refit's own AI calls use the Responses endpoint (source: pipeline/openai.ts).

**SDK patterns to trace.** Package `openai`, default import, named export `OpenAI` (source: examples/openai.provider.json). Call shapes in the fixtures and coverage set: `new OpenAI(...)`, `client.chat.completions.create({ model, messages })`, `client.models.retrieve(id)`; the `model` argument is where the retiring value lives. Real repositories hold the client in class fields, path-alias modules and factories (source: docs/SDK-COVERAGE.md). `client.responses.create` and `client.embeddings.create` are traced like the others (pipeline/model-retirements.test.ts). On the deadline benchmark most live pins sit outside traced calls: the v3 SDK's `openai.createChatCompletion`, `openai-edge`, model constants, helper parameters and UI state (source: docs/benchmarks/2026-10-20-model-replacement-results.json).

**Definition of done.**

| Measure | Target |
|---|---|
| Frozen set | 100 repositories declaring `openai`, selected as above; 30 hand-labelled for live model pins and the correct replacement |
| Live model pins traced to a call argument | ≥ 90% of labelled pins |
| Affected repositories (live pin of a registry model) ending in a validated fix | ≥ 70% of those with runnable checks |
| Wrong fixes on hand review of every validated fix | 0 |
| Remaining stops | each a named owner decision (replacement model policy, catalogs, env fallbacks) |

**Milestones.** 1. Catalog entry exists. 2. **Done 2026-10-20, except `responses.create`:** the adapter maps `chat.completions.create` and `embeddings.create`, written by hand from the published OpenAPI document, so no `adapter-suggest` budget was spent. `responses.create` needs `allOf` support in adapter mappings. 3. **Review-only rule done 2026-10-20:** `refit deadlines --propose-model-fixes` replaces a live literal model ID with the registry `replacement` (followed while it retires too), only in a traced text-generation call's `model` or a `??`/`||` default there, never in catalogs, tests or comparisons, and stops for review on sampling and length parameters, spread options and constants. It is not wired into `refit run`, validation or drafts until the replacement policy below is decided. Next coverage steps, by benchmark count: the v3 SDK's `createChatCompletion`, request objects held in a variable, and constants used by one call. 4. Deadline entries already exist; keep `checkedAt` current. 5. Freeze the 100-repository set and labels (needs a GitHub code search token; this session had none). 6. Run the fix benchmark with validation; publish per-repository results like the Stripe sets.

**Blockers and owner decisions.** Whether a model swap is a "migration" Refit may apply, validate and publish as a draft, rather than only propose as a patch for review: the replacement changes behaviour, cost and limits, so the rule needs an owner policy on which replacements are allowed (registry `replacement` as-is, or review only). `adapter-suggest` spends OpenAI budget; the budget ledger decision in [STRIPE-PLAN.md](STRIPE-PLAN.md#open-decisions) applies. Any check that calls OpenAI live is out; validation stays offline.

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

**Status today.** In the catalog with `adapter: null`, package `facebook-nodejs-business-sdk`, hostname `graph.facebook.com` (source: pipeline/agent-catalog.ts). Deadline registry: 13 versions, v13.0 to v25.0, source `https://developers.facebook.com/docs/graph-api/changelog`, checked 2026-10-15 (source: data/deadlines.json). On the labelled deadline set, 11 of 11 Meta repositories were exposed, all past due on v13.0–v20.0, with 100% line precision (source: docs/DEADLINE-BENCHMARK.md). The matcher reads versioned URLs, quoted `'v20.0'` strings in Graph files, and the SDK version from manifests and lockfiles (source: docs/DEADLINES.md).

**What breaks for its users.** Dated major versions; a retired version is "defaulted to the next oldest, usable version" (source: docs/DEADLINE-BENCHMARK.md, citing `https://developers.facebook.com/docs/graph-api/guides/versioning`). So exposure means silently changed behaviour, not an outage. Each version's changelog lists removed fields and endpoints: unverified: check whether the changelog is machine-readable. OpenAPI document: unverified: check (none is cited in the repository).

**SDK patterns to trace.** Most benchmark repositories call Graph through raw `fetch`/`axios` to `https://graph.facebook.com/v20.0/...` (source: docs/DEADLINE-BENCHMARK.md, search queries). SDK shape `FacebookAdsApi.init(token)` then resource classes such as `new AdAccount(id).getCampaigns(fields, params)`: unverified: check against the SDK README. The browser `FB.init({ version })` is not read today (source: docs/DEADLINES.md).

**Definition of done.** Frozen set of 50 repositories using `graph.facebook.com` or the business SDK (the deadline frame already holds 33). Targets: ≥ 90% of versioned URL pins and SDK pins traced; ≥ 70% of affected repositories with runnable checks end in a validated version move; 0 wrong fixes; every field removal on a called edge stops as a named owner decision until a rule covers it.

**Milestones.** 1. Catalog entry exists. 2. An adapter for raw versioned URLs (a new contract shape: path-and-version, not OpenAPI) and the business SDK's resource classes. 3. Deterministic rule: move the version segment in URLs and the SDK's declared version only when every called edge and read field exists on the target per the changelog; otherwise stop at the line. 4. Deadline entries exist; keep them current. 5. Freeze 50 repositories. 6. Run and publish.

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
| Fresh | 200 | 170 | 6 (13 patched) | 44 need an SDK upgrade, 39 use REST |
| Original | 50 | 46 | 1 | 15 need an SDK upgrade |

23 of 200 fresh apps send a query that fails on every served version, each at an exact line. Repeat runs matched 200 of 200. Deadline registry: 7 Admin versions, 2025-04 to 2026-10 (source: data/deadlines.json).

**What breaks for its users.** Quarterly dated versions, each supported for a year; an unsupported pin "falls forward" to the oldest supported version (source: docs/SHOPIFY.md, citing `https://shopify.dev/docs/api/usage/versioning`). Removed fields, arguments, enum values and types per version are provable from the schema. REST Admin calls have no published versioned contract (source: docs/SHOPIFY.md). The REST API's deprecation in favour of GraphQL: unverified: check the date and scope. `ApiVersion.October26` needs `@shopify/shopify-api` 14 (source: docs/SHOPIFY.md).

**SDK patterns to trace.** Already read: `admin.graphql(...)` from the Remix, React Router and Express packages, `createAdminApiClient(...).request(...)`, `shopify.clients.Graphql(...).request/query(...)`, and pins as `ApiVersion.<Month><YY>`, `apiVersion: 'YYYY-MM'`, versioned URLs and `LATEST_API_VERSION` (source: docs/SHOPIFY.md). Not read: documents built at runtime, arrays, closures, re-exports; `shopify-api-node`; REST calls (source: docs/SHOPIFY.md, limits).

**Definition of done.** Measured on the frozen fresh 200 (`docs/benchmarks/2026-10-16-shopify-repos.json` and `-fresh-repos.json`):

| Measure | Today | Target |
|---|---|---|
| Admin apps ending in a validated version move | 6 of 170 | ≥ 70% of those with runnable checks, once the SDK-upgrade decision is made |
| Apps stopped on "SDK upgrade needed" | 44 | 0 without a named decision |
| Apps stopped on REST | 39 | each reported with the exact REST calls; migration only under an owner-approved rule |
| Wrong fixes on hand review | 0 of 7 | 0 |
| Repeat-run agreement | 200/200 | 200/200 |

**Milestones.** 1. Catalog entry exists. 2. Adapter exists. 3. Rules: an `@shopify/shopify-api` major upgrade in the same patch as the pin move, modelled on the stripe-node upgrade in [DEPENDENCIES.md](DEPENDENCIES.md#stripe-node-upgrade-in-a-patch), if the owner allows a major bump; helper and closure document tracing. 4. Deadline entries exist; add versions older than 2025-04 so older pins are reported. 5. Set is frozen. 6. Rerun and publish.

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

**Status today.** In the catalog with `adapter: null`, packages `@paypal/paypal-server-sdk` and `@paypal/checkout-server-sdk`, hostnames `api-m.paypal.com` and `api-m.sandbox.paypal.com` (source: pipeline/agent-catalog.ts). No deadline entries, benchmark or fixture.

**What breaks for its users.** `@paypal/checkout-server-sdk` is deprecated in favour of `@paypal/paypal-server-sdk`, with different client and request classes: unverified: check the date and whether the old package still works. REST APIs are versioned by path (`/v1`, `/v2`) with per-API deprecations: unverified: check. Machine-readable spec: PayPal publishes OpenAPI documents for its REST APIs: unverified: check the repository and coverage. Official release notes: unverified: check.

**SDK patterns to trace.** Old: `new paypal.core.PayPalHttpClient(environment)`, `client.execute(new paypal.orders.OrdersCreateRequest())`. New: `new Client({ clientCredentialsAuthCredentials, environment })`, `new OrdersController(client).createOrder({ body })`. Raw `fetch` to `api-m.paypal.com/v2/checkout/orders`. Shapes from memory: unverified: check both READMEs.

**Definition of done.** Frozen set of 50 repositories declaring either package. Targets: ≥ 90% of likely SDK calls traced; ≥ 70% of affected repositories with runnable checks validated; 0 wrong fixes; the package replacement is a named owner decision until a rule covers it.

**Milestones.** 1. Catalog entry exists. 2. Adapter for the new SDK's controllers from the OpenAPI document via `adapter-suggest`, hand reviewed; the old SDK's `execute(request)` shape needs a new tracing pattern. 3. Rules for removals and renames the diff proves; the SDK replacement review-only. 4. Deadline entries for the old SDK's end of support and any API retirement. 5. Freeze 50. 6. Run and publish.

**Blockers and owner decisions.** Package replacement policy. `adapter-suggest` spend. Sandbox credentials are never used; validation stays offline with simulated responses, as for Stripe.

**Effort: M.**

---

## Priority order

| # | Provider | Reason |
|---|---|---|
| 1 | Shopify | Built-in agent and a 200-app frozen set exist; one owner decision (SDK major upgrade) unblocks up to 44 apps |
| 2 | OpenAI | Adapter and registry exist; 51 of 381 fresh Stripe repositories hit a shutdown on 2026-10-23, three days from this writing |
| 3 | Anthropic | Same SDK shape and the same retirement rule as OpenAI; already in the coverage set; cheapest second AI provider |
| 4 | Meta Graph | Registry exists and matched at 100% line precision; all labelled repositories are past due, so the pain is real; but raw-URL migration is new work |
| 5 | PayPal | In the catalog, a deprecated SDK forces real migrations, and an OpenAPI document likely exists (unverified) |
| 6 | Gemini | Reuses the retirement rule; the SDK replacement is the only new piece |
| 7 | Slack | Common in app code with named method sunsets; a spec may exist (unverified) |
| 8 | Cloudflare | Likely OpenAPI and a `client.resource.method` SDK, but no evidence yet of how often it breaks users |
| 9 | Google | Largest surface and a non-OpenAPI contract format; needs an architecture decision first |
| 10 | Salesforce | Community SDK, breakage inside SOQL strings, few public repositories |

The order weighs reuse of existing work, how common the SDK is in public repositories, how often the provider breaks users, and whether a machine-readable contract exists. Counts of how common each SDK is come only from Refit's own sets for Stripe, Shopify, OpenAI, Anthropic and Meta; for the others the ranking is a judgement to confirm with a code search before freezing a set.

## Shared work

Capabilities several providers need, in the order the priorities above reach them:

1. **Model-retirement rule** (OpenAI, Anthropic, Gemini): review-only proposals exist for OpenAI and Anthropic (`refit deadlines --propose-model-fixes`, 2026-10-20). Applying them through validation and drafts waits on an owner replacement policy.
2. **Deadline registry entries** for Gemini, PayPal, Slack, Cloudflare, Google and Salesforce, each with a verified `source` and `checkedAt`, and matcher rules per provider (today OpenAI and Anthropic have catalog, test and comparison classes).
3. **Factory and lazy clients** (every provider): the active-teams set shows `getStripe()`-style factories as the main tracing gap (source: docs/READINESS.md, 2026-10-16). Fixing it once lifts every adapter.
4. **Versioned-URL pin moves** (Meta, Shopify REST, Salesforce, Google): one rule that moves a version segment in a URL or a `version` option when the per-version change list proves nothing the code touches changed. Needs a contract shape for "list of removals per version" that is not OpenAPI.
5. **Non-OpenAPI change sources** (Meta changelog, Google Discovery, Slack method notices): a reader per shape, or a hand-maintained JSON list like `data/deadlines.json`, with an owner decision on whether a hand list is evidence enough for an edit.
6. **SDK major and package replacement in the same patch** (Shopify 14, PayPal, Gemini): generalise the stripe-node lockfile upgrade so a pin move and its required SDK bump ship together, behind an owner policy per provider.
7. **REST-to-SDK and raw-HTTP detection** (Shopify, Meta, PayPal, Cloudflare): report raw calls by hostname and path with the exact line, as the catalog's hostname evidence already does, before any migration of them is considered.
8. **`adapter-suggest` runs** (PayPal, Cloudflare, Slack, OpenAI): each spends budget and needs hand review; batch them under one approved budget.
