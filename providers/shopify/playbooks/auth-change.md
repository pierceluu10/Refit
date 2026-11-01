---
provider: shopify
kind: auth-change
reviewed: false
drafted: 2026-11-01
sources:
  - https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/token-exchange
  - https://shopify.dev/docs/api/usage/access-scopes
  - https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration
---

# Shopify: access tokens, session tokens and scopes

**What usually changes.** Embedded apps moved from redirect-based OAuth to **Shopify managed installation** plus **token exchange**. The frontend gets a short-lived ID (session) token from App Bridge, and the backend swaps it for an access token at `POST https://{shop}.myshopify.com/admin/oauth/access_token` with `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` ([token exchange](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/token-exchange)). The current deadline: **public apps must use expiring offline tokens for GraphQL Admin requests by January 1, 2027**. Those tokens last 1 hour and come with 90-day refresh tokens (`expiring=1`). Custom and merchant-created apps are exempt.

**How to spot it.** Look for `/admin/oauth/authorize` redirects, `shopify.auth.begin`/`callback`, `shopify.auth.tokenExchange`, `authenticate.admin` (React Router/Remix), `ShopifyAPI::Auth::TokenExchange`, `use_legacy_install_flow` and `[access_scopes] scopes` in `shopify.app.toml` ([app config](https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration)), session storage that keeps one non-expiring offline token per shop, and the `X-Shopify-Access-Token` header.

**What to check.**

- Token storage must handle expiry and refresh: keep `expires_in`, the `refresh_token` and its expiry, and refresh before calling the API. Shopify keeps only one current expiring offline token per app and store, and a new one retires the old.
- Online tokens follow the staff session (24 hours or logout). Use offline tokens for webhooks and jobs.
- Scopes: optional scopes are granted after install, so check `currentAppInstallation { accessScopes }` rather than assuming ([access scopes](https://shopify.dev/docs/api/usage/access-scopes)). `read_all_orders` works only alongside `read_orders`/`write_orders`. Protected customer data needs approval.
- `shopify_api_versions` (no input) lists the token deadline with its source, and `shopify_search_docs` "token exchange" gives the request details.

**Pitfalls.** Never cache ID tokens, because they are short-lived and a stale one gets a 400. Background workers that assume a token never expires break silently once expiring tokens arrive. Don't log tokens or client secrets.
