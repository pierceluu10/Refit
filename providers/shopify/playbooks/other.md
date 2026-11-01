---
provider: shopify
kind: other
reviewed: false
drafted: 2026-11-01
sources:
  - https://shopify.dev/changelog
  - https://shopify.dev/docs/api/usage/gids
---

For Shopify changes that fit no other kind (behaviour changes, new validation rules, money or tax handling, ID formats), start from the [changelog](https://shopify.dev/changelog) entry and search it with `shopify_search_docs`. Check any GraphQL you touch with `shopify_validate_graphql` at the pinned version (`shopify_api_versions` shows which versions are live). Watch for GID handling (`gid://shopify/Type/123`, [GIDs](https://shopify.dev/docs/api/usage/gids)) and for HTTP-200 GraphQL errors. If it turns out to be a version, auth, webhook or pagination change, use that playbook.
