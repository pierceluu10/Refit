---
provider: stripe
kind: endpoint-removed
reviewed: false
drafted: 2026-11-01
sources:
  - https://docs.stripe.com/payments/older-apis
  - https://docs.stripe.com/payments/payment-intents/migration
  - https://docs.stripe.com/sources
  - https://docs.stripe.com/payments/checkout/migration
  - https://docs.stripe.com/changelog/basil/2025-03-31/invoice-preview-api-deprecations
  - https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-legacy-usage-based-billing
  - https://github.com/stripe/stripe-node/wiki/Migration-Guide-for-v9
---

# Stripe endpoint or API removed

**What changes.** An operation goes away in a version, or a whole older API is deprecated in favour of a newer one.

- basil replaced the Upcoming Invoice methods (`GET /v1/invoices/upcoming`, `.../upcoming/lines`) with `POST /v1/invoices/create_preview` ([changelog](https://docs.stripe.com/changelog/basil/2025-03-31/invoice-preview-api-deprecations)). It also removed legacy usage-based billing: metered prices without a `meter`, `aggregate_usage` and `billing_thresholds`. Meter-based prices are the replacement ([changelog](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-legacy-usage-based-billing)).
- Older APIs: Charges, Tokens and Sources lack SCA support and get no new features. Sources is deprecated, and local payment methods on it are planned to be turned off. Charges still works but is unsupported ([older APIs](https://docs.stripe.com/payments/older-apis), [Sources](https://docs.stripe.com/sources)). The path forward is Payment Intents and Payment Methods ([migration](https://docs.stripe.com/payments/payment-intents/migration)).
- Legacy Checkout (the modal returning a token) gives way to hosted Checkout Sessions or Payment Links ([migration](https://docs.stripe.com/payments/checkout/migration)).
- The legacy Orders API was deprecated in 2019 and dropped from SDK majors in May 2022 ([stripe-node v9 guide](https://github.com/stripe/stripe-node/wiki/Migration-Guide-for-v9)).

**How to spot it.** Grep for `charges.create` / `Charge.create`, `sources.create`, `tok_` / `src_` handling, `createToken`, `createSource`, `checkout.js` / `StripeCheckout.configure`, `invoices.retrieveUpcoming` / `Invoice.upcoming`, `createUsageRecord`, `usage_records`, and `orders.`.

**What to check.**

- `stripe_check_params` on the old operation. Online it reads the spec for your target version and reports when the operation is missing, with the closest operations. Offline it only knows the excerpt.
- `stripe_api_versions` with `query` (e.g. "upcoming invoice") for the removal entry and its upgrade steps.
- `stripe_search_docs` for the migration guide.

**Pitfalls.** Charges to Payment Intents is a flow change (client confirmation, `requires_action`, webhooks), not a rename. Saved cards on Customers (`default_source`) need migrating to PaymentMethods. Keep read paths working for both old charges and new payments during the cutover ([charges read path](https://docs.stripe.com/payments/payment-intents/migration/charges)).
