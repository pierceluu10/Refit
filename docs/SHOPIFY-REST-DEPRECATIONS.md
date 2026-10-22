# Shopify REST deprecations

Shopify's REST Admin API is legacy, and some of its endpoints and fields are gone from newer API versions. `refit shopify-rest` lists the REST Admin calls an app makes to an endpoint that a later version no longer has. It also says whether the version the app is served already lacks the endpoint, and when the last version that has it is retired. It is report only. Refit never rewrites a REST call, and the Shopify agent's GraphQL migration ([Shopify](SHOPIFY.md)) is unchanged. `pipeline/shopify-sdk-upgrade*` is untouched.

## Where the removals come from

`shopify.dev` (the REST reference, the per-version release notes and the changelog) and its Admin GraphQL proxy were refused by the cloud environment's network proxy on 2026-10-22. Each failed twice with `curl: (56) CONNECT tunnel failed, response 403`, so Shopify's deprecation pages were not read.

The removals come instead from the REST resources Shopify generates for every Admin API version and ships in `@shopify/shopify-api` (`rest/admin/<version>/`). Each resource class lists its endpoints (`paths`: HTTP method, operation, path) and its fields. `scripts/shopify-rest-deprecations.mjs` reads them as text from the downloaded, never-installed tarballs of releases 6.2.0 (versions 2022-01 to 2022-07), 12.3.0 (2022-10 to 2024-07) and 15.0.1 (2024-10 to 2026-07). Each version is taken from the newest release that ships it. It then writes `data/shopify-rest-deprecations.json`:

- **endpoints:** an endpoint (resource, method, operation, path) that a version lists and no later version lists again. `lastVersion` is the last version that has it and `removedIn` the next one. `resourceRemoved` marks a whole resource class that is gone.
- **fields:** a field of a resource that is still there in later versions but no longer declares the field.
- **resources:** each class's operations across all versions, used to match `shopify.rest.CustomerAddress.all()` to `GET customers/<customer_id>/addresses.json`.

The generated resources occasionally leave a resource out of one version and restore it in the next. `CustomerSavedSearch` is missing from 2022-10 and back in 2023-01. Only a removal that no later version undoes is listed, so that resource counts as removed in 2023-10.

**This is what Shopify's generated SDK resources say, not a changelog entry.** An endpoint can leave the SDK's resources while the API still serves it for a while. The list has not been checked against Shopify's release notes, which could not be read; see [Blocked](#blocked). The `source` of each entry names the two tarballs and the files compared.

`npm run shopify-rest:check` (`refit shopify-rest --check-deprecations`) validates the list and exits 1 on any error, as `npm run meta-graph:check` does for Meta. It checks that every entry has its fields, that `removedIn` is the version right after `lastVersion`, that both are listed versions, and that sources are https URLs. It also checks that methods are GET, POST, PUT or DELETE and that no endpoint is listed twice. Regenerate the file rather than editing it.

### What the list holds

30 endpoints and 12 fields, read on 2026-10-22:

| Removed in | Endpoints | Fields |
| --- | --- | --- |
| 2022-04 | | `Metafield.value_type`, `PriceRule.prerequisite_saved_search_ids` |
| 2022-07 | `POST orders/<order_id>/fulfillments.json`, `PUT orders/<order_id>/fulfillments/<id>.json`, and its `cancel`, `complete` and `open` actions (the order-based fulfillment writes) | `FulfillmentService.format` |
| 2022-10 | | `Shop.cookie_consent_level`, `Variant.inventory_quantity_adjustment` |
| 2023-01 | `AndroidPayKey` (3 endpoints) | |
| 2023-04 | | `Order.payment_details`, `Order.processing_method` |
| 2023-07 | `POST application_credits.json` | |
| 2023-10 | `CustomerSavedSearch` (7 endpoints) | |
| 2024-04 | `Report` (5 endpoints) | |
| 2025-01 | `GET checkouts/<checkout_id>/payments.json` and its `count` | `Customer.accepts_marketing`, `Customer.accepts_marketing_updated_at`, `Order.gateway`, `Shop.eligible_for_card_reader_giveaway` |
| 2025-07 | `CustomerAddress` (7 endpoints: `customers/<customer_id>/addresses…`) | |
| 2026-04 | | `FulfillmentService.permits_sku_sharing` |

## Deadlines

No new registry entry was added. Shopify's announced removal dates are on the pages that could not be read. The date that matters for an app follows from what is already in `data/deadlines.json`: Shopify serves an unsupported version as the oldest supported one. So an endpoint is gone for every app once the last version that has it (`lastVersion`) is retired, and each report shows that version's registry sunset. The customer address endpoints, last in 2025-04, are gone for every app since 2025-04 was retired on 2026-04-16.

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
- **`deadline`:** the registry sunset of `lastVersion`.

The output also lists every REST call `scanShopify` found (`rest`), so the inventory shows which REST endpoints an app uses.

## Measurement

<!-- filled in below -->

## Blocked

- **Shopify's pages:** shopify.dev's REST deprecation pages, per-version release notes and changelog were refused on 2026-10-22 (`CONNECT tunnel failed, response 403`, twice each). So no removal is cited from them, no removal date was added to the registry, and the generated list is not cross-checked against the release notes. To unblock, read those pages from a machine with access, add dated `source` citations, and confirm or drop each entry.
- **Keep going: GraphQL Admin fields deprecated in the pinned schema.** This needs the Admin GraphQL schema for the app's API version. The only source Refit uses, Shopify's public documentation proxy (`https://shopify.dev/admin-graphql-direct-proxy/<version>`, see [Shopify](SHOPIFY.md)), was refused with the same error twice. No schema is committed to the repository, and a copy from a third-party repository is not Shopify's page. Once snapshots can be saved (`refit shopify-snapshot`), the Shopify agent's report already lists deprecated fields for a draft; a report-only listing for the pinned version would read the same snapshots.

## Not covered

- Removed fields are listed but not matched in code. A REST response field is read through objects Refit does not trace (`order.gateway`, `body.order.gateway`).
- REST calls `scanShopify` cannot read: a path built at runtime, a client stored in an object, an untraced helper. These are counted as `unreadable`.
