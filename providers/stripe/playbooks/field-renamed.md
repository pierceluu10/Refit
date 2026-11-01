---
provider: stripe
kind: field-renamed
reviewed: false
drafted: 2026-11-01
sources:
  - https://docs.stripe.com/changelog
  - https://docs.stripe.com/changelog/endive/2026-09-30/rename-financial-connections-countries-filter-to-country
  - https://docs.stripe.com/changelog/clover/2025-09-30/add-discount-source-property
  - https://docs.stripe.com/changelog/dahlia/2026-03-25/rename-init-checkout-to-init-checkout-elements
---

# Stripe field renamed or reshaped

**What changes.** Stripe rarely does a pure rename. Usually a field is replaced by a differently shaped one in a major release. Examples:

- endive renamed the Financial Connections `countries` filter to `country` ([changelog](https://docs.stripe.com/changelog/endive/2026-09-30/rename-financial-connections-countries-filter-to-country)).
- clover replaced `Discount.coupon` with a polymorphic `Discount.source` ([changelog](https://docs.stripe.com/changelog/clover/2025-09-30/add-discount-source-property)).
- dahlia renamed the Stripe.js `initCheckout` method ([changelog](https://docs.stripe.com/changelog/dahlia/2026-03-25/rename-init-checkout-to-init-checkout-elements)).
- Some enum values get renamed too, such as the Reserve Release reason in endive.

**How to spot it.** Grep for the old name in snake_case, in camelCase (typed SDKs, Stripe.js), and inside string literals used as enum values. Expected-value tests and fixtures often hold the old spelling. For Stripe.js renames, search the front end and any `@stripe/stripe-js` wrapper.

**What to check.**

- `stripe_api_versions` (`version` → `target`, `query` set to the old name's words) to find the entry and the exact new shape.
- `stripe_check_params` with the old name gives a did-you-mean that often points at the new field. Enum mismatches show the allowed values at that version.
- For responses, read the linked changelog page. A reshaped field, such as an object in place of a string id, changes every reader, not only the key.

**Pitfalls.** Polymorphic replacements need a type check (`source.type`) before reading nested data. If you keep both the old and new names "for safety", the request fails, because the old one is now unknown. Webhook handlers may receive the old name until endpoints are upgraded, so read both during the switchover and drop the old one after.
