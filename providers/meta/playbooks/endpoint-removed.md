---
provider: meta
kind: endpoint-removed
reviewed: false
drafted: 2026-11-01
sources:
  - https://developers.facebook.com/docs/graph-api/changelog/version26.0
  - https://developers.facebook.com/docs/graph-api/changelog/version22.0
  - https://developers.facebook.com/docs/graph-api/changelog/version19.0
  - https://developers.facebook.com/docs/graph-api/changelog/version20.0
---

# Endpoint or edge removed

Meta removes whole edges or APIs fairly often. Recent ones:

- Commerce Order Management API (47 endpoints like `/{page-id}/commerce_orders`), blocked on v26.0 and removed from all versions 2026-10-27, no replacement ([v26.0](https://developers.facebook.com/docs/graph-api/changelog/version26.0)).
- Root `GET /?ids=...` lookups error from v26.0 (all versions 2026-10-27); use per-object calls or [batch requests](https://developers.facebook.com/docs/graph-api/batch-requests) (max 50 per batch).
- Legacy Instagram v1.0 ads endpoints (`/{instagram-user-id}`, `/{page-id}/instagram_accounts`...) replaced by Instagram Platform IG User/IG Media endpoints ([v22.0](https://developers.facebook.com/docs/graph-api/changelog/version22.0)); `/{page-id}/ratings` deprecated.
- Groups API and its permissions removed 2024-04-22 ([v19.0](https://developers.facebook.com/docs/graph-api/changelog/version19.0)); Offline Conversions API deprecated in favour of Conversions API offline events ([v20.0](https://developers.facebook.com/docs/graph-api/changelog/version20.0)); Messaging Events API `/{app-id}/page_activities` unsupported from v21.0.

**Spotting usage.** Grep path strings (`/commerce_orders`, `/ratings`, `page_activities`, `offline_conversion_data_sets`, `?ids=`), SDK classes (`OfflineConversionDataSet`, `CommerceOrder`) and batch payloads (`relative_url`).

**What to check.** `meta_lookup_field` with the path (placeholders like `{page-id}` are ignored in matching) and `meta_search_docs` for the replacement API. Decide with the user-facing feature in mind: if there is no replacement, the honest change is removing the feature path and saying so in the PR.

**Pitfalls.** Replacement APIs often need different permissions or a different token type (e.g. Conversions API uses a pixel/dataset and system-user token), which is an auth change too; see the auth-change playbook.
