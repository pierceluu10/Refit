---
provider: meta
kind: auth-change
reviewed: false
drafted: 2026-11-01
sources:
  - https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
  - https://developers.facebook.com/docs/facebook-login/facebook-login-for-business
  - https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
  - https://developers.facebook.com/docs/graph-api/changelog/version19.0
---

# Auth, permissions and tokens

What changes: permission/scope names, permissions removed outright, token types required by an endpoint, and login flows.

- **Scope renames.** Instagram API with Instagram Login moved from `business_basic`, `business_content_publish`, `business_manage_messages`, `business_manage_comments` to `instagram_business_*`; the old values stopped working 2025-01-27 ([business login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login)).
- **Removed permissions.** `publish_to_groups` and `groups_access_member_info` went with the Groups API on 2024-04-22 ([v19.0](https://developers.facebook.com/docs/graph-api/changelog/version19.0)).
- **Login flow.** Facebook Login for Business uses a `config_id` instead of `scope` ("`config_id` has replaced `scope`") and can issue system-user or user tokens ([FBL4B](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business)).
- **Token lifetimes.** Default user/Page tokens are short-lived (hours); exchange server-side with `grant_type=fb_exchange_token` for a ~60-day user token; Page tokens derived from a long-lived user token don't expire ([long-lived tokens](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived)). Instagram Login long-lived tokens last 60 days and must be refreshed.
- **Error codes.** Since v20.0, missing field permission returns code `200` instead of `2` ([v20.0](https://developers.facebook.com/docs/graph-api/changelog/version20.0)); error handlers matching on `2` miss it.

**Spotting usage.** Grep `scope=`, `scope:` arrays, `config_id`, `FB.login`, `LoginManager`, `/dialog/oauth`, `fb_exchange_token`, `debug_token`, permission names, and error-code switches.

**What to check.** `meta_permission_info` for recorded renames/removals; `meta_search_docs` for the permission reference and App Review needs. New permissions require App Review for Advanced Access — code can be ready while review is pending; say so in the PR.

**Pitfalls.** Users who granted old scopes must re-authorize; existing stored tokens don't gain new scopes. Never log tokens or app secrets while debugging.
