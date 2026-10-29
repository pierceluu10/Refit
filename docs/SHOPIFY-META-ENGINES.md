# Shopify and Meta Graph engines

Written 2026-10-29. Each provider gets its own deterministic engine, built like Stripe's:

- a versioned contract;
- rules from the provider's own documentation, with sources quoted;
- tracing;
- proof;
- PRs.

AI is used heavily wherever it adds coverage: mining changelogs, repairing patches, writing behaviour tests, second-opinion review, and complex migrations. The aim is coverage of nearly every breaking-change type, not only version bumps.

## What is reused, not rebuilt

- **Pipeline and proof:** findings, the patch engine, proof levels A–D (`docs/PROOF-BASED-VALIDATION.md`), and PR writing.
- **AI:** AI repair with the 2026-10-28 founder unblocks, and the learning loop (`docs/AUTONOMOUS-LOOP.md`).
- **Validation sandbox:** lockfile, Bun, pnpm and Node handling; baseline comparison.
- **Tracing and PRs:** type-based client tracing, version-bump PRs, and version moves made together with SDK moves.
- **Benchmarking:** refit-bench, one repo per shard, the bench monitor, and the blocker census.
- **Existing provider code:**
  - Shopify: `pipeline/shopify*.ts` (pipeline, schemas, versions, REST deprecations, SDK upgrade);
  - Meta: `pipeline/meta-graph-*.ts` (calls, changes, moves);
  - `data/deadlines.json`: 7 Shopify and 13 Meta Graph deadlines.

## Lessons from Stripe, applied from day one

1. **Freeze blind sets first.** Pre-scan for affected repos and freeze a dev set and a blind set before writing code. Never tune on the blind set.
2. **Pick fixes by frequency** across many repos, using the census, never repo by repo.
3. **Proof is the target, not patch count.**
4. **Build tracing first.** Factories, wrappers and URL builders hid most of Stripe's misses.
5. **Move the version and the SDK together, or not at all**, honouring the lockfile choice.
6. **Rules come from the provider's docs with quotes; AI fills the rest; hand-check everything.**
7. **One combined benchmark run per provider** at the end. No l2-push-249 runs.

## Shopify: breaking-change catalogue

| #   | Change type                                                                                                                                             | Find                                                                                                                            | Fix                                                                                | Proof                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | API version lifecycle (quarterly versions, about 12 months of support)                                                                                  | `apiVersion` in `shopifyApi()`/`LATEST_API_VERSION`, `shopify.app.toml` `api_version`, `/admin/api/YYYY-MM/` URLs, env defaults | Move to a supported version together with the SDK                                  | Schema validation at the target version                                                                                |
| 2   | GraphQL Admin: removed or renamed fields, arguments and enum values; nullability and type changes; input object changes; deprecations becoming removals | GraphQL documents in `.graphql`/`gql`/template strings and codegen, traced to Admin clients                                     | Rules from the schema diff between versions plus the changelog                     | Validate every document against the target schema with `graphql-js` (deterministic); codegen types plus the type check |
| 3   | Mutation and payload changes: `userErrors` shapes, renamed mutations, new required inputs                                                               | Mutation documents and the code reading their payloads                                                                          | Rules; AI repair for reads                                                         | Schema validation plus the type check                                                                                  |
| 4   | Product model changes (2024-04 onward): option and variant model, bulk variant mutations, raised variant limits                                         | Product and variant queries and mutations                                                                                       | Documented migrations as rules; AI for the rest                                    | Schema validation; dev store calls                                                                                     |
| 5   | REST Admin legacy deprecation, toward GraphQL                                                                                                           | REST client calls (`shopify.rest.*`, `/admin/api/.../*.json`)                                                                   | REST-to-GraphQL migrations where Shopify documents the mapping; AI writes the rest | Schema validation of the generated GraphQL; dev store calls                                                            |
| 6   | Webhooks: topic changes, payload versions, mandatory compliance webhooks, TOML subscriptions                                                            | Webhook registration and handlers                                                                                               | Rules; payload reads made to work across versions                                  | Type check; signed sample payloads                                                                                     |
| 7   | `@shopify/shopify-api`, `@shopify/shopify-app-remix` / React Router app template, App Bridge and Polaris major versions                                 | `package.json` and lockfile, plus call sites                                                                                    | Package and lockfile upgrade plus documented call rewrites                         | Type check, tests, build                                                                                               |
| 8   | Storefront API and Customer Account API versions                                                                                                        | Storefront clients and documents                                                                                                | As in #1–#3, against the Storefront schema                                         | Schema validation                                                                                                      |
| 9   | Checkout and scripts: `checkout.liquid` to Checkout Extensibility; Shopify Scripts to Functions                                                         | Liquid and Scripts files                                                                                                        | **Alert only**, with deadlines. These are redesigns, not mechanical edits.         | n/a                                                                                                                    |
| 10  | Access scopes and billing API changes                                                                                                                   | Scopes in TOML and config; billing calls                                                                                        | Rules where documented; otherwise an alert                                         | Type check                                                                                                             |

## Meta Graph: breaking-change catalogue

| #   | Change type                                                                                                                                         | Find                                                                                                                         | Fix                                                                             | Proof                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | Graph API version lifecycle (about 2 years per version)                                                                                             | Versioned URLs (`graph.facebook.com/vXX.X/`), SDK default versions, the FB JS SDK `init({version})`, env and config defaults | Move to a supported version together with the SDK                               | Request fields checked against the version change table |
| 2   | Removed or renamed fields and edges per version                                                                                                     | `fields=` lists, edge paths and SDK field constants, traced to Graph calls (fetch, axios, `facebook-nodejs-business-sdk`)    | Rules from a **versioned change table** built from Meta's changelog with quotes | Field-table check; test app calls                       |
| 3   | New required parameters and changed parameter semantics                                                                                             | Request parameters on traced calls                                                                                           | Rules; AI for computed values                                                   | Field-table check                                       |
| 4   | Response shape changes                                                                                                                              | Code reading responses                                                                                                       | Rules; AI repair                                                                | Type check; recorded responses                          |
| 5   | Product shutdowns and migrations, e.g. Instagram Basic Display to the Instagram API with Instagram Login, and WhatsApp on-premises to the Cloud API | Endpoint usage                                                                                                               | Documented migrations where mechanical; otherwise [Needs review] with the plan  | Field-table check; test app calls                       |
| 6   | Marketing API changes: insights metric deprecations, ad object field changes                                                                        | Insights `fields`/`breakdowns`; ad object calls                                                                              | Rules from the Marketing API changelog                                          | Field-table check                                       |
| 7   | Webhooks: field and subscription changes                                                                                                            | Webhook handlers and subscription calls                                                                                      | Rules                                                                           | Type check; sample payloads                             |
| 8   | Error code and permission changes                                                                                                                   | Error handling; requested scopes                                                                                             | Rules where documented; otherwise an alert                                      | Type check                                              |
| 9   | App review, permission and policy changes                                                                                                           | n/a                                                                                                                          | **Alert only**                                                                  | n/a                                                     |

## AI, used heavily

**Founder decision, 2026-10-29: maximise useful AI use with the OpenAI credit.** AI is used for:

1. **Changelog mining.** Read every Shopify and Meta changelog entry since the oldest supported version and propose candidate rules. Each one is verified deterministically, against the schema diff for Shopify or by quoting the source and passing `rules:check` for both, before it becomes a rule.
2. **Repair:** of every patch that breaks the build (founder decisions of 2026-10-28).
3. **Behaviour tests:** against the Shopify dev store and the Meta test app where available, using the harness from #386.
4. **REST-to-GraphQL and product-migration rewrites** where no one-to-one rule exists. They must pass schema validation.
5. **Second-opinion review of every patch** (the AI assessment). Advisory only; it never clears a stop alone.

Spend is recorded per repo and per stage, with a run-level cap and no per-repo cap.

## Benchmarks

**Selection.** For each provider, choose active repositories using the provider's SDK or endpoints. Pre-scan them, keep only the affected ones, and freeze a **dev** set of about 60 and a **blind** set of about 30, with no overlap with each other or with any earlier list.

**Agent work happens offline** on the dev set. **One combined run per provider** on the blind set at the end, with AI and proof.

**Report:**

- validated, version-bump and needs-review counts by reason;
- proof levels;
- hand-checked verdicts on every new validated row;
- the score from `docs/BENCH-MONITOR.md`;
- AI spend.

## Founder actions (optional; they raise proof quality)

- **Shopify:** a Partner development store and an Admin API access token, set as the refit-bench secret `SHOPIFY_TEST_STORE` / `SHOPIFY_TEST_TOKEN`.
- **Meta:** a test app and test user token, set as `META_TEST_TOKEN`.
- **OpenAI:** credit for heavy AI use (auto-recharge on).
