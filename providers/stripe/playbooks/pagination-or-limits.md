---
provider: stripe
kind: pagination-or-limits
reviewed: false
drafted: 2026-11-01
sources:
  - https://docs.stripe.com/api/pagination
  - https://docs.stripe.com/api/pagination/auto
  - https://docs.stripe.com/search
  - https://docs.stripe.com/rate-limits
  - https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-total-count-expansion
  - https://docs.stripe.com/api-v2-overview
---

# Stripe pagination, search and rate limits

**What changes.** v1 lists use cursor pagination: `limit` (1–100, default 10), `starting_after` / `ending_before` and `has_more` ([pagination](https://docs.stripe.com/api/pagination)). basil removed `total_count` expansion, so code that shows totals has to count instead ([changelog](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-total-count-expansion)). Search endpoints paginate with `page` / `next_page` and are eventually consistent, with data usually searchable within a minute. Don't use them for read-after-write. They are unavailable in India ([search](https://docs.stripe.com/search)). v2 endpoints use page tokens and eventually consistent lists ([v2 overview](https://docs.stripe.com/api-v2-overview)).

**Limits.** Exceeding a limit returns 429 with a `Stripe-Rate-Limited-Reason` header. Live mode allows 100 requests/s globally and sandboxes 25. Most endpoints allow 25/s, Search 20 reads/s, and each PaymentIntent 1000 updates per hour. Separately, about 50 concurrent live requests are allowed by default ([rate limits](https://docs.stripe.com/rate-limits)).

**How to spot it.** Look for hand-rolled loops on `has_more` and `starting_after`, `total_count`, `limit: 1000` (invalid), `.search(` calls right after creates, and tight loops without backoff. Also look for the SDK helpers: Node `for await` or `autoPagingEach`, Python `auto_paging_iter()`, Ruby `auto_paging_each`, PHP `autoPagingIterator()`, Java `autoPagingIterable()`, .NET `ListAutoPaging` ([auto-pagination](https://docs.stripe.com/api/pagination/auto)).

**What to check.**

- `stripe_check_params` on list calls: it catches `limit`/filter typos and unknown params such as removed filters.
- `stripe_search_docs` for "auto-pagination" in the repo's language.
- Retry and backoff settings in the SDK client config (for example stripe-node `maxNetworkRetries`), and idempotency keys on POSTs ([idempotency](https://docs.stripe.com/api/idempotent_requests)).

**Pitfalls.** Paginating with `ending_before` reverses the order. Expanding inside lists (`data.customer`) adds load and makes concurrency limits more likely ([rate limits](https://docs.stripe.com/rate-limits)). Search query syntax differs from list filters. Test mode has lower limits than live, so load tests in a sandbox under-report headroom.
