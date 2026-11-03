---
provider: generic
kind: other
reviewed: false
drafted: 2026-11-02
sources:
  - https://www.rfc-editor.org/rfc/rfc9745
  - https://semver.org/
---

# Other API changes (any provider)

_General advice for any provider. Where the provider's own docs say otherwise, follow them._

**What usually changes.** Anything that is not a clean version, field, endpoint, auth, webhook, model, shutdown or pagination change: new required headers, changed defaults, stricter validation, new error codes, regional hosts, TLS or IP changes, pricing that changes how an API should be called, or behaviour the provider now treats differently.

**How to spot it in code.** Start from the quoted change in the task and find every call site it could touch: the API host, the SDK client, the operation names and fields it mentions. Read the code around each call: what it sends, what it does with the response and how it handles errors.

**What to check.**

- Read the source page in full with `fetch_changelog` (it splits the page into entries; use `query` with words from the change) and related docs with `search_docs`.
- If a spec exists, `openapi_lookup` or `graphql_lookup` shows the current shape, and `openapi_check` or `graphql_check` validates the changed requests.
- If an SDK is involved, `package_lookup` shows whether a release already handles the change.

**Pitfalls.** Vague announcements tempt either over-editing or doing nothing. Tie each edit to a sentence in the source. Changed defaults are easy to miss because no code mentions them; setting the old value explicitly is often the smallest correct change.

**When you're unsure.** Make the smallest change the source supports, quote the sentence that motivates it in the PR, and list what only a live call would show. If, after reading the code, the change does not touch it, finish with "not affected" and explain why.
