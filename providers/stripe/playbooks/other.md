---
provider: stripe
kind: other
reviewed: false
drafted: 2026-11-01
sources:
  - https://docs.stripe.com/changelog
  - https://docs.stripe.com/error-codes
---

# Other Stripe changes

Some changes fit no other kind:

- new decline or error codes, which the changelog marks as breaking when they replace generic codes ([error codes](https://docs.stripe.com/error-codes));
- changed defaults, such as clover making flexible billing mode the default for new subscriptions;
- validation that got stricter;
- Stripe.js behaviour changes tagged `stripejs` in the [changelog](https://docs.stripe.com/changelog).

Look for code that switches on `decline_code` / `code` strings, relies on a default instead of passing a param, or calls Stripe.js methods. Use `stripe_api_versions` with a `query` for the behaviour, `stripe_check_params` to confirm the params you now need to pass explicitly, and `stripe_search_docs` for the guide. Changed defaults are the easiest to miss: tests with mocked responses won't notice them, so pin the old behaviour explicitly when it matters, and say what you could not exercise.
