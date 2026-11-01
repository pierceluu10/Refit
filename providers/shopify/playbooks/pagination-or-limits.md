---
provider: shopify
kind: pagination-or-limits
reviewed: false
drafted: 2026-11-01
sources:
  - https://shopify.dev/docs/api/usage/pagination-graphql
  - https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits
  - https://shopify.dev/docs/api/usage/limits
  - https://shopify.dev/docs/api/usage/bulk-operations/queries
---

# Shopify: pagination, rate limits and bulk operations

**What usually changes.** GraphQL Admin uses cursor connections: `first`/`after` or `last`/`before`, then read `pageInfo { hasNextPage endCursor }`, with up to 250 nodes per page ([pagination](https://shopify.dev/docs/api/usage/pagination-graphql)). Rate limits are based on **calculated query cost**: 100 points/second on standard plans, 200 on Advanced, 1,000 on Plus and 2,000 on enterprise, with at most 1,000 points for a single query ([rate limits](https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits)). Array inputs take at most 250 items, and paginated lists stop at 25,000 objects ([limits](https://shopify.dev/docs/api/usage/limits)). From 2026-01, bulk queries allow up to five concurrent operations per shop, polled with `bulkOperation(id:)`. `currentBulkOperation` is gone from the 2026-10 schema ([bulk queries](https://shopify.dev/docs/api/usage/bulk-operations/queries)).

**How to spot it.** Look for `page_info`/`Link` header parsing and `limit=250` (REST), `since_id`, loops over `hasNextPage`, `X-Shopify-Shop-Api-Call-Limit`, `Retry-After`/429 handling, `THROTTLED` checks, `extensions.cost`, `bulkOperationRunQuery`, `currentBulkOperation`, and JSONL parsing.

**What to check.**

- Page loops must pass `endCursor` back as `after` and stop on `hasNextPage: false`.
- Nested connections multiply cost (`products(first: 250) { variants(first: 250) }` blows past 1,000 points). Lower the page sizes or use a bulk operation. Send `Shopify-GraphQL-Cost-Debug=1` for a per-field cost breakdown.
- Throttling arrives as a GraphQL error (`THROTTLED`), often with HTTP 200. Back off using `throttleStatus` (`currentlyAvailable`, `restoreRate`).
- Bulk queries allow at most five connections and two levels of nesting, and no top-level `node`/`nodes`. Results come as JSONL with child rows linked by `__parentId`, and the URL expires after a week.
- `shopify_validate_graphql` catches pagination argument mistakes, for example `currentBulkOperation` against 2026-10. `shopify_search_docs` covers limits.

**Pitfalls.** REST `since_id` loops have no direct GraphQL equivalent, so use cursors or a `query:` filter. Variant creation can be throttled on stores with 500,000+ variants. Don't trust `bulk_operations/finish` alone, and keep polling as a fallback.
