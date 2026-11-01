---
provider: stripe
kind: rest-to-graphql
reviewed: false
drafted: 2026-11-01
sources:
  - https://docs.stripe.com/api-v2-overview
---

Rarely applies to Stripe: its API is REST (v1 form-encoded, v2 JSON) with no GraphQL migration. The nearest case is moving v1 calls to the /v2 namespace, which uses JSON bodies, page tokens and no `expand` ([v2 overview](https://docs.stripe.com/api-v2-overview)). See the endpoint-removed and api-version playbooks, and use `stripe_check_params` and `stripe_search_docs`.
