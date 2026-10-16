# Shopify real-app benchmark

## Method

The 50 apps in [`2026-10-16-shopify-repos.json`](benchmarks/2026-10-16-shopify-repos.json) were chosen and frozen before any Refit Shopify code existed. A GitHub code search for Shopify Admin clients with a pinned `apiVersion` returned 187 repositories. 155 were not forks or archived, were under 50 MB, had been pushed since 2024-01, and declared a Shopify SDK in their root `package.json`; the 50 most starred were pinned at their default-branch HEAD. Development used 10 other eligible apps (ranks 51–60), never these.

Contracts are the four supported Admin API schemas, `2026-01` to `2026-10`, pinned by SHA-256 in the same file. For each app:

- **Before** is the version Shopify serves for the app's pin: the pin itself, or `2026-01` for a version Shopify no longer supports.
- **Target** is the newest pinned version the code can name: any version for strings and URLs, and for an `ApiVersion` enum pin only members the locked `@shopify/shopify-api` release defines.

When a patch is proposed and the app has a root npm lockfile, it is validated like the [Stripe benchmark](STRIPE-BENCHMARK.md): the app's tests, or `tsc` with only newly introduced errors counted, run in offline Docker on the original and migrated code. No AI is used (spend: $0), and nothing contacts a store.

## Results (Refit `4529530`)

| Outcome | Apps |
|---|---|
| Patched and validated | **1** |
| Already on `2026-10` | 3 |
| On the newest version the locked SDK can name (`2026-10` needs SDK 14) | 3 |
| Stopped: an SDK upgrade is needed to reach a supported version | 15 |
| Stopped: REST Admin calls (no published versioned contract) | 7 |
| Stopped: a GraphQL document is built at runtime | 6 |
| Stopped: the pin is dynamic (environment or configuration value) | 6 |
| Stopped: a GraphQL document already fails on the served version | 5 |
| No Admin API usage | 2 |
| Repository exceeds Refit's scan limits (50 MB) | 2 |

The same commit run a second time gave the **same outcome for 50 of 50 apps**. Per-app outcomes, pins, SDK releases and stop reasons are in [`2026-10-16-shopify-results.json`](benchmarks/2026-10-16-shopify-results.json).

Across the 50 apps Refit found 320 Admin calls and 443 GraphQL documents, 255 of them traced to an Admin call.

- **31 apps pin a version Shopify no longer serves.** Their requests already get `2026-01`.
- **32 apps cannot reach `2026-10` without upgrading `@shopify/shopify-api`.** `ApiVersion.October26` first ships in 14.0.0, and Shopify's app frameworks pin older SDKs.
- **5 apps contain queries that fail on every version Shopify serves.** This is real breakage, at exact lines:
  - Shopify's own `tutorial-discount-functions-with-remix` and `editions-dev-2024-workshop-customer-account` still call `productVariantUpdate` with `ProductVariantInput`, neither of which exists in any supported version.
  - `marketplace-app` selects `productsCount` as a scalar; it is now a `Count` object.
  - `GEO-AI-Shopify` calls `metafieldDelete` with `MetafieldDeleteInput`.
  - `busymate-ai-connector-shopify` selects `returnableFulfillments` on `Order`.
- **29 apps select fields deprecated on their target.** These are listed for review, not changed.

The validated app, `samirjabib/shopify-apps-convex-template`, moved `ApiVersion.October25` to `ApiVersion.April26`, the newest member its SDK 13.0.0 defines. Its tests passed on both versions. It makes no Admin GraphQL calls of its own, and the draft PR says so.

### Before and after fixes

The first run (`844adee`) found three Refit bugs, each fixed with a test:

| Outcome | First run | Final |
|---|---|---|
| Already on `2026-10`, or on the newest version the SDK can name | 1 | 6 |
| Stopped: dynamic pin | 14 | 6 |
| Stopped: SDK upgrade needed | 8 | 15 |
| Stopped: document already fails | 6 | 5 |
| Stopped: runtime-built document | 8 | 6 |
| Misclassified as stopped while already on `2026-10` | 1 | 0 |

The fixes:

- **`LATEST_API_VERSION` counted as unknown.** It is fixed by the locked SDK release, so 10 apps moved from "dynamic pin" to the more precise "SDK upgrade needed".
- **Documents for other Shopify APIs blocked runs.** Customer Account and Partner API documents, and fixtures in test files, are now noted instead.
- **Two readable patterns were missed.** SDK copies nested under an app framework in `package-lock.json`, and a `const` chosen by a ternary of two documents, are now read.

### Helper tracing (`21efc5a`)

Refit now follows default-exported documents, Remix-style `./shopify.server` imports and documents passed as a helper's parameter (see [Shopify](SHOPIFY.md#what-refit-reads)). On the same 50 apps, traced Admin documents rose from 255 to **336** and unreadable documents fell from 55 to **27**. Every outcome stayed the same (50 of 50): Shopify's own `subscriptions-reference-app` is now fully read, and stops only because it pins `ApiVersion.Unstable`. The whole run took 22 seconds.

## Fresh apps (200, October 16)

The 200 apps in [`2026-10-16-shopify-fresh-repos.json`](benchmarks/2026-10-16-shopify-fresh-repos.json) were frozen before any run, and none of them was in the original 50 or the 10 development apps. A wider search covered 13 queries: Shopify SDK dependencies in `package.json`, `authenticate.admin`, `admin.graphql` with `#graphql`, `ApiVersion` with `shopifyApp`, `clients.Graphql` and `createAdminApiClient`. It returned 3,496 repositories. 2,139 met the same criteria as above, and the 200 most starred were pinned at HEAD (1 to 562 stars).

| Outcome (Refit `5f94ab4`) | Apps |
|---|---|
| **Patched and validated** in offline Docker (2 with tests, 4 with `tsc`) | **6** |
| Patched, no runnable checks (no npm lockfile or test script) | 5 |
| Patched, baseline checks already fail | 1 |
| Patched, repository refused for validation (tracked symbolic link) | 1 |
| Already on `2026-10` | 1 |
| Stopped: an SDK upgrade is needed to reach a supported version | 44 |
| Stopped: REST Admin calls | 39 |
| Stopped: a GraphQL document is built at runtime | 26 |
| Stopped: a GraphQL document **already fails** on the version Shopify serves | **23** |
| Stopped: the pin is dynamic, missing or set from configuration | 21 |
| Stopped: a document does not parse, or two pins conflict | 3 |
| No Admin API usage (Storefront, Functions, themes or extensions only) | 28 |
| Repository exceeds Refit's scan limits | 2 |

Refit found 677 Admin calls and 895 GraphQL documents, 628 of them traced to an Admin call. Per-app outcomes are in [`2026-10-16-shopify-fresh-results.json`](benchmarks/2026-10-16-shopify-fresh-results.json). Scanning all 200 took 134 seconds of CPU time on one machine; validation ran in Docker with concurrency 1, and no AI was used.

- **13 apps were patched (6.5%), against 1 of the original 50.** All 13 diffs were read by hand. Each moves only Admin API version pins, to the newest version the locked SDK can name, in the runtime configuration and the matching `.graphqlrc` codegen file.
- **23 apps (12%) send a query that fails today.** Each error was rechecked with graphql-js against the served schema. 11 are the old Remix template's `productVariantUpdate(input: ProductVariantInput)`, which no supported version has. Others select removed fields (`Product.publishedScope`, `ProductVariant.weight`, `Collection.onlineStoreUrl`), call removed mutations (`inventoryAdjustQuantity`, `orderAddNote`), select `productsCount` without its new subfields, or declare unused variables.
- **The benchmark found four Refit bugs, each fixed with a test before the final run.** Three were REST calls that were not recognized, so the app's version was moved instead of stopping for review:
  - a REST URL whose resource path comes before a substitution (`/admin/api/2021-10/products/${id}.json`);
  - `createAdminRestApiClient(...)` from `@shopify/admin-api-client`;
  - REST resource classes such as `shopify.rest.Product` and `shopify.api.rest.CustomCollection.all()`.

  The fourth was preparation: npm workspaces declared as `{ "packages": [...] }`, the Shopify CLI template's form, were refused. npm reads that form the same way as an array, so `cornerstone-report/x-money-shopify` and `sahmsec/conversion-app` (63 tests) now validate. The REST fixes turned 3 wrongly patched apps into stops; none of them had validated. Between the first run (`d368c2a`) and the final one, 10 apps changed, each because of one of these fixes.

## Reproduce

```sh
node scripts/shopify-benchmark-setup.mjs --root <dir>
git worktree add --detach <worktree> <commit>   # run from a pinned checkout
npm run benchmark:shopify -- --root <dir> --output <run> --validate --concurrency 2
# fresh 200: add --list docs/benchmarks/2026-10-16-shopify-fresh-repos.json to both commands
```

## What this shows

Refit's contract check is precise. Every stop names a file and line, and the five already-broken apps are true breakage. But one benchmark app was moved automatically: real Shopify apps mostly sit behind their framework's SDK, so the version they can reach is limited by `@shopify/shopify-api`, not by the Admin API. Automating that SDK upgrade, and reading documents passed through helpers, would move the most apps.
