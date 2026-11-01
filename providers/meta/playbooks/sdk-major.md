---
provider: meta
kind: sdk-major
reviewed: false
drafted: 2026-11-01
sources:
  - https://github.com/facebook/facebook-python-business-sdk
  - https://github.com/facebook/facebook-nodejs-business-sdk
  - https://developers.facebook.com/docs/graph-api/guides/versioning
---

# Business SDK major upgrade

Meta's business SDKs (`facebook-business` on PyPI, `facebook-nodejs-business-sdk` on npm, `facebook/php-business-sdk`, Java, Ruby) use the **API version as the SDK major**: SDK 26.x calls API v26.0. The version is hard-coded in the SDK — `facebook_business/apiconfig.py` `API_VERSION` ([Python](https://github.com/facebook/facebook-python-business-sdk)), `FacebookAdsApi.VERSION` in `src/api.js` ([Node](https://github.com/facebook/facebook-nodejs-business-sdk)), `ApiConfig::APIVersion` in PHP. So an SDK major bump **is** an API version upgrade; run the api-version playbook too.

Python lets you override per session: `FacebookAdsApi.init(..., api_version='v24.0')`. The Node SDK's `init(accessToken, locale, crashLog)` takes no version, so the package version decides. Note npm's `latest` tag was 24.0.1 on 2026-11-01 while GitHub main was 26.0.2; check what is actually installed (lockfile) rather than assuming.

**What usually changes.** Generated object classes and `Field` enums track the API: removed fields disappear from enums (code referencing `AdCreative.Field.instagram_actor_id` fails at import/compile time, which is helpful), new required params appear, removed endpoints lose their methods (v26 dropped the Commerce Order Management classes). Dependency bumps ship alongside.

**Spotting usage.** `facebook_business` imports, `require('facebook-nodejs-business-sdk')`, `FacebookAds\` namespaces, `FacebookAdsApi.init`, `AdAccount(...).get_insights(fields=[...])`, `.Field.` constants.

**What to check.** `meta_api_versions` for the SDK-to-API mapping and expiry; `meta_lookup_field` for each field constant and param the code uses across the version window; `meta_search_docs` for SDK notes. The SDK changelogs mostly list additions, so the Graph/Marketing changelogs are the real list of breaking changes.

**Pitfalls.** Jumping several majors at once crosses several changelogs. Mobile/JS SDKs (Facebook Login) are separate products with their own versioning.
