# Shopify REST deprecations

Shopify's REST Admin API is legacy, and some of its endpoints and fields are gone from newer API versions. `refit shopify-rest` lists the REST Admin calls an app makes to an endpoint that a later version no longer has. It also says whether the version the app is served already lacks the endpoint, and when the last version that has it is retired. It is report only. Refit never rewrites a REST call, and the Shopify agent's GraphQL migration ([Shopify](SHOPIFY.md)) is unchanged. `pipeline/shopify-sdk-upgrade*` is untouched.

## Where the removals come from

The removals come from the REST resources Shopify generates for every Admin API version and ships in `@shopify/shopify-api` (`rest/admin/<version>/`). Each resource class lists its endpoints (`paths`: HTTP method, operation, path) and its fields. `scripts/shopify-rest-deprecations.mjs` reads them as text from the downloaded, never-installed tarballs of releases 6.2.0 (versions 2022-01 to 2022-07), 12.3.0 (2022-10 to 2024-07) and 15.0.1 (2024-10 to 2026-07). Each version is taken from the newest release that ships it. It then writes `data/shopify-rest-deprecations.json`:

- **endpoints:** an endpoint (resource, method, operation, path) that a version lists and no later version lists again. `lastVersion` is the last version that has it and `removedIn` the next one. `resourceRemoved` marks a whole resource class that is gone.
- **fields:** a field of a resource that is still there in later versions but no longer declares the field.
- **resources:** each class's operations across all versions, used to match `shopify.rest.Report.all()` to `GET reports.json`.

The generated resources occasionally leave a resource out of one version and restore it in the next. `CustomerSavedSearch` is missing from 2022-10 and back in 2023-01. Only a removal that no later version undoes is listed, so the SDK resources put that removal in 2023-10 (shopify.dev says 2022-04, which the list uses).

**This is what Shopify's generated SDK resources say, checked against shopify.dev** ([below](#checked-against-shopifydev)). An endpoint can leave the SDK's resources while the API still serves it, so every endpoint was checked, and the ones shopify.dev still documents were dropped. The `source` of each entry names the two tarballs and the files compared; `shopifyDev` gives shopify.dev's status, the page and the day it was read.

`npm run shopify-rest:check` (`refit shopify-rest --check-deprecations`) validates the list and exits 1 on any error, as `npm run meta-graph:check` does for Meta. It checks that every entry has its fields, that `removedIn` is the version right after `lastVersion`, that both are listed versions, and that sources are https URLs. It also checks that methods are GET, POST, PUT or DELETE and that no endpoint is listed twice. Regenerate the file rather than editing it.

### Checked against shopify.dev

Owner decision, 2026-10-22: every endpoint in the SDK-derived list is checked against shopify.dev before Refit reports it. The cloud environment's proxy refused shopify.dev on 2026-10-22 (`CONNECT tunnel failed, response 403`); it was read from a local machine the same day. `scripts/shopify-rest-verify.mjs` wrote [the verification](benchmarks/2026-10-22-shopify-rest-verification.json), and `scripts/shopify-rest-deprecations.mjs --verification` applies it. Two kinds of evidence:

- **The REST reference for every supported version** (2026-01, 2026-04, 2026-07, 2026-10), read live as Markdown. The page URL and its SHA-256 are recorded per endpoint and version, since a live page cannot be pinned. Older versions' reference pages redirect to `latest`, so they cannot be read.
- **Release notes and changelog posts** that name a removal. shopify.dev no longer serves release notes before 2024-10, so each is cited by its shopify.dev URL plus a pinned Wayback Machine copy of that page. A person read each one on 2026-10-22.

| shopify.dev says                                                                                                                                                                                                        | Endpoints | Status                     | Result                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------: | -------------------------- | ----------------------------------------------------------------------- |
| The 2022-07 release notes list the five order-based fulfillment writes as removed                                                                                                                                       |         5 | `confirmed`                | Kept (2022-07)                                                          |
| The 2023-07 release notes deprecate creating app credits through the Admin API (`POST application_credits.json`)                                                                                                        |         1 | `confirmed`                | Kept (2023-07)                                                          |
| The 2022-04 release notes remove all 7 `CustomerSavedSearch` endpoints; the SDK kept generating them until 2023-07                                                                                                      |         7 | `confirmed-earlier`        | Kept, `removedIn` 2022-04 (was 2023-10; `sdkRemovedIn` keeps the SDK's) |
| `Report` and `AndroidPayKey` are in no supported version's reference, but no page found names the removal version                                                                                                       |         8 | `not-in-current-reference` | Kept; the version is the SDK's                                          |
| `GET checkouts/<checkout_id>/payments.json` and its count: absent from the 2026-01 reference. The REST Checkout endpoints were deprecated (2024-04 notes) and shut off on 2025-04-01 (changelog); neither names 2025-01 |         2 | `not-in-current-reference` | Kept; the version is the SDK's                                          |
| The reference for 2026-01, 2026-04, 2026-07 and 2026-10 still documents all 7 `CustomerAddress` endpoints                                                                                                               |         7 | `contradicted`             | **Dropped**                                                             |

So 30 endpoints become 23. `refit shopify-rest` prints each call's shopify.dev status, and `npm run shopify-rest:check` requires one on every endpoint. No REST site in the benchmark below calls a changed endpoint, so its numbers are unchanged.

- **Not added:** shopify.dev was searched per listed resource, not systematically for removals the SDK list missed, so it may miss some. The one found is the REST Checkout endpoints, shut off on 2025-04-01. That is a shutdown date rather than a version removal, and their reference pages remain, so they are left out rather than given an invented version. A full pass over the release notes (archived before 2024-10) would be a separate change.
- **Not checked:** the 12 removed fields. They are listed but never matched in code (see [Not covered](#not-covered)).

### What the list holds

23 endpoints and 12 fields, read on 2026-10-22:

| Removed in | Endpoints                                                                                                                                                                        | Fields                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 2022-04    | `CustomerSavedSearch` (7 endpoints; the SDK resources say 2023-10)                                                                                                               | `Metafield.value_type`, `PriceRule.prerequisite_saved_search_ids`                                                                |
| 2022-07    | `POST orders/<order_id>/fulfillments.json`, `PUT orders/<order_id>/fulfillments/<id>.json`, and its `cancel`, `complete` and `open` actions (the order-based fulfillment writes) | `FulfillmentService.format`                                                                                                      |
| 2022-10    |                                                                                                                                                                                  | `Shop.cookie_consent_level`, `Variant.inventory_quantity_adjustment`                                                             |
| 2023-01    | `AndroidPayKey` (3 endpoints)                                                                                                                                                    |                                                                                                                                  |
| 2023-04    |                                                                                                                                                                                  | `Order.payment_details`, `Order.processing_method`                                                                               |
| 2023-07    | `POST application_credits.json`                                                                                                                                                  |                                                                                                                                  |
| 2024-04    | `Report` (5 endpoints)                                                                                                                                                           |                                                                                                                                  |
| 2025-01    | `GET checkouts/<checkout_id>/payments.json` and its `count`                                                                                                                      | `Customer.accepts_marketing`, `Customer.accepts_marketing_updated_at`, `Order.gateway`, `Shop.eligible_for_card_reader_giveaway` |
| 2026-04    |                                                                                                                                                                                  | `FulfillmentService.permits_sku_sharing`                                                                                         |

## Deadlines

No new registry entry was added. Shopify's announced removal dates are on the pages that could not be read. The date that matters for an app follows from what is already in `data/deadlines.json`: Shopify serves an unsupported version as the oldest supported one. So an endpoint is gone for every app once the last version that has it (`lastVersion`) is retired, and each report shows that version's registry sunset. For example, the `Report` endpoints, last in 2024-01, are gone for every app since 2024-01 was retired.

## List the calls

```sh
refit shopify-rest --repository /path/to/app
refit shopify-rest --repository /path/to/app --json
```

Calls come from the REST evidence `scanShopify` already collects, which `refit scan` reports as `shopify.restCalls`. That covers REST clients (`admin.rest`, `shopify.clients.Rest`, `createAdminRestApiClient`) with a literal or constant `path`, resource classes (`shopify.rest.Product.all()`), and versioned `/admin/api/<version>/…json` URLs passed to `fetch` or an HTTP verb call. Each call is matched to the list:

- **by path:** `customers/${id}/addresses` and `customers/<customer_id>/addresses.json` compare equal. A leading slash, `.json`, a query and the names of substituted segments do not matter. The method must match when the code states it.
- **by resource class and operation:** `all` reads the collection, `find` one record, `count` the count, `delete` deletes, and `save` posts or puts.

When the code leaves the endpoint open, the call matches only if every endpoint it could be is removed. That happens with a path but no method, or with `save`, which could be POST or PUT. So `fulfillment.save()`, which today posts to `fulfillments.json`, is never reported because of the removed `orders/<order_id>/fulfillments.json`.

Each reported call has:

- **file and line;**
- **the call** as `scanShopify` read it;
- **the removed endpoint;**
- **`status`:**
  - `removed`: the version the app is served, meaning its newest pin raised to the oldest supported version, no longer has the endpoint;
  - `upcoming`: it still does;
  - `unknown`: no pin was found;
- **`deadline`:** the registry sunset of `lastVersion`. It is null when the registry has no entry for that version, as for versions retired before the registry begins (2022-04, for example).

The output also lists every REST call `scanShopify` found (`rest`), so the inventory shows which REST endpoints an app uses.

## Measurement

The frozen 200-app Shopify set (`docs/benchmarks/2026-10-16-shopify-fresh-repos.json`) was scanned statically: shallow checkouts at the pinned commits, nothing installed or run. All numbers are from Refit `c9f854f`, in a clean detached worktree. Results are in `docs/benchmarks/2026-10-22-shopify-rest-results.json`.

```sh
node scripts/shopify-rest-benchmark.mjs --root <dir> --labels docs/benchmarks/2026-10-22-shopify-rest-labels.json
```

- **Scanned:** 198 of 200. `Crunchyman-ralph/shopify-app-node-monorepo-express-vite` and `strapi-community/shopify` exceed Refit's scan limits.
- **REST usage:** 48 apps make REST Admin calls in live code, 181 calls in all.
- **Calls to an endpoint with a removal: 1 app.** `mikelaurenzo7-collab/MANUSshopabot` posts to `orders/<order_id>/fulfillments.json` (`server/adapters/ecommerce/shopifyAdapter.ts:261`), which the generated resources drop in 2022-07. The version the app is served, its 2024-01 pin raised to the oldest supported 2026-01, no longer has it.
  - The registry has no sunset for that endpoint's last version (2022-04), so the call has no deadline date. It has been gone since long before the registry begins.
  - No app calls a `CustomerAddress`, `CustomerSavedSearch`, `Report`, `AndroidPayKey`, `ApplicationCredit` or checkout-payments endpoint.

### Labels, precision and recall

Labels are in `docs/benchmarks/2026-10-22-shopify-rest-labels.json`. They were labelled blind:

- **Candidates:** `scripts/shopify-rest-label-candidates.mjs`, an independent text search that imports no pipeline code.
- **Labellers:** fresh-context AI-assisted agents that read the checkouts, searched beyond the candidates, and used the generated list as their reference for what is removed. They never saw Refit output. The labels were committed before any committed scan output, but the history cannot show they were written before Refit ran: the labels commit (`f929779`, 10:05:50Z) follows the detection code (`818d901`, 10:00:52Z) and the benchmark script (`17d338a`, 10:03:54Z), so their blindness rests on the lane's notes.
- **Sample:** 20 apps, 10 seeded from the 67 with REST usage and 10 from the 133 without, all within scan limits counted before scanning.
- **Extension:** the sample has no call to a removed endpoint, so the labels were extended the same way to every other app with REST usage (57 more), again before any scan.
- This is one pass, not second-labelled.

The unit is a REST request site in live code, by file and line. One labelled app, `strapi-community/shopify`, exceeds the scan limits; it stays in the denominator, but none of its 4 labelled sites is a REST request, so no count changes.

| Unit                                          | Labelled apps scanned | Labelled sites |                          Precision |                             Recall |
| --------------------------------------------- | --------------------: | -------------: | ---------------------------------: | ---------------------------------: |
| Call to a removed endpoint, 20-app sample     |                    19 |              0 |          not measured (0 reported) |                       not measured |
| Call to a removed endpoint, all labelled apps |                    76 |              1 | not measured (1 of 1, tuned on it) | not measured (1 of 1, tuned on it) |
| REST request site, 20-app sample              |                    19 |             42 |                              77.8% |                              33.3% |
| REST request site, all labelled apps          |                    76 |            257 |                              78.5% |                              55.3% |

**The removed-endpoint row for all labelled apps is after a fix made on these labels.** The first run (`a7722f9`) reported nothing and missed the one call (recall 0%).

- **What it missed:** MANUSshopabot builds the URL as `${this.baseUrl(credentials)}/orders/${orderId}/fulfillments.json`, with the versioned base in a helper and the method in a wrapper's options. `scanShopify` reads a REST URL only when `/admin/api/<version>/` is in the same literal.
- **The fix, in this module only:**
  - It reads a bare REST path in a file that builds an `/admin/api/` URL, when the path's first segment is a REST resource root (`orders`, `products`, …).
  - It takes the method from the call's options.
  - It reads a version that ends a base URL as a pin.
- **What it does not change:** `scanShopify`, the Shopify agent's REST stop rule, and `refit scan` are all unchanged.
- **A first version of the fix also matched an app's own routes such as `/ai/products.json`, adding 16 false REST sites. The resource-root rule removed 12 of them. The other 4 are three requests to a storefront's public `${storeUrl}/products.json` (not the Admin API) and one Admin path held in a variable that the labels place at the helper sending it.

One removed-endpoint call is too few to estimate a rate. It shows the matcher and the fix work on that form.

The REST-site rows measure the evidence `scanShopify` collects, plus the relative paths above, against a strict reading of "request site":

- **False positives:** most are lines that create a REST client (`new shopify.clients.Rest(...)`), which `scanShopify` reports and the labels count as not a request. A few are generic wrappers whose path comes from the caller.
- **False negatives:** most are calls through an app's own helper whose path or base is built elsewhere, which `scanShopify` cannot follow. A labelled `src/app/api/.../test/route.ts` API route also counts, which Refit's test-path rule treats as a test.
- **Effect on matching:** a REST call Refit cannot see cannot be matched to a removal, so removed-endpoint recall is bounded by this recall.

## Blocked

- **Shopify's pages: unblocked.** The cloud proxy refused shopify.dev, but it was read locally on 2026-10-22, and every endpoint is now checked ([above](#checked-against-shopifydev)). No registry date was added.
- **Keep going: GraphQL Admin fields deprecated in the pinned schema.** This needs the Admin GraphQL schema for the app's API version. The only source Refit uses, Shopify's public documentation proxy (`https://shopify.dev/admin-graphql-direct-proxy/<version>`, see [Shopify](SHOPIFY.md)), was refused with the same error twice. No schema is committed to the repository, and a copy from a third-party repository is not Shopify's page. Once snapshots can be saved (`refit shopify-snapshot`), the Shopify agent's report already lists deprecated fields for a draft; a report-only listing for the pinned version would read the same snapshots.

## Not covered

- Removed fields are listed but not matched in code. A REST response field is read through objects Refit does not trace (`order.gateway`, `body.order.gateway`).
- REST calls `scanShopify` cannot read: a path built at runtime, a client stored in an object, an untraced helper. These are counted as `unreadable`.
