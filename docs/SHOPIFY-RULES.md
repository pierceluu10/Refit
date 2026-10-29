# Shopify contracts and rules

Refit's Shopify engine is built like Stripe's: pinned, versioned contracts, deterministic diffs between them, and migration rules that quote Shopify's own changelog or migration guides and must agree with the diff. This page covers the contract and rule layer (catalogue rows 1–8 and AI use #1 in the Shopify engine plan). Tracing documents to clients and editing them is in [Shopify Admin API](SHOPIFY.md).

Every rule is **review-only**. No Shopify rule edits code yet: owner decision D3 makes a rule `auto` only after a benchmark run shows zero wrong patches, and no Shopify benchmark has run on these rules.

## Pinned schemas

`data/shopify-schema-versions.json` pins each schema by the SHA-256 of its introspection, saved gzipped in `data/shopify-schemas/<api>/<version>.json.gz`, so checks work offline and keep working after Shopify stops serving a version. Refit refuses a saved schema whose content does not match its pin.

| API        | Versions                           | Source                                                                                                                           |
| ---------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Admin      | 2026-01, 2026-04, 2026-07, 2026-10 | `https://shopify.dev/admin-graphql-direct-proxy/<version>`, fetched 2026-10-29                                                   |
| Admin      | 2025-01                            | `@shopify/dev-mcp` 1.1.0, `data/admin_schema_2025-01.json.gz` (Shopify's dev MCP server), with the tarball's npm integrity       |
| Storefront | 2026-01, 2026-04, 2026-07, 2026-10 | `https://shopify.dev/storefront-graphql-direct-proxy/<version>`, fetched 2026-10-29                                              |
| Storefront | 2024-10, 2025-01, 2025-07, 2025-10 | `storefront.schema.json` in `@shopify/hydrogen-react` 2024.10.2, 2025.1.4, 2025.7.2 and 2025.10.0, with each tarball's integrity |

Pin or refresh one:

```sh
refit shopify-snapshot --pin --api admin --version 2026-10
```

```sh
refit shopify-snapshot --pin --api storefront --version 2025-01 --file <unpacked>/package/storefront.schema.json --package @shopify/hydrogen-react@2025.1.4 --path storefront.schema.json --integrity <sha512-…>
```

Limits of these sources:

- Shopify's proxy serves only supported versions (2026-01 to 2026-10 today, plus the 2027-01 release candidate, which is not pinned because it can still change). Admin 2025-01 is the most common unsupported pin in the frozen Shopify benchmark lists after the supported ones, and the only older Admin schema Shopify publishes in a package. Admin 2024-xx and 2025-04 to 2025-10 have no Shopify-published source, so their changes appear in the 2025-01 → 2026-01 diff together.
- `@shopify/hydrogen-react` 2025.4.x ships the same `storefront.schema.json` bytes as 2025.1.4, so Storefront 2025-04 is not pinned rather than pinned to a copy of 2025-01.
- A package's schema is the one Shopify captured when it built the package. Compared with the proxy, hydrogen-react 2026.1.2 lacks 3 members the proxy's 2026-01 schema has (`CartBuyerIdentityInput.deliveryAddressPreferences`, `CurrencyCode.XCG`, `Metafield.list`). A diff from a package pin to a proxy pin can therefore include capture drift; every rule also needs Shopify's own words, so drift alone never makes a rule.
- The Customer Account API is not pinned: hydrogen-react ships a `customer-account.schema.json`, but nothing in the package says which API version it is.

## Schema diffs

`data/shopify-schema-diffs/<api>/<version>.json` holds the changes into each pinned version from the pinned version before it (`pipeline/shopify-schema-diff.ts`), at schema coordinates (`Type`, `Type.field`, `Type.field(argument:)`, `Input.field`, `Enum.VALUE`):

- breaking, as graphql-js's `findBreakingChanges` defines them: removed types, fields, arguments, input fields, enum values, union members and interfaces; type changes (an output field that becomes nullable or another type, an input that becomes required or another type); new required arguments and input fields;
- `deprecated`: a member newly deprecated, with Shopify's reason (the usual warning before a removal), and on every removal the deprecation reason the earlier version gave;
- `enum-value-added`, listed for code that switches over an enum, not counted as breaking.

`refit shopify-snapshot --diffs` regenerates them; `refit rules check` fails when a committed diff is not what the pinned schemas give.

## Rules

Rule tables live in `data/rules/shopify/<api>-<version>.json` (hand-written) and `generated-<api>-<version>.json` (AI-mined), in the Stripe tables' shape (`pipeline/shopify-rules.ts`): each rule has its family's values, `source`, a verbatim `quote`, `checkedAt`, `status`, `origin` and the `diff` entry it answers, whose `operationId` is the schema coordinate. A table's `previous` is the pinned version before its `version`; a change from an unpinned quarter goes in the next pinned version's table, whose diff contains it, and a change older than every pin is checked against the oldest pin (the old member must be absent from it).

| Family                  | Edit it describes                                                                               | What `rules check` verifies                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `graphql-rename`        | A field, argument, input field or enum value replaced by another coordinate (renames and moves) | The diff removes or deprecates the old coordinate; the replacement exists with the same type and every old argument |
| `graphql-argument-drop` | An argument or input field Shopify removed because one value remains allowed                    | The diff removes or deprecates it                                                                                   |
| `rest-to-graphql`       | A REST Admin endpoint and the GraphQL root field Shopify maps it to                             | The root field exists at the table's version                                                                        |
| `webhook-topic-rename`  | A `WebhookSubscriptionTopic` value and its replacement                                          | The diff removes or deprecates the old topic; the new one exists                                                    |
| `package-major`         | A call rewrite in a major release of a Shopify npm package (`packages.json`)                    | The major is published on npm                                                                                       |

Every rule's quote must be in its saved page (`docs/benchmarks/shopify-changelog/pages/`, saved with `refit rules save-page --url <https://shopify.dev/….md>`) character for character.

## Alerts

A change with no mechanical replacement is an alert in `data/shopify-alerts.json`: the coordinates it affects (a prefix ending in `*`, such as `PriceRule*`, or none for a change outside the schemas), a summary, the version it takes effect in (the changelog entry's own `effectiveApiVersion`) and the day the page names, each when known, with its quote. `rules check` verifies the quote, that every coordinate is in a pinned schema, and that the date is written on the page. The Shopify tracer does not read alerts yet.

## AI changelog mining

```sh
refit rules mine-shopify --output <new-directory> --write
```

reads `https://shopify.dev/changelog/feed.xml` (entries since 2024-10-30), keeps the entries tagged with an API area Refit reads (Admin GraphQL, Storefront, Customer Account, webhooks, REST Admin, App Bridge, Polaris, Hydrogen, Shopify CLI, metafields) and a change tag (Action Required, Breaking API Change, Deprecation announcement, Update), saves each entry's Markdown page and asks OpenAI for candidate rules and alerts with the schema changes the entry mentions (`pipeline/shopify-changelog-mining.ts`). Code derives the diff entry and the table, and verifies each candidate as `rules check` does. A rule candidate that fails becomes an alert when its quote verifies; a candidate whose quote is not on the page is refused. `results.json` records every candidate with its outcome, `audit.json` every model answer. It needs `OPENAI_API_KEY` and `OPENAI_MODEL` and spends at most `REFIT_AI_BUDGET_USD`.

## Coverage

`refit rules check --provider shopify --coverage <file>` prints and writes, for every breaking or deprecated change in every pinned diff, whether a rule answers it, an alert covers it, or neither.

On 2026-10-29, before the AI mining run, with 27 hand-written rules and 40 hand-written alerts:

| Diff                         | Breaking: rule | Breaking: alert-only | Breaking: unmapped | Deprecated: rule | Deprecated: alert-only | Deprecated: unmapped |
| ---------------------------- | -------------- | -------------------- | ------------------ | ---------------- | ---------------------- | -------------------- |
| admin 2025-01 → 2026-01      | 1              | 57                   | 4                  | 2                | 32                     | 149                  |
| admin 2026-01 → 2026-04      | 3              | 13                   | 5                  | 0                | 0                      | 0                    |
| admin 2026-04 → 2026-07      | 0              | 10                   | 0                  | 0                | 6                      | 0                    |
| admin 2026-07 → 2026-10      | 0              | 28                   | 0                  | 0                | 8                      | 1                    |
| storefront 2024-10 → 2025-01 | 0              | 2                    | 0                  | 0                | 5                      | 0                    |
| storefront 2025-01 → 2025-07 | 0              | 0                    | 0                  | 0                | 0                      | 2                    |
| storefront 2025-07 → 2025-10 | 0              | 0                    | 0                  | 0                | 0                      | 1                    |
| storefront 2025-10 → 2026-01 | 0              | 1                    | 0                  | 0                | 5                      | 4                    |
| storefront 2026-07 → 2026-10 | 0              | 0                    | 1                  | 0                | 0                      | 2                    |
| **Total**                    | **4**          | **111**              | **10**             | **2**            | **56**                 | **159**              |

The table counts diff entries only. 22 more rules answer changes older than every pin: 8 `Shop` connections moved to `QueryRoot` (removed by 2025-01) and 14 REST product, variant and image endpoints mapped to GraphQL root fields by Shopify's REST reference pages.

The 10 unmapped breaking changes have no changelog entry Refit found: `ShopPolicy.createdAt`/`updatedAt` and three `ShopifyPaymentsDispute` dates (`Date` to `DateTime`), the `ShopifyPaymentsVerification*` types, `pubSubWebhookSubscriptionUpdate(webhookSubscription:)` becoming required, and Storefront `ShopPayPaymentRequestSession.paymentRequest` becoming nullable. Schema validation of documents still catches the removals among them.

What has no rule yet:

- **Product model (row 4):** the migration guide `docs/apps/build/graphql/migrate/new-product-model` now redirects to a general products page with no mapping, so the product model has only its REST mappings and alerts.
- **Webhook topics (row 6):** no `WebhookSubscriptionTopic` value is removed or deprecated in any pinned diff.
- **Package majors (row 7):** no shopify.dev page quotes an SDK call rewrite; the package changelogs on GitHub are not saved pages yet.
- `InventoryQuantityInput.compareQuantity` → `changeFromQuantity` is a rule, but an input that also sends `ignoreCompareQuantity: true` needs `changeFromQuantity: null` instead; the rule's warning says so, and whatever applies it must stop on that case.
