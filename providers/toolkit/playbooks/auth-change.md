---
provider: generic
kind: auth-change
reviewed: false
drafted: 2026-11-02
sources:
  - https://www.rfc-editor.org/rfc/rfc6749
  - https://www.rfc-editor.org/rfc/rfc6750
  - https://www.rfc-editor.org/rfc/rfc7636
  - https://www.rfc-editor.org/rfc/rfc9700
---

# Authentication change (any provider)

_General advice for any provider. Where the provider's own docs say otherwise, follow them._

**What usually changes.** A provider moves from API keys in a query string to a header, from basic auth to bearer tokens ([RFC 6750](https://www.rfc-editor.org/rfc/rfc6750)), from long-lived keys to OAuth 2.0 ([RFC 6749](https://www.rfc-editor.org/rfc/rfc6749)) with PKCE ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)), from broad scopes to narrow ones, or retires an old token type or signing method. Security guidance pushes the same way ([RFC 9700](https://www.rfc-editor.org/rfc/rfc9700)).

**How to spot it in code.** Search for where credentials are read (env names in `.env.example` and the like, config files, secret managers), where headers such as `Authorization` are set, SDK constructor options, OAuth redirect and token endpoints, and token refresh logic. Never read a real `.env` file; the templates name the keys.

**What to check.**

- Read the provider's auth guide with `search_docs` and the announcement with `fetch_changelog` (`query`: the old method's name).
- If the spec declares security schemes, `openapi_lookup` on an operation shows which one it expects; `openapi_check` reports a header param that is required and missing.
- If an SDK handles auth, `package_lookup` shows the release that changed it.

**Pitfalls.** New credentials usually have to be created by a human in the provider's dashboard; the code change alone is not enough, and the PR must say what the owner has to create or rotate. Scopes may need re-consent from users. Token lifetimes and refresh flows change error handling. Never put a secret in code, tests or the PR.

**When you're unsure.** Change the code to the new method behind the same config names where possible, add new names to the env template (never real values), and list in the PR exactly which credentials, scopes or dashboard settings a human must set up.
