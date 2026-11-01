---
provider: shopify
kind: product-shutdown
reviewed: false
drafted: 2026-11-01
sources:
  - https://shopify.dev/changelog/posts/shopify-scripts-will-be-deprecated-on-june-30-2026
  - https://shopify.dev/docs/storefronts/themes/architecture/layouts/checkout-liquid
  - https://shopify.dev/docs/api/functions
  - https://shopify.dev/docs/api/admin-rest
---

# Shopify: retired platform features

**What usually changes.** Whole features get sunset with a replacement:

- **Shopify Scripts** (Ruby line-item, shipping and payment scripts): editing stopped on April 15, 2026, and execution stopped on **June 30, 2026** ([changelog](https://shopify.dev/changelog/posts/shopify-scripts-will-be-deprecated-on-june-30-2026)). The replacement is **Shopify Functions**: Discount, Delivery and Payment Customization, Cart Transform, Cart and Checkout Validation and others. Each function pins `api_version` in its `shopify.extension.toml` ([Functions](https://shopify.dev/docs/api/functions)).
- **checkout.liquid** is no longer supported for the Information, Shipping and Payment steps. On the Thank you and Order status pages, checkout.liquid and additional scripts were sunset for Plus on August 28, 2025, and script tags for non-Plus stores on August 26, 2026 ([checkout.liquid](https://shopify.dev/docs/storefronts/themes/architecture/layouts/checkout-liquid)). The replacement is checkout UI extensions plus web pixels.
- **REST Admin** has been legacy since 2024-10 ([REST](https://shopify.dev/docs/api/admin-rest)). See the rest-to-graphql playbook.

**How to spot it.** Look for `*.rb` script files and Script Editor exports (`Input.cart`, `Output.cart`, `ShippingRate`), `checkout.liquid` in `layout/`, `{{ checkout.* }}` Liquid on order status pages, "additional scripts" snippets, `scriptTagCreate`/`script_tags.json` with `display_scope: order_status`, and tracking pixels injected into the thank-you page.

**What to check.**

- Each Script maps to one or more Function APIs. Rebuild the logic as a Function extension (Rust or JS) with Shopify CLI. Test with function runner fixtures and keep the business rules identical.
- Thank-you or order-status tracking moves to web pixels (customer events). UI moves to checkout UI extensions.
- `shopify_api_versions` (no input) lists these deadlines with sources. `shopify_search_docs` "Functions discount" or "checkout extensibility" gives details.

**Pitfalls.** Past deadlines mean the old code is already dead code. Say so in the PR rather than leaving it in place. Functions can't make network calls, so logic that depended on external lookups needs metafields or a different design.
