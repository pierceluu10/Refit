---
provider: stripe
kind: field-removed
reviewed: false
drafted: 2026-11-01
sources:
  - https://docs.stripe.com/changelog
  - https://docs.stripe.com/changelog/endive/2026-09-30/removes-the-payment-method-types-parameter-from-payment-intents-and-setup-intents
  - https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end
  - https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-total-count-expansion
---

# Stripe field or param removed

**What changes.** A request param or response property goes away in a version's breaking changes. Recent examples:

- endive removed `payment_method_types` from Payment Intents, Setup Intents and Checkout Sessions ([changelog](https://docs.stripe.com/changelog/endive/2026-09-30/removes-the-payment-method-types-parameter-from-payment-intents-and-setup-intents)).
- basil removed subscription-level `current_period_start/end` in favour of item-level periods ([changelog](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end)).
- basil also removed `total_count` expansion on lists ([changelog](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-total-count-expansion)).
- 2022-11-15 removed `charges` from PaymentIntent ([changelog](https://docs.stripe.com/changelog/2022-11-15/removes-charges-attribute-paymentintent)).

Removals only bite once the version that removes them is sent. Older pins keep working.

**How to spot it.** Grep for the snake_case name, for example `payment_method_types` or `current_period_end`. In TypeScript and Java SDKs, also grep for the camelCase form. Check every place the name appears: request builders, response readers (`subscription.current_period_end`), webhook handlers reading `event.data.object`, fixtures and serializers. Removed response fields often come back as `undefined` rather than as errors.

**What to check.**

- `stripe_check_params` flags a removed request param as unknown. For an unknown name it searches the changelog and prints the removal entry, plus a did-you-mean such as `allowed_payment_method_types`.
- `stripe_api_versions` with `query` set to the field's words, between the current and target versions.
- The linked changelog page for the replacement. It is often a different shape, not a rename: for example, item-level periods, or dynamic payment methods configured in the Dashboard.
- `stripe_search_docs` for the replacement guide.

**Pitfalls.** Response readers fail silently while request writers fail loudly (`parameter_unknown`). Webhook payloads follow the endpoint version, so a handler can see both shapes during rollout. Code that defaults a missing field to 0 or null hides the problem.
