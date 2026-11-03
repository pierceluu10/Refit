---
provider: generic
kind: api-version
reviewed: false
drafted: 2026-11-02
sources:
  - https://www.rfc-editor.org/rfc/rfc8594
  - https://www.rfc-editor.org/rfc/rfc9745
  - https://semver.org/
---

# API version upgrade (any provider)

_General advice for any provider. Where the provider's own docs say otherwise, follow them._

**What usually changes.** Providers version an API in one of four ways: a version in the URL path (`/v1/` to `/v2/`), a dated or numbered header (`Api-Version: 2025-01-01`), a query parameter (`?api-version=`), or the version an SDK release pins for you. A new version can rename or remove fields, change defaults, change error shapes and change response objects. An old one may answer with a `Sunset` or `Deprecation` header before it stops working ([RFC 8594](https://www.rfc-editor.org/rfc/rfc8594), [RFC 9745](https://www.rfc-editor.org/rfc/rfc9745)).

**How to spot it in code.** Search for the version string itself, the API host with a path segment like `/v1`, header names containing `version`, SDK constructor options such as `apiVersion` or `api_version`, and config or env templates (`.env.example`) that hold a base URL. Several call sites may pin different versions; the repo can disagree with itself.

**What to check.**

- Read the provider's version or upgrade guide with `fetch_changelog` (pass `since` with the pinned version or its date), and `search_docs` for each operation the repo calls.
- If the provider publishes an OpenAPI spec, use `openapi_lookup` on the new version and `openapi_check` on each changed request. For GraphQL, use `graphql_check` with `compare_to` set to the old schema.
- If an SDK pins the version, `package_lookup` shows which SDK release moved to which version.
- Run the repo's checks with `run_checks` before and after.

**Pitfalls.** Response changes matter as much as request changes: code that reads a removed field fails at runtime, not at compile time. Tests that mock HTTP will pass anyway. Webhooks may be rendered at a version set elsewhere (an endpoint setting or account default). Changing one call site's version while leaving others is fine if the provider allows it, but say so.

**When you're unsure.** Make the smallest change that moves the pinned version, update the fields the changelog names, and list in the PR every response field you could not confirm.
