---
provider: meta
kind: other
reviewed: false
drafted: 2026-11-01
sources:
  - https://developers.facebook.com/docs/graph-api/changelog/out-of-cycle-changes
  - https://developers.facebook.com/docs/graph-api/changelog/version26.0
  - https://developers.facebook.com/docs/graph-api/changelog/version24.0
---

# Other Meta changes

Things that don't fit a neat kind but break code:

- **Out-of-cycle changes** apply to every version at once for policy/privacy reasons, e.g. oEmbed `author_name`, `author_url`, `thumbnail_*` removed 2025-11-03 ([out-of-cycle](https://developers.facebook.com/docs/graph-api/changelog/out-of-cycle-changes)). Pinning won't help.
- **Protocol behaviour** in v26.0: `pretty`/`debug` ignored, `date_format` errors, ETag/`If-None-Match` caching removed ([v26.0](https://developers.facebook.com/docs/graph-api/changelog/version26.0)). Code relying on 304s or server-formatted dates breaks quietly.
- **Marketing API behaviour changes**: new required flags (`is_adset_budget_sharing_enabled`, explicit `advantage_audience`), removed placements (Facebook video feeds, Instagram Explore), default opt-ins (Advantage+ audience) ([v24.0](https://developers.facebook.com/docs/graph-api/changelog/version24.0)).

Use `meta_lookup_field` (it covers parameters and behaviours too), `meta_api_versions`, and `meta_search_docs`. Say clearly in the PR when the change alters ad delivery or spend, not just code shape.
