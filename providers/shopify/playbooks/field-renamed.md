---
provider: shopify
kind: field-renamed
reviewed: false
drafted: 2026-11-01
sources:
  - https://shopify.dev/docs/api/admin-graphql
  - https://shopify.dev/changelog
---

# Shopify: a field or argument was renamed or replaced

**What usually changes.** Shopify rarely renames in place. It adds the new name, deprecates the old one with a reason like "Use `descriptionHtml` instead", and removes the old name later. The 2026-10 schema has many of these: `Product.bodyHtml` → `descriptionHtml`, `featuredImage` → `featuredMedia`, `totalVariants` → `variantsCount`, `priceRange` → `priceRangeV2`, `productByHandle` → `productByIdentifier`, `Customer.email` → `defaultEmailAddress.emailAddress`, and the `productUpdate(input:)` argument → `product:` ([GraphQL reference](https://shopify.dev/docs/api/admin-graphql)).

**How to spot it.** Look for deprecation warnings in logs and GraphiQL, and grep for the old name in queries, fragments, generated types and the code that reads responses. Arguments get renamed too, so check variables objects (`{ input: ... }` versus `{ product: ... }`) and the input type names in variable definitions (`$input: ProductInput!` versus `ProductUpdateInput!`).

**What to check.**

- `shopify_validate_graphql` prints every deprecated field and argument it meets, with Shopify's reason. Treat the reasons as your rename list. It also offers "did you mean" for names that no longer exist.
- Confirm the new field's type. Many renames also change shape (bare money to MoneyBag, list to connection, string to enum).
- Use `shopify_search_docs` or the [changelog](https://shopify.dev/changelog) when the reason doesn't name a replacement.

**Pitfalls.**

- When a mutation input type is renamed, the variable definition changes too, and so may the payload shape.
- Aliases in queries (`body: bodyHtml`) can make a rename look harmless while downstream code still expects the old format.
- Keep webhook payloads in mind. They follow the webhook API version, not your query, so field names there change on their own schedule.
