---
provider: openai
kind: pagination-or-limits
reviewed: false
drafted: 2026-11-01
sources:
  - https://developers.openai.com/api/docs/guides/rate-limits
  - https://developers.openai.com/api/reference/overview
  - https://developers.openai.com/api/reference/resources/files/methods/list
---

**Pagination.** List endpoints use cursor pagination. Pass `after=<last id>` for the next page, `limit` for page size and `order` (`asc`/`desc` by `created_at`). Responses return `data`, `first_id`, `last_id` and `has_more` ([files list](https://developers.openai.com/api/reference/resources/files/methods/list)). Limits and defaults differ per endpoint (files allow up to 10,000), so don't hard-code one. The SDKs auto-paginate: python `for x in client.files.list()` since v1 ([v1 guide](https://github.com/openai/openai-python/discussions/742)), and node v5 changed the pagination classes ([MIGRATION.md](https://github.com/openai/openai-node/blob/main/MIGRATION.md)). Hand-rolled loops that read `data` only once, or that stop on an empty page instead of `has_more`, are the usual bugs.

**Rate limits.** Limits are measured in RPM, RPD, TPM, TPD, IPM and audio minutes. They're set per organization and per project and vary by model, and some families share a pool ([rate limits](https://developers.openai.com/api/docs/guides/rate-limits)). Usage tiers were simplified to Build, Launch and Grow in October 2026 ([changelog](https://developers.openai.com/api/docs/changelog)). Response headers: `x-ratelimit-limit-requests|tokens`, `x-ratelimit-remaining-*`, `x-ratelimit-reset-*`, plus `*-project-tokens` variants when a project token limit applies ([overview](https://developers.openai.com/api/reference/overview)). On 429/503, follow `Retry-After` when present. Otherwise use exponential backoff with jitter and cap the retries. The official SDKs already retry eligible 429 and 503 responses ([rate limits](https://developers.openai.com/api/docs/guides/rate-limits)).

**Other limits.** Vector store file ingestion allows 300 requests/minute per vector store, so prefer `file_batches` for big loads. Batch queue limits count queued input tokens ([same guide](https://developers.openai.com/api/docs/guides/rate-limits)). 429s can also mean spend or usage limits were reached, not throughput ([error codes](https://developers.openai.com/api/docs/guides/error-codes)).

**Check.** `openai_search_docs` with "rate limit headers" or "pagination after has_more". `openai_check_request` validates list/create bodies at the top level.

**Pitfalls.** Reset headers are durations such as `1s` or `6m0s`, not plain seconds ([rate limits](https://developers.openai.com/api/docs/guides/rate-limits)), so test any parser. Retrying a request with its own backoff on top of the SDK's retries multiplies the wait.
