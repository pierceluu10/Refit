---
provider: generic
kind: endpoint-removed
reviewed: false
drafted: 2026-11-02
sources:
  - https://www.rfc-editor.org/rfc/rfc9110#name-410-gone
  - https://www.rfc-editor.org/rfc/rfc8594
---

# An endpoint is removed (any provider)

_General advice for any provider. Where the provider's own docs say otherwise, follow them._

**What usually changes.** An operation is retired and calls start failing, often with `404` or `410 Gone` ([RFC 9110](https://www.rfc-editor.org/rfc/rfc9110#name-410-gone)), sometimes after a `Sunset` header period ([RFC 8594](https://www.rfc-editor.org/rfc/rfc8594)). The provider usually points to a replacement: a new endpoint, a new API version, a batch or search endpoint, or a different product. The replacement rarely takes exactly the same request or returns exactly the same response.

**How to spot it in code.** Search for the path (with and without the version prefix and with path parameters in different forms), the SDK method that wraps it, and any URL built from parts in config. Check background jobs, scripts and admin tools as well as request handlers.

**What to check.**

- Find the replacement: `fetch_changelog` with `query` set to the path or method, then `search_docs` for the new endpoint.
- Compare the two operations with `openapi_lookup` (old and new specs if both exist): params, body, response fields and pagination.
- After the edit, `openapi_check` the new request. Map every response field the code reads to its new place.
- If an SDK wraps the endpoint, `package_lookup` shows whether the SDK removed the method in a new major.

**Pitfalls.** Replacements often change pagination, rate limits, error codes or required scopes. A list endpoint may become a search endpoint with eventual consistency. Some removals have no replacement; then the feature in the repo needs another way, and the PR should say what was chosen.

**When you're unsure.** Move to the documented replacement, keep the repo's behaviour as close as possible, and list in the PR each response field or behaviour you could not confirm without a live call.
