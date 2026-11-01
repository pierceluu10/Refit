---
provider: shopify
kind: endpoint-removed
reviewed: false
drafted: 2026-11-01
sources:
  - https://shopify.dev/docs/api/admin-graphql
  - https://shopify.dev/docs/api/admin-rest/latest/resources/product-variant
  - https://shopify.dev/changelog
---

# Shopify: a query, mutation or REST endpoint was removed

**What usually changes.** In GraphQL, an "endpoint" is a root field: a query or mutation. Shopify deprecates it with a reason and removes it in a later version. Examples visible in the 2026-10 schema: `productVariantCreate`/`productVariantUpdate` are gone (use `productVariantsBulkCreate`/`productVariantsBulkUpdate`), `productCreateMedia`/`productUpdateMedia`/`productDeleteMedia` and `fulfillmentCreateV2` are deprecated, `currentBulkOperation` is gone (use `bulkOperation(id:)`), and `inventorySetScheduledChanges` was phased out ([GraphQL reference](https://shopify.dev/docs/api/admin-graphql)). In REST, endpoints are deprecated per resource. Product and variant writes were deprecated in 2024-04 ([variants](https://shopify.dev/docs/api/admin-rest/latest/resources/product-variant)).

**How to spot it.** Grep for the mutation or query name in GraphQL documents, generated SDK types and Ruby/TS clients, and for REST paths (`/variants/`, `/products/.../images`). At runtime, a removed root field comes back as a GraphQL error saying the field doesn't exist on `Mutation`/`QueryRoot`, often with HTTP 200.

**What to check.**

- `shopify_validate_graphql` at the target version flags unknown root fields with "did you mean" suggestions (e.g. `productVariantsBulkUpdate`) and deprecated ones with the reason. The offline excerpt lists every root field name, so a missing root field is a real finding.
- For REST endpoints, `shopify_rest_to_graphql` gives the replacement operation and the field differences.
- The replacement's input usually differs (bulk inputs take arrays and a `productId`, media goes through `fileCreate`/`productSet`). Rewrite the input mapping and the `userErrors` handling, not just the name.
- `shopify_search_docs` and the [changelog](https://shopify.dev/changelog) confirm when and why.

**Pitfalls.** Bulk replacements return per-item `userErrors` that point at array indexes. Check that error handling still points at the right record.
