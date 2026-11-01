---
provider: meta
kind: product-shutdown
reviewed: false
drafted: 2026-11-01
sources:
  - https://developers.facebook.com/docs/instagram-basic-display-api/overview
  - https://developers.facebook.com/docs/whatsapp/on-premises/sunset
  - https://developers.facebook.com/docs/graph-api/changelog/version26.0
  - https://developers.facebook.com/blog/post/2025/10/16/ads-insights-api-metric-availability-updates/
---

# Product shutdown

Meta shuts down whole products on fixed dates, independent of API version:

- **Instagram Basic Display API**: deprecation announced 2024-09-04; all requests error from 2024-12-04. The replacement Instagram API supports only business and creator accounts, so personal-account features have no direct successor ([overview](https://developers.facebook.com/docs/instagram-basic-display-api/overview)).
- **WhatsApp On-Premises API**: ended 2025-10-23; use Cloud API ([sunset](https://developers.facebook.com/docs/whatsapp/on-premises/sunset)).
- **Commerce Order Management API** (Checkout on FB/IG Shops): removed 2026-10-27 ([v26.0](https://developers.facebook.com/docs/graph-api/changelog/version26.0)).
- **Legacy Insights data**: the 7d_view/28d_view attribution windows stopped being returned 2026-01-12, with tighter breakdown retention ([blog](https://developers.facebook.com/blog/post/2025/10/16/ads-insights-api-metric-availability-updates/)); large batches of Page Insights impression metrics are gone (see field-removed).
- Offline Conversions API and Groups API (see endpoint-removed).

**Spotting usage.** Basic Display: `graph.instagram.com/me/media` with `user_profile`/`user_media` scopes, `api.instagram.com/oauth/authorize`, packages like Instagram feed widgets. On-Prem WhatsApp: self-hosted `/v1/messages` on your own host, Docker `whatsapp/coreapp`. Attribution windows: `action_attribution_windows` containing `7d_view`/`28d_view`.

**What to check.** `meta_permission_info` (lists product shutdowns), `meta_lookup_field`, `meta_search_docs` for the successor. Migrations here are often product decisions (account type, hosting, data loss); make the code change you can, and spell out the user-visible consequence in the PR.

**Pitfalls.** Instagram API with Instagram Login uses `graph.instagram.com` and `instagram_business_*` scopes; Instagram API with Facebook Login uses `graph.facebook.com` and a linked Page. Pick one deliberately. The Basic Display scope names above are from memory, not re-verified in this snapshot.
