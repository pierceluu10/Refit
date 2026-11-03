---
provider: generic
kind: pagination-or-limits
reviewed: false
drafted: 2026-11-02
sources:
  - https://www.rfc-editor.org/rfc/rfc8288
  - https://www.rfc-editor.org/rfc/rfc6585#section-4
  - https://www.rfc-editor.org/rfc/rfc9110#name-retry-after
  - https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/
---

# Pagination or limits change (any provider)

_General advice for any provider. Where the provider's own docs say otherwise, follow them._

**What usually changes.** Offset or page-number pagination becomes cursor pagination, page sizes get a new maximum or default, a `Link` header ([RFC 8288](https://www.rfc-editor.org/rfc/rfc8288)) replaces fields in the body, or rate limits tighten. Over the limit, APIs answer `429 Too Many Requests` ([RFC 6585](https://www.rfc-editor.org/rfc/rfc6585#section-4)), often with `Retry-After` ([RFC 9110](https://www.rfc-editor.org/rfc/rfc9110#name-retry-after)) or rate-limit headers ([draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/)).

**How to spot it in code.** Find loops that fetch lists: `page`, `offset`, `limit`, `per_page`, `cursor`, `starting_after`, `next` fields, SDK auto-pagination helpers. Find retry and backoff code, and any hard-coded page size above the new maximum.

**What to check.**

- Read the change with `fetch_changelog` and the pagination guide with `search_docs`.
- `openapi_lookup` the list operation for its query params and response fields; `openapi_check` the changed request so the new param names and limits are right.
- For GraphQL, `graphql_check` the document with its `first`, `after` and `pageInfo` fields.

**Pitfalls.** A loop that stops on "fewer results than the page size" may stop early or never stop with cursors. Sorting and filtering may not be allowed with cursors. Lowering a page size multiplies requests and can hit rate limits. Retries without backoff make limits worse; honour `Retry-After`.

**When you're unsure.** Keep the function's signature and return the same full list as before, switch the loop to the documented mechanism, add backoff on `429`, and say in the PR which edge cases (empty pages, very large lists) were not exercised.
