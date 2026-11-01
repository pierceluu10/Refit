---
provider: shopify
kind: field-removed
reviewed: false
drafted: 2026-11-01
sources:
  - https://shopify.dev/docs/api/usage/versioning
  - https://shopify.dev/changelog
  - https://shopify.dev/docs/api/admin-graphql
---

# Shopify: a GraphQL field or input was removed

**What usually changes.** Shopify deprecates a field or input field (with a `deprecationReason` naming the replacement) and removes it in a later quarterly version. Recent examples from the schema include `InventoryQuantityInput.compareQuantity` and `InventorySetQuantitiesInput.ignoreCompareQuantity`. The 2026-01 schema said both would go in 2026-04, replaced by `changeFromQuantity`, and both are absent from 2026-10. Removals take effect when you bump the version, or when an old pin falls forward ([versioning](https://shopify.dev/docs/api/usage/versioning)).

**How to spot it.** Search GraphQL documents in `.graphql`/`.gql` files, `#graphql` template literals, `gql\``, `graphql(`and`admin.graphql(` calls, and generated types (`*.generated.d.ts`, `admin.types.d.ts`) for the field name. Also search Ruby heredocs passed to `client.query`. Check the response-handling code that reads the field, not only the query.

**What to check.**

- `shopify_validate_graphql` against the target version reports the field as missing and, where an older offline snapshot has it, quotes the old deprecation reason. That reason usually names the replacement.
- If the field lives on a type outside the offline excerpt, the tool says "not checked". Run it online for the full live schema, or pass a `schemaPath`.
- `shopify_search_docs` with the field name, plus the [changelog](https://shopify.dev/changelog), confirms the replacement and any change in behaviour.

**Pitfalls.**

- Replacements are often not drop-in. They can return a MoneyBag instead of a string, a connection instead of a list, or move to a different type entirely (for example variant weight now lives on `InventoryItem.measurement`).
- Generated TypeScript types can hide the problem until you rerun codegen against the new version.
- Input fields matter as much as output fields. An unknown input field fails the whole mutation.
