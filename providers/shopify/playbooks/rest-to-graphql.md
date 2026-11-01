---
provider: shopify
kind: rest-to-graphql
reviewed: false
drafted: 2026-11-01
sources:
  - https://shopify.dev/docs/api/admin-rest
  - https://shopify.dev/docs/api/usage/gids
  - https://shopify.dev/docs/apps/build/product-merchandising/products-and-collections
  - https://shopify.dev/docs/api/usage/pagination-graphql
---

# Shopify: REST Admin to GraphQL Admin

**What usually changes.** The REST Admin API has been legacy since October 1, 2024, and new public apps must use GraphQL only from April 1, 2025 ([REST reference](https://shopify.dev/docs/api/admin-rest)). REST product and variant writes were deprecated in 2024-04, when the product model moved to GraphQL (up to 2,048 variants). Product images followed in 2025-01. This is rarely a rename-for-rename job, because one REST write often becomes several mutations.

**How to spot it.** Look for `/admin/api/<version>/<resource>.json` URLs, `shopify.rest.*` / `restResources` in `@shopify/shopify-api`, `ShopifyAPI::Product.find` or other `ShopifyAPI::<Resource>` REST classes in Ruby, `session.rest`, and `Link` header pagination with `page_info`.

**What to check.**

- `shopify_rest_to_graphql` with the exact endpoint (`PUT /admin/api/2024-01/variants/123.json`) returns the GraphQL equivalent listed on Shopify's REST page, the field differences and the deprecation status.
- IDs become GIDs, e.g. `gid://shopify/Product/123`. REST responses carry `admin_graphql_api_id`. Some IDs take parameters, such as `InventoryLevel` ([GIDs](https://shopify.dev/docs/api/usage/gids)). Stored numeric IDs need converting at the boundary.
- Products: `variants` are written with `productVariantsBulkCreate/Update/Delete` or `productSet`. `images` become media (`MediaImage`). Options are `ProductOption` with option values. `inventory_quantity` is read-only, so set stock per location with `inventorySetQuantities` or `inventoryAdjustQuantities` ([product model](https://shopify.dev/docs/apps/build/product-merchandising/products-and-collections)).
- Pagination becomes cursors (`first/after`, `pageInfo`), up to 250 nodes per page ([pagination](https://shopify.dev/docs/api/usage/pagination-graphql)). Big exports belong in bulk operations.
- Validate each new document with `shopify_validate_graphql` before running tests.

**Pitfalls.**

- Always request `userErrors` on mutations. GraphQL errors arrive with HTTP 200.
- Money fields moved to `*Set` MoneyBags, and the bare amounts are deprecated.
- `productSet` replaces list fields like variants and options wholesale. Don't send a partial list unless you mean it.
- `read_orders` sees only 60 days of orders without `read_all_orders`, whichever API you use.
