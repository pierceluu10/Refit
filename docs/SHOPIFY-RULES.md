# Shopify contracts and rules

Refit's Shopify engine is built like Stripe's: pinned, versioned contracts, deterministic diffs between them, and migration rules that quote Shopify's own changelog or migration guides and must agree with the diff. This page covers the contract and rule layer (catalogue rows 1–8 and AI use #1 in the Shopify engine plan). Tracing documents to clients and editing them is in [Shopify Admin API](SHOPIFY.md).

**Automatic rules (founder decision, 2026-10-29, relayed by the coordinating session: "proof decides, not caution").** For Shopify this replaces D3's benchmark requirement. A rule may be `auto` when (a) the schema diff confirms the change, (b) the edited document validates on the target schema before a patch is kept (the applier in `pipeline/shopify-document-rules.ts` and SH4's proof), and (c) the response keys the code reads are unchanged. Only two families can promise (c), and `refit rules check` refuses `auto` on any other: `graphql-rename` within one owner (a field selected under an alias of its old name, an argument of the same field, an input field or enum value of the same type) and `graphql-argument-drop`. Moves to another type, REST rewrites, webhook topics and package rewrites change what the code reads or calls, so they stay review-only. An `auto` rule names the decision in `decision`. No Shopify benchmark has run on these rules.

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
| `graphql-migration`     | A documented replacement that changes the document's shape, made by a named transform           | The diff removes or deprecates the old coordinate; the replacement exists                                           |
| `rest-to-graphql`       | A REST Admin endpoint and the GraphQL root field Shopify maps it to                             | The root field exists at the table's version                                                                        |
| `webhook-topic-rename`  | A `WebhookSubscriptionTopic` value and its replacement                                          | The diff removes or deprecates the old topic; the new one exists                                                    |
| `package-major`         | A call rewrite in a major release of a Shopify npm package (`packages.json`)                    | The major is published on npm                                                                                       |

Every rule's quote must be in its saved page (`docs/benchmarks/shopify-changelog/pages/`, saved with `refit rules save-page --url <https://shopify.dev/….md>`) character for character. A Markdown file in a Shopify GitHub repository counts too when it is pinned to a commit (`https://raw.githubusercontent.com/Shopify/<repo>/<commit>/<path>.md`), such as an app template's changelog.

### Migrations

A `graphql-migration` rule names a transform in `pipeline/shopify-migrations.ts`. Unlike a rename, it also edits the code around the document: the variables the call sends and the code's reads of the response. It may be `auto` because the transform rewrites every read it allows and refuses any other, the rewritten document must validate on the target, and where the variables change shape the development store must run the operation before the patch can be graded above D ([Shopify proof](SHOPIFY-PROOF.md)). One transform exists:

- `variants-bulk-update` (`shopify-product-variant-update-to-bulk-update`): `productVariantUpdate(input: $input)` becomes `productVariantsBulkUpdate(productId: $productId, variants: $variants)`, as Shopify's Remix app template made the change in commit `bd7c2efd`. The call sends `productId: <product>.id` and `variants: [<the old input>]`, and reads of `.productVariantUpdate.productVariant` read `.productVariantsBulkUpdate.productVariants[0]`. It stops unless the document is one mutation with only that field, its payload selects only `productVariant` and `userErrors`, the input is an object literal sending only `id`, `price`, `compareAtPrice`, `barcode`, `taxable`, `taxCode` or `inventoryPolicy`, the variant ID is read as `<product>.variants.edges[n].node.id` (or `.nodes[n].id`) from a response whose document selects the product's `id`, and every read of the response goes through `data.productVariantUpdate.productVariant` or `.userErrors`.

The GraphQL specification's "All Variables Used" rule is fixed the same way without a table entry (`graphql-unused-variable`): Shopify rejects a document that declares a variable it never uses on every version, so the declaration is removed. The value the code still sends is ignored; the development store case for a query sends it to show that.

The other migrations the round-3 diagnosis lists (`Shop` policy fields, `Order.financialStatus` and `fulfillmentStatus`, `Customer.ordersCount`, the `ProductVariant` fields moved to `inventoryItem`, `AppPlanV2` spreads) have no rule. Each member is absent from every pinned Admin schema, so Shopify removed it before 2025-01, and the changelog entries for those removals return 404 (read on 2026-10-30: `deprecated-fields-on-the-customer-object`, `product-variant-field-cleanup`, `inventory-item-new-fields-and-productvariant-deprecations`, `inventory-mutations-and-fields-removal`, `deprecating-mutations-inventoryadjustquantity-and-inventorybulkadjustquantityatlocation`). `https://shopify.dev/changelog/feed.xml` starts in October 2024, and the old API reference versions redirect to `latest`. A rule needs a quote from a page someone read, so none is written from search summaries or memory. The pinned Storefront 2026-10 schema has several of the same names (`ProductVariant.weight`, `Order.financialStatus`, `Shop.privacyPolicy`), but a shared name does not show the Admin field never existed, so it is not used as evidence.

Such a document stops with a named reason instead of a bare "already fails" (`unmigratedReasons` in `pipeline/shopify-migrations.ts`):

- a document that validates whole on the pinned Storefront schema is named as a Storefront document sent with an Admin client (such as a `cartCreate` mutation);
- otherwise each member: a documented removal, quoted from its saved page (`metafieldDelete`, removed in 2025-01 for `metafieldsDelete`, which takes `ownerId`, `namespace` and `key`, not the GID the code sends; `discountsAllocatorFunctionRegister`, whose developer preview ended with no replacement), or a member no pinned Admin schema has and no saved page replaces.

With AI enabled, these documents still go to the bounded AI rewrite (`pipeline/shopify-ai-rewrite.ts`), and its result stays `[Needs review]`.

## Alerts

A change with no mechanical replacement is an alert in `data/shopify-alerts.json`: the coordinates it affects (a prefix ending in `*`, such as `PriceRule*`, or none for a change outside the schemas), a summary, the version it takes effect in (the changelog entry's own `effectiveApiVersion`) and the day the page names, each when known, with its quote. `rules check` verifies the quote, that every coordinate is in a pinned schema, and that the date is written on the page. The Shopify tracer does not read alerts yet.

## AI changelog mining

```sh
refit rules mine-shopify --output <new-directory> --write
```

reads `https://shopify.dev/changelog/feed.xml` (entries since 2024-10-30), keeps the entries tagged with an API area Refit reads (Admin GraphQL, Storefront, Customer Account, webhooks, REST Admin, App Bridge, Polaris, Hydrogen, Shopify CLI, metafields) and a change tag (Action Required, Breaking API Change, Deprecation announcement, Update), saves each entry's Markdown page and asks OpenAI for candidate rules and alerts with the schema changes the entry mentions (`pipeline/shopify-changelog-mining.ts`). Code derives the diff entry and the table, and verifies each candidate as `rules check` does. A rule candidate that fails becomes an alert when its quote verifies; a candidate whose quote is not on the page is refused. `results.json` records every candidate with its outcome, `audit.json` every model answer. It needs `OPENAI_API_KEY` and `OPENAI_MODEL` and spends at most `REFIT_AI_BUDGET_USD`.

## Mining runs

Both ran on refit-bench Actions (`rules.yml` with `provider: shopify`, branch `feat/shopify-rule-mining`) with `gpt-6.1-sol`; results are in `docs/benchmarks/shopify-changelog/mining/`, audits in the run artifacts.

| Run         | Refit commit | Entries | Candidates | Rules kept | Reproduced hand-written | Alerts | Refused | Cost  |
| ----------- | ------------ | ------- | ---------- | ---------- | ----------------------- | ------ | ------- | ----- |
| 40834224466 | `cb301975`   | 227     | 233        | 20         | 10                      | 182    | 21      | $1.58 |
| 40835715958 | `8fdb317f`   | 14      | 23         | 0          | 2                       | 16     | 5       | $0.12 |

The first run sent six entries at a time and 14 failed on the budget ledger's lock; mining is sequential since, and the second run mined those 14 with `--entry`. Most refusals name a coordinate in no pinned schema (members removed before Admin 2025-01, and the Customer Account API, which is not pinned).

## Coverage

`refit rules check --provider shopify --coverage <file>` prints and writes, for every breaking or deprecated change in every pinned diff, whether a rule answers it, an alert covers it, or neither.

On 2026-10-29, after the AI mining runs, with 67 rules (44 `auto`) and 238 alerts:

| Diff                         | Breaking: rule | Breaking: alert-only | Breaking: unmapped | Deprecated: rule | Deprecated: alert-only | Deprecated: unmapped |
| ---------------------------- | -------------- | -------------------- | ------------------ | ---------------- | ---------------------- | -------------------- |
| admin 2025-01 → 2026-01      | 41             | 17                   | 4                  | 2                | 59                     | 122                  |
| admin 2026-01 → 2026-04      | 3              | 13                   | 5                  | 0                | 0                      | 0                    |
| admin 2026-04 → 2026-07      | 0              | 10                   | 0                  | 0                | 6                      | 0                    |
| admin 2026-07 → 2026-10      | 0              | 28                   | 0                  | 0                | 8                      | 1                    |
| storefront 2024-10 → 2025-01 | 0              | 2                    | 0                  | 0                | 5                      | 0                    |
| storefront 2025-01 → 2025-07 | 0              | 0                    | 0                  | 0                | 0                      | 2                    |
| storefront 2025-07 → 2025-10 | 0              | 0                    | 0                  | 0                | 0                      | 1                    |
| storefront 2025-10 → 2026-01 | 0              | 1                    | 0                  | 0                | 5                      | 4                    |
| storefront 2026-07 → 2026-10 | 0              | 0                    | 1                  | 0                | 0                      | 2                    |
| **Total**                    | **44**         | **71**               | **10**             | **2**            | **83**                 | **132**              |

The rules:

- `auto` (44): 40 removed `RELEVANCE` sort keys become `ID`, because Shopify's entry says each "acted as a basic `ID` sort" (20 mined, 20 added by hand with the same quote after the model reached its 20-item limit); `Shop.billingAddress` → `Shop.shopAddress` ("identical structure and values"); `InventoryQuantityInput.compareQuantity` → `changeFromQuantity`; and `permitsSkuSharing` dropped where it is `true` on `fulfillmentServiceCreate` and `fulfillmentServiceUpdate`.
- review-only (23): 9 `Shop` connections moved to `QueryRoot` and 14 REST endpoints mapped to GraphQL root fields.

The table counts diff entries only. 22 more rules answer changes older than every pin: 8 `Shop` connections moved to `QueryRoot` (removed by 2025-01) and 14 REST product, variant and image endpoints mapped to GraphQL root fields by Shopify's REST reference pages.

The 10 unmapped breaking changes have no changelog entry Refit found: `ShopPolicy.createdAt`/`updatedAt` and three `ShopifyPaymentsDispute` dates (`Date` to `DateTime`), the `ShopifyPaymentsVerification*` types, `pubSubWebhookSubscriptionUpdate(webhookSubscription:)` becoming required, and Storefront `ShopPayPaymentRequestSession.paymentRequest` becoming nullable. Schema validation of documents still catches the removals among them.

What has no rule yet:

- **Product model (row 4):** the migration guide `docs/apps/build/graphql/migrate/new-product-model` now redirects to a general products page with no mapping, so the product model has only its REST mappings and alerts.
- **Webhook topics (row 6):** no `WebhookSubscriptionTopic` value is removed or deprecated in any pinned diff.
- **Package majors (row 7):** no shopify.dev page quotes an SDK call rewrite; the package changelogs on GitHub are not saved pages yet.
- `InventoryQuantityInput.compareQuantity` → `changeFromQuantity` is `auto`, but an input that also sends `ignoreCompareQuantity: true` needs `changeFromQuantity: null` instead. Such a document still sends `ignoreCompareQuantity`, which 2026-04 removed, so it fails validation on the target schema and no patch is kept.
- An enum value passed through a GraphQL variable is a runtime value: the applier edits only literals, and schema validation cannot see a variable's value, so a `RELEVANCE` sent as a variable is not fixed or proven.
