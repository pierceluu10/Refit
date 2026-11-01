---
provider: stripe
kind: product-shutdown
reviewed: false
drafted: 2026-11-01
sources:
  - https://docs.stripe.com/payments/older-apis
  - https://docs.stripe.com/sources
  - https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-legacy-usage-based-billing
  - https://docs.stripe.com/payments/checkout/migration
  - https://github.com/stripe/stripe-node/wiki/Migration-Guide-for-v9
---

# Stripe product shutdown or deprecation

**What changes.** Stripe sometimes retires a whole product, not just a field. Known cases:

- The Sources API is deprecated, and new integrations cannot use it. Local payment methods on Sources are planned to be turned off, and card payments on Sources are deprecated with no shutdown date ([older APIs](https://docs.stripe.com/payments/older-apis), [Sources](https://docs.stripe.com/sources)).
- Legacy usage-based billing (metered prices without a `meter`, `aggregate_usage`, `billing_thresholds`) was removed in basil. Meter-based prices are the replacement ([changelog](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-legacy-usage-based-billing)).
- Legacy Checkout gave way to hosted Checkout ([migration](https://docs.stripe.com/payments/checkout/migration)).
- Legacy Orders was dropped from SDKs in 2022 ([stripe-node v9 guide](https://github.com/stripe/stripe-node/wiki/Migration-Guide-for-v9)).
- Stripe.js has removed deprecated methods and elements in majors, for example `redirectToCheckout` in clover.

Unlike version changes, a shutdown can affect a pinned integration, because Stripe turns the product off for everyone, usually announced by email ([older APIs](https://docs.stripe.com/payments/older-apis)).

**How to spot it.** Look for `src_` ids, `sources.create`, `type: 'sepa_debit'` on sources, `createSource`, `usage_records` / `createUsageRecord`, `StripeCheckout`, `redirectToCheckout`, and imports of SDK majors from before the removal.

**What to check.**

- `stripe_search_docs` for the product name plus "deprecated" or "migrate", and read the migration guide it returns.
- `stripe_api_versions` with `query` set to the product name, to find the version where the API dropped it.
- `stripe_check_params` on the replacement calls, for example meter-based prices or Payment Intents.
- Saved data. Stored `src_`/`card_` ids may need converting to PaymentMethods, so look for a data migration, not only code.

**Pitfalls.** Treat it as a feature migration with a data component. Note in the PR what was not exercised (live payments, mandates). Shutdown dates in the docs change, so link the page rather than copying a date.
