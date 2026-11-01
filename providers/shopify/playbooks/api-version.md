---
provider: shopify
kind: api-version
reviewed: false
drafted: 2026-11-01
sources:
  - https://shopify.dev/docs/api/usage/versioning
  - https://shopify.dev/docs/api/release-notes
  - https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration
---

# Shopify: Admin API version upgrades

**What usually changes.** Shopify ships a dated Admin API version every quarter (January, April, July, October) and keeps each one accessible for about 12 months ([versioning](https://shopify.dev/docs/api/usage/versioning)). When a pinned version goes out of support, requests don't fail. Shopify **falls forward** to the oldest accessible stable version, so the app quietly runs on behaviour it was never tested against. A version bump means reading the [release notes](https://shopify.dev/docs/api/release-notes) for every version you skip, because breaking changes add up.

**How to spot it.** Grep for `/admin/api/20`, `apiVersion`, `ApiVersion.` (`@shopify/shopify-api`), `api_version` (`shopify.app.toml`, `shopify.extension.toml`, the Ruby `ShopifyAPI::Context.setup`), `LATEST_API_VERSION`, and the `X-Shopify-API-Version` header. Webhooks have their own version in `[webhooks] api_version` ([app configuration](https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration)). Each Function or UI extension pins its own `api_version` too.

**What to check.**

- `shopify_api_versions` with the pinned version gives its status, end date, the oldest supported version (what you are falling forward to) and release-notes links for each version in between.
- Bump every pin together where you can. Admin, webhook and extension versions can differ, but mixed versions make payload shapes hard to reason about.
- Run every GraphQL document through `shopify_validate_graphql` with the target `version`. It flags removed fields (using an older snapshot as history), deprecated fields with Shopify's reason, and changed arguments. When online it checks the exact live schema.
- Use `shopify_search_docs` for a field or mutation named in the release notes.

**Pitfalls.**

- SDK constants such as `LATEST_API_VERSION` move when you upgrade the SDK. An SDK upgrade can therefore be an API version bump in disguise, and the other way round.
- Release candidates can still change. Don't pin production code to the RC or to `unstable`.
- Deprecation warnings don't block anything, and removals often land a version or two later. Treat each deprecation reason as a to-do item.
- A GraphQL response can be HTTP 200 and still carry `errors`. Tests that check only the status code miss removed fields.
