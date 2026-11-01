---
provider: twilio
kind: pagination-or-limits
reviewed: false
drafted: 2026-11-01
sources:
  - https://www.twilio.com/docs/usage/twilios-response
  - https://www.twilio.com/docs/usage/rest-api-best-practices
  - https://www.twilio.com/docs/api/errors/20429
  - https://github.com/twilio/twilio-oai
---

# Twilio pagination and limits

**Pagination comes in two shapes:**

- **Core 2010 API.** The list body has `next_page_uri`, `previous_page_uri`, `first_page_uri`, `page`, `page_size`, and the items under a resource key (`messages`, `calls`). `page_size` defaults to 50 and pages are zero-indexed ([responses](https://www.twilio.com/docs/usage/twilios-response)).
- **Product APIs (vN hosts).** Links sit under `meta`: `meta.next_page_url`, and `meta.key` names the array.

Both accept `PageSize` (1-1000 in the spec), `Page` and `PageToken` ([twilio-oai](https://github.com/twilio/twilio-oai)). Follow the next link Twilio returns; don't compute `Page=N` yourself, because the `PageToken` inside the link is what keeps paging stable. SDKs auto-page with `list`/`each`/`stream` and their `limit`/`pageSize` options.

**Limits:**

- REST calls are capped by account concurrency. Going over returns HTTP 429 / error 20429.
- A 429 request was not processed, so retrying with exponential backoff is safe.
- Watch the `Twilio-Concurrent-Requests` header. It counts 429s too, and subaccounts don't roll up ([best practices](https://www.twilio.com/docs/usage/rest-api-best-practices), [20429](https://www.twilio.com/docs/api/errors/20429)).
- Verify has extra per-number and per-service rate limits under the same code.

**Spotting it:** grep for `next_page_uri`, `nextPageUri`, `next_page_url`, `meta`, `PageSize`, `pageSize`, `Page=`, `PageToken`, `.list(`, `.each(`, `.stream(`, `.page(`, `429`, `20429`, `retry`, and `Promise.all` over Twilio calls.

**What to check:**

- **Hand-written pagination.** Code ported between the core API and a product API must swap `next_page_uri` (relative URI, prefix with `https://api.twilio.com`) for `meta.next_page_url` (absolute URL).
- **Unbounded `list()`.** Calls without a `limit` page through everything. That can be slow or hit concurrency limits.
- **Burst sends.** Bulk sends with unbounded parallelism (`Promise.all` over thousands of messages) need a concurrency cap and a 429 retry. Consider a Messaging Service or the Bulk Messaging API.

**Pitfalls:**

- Older responses carried `total`/`num_pages`. The current spec does not list them, so don't rely on them.
- Retrying non-429 errors like 400 or 21211 wastes calls.
