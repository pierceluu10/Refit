# Payments and commerce APIs (list A)

Refit detects Plaid, Square, Braintree, Adyen, Paddle, Lemon Squeezy, Shippo, EasyPost, Lob and Coinbase Commerce in JS/TS repositories. For each one it reports:

- the API version the code pins, where the provider versions its API, with the version, file and line;
- installed SDK majors that are past their announced end of support.

All ten providers are `adapter: null`, so Refit reports and never edits.

Checked 2026-10-22 (FG10). Nothing was installed, run or sent to a provider.

## What is detected

| Provider | Catalog packages (npm) | Hostnames (from the SDK's own code) |
| --- | --- | --- |
| Plaid | `plaid`, `react-plaid-link` | `production.plaid.com`, `sandbox.plaid.com` |
| Square | `square`, `@square/web-sdk`, `@square/web-payments-sdk-types` | `connect.squareup.com`, `connect.squareupsandbox.com` |
| Braintree | `braintree`, `braintree-web`, `braintree-web-drop-in` | `api.braintreegateway.com`, `api.sandbox.braintreegateway.com`, `payments.braintree-api.com`, `payments.sandbox.braintree-api.com` |
| Adyen | `@adyen/api-library`, `@adyen/adyen-web` | `checkout-test.adyen.com`, `checkout-live.adyenpayments.com`, `pal-test.adyen.com`, `pal-live.adyen.com`, `management-test.adyen.com`, `management-live.adyen.com` |
| Paddle | `@paddle/paddle-node-sdk`, `@paddle/paddle-js` | `api.paddle.com`, `sandbox-api.paddle.com` |
| Lemon Squeezy | `@lemonsqueezy/lemonsqueezy.js` | `api.lemonsqueezy.com` |
| Shippo | `shippo` | `api.goshippo.com` |
| EasyPost | `@easypost/api` | `api.easypost.com` |
| Lob | `lob`, `@lob/lob-typescript-sdk` | `api.lob.com` |
| Coinbase Commerce | `coinbase-commerce-node` | `api.commerce.coinbase.com` |

Packages were checked on the npm registry on 2026-10-22. Each one's repository is in the provider's GitHub organization; `@paddle/paddle-js` names no repository, and its publisher is the `paddle.com` npm account. Third-party wrappers such as `paddle-sdk` and `lemonsqueezy.ts` are left out.

The hostnames are the API base URLs in each provider's published SDK code: plaid-node, square-nodejs-sdk, braintree_node and braintree-web, adyen-node-api-library, paddle-node-sdk, lemonsqueezy.js, shippo-javascript-sdk, easypost-node, lob-node and coinbase-commerce-node. The providers' API reference sites were unreachable (see Sources).

## Pinned API versions

`detectApiVersionPins(directory)` in `pipeline/commerce-api-versions.ts` lists each pin. So do `detectProviders` (`apiVersions` on the detection) and `refit agents`. A pin has `provider`, `version`, `file`, `line`, `form`, a `use` of live or test, and `text`.

`scanDeadlines` matches pins against `api-version` registry entries of the same provider. The shipped registry has none yet (below).

| Form | What is read | Providers |
| --- | --- | --- |
| Header | A literal value (or a `const` in the same file) for the version header. It can sit in an object literal, a `.set` or `.append` call, or an element assignment. | `Plaid-Version`, `Square-Version`, `Braintree-Version` (GraphQL), `Paddle-Version`, `Shippo-API-Version`, `Lob-Version`, `X-CC-Version` (Coinbase Commerce) |
| Option | An SDK option in a file that imports the SDK: Square's legacy `squareVersion`, Square's per-request `version`, Shippo's `shippoApiVersion`. lob-node's `apiVersion` counts only in an argument of `require('lob')(…)` or a call on a name bound to `lob`, so a Stripe `apiVersion` in the same file is not taken for Lob. | Square, Shippo, Lob |
| Path | A versioned URL path in a string or template piece. Adyen versions each API separately, so its version names the API: `checkout/v71`, `Payment/v68`, `management/v3`, `bcl/v2`. | Adyen, EasyPost, Lemon Squeezy, Lob |

- Values must look like a version: a date (`2020-09-14`), or Paddle's integer version.
- Computed values, comments and documentation URLs are not pins.
- Pins in test, spec, fixture and example files are marked `test`.

Each form comes from the provider's SDK code or README:

- plaid-node's README client setup;
- the `Square-Version` header and the per-request `version` option in square-nodejs-sdk, and `squareVersion` in its legacy client;
- `Braintree-Version` in braintree_node's GraphQL client;
- `shippoApiVersion` in the shippo-javascript-sdk README;
- lob-node's `apiVersion` option, which sets `Lob-Version`;
- `DEFAULT_API_VERSION` in coinbase-commerce-node;
- the versioned base URLs in adyen-node-api-library, easypost-node, lemonsqueezy.js and lob-node.

## Registry entries

All are `kind: "sdk"` with a version range (the range matcher from #188), and each cites a page that was read.

| Entry | Date | Matches | Source read |
| --- | --- | --- | --- |
| `adyen-2025-10-01-adyen-web-v3` | 2025-10-01 | `@adyen/adyen-web@<4` | npm deprecation notice on every 3.x release: "will no longer be supported after October 1, 2025"; the adyen-web README lifecycle table agrees |
| `adyen-2026-08-01-adyen-web-v4` | 2026-08-01 | `@adyen/adyen-web@>=4 <5` | npm deprecation notice on every 4.x release: "after August 1, 2026" |
| `braintree-2023-02-01-braintree-web-v2` | 2023-02-01 | `braintree-web@<3` | braintree-web README version table: 2.x Unsupported since February 2023. Month only; the date is the first of the month. |
| `braintree-2023-09-01-braintree-node-v2` | 2023-09-01 | `braintree@<3` | braintree_node README version table: 2.x unsupported from September 2023. Month only. |
| `coinbase-commerce-2021-06-10-commerce-node` | 2021-06-10 | `coinbase-commerce-node` | README notice "not actively maintained", added 2021-06-10, and the npm deprecation notice |
| `easypost-2025-04-28-easypost-node-v7` | 2025-04-28 | `@easypost/api@<8` | easypost-node upgrade guide: v5, v6 and v7 are deprecated. No dates are given; the date is the v8.0.0 release in its CHANGELOG. |

### Checked, nothing dated

- **API version end of life.** No retirement date for a Plaid, Square, Adyen, Paddle, Shippo, Lob, Braintree GraphQL or Coinbase Commerce API version was found in any SDK repository or OpenAPI repository read:
  - plaid-node only supports `2020-09-14` and is generated from that version's OpenAPI document;
  - the Adyen OpenAPI repository marks deprecated fields per version (`x-deprecatedInVersion`) but gives no end-of-life dates for whole versions.

  The providers' versioning pages, which would give these dates, were unreachable (Sources), so there are no `api-version` entries. The matcher is in place and tested with an illustrative registry.
- **Other SDKs.**
  - Lemon Squeezy's v3 removed the long-deprecated `LemonSqueezy` class, but no SDK major is announced as out of support.
  - Paddle's upgrade guide drops Node.js 18 support, not an SDK major.
  - Shippo, Lob and Plaid SDK repositories announce no end of support.
  - The Square SDK still ships its legacy client as `square/legacy`, with no end date.
  - Adyen's `@adyen/api-library` README marks the POS Terminal Management API deprecated, with no date.

## Sources and access

The providers' documentation sites (plaid.com, developer.squareup.com, docs.adyen.com, developer.paypal.com for Braintree, developer.paddle.com, docs.lemonsqueezy.com, docs.goshippo.com, easypost.com, docs.lob.com, docs.cdp.coinbase.com) did not resolve from the cloud environment on 2026-10-22.

Every fact here comes from the npm registry or from the provider's own GitHub repositories, read at these commits:

- braintree/braintree_node `5d24276`, braintree/braintree-web `9672fcf`
- plaid/plaid-node `ae67ead`, square/square-nodejs-sdk `5e48450`
- Adyen/adyen-node-api-library `b1ca6a3`, Adyen/adyen-web `b1bd8f9`
- PaddleHQ/paddle-node-sdk `6a01ef4`, lmsqueezy/lemonsqueezy.js `b1f66e9`
- goshippo/shippo-javascript-sdk `8c25940`, easypost/easypost-node `64aa7e0`
- lob/lob-node `320d35c`, coinbase/coinbase-commerce-node `d46c596`

A reviewer with web access should check the providers' API versioning pages for dated version retirements.

## Benchmark

**Sample.** `docs/benchmarks/2026-10-22-commerce-repos.json` holds **81 repositories**, made by `node scripts/commerce-select.mjs --per 17 --output … --cache <dir>`.

- GitHub code search was unavailable. The repositories frozen earlier held only 5 list-A users (Plaid 1, Paddle 2, Lemon Squeezy 1, Shippo 1).
- The rest come from npm search. The queries are listed in the script, and the npm responses are cached so a rerun reads the same answers.
- The npm repositories are published packages (plugins, SDK wrappers, CLIs, MCP servers), not applications.

| Provider | Plaid | Square | Braintree | Adyen | Paddle | Lemon Squeezy | Shippo | EasyPost | Lob | Coinbase Commerce |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Sampled | 16 | 8 | 17 | 15 | 11 | 10 | 1 | 2 | 1 | 0 |

**Blocked: sample size.** The goal asks for at least 100 repositories and at least 8 per provider. Shippo, EasyPost, Lob and Coinbase Commerce have almost no public npm dependents, and the GitHub search that could find applications for them was unavailable here.

- Wider npm queries and four web searches for these four providers (2026-10-22) found no further repository whose manifest declares their SDK.
- To unblock: frozen GitHub code-search lists for those four SDKs, run where `gh api search/code` works, appended with `--list`.

**Labels.** `docs/benchmarks/2026-10-22-commerce-labels.json` holds 30 repositories, labelled blind and committed (`0f6e2a5`) before Refit scanned the sample. Every provider with a sampled repository is represented. Each label lists the list-A providers used (package or API host), the registry entries that apply, and the API versions live code pins.

**Run.** `node scripts/commerce-benchmark.mjs --root <clones>` on clean commit `f224528` wrote `docs/benchmarks/2026-10-22-commerce-results.json`.

| Measure (27 labelled repositories scanned) | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| Provider detection | 29 | 0 | 0 | 100% | 100% |
| Exposure (repository × entry) | 1 | 0 | 0 | 100% | 100% |
| Pinned API versions (repository × pin) | 4 | 0 | 0 | 100% | 100% |

- **Failed scans.** Six repositories exceed Refit's existing scan limits (10,000 files or 50 MiB), three of them labelled: `commercelayer/commercelayer-react-components`, `ovh/manager`, `medusajs/medusa`, `lambda-curry/medusa-plugins`, `graphcommerce-org/graphcommerce` and `zakariaelas/medusa`. They count as failed scans, not as hits or misses.
- **Small counts.** Exposure and pins have few positives, so their 100% rests on 1 and 4 items.
- **Every live pin reviewed.** All 9 live pin lines across the 75 scanned repositories were read by hand after the scan, and all 9 are correct:
  - Lemon Squeezy `v1` in 5 repositories;
  - `Paddle-Version: 1` in 2, one through a same-file `const`;
  - Plaid `2020-09-14` and Coinbase Commerce `2018-03-22`, one each.
- **A bug the run surfaced.** The first run took `version: 1` (a Square catalog object's version) in `goparrot/square-connect-plus` test files for a Square option pin. Those matches were marked test, so no score changed. The fix accepts only dated versions, apart from Paddle's integer, and is tested.

**Across the 75 scanned repositories**

| | Plaid | Square | Braintree | Adyen | Paddle | Lemon Squeezy | Shippo | EasyPost | Lob | Coinbase Commerce |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Detected | 15 | 9 | 12 | 12 | 12 | 12 | 1 | 2 | 1 | 1 |
| Exposed | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 1 | 0 | 0 |
| Repositories with a live pin | 1 | 0 | 0 | 0 | 2 | 5 | 0 | 0 | 0 | 1 |

- **Exposed.**
  - `Parcela-Express/checkout-component-js` locks `@adyen/adyen-web` 3.23.0 (end of life 2025-10-01).
  - `pastudan/easypost-cli` locks `@easypost/api` 5.3.0.
- **Detection without a package.** Coinbase Commerce and some of Paddle and Lemon Squeezy are found only by API host or version pin, in code that calls the REST API directly.
- **Scan time.** `refit agents` plus `refit deadlines` took 286 s in total over the 75 repositories.

## OpenAPI documents (groundwork for a future agent)

These providers publish their API contract in a public repository. The documents are pinned here by commit and SHA-256, and nothing was built on them. Braintree publishes a GraphQL schema rather than OpenAPI.

| Provider | Document (raw URL at the pinned commit) | Format | SHA-256 | Bytes |
| --- | --- | --- | --- | ---: |
| Square | `https://raw.githubusercontent.com/square/connect-api-specification/0689c901bdfe1ff73f47aa28b17ccd6e0c40bf2d/api.json` | Swagger 2.0 | `8f65460732e19d7445f7a34d8a9df09163db45273df5176a1cc794890ef591fb` | 3273134 |
| Adyen (Checkout v72) | `https://raw.githubusercontent.com/Adyen/adyen-openapi/507d6674c61622c61990f2f3b3ec4038a191d10c/json/CheckoutService-v72.json` | OpenAPI 3.1 | `a9866a157e8ed9e677cbcb946a86d396dfe94302c0f194035adb220ea1229d52` | 963399 |
| Adyen (Payment v68) | `https://raw.githubusercontent.com/Adyen/adyen-openapi/507d6674c61622c61990f2f3b3ec4038a191d10c/json/PaymentService-v68.json` | OpenAPI 3.1 | `bbf83ab63f54bfd55886cd92e72192ddd624ca0529f9fce992dce9636259401a` | 353831 |
| Adyen (Management v3) | `https://raw.githubusercontent.com/Adyen/adyen-openapi/507d6674c61622c61990f2f3b3ec4038a191d10c/json/ManagementService-v3.json` | OpenAPI 3.1 | `55cb8143ce0eb3dd08c74f560cd132b3b689150a2552c6f443c7c1f1cd8f2b7e` | 1450908 |
| Plaid (2020-09-14) | `https://raw.githubusercontent.com/plaid/plaid-openapi/abdd466c34798e9d71663dcb6a3aa9ba78d74959/2020-09-14.yml` | OpenAPI 3.0 | `ea443cd78f6f6bb648c6f0c13f4b00095c3520dcaf45fc7930c36594227a43ee` | 3287800 |
| Lob | `https://raw.githubusercontent.com/lob/lob-openapi/3d9baefb710ae474cae38d6d5b3a28bea5859944/lob-api-public.yml` | OpenAPI 3.0 | `53d35d5e5a18fad19a0375c13a0842350348a0f2afda294104b19c953f5ebabc` | 134347 |
| Paddle (Billing v1) | `https://raw.githubusercontent.com/PaddleHQ/paddle-openapi/2d8dc8471b57a8e85c1979def1649099690377c9/v1/openapi.yaml` | OpenAPI 3 | `4f35a8c6ea4dc930c66ba50d48af16611cbda93b3fb368bbc29c0d578e0b5433` | 7941558 |
| Braintree (GraphQL) | `https://raw.githubusercontent.com/braintree/graphql-api/9f76e60580da00f6740a20692d0b5ea2f313d93e/schema.graphql` | GraphQL SDL | `3b0ddaf6dda2f22d9c7c62c2fdda81bedf29c51997346ce56bca9a3a90793937` | 530644 |

`Adyen/adyen-openapi` holds one document per API version, for example `CheckoutService-v37.json` to `CheckoutService-v72.json`. A future agent can diff versions the way Refit diffs Stripe's pinned documents.

The repository names that were tried and do not exist, or are private, are `goshippo/shippo-openapi`, `EasyPost/easypost-openapi`, `lmsqueezy/openapi` and `coinbase/commerce-openapi`. Nothing else was found for Shippo, EasyPost, Lemon Squeezy or Coinbase Commerce.

## Limits

- Only JS/TS is read. SDK users in other languages wait on FG5's manifests.
- A pin is reported only from a literal or a same-file `const`. Versions set from environment variables or config files are not followed.
- Hostname evidence matches text, as for every catalog provider. A comment that names an API host counts as host evidence.
