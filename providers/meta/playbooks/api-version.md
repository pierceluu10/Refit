---
provider: meta
kind: api-version
reviewed: false
drafted: 2026-11-01
sources:
  - https://developers.facebook.com/docs/graph-api/guides/versioning
  - https://developers.facebook.com/docs/graph-api/changelog
  - https://developers.facebook.com/docs/marketing-api/overview/versioning
---

# Meta Graph / Marketing API version upgrade

Meta versions are numbered (`v19.0` ... `v26.0`) and pinned in the URL path, e.g. `graph.facebook.com/v21.0/{page-id}` ([versioning](https://developers.facebook.com/docs/graph-api/guides/versioning)). A Graph version stays usable until two years after the next version ships; after that, calls are **defaulted to the next oldest usable version**, so expired pins keep "working" with newer behaviour rather than failing loudly. Marketing API versions live only about 90 days past their successor, and after that calls may fail or be auto-upgraded only where the endpoint didn't change ([Marketing versioning](https://developers.facebook.com/docs/marketing-api/overview/versioning)). Unversioned calls use the app default on Graph and are rejected on Marketing endpoints.

**Find the pin.** Grep for `graph.facebook.com/v`, `graph.instagram.com/v`, `graph-video.facebook.com/v`, `/dialog/oauth`, env names like `GRAPH_API_VERSION`, `FB.init({ version })`, `FacebookAdsApi.init(..., api_version=...)` (Python), and the installed business SDK version (Node/PHP SDKs hard-code the API version). Often the version is repeated in several places (OAuth URL, REST client, webhook subscription), so update them together. `meta_api_versions` lists all of these and computes days to expiry.

**Check the window.** Read every per-version changelog between the old and new version, not just the target ([changelog](https://developers.facebook.com/docs/graph-api/changelog)), plus the Marketing API changelog if the code touches ads. Use `meta_lookup_field` with `from_version`/`to_version` for each field, metric and edge the code reads; it also flags changes that already hit **all** versions (pinning doesn't protect you from those). `meta_search_docs` covers the rest.

**Pitfalls.**

- Insights metrics are often removed for every version at once; a version bump won't be the only breakage.
- v26.0 changes protocol features: `date_format` and root `/?ids=` now error, `pretty`/`debug`/ETags are ignored ([v26.0](https://developers.facebook.com/docs/graph-api/changelog/version26.0)).
- Webhook subscriptions carry their own version; bump them in the App Dashboard too.
- An app can only call older versions it has already called, so testing against an old version from a new app may not be possible.
