---
provider: meta
kind: field-removed
reviewed: false
drafted: 2026-11-01
sources:
  - https://developers.facebook.com/docs/graph-api/changelog/version25.0
  - https://developers.facebook.com/documentation/pages-api/platforminsights/page/deprecated-metrics
  - https://developers.facebook.com/docs/graph-api/changelog/version21.0
---

# Field or metric removed

Most Meta removals are fields on a node, values of an enum-like param, or **Insights metrics**. Two flavours ([changelog](https://developers.facebook.com/docs/graph-api/changelog)):

- _Versioned_: gone on vN+ only; older versions keep it until they expire (e.g. `LiveVideo.overlay_url` in [v24.0](https://developers.facebook.com/docs/graph-api/changelog/version24.0)).
- _All versions on a date_: the changelog says "applies to all versions on <date>". Insights metrics almost always work this way, e.g. Page `page_fans`, `page_impressions` and `post_impressions` were deprecated on 2025-11-15 ([deprecated metrics](https://developers.facebook.com/documentation/pages-api/platforminsights/page/deprecated-metrics)), and IG user metrics like `profile_views` and `website_clicks` on 2025-01-08 ([v21.0](https://developers.facebook.com/docs/graph-api/changelog/version21.0)).

**Spotting usage.** Look at `fields=` query strings, `metric=` lists on `/insights`, SDK field constants (`AdsInsights.Field.*`, `Page.Field.*` in the business SDKs), GraphQL-like nested field syntax (`insights.metric(page_fans)`), and any dashboards/DB columns fed by them. Metric names are often built from strings or config, so grep for fragments.

**What to check.** Run `meta_lookup_field` for each name; it reports the replacement (if any), the version and whether it applies to all versions already. Deprecated metrics return an invalid-metric error, and one bad metric in a `metric=` list can fail the whole request, so remove them individually rather than wrapping the call.

**Pitfalls.**

- Replacement metrics are rarely equivalent: `page_media_view` counts views, not impressions; paid/organic needs the `is_from_ads` breakdown. Say so in the PR.
- Many removals have no replacement. Delete the code path and its downstream consumers, and note the data loss.
- Two sources sometimes disagree on dates (e.g. `page_impressions_unique`: 2025-06-15 on the metrics page vs "when v26.0 ships" in [v25.0](https://developers.facebook.com/docs/graph-api/changelog/version25.0)). Treat it as already gone.
