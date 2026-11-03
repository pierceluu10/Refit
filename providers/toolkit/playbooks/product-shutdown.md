---
provider: generic
kind: product-shutdown
reviewed: false
drafted: 2026-11-02
sources:
  - https://www.rfc-editor.org/rfc/rfc8594
---

# A product or API is shut down (any provider)

_General advice for any provider. Where the provider's own docs say otherwise, follow them._

**What usually changes.** A whole product, API family or SDK is discontinued on a date. The provider may name a successor product, a partner, or nothing. Calls start failing after the date, sometimes after a period of `Sunset` headers ([RFC 8594](https://www.rfc-editor.org/rfc/rfc8594)) or brownouts.

**How to spot it in code.** Find every use: SDK imports, API hosts, env names in templates, feature flags, scheduled jobs, UI that depends on it, and docs in the repo that mention it. Work out which user-facing feature each use supports.

**What to check.**

- Read the shutdown notice and the migration guide with `fetch_changelog` and `search_docs`; note the exact date and the named successor.
- If the successor has a spec, `openapi_lookup` or `graphql_lookup` it and check each new request with `openapi_check` or `graphql_check`.
- `package_lookup` shows whether the old SDK is deprecated and whether the successor has its own package.

**Pitfalls.** A successor product is rarely a drop-in replacement: data may need exporting before the date, pricing and limits differ, and new credentials are usually needed. Removing the code without a replacement silently removes a feature; that is a product decision the PR must state plainly.

**When you're unsure.** Migrate to the named successor where there is one, behind the same interface the repo already uses. Where there is none, make the smallest change that keeps the app working (for example, a clear error or a disabled feature behind the existing flag) and explain the choice and the data question in the PR.
