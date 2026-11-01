---
provider: stripe
kind: auth-change
reviewed: false
drafted: 2026-11-01
sources:
  - https://docs.stripe.com/keys
  - https://docs.stripe.com/connect/authentication
  - https://docs.stripe.com/connect/oauth-reference
  - https://docs.stripe.com/webhooks
---

# Stripe authentication changes

**What changes.** Stripe authenticates with an API key sent as the HTTP Basic Auth username, or as a bearer token ([authentication](https://docs.stripe.com/api/authentication)). Key types are publishable `pk_`, restricted `rk_`, secret `sk_` and organization `sk_org_`. Stripe recommends restricted keys (RAKs) for most server use and discourages secret keys for new use cases ([keys](https://docs.stripe.com/keys)). Moving to a RAK means each endpoint the code calls needs a permission. A missing one shows up as a permission error at runtime, not at deploy.

**Connect.** Platforms act for connected accounts with the `Stripe-Account: acct_…` header (`stripeAccount` / `stripe_account` options in SDKs) and their own key ([Connect auth](https://docs.stripe.com/connect/authentication)). In the OAuth token response, `access_token`, `stripe_publishable_key` and `refresh_token` are marked deprecated in favour of that header ([OAuth reference](https://docs.stripe.com/connect/oauth-reference)). Code that stores per-account access tokens and uses them as API keys should move to the header.

**How to spot it.** Look for env var names like `STRIPE_SECRET_KEY` and `STRIPE_API_KEY`, `sk_live` / `rk_live` patterns in config (never print values), `Stripe-Account`, `stripeAccount`, `stripe_account`, `connect.stripe.com/oauth/token`, `oauth.token`, `stripe_user_id` and `access_token` columns, and `whsec_` for webhook secrets.

**What to check.**

- Which resources the code touches. Use them to list the permissions a restricted key needs. `stripe_check_params` helps confirm each operation's path.
- That every Connect call that should run on a connected account passes the account option. Missing it silently acts on the platform.
- `stripe_search_docs` for "restricted API keys" and "Stripe-Account".

**Pitfalls.** Never commit or log keys. Publishable keys are the only ones safe in clients ([keys](https://docs.stripe.com/keys)). Each webhook endpoint gets its own `whsec_` signing secret when it is created. A new endpoint, for example one created for a version upgrade, needs its secret deployed ([webhooks](https://docs.stripe.com/webhooks)). Tests often stub auth, so verify against a sandbox key with the same permissions.
