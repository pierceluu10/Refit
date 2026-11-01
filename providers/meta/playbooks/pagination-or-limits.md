---
provider: meta
kind: pagination-or-limits
reviewed: false
drafted: 2026-11-01
sources:
  - https://developers.facebook.com/docs/graph-api/overview/rate-limiting
  - https://developers.facebook.com/docs/graph-api/results
  - https://developers.facebook.com/docs/graph-api/batch-requests
---

# Pagination and rate limits

**Pagination** ([results](https://developers.facebook.com/docs/graph-api/results)). Edges return `paging.cursors.before/after` and `paging.next/previous`. Prefer cursors; time-based `since`/`until` works on some edges (keep ranges ~6 months); offset only when nothing else exists. Stop when `paging.next` is absent, not when a page is short: pages can be short or even empty with a `next` link. Cursors can expire; don't persist them.

**Rate limits** ([rate limiting](https://developers.facebook.com/docs/graph-api/overview/rate-limiting)).

- Platform limits (user/app tokens): `X-App-Usage` header with `call_count`, `total_time`, `total_cputime` as percentages. Errors `4` (app), `17` (user), `32` (Pages with user token), `613` (custom).
- Business Use Case limits apply to Marketing API, Instagram Platform and Pages API with Page/system-user tokens, and win over platform limits. `X-Business-Use-Case-Usage` is JSON keyed by business ID with `type` (`ads_insights`, `ads_management`, `custom_audience`, `instagram`, `leadgen`, `messenger`, `pages`), `call_count`, `total_cputime`, `total_time`, `estimated_time_to_regain_access` (minutes). BUC errors: `80000` insights, `80004` ads management, `80003` custom audience, `80002` Instagram, `80001` Pages, `80005` leadgen, `80006` Messenger, `80008` WhatsApp Business Management, `80014` catalog batch.
- Batch requests take up to 50 calls, each counted separately ([batch](https://developers.facebook.com/docs/graph-api/batch-requests)).

**Spotting usage.** Grep `paging.next`, `after=`, `offset=`, `limit=`, `X-App-Usage`, `X-Business-Use-Case-Usage`, `X-Ad-Account-Usage`, and error-code checks (`code === 17`, `80004`). Hand-rolled loops that build `?after=` from the cursor are fine; loops that increment `offset` are fragile.

**What to check.** `meta_search_docs` for the edge's supported paging; `meta_lookup_field` for limit changes (e.g. 30 MB catalog `items_batch` payload in v24.0). Backoff should read `estimated_time_to_regain_access` rather than sleeping a fixed time.

**Pitfalls.** Header JSON is per business; parse all keys. Ads Insights long ranges are better as async report runs.
