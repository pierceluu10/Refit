---
provider: meta
kind: field-renamed
reviewed: false
drafted: 2026-11-01
sources:
  - https://developers.facebook.com/docs/graph-api/changelog/version22.0
  - https://developers.facebook.com/docs/graph-api/changelog/version26.0
  - https://developers.facebook.com/docs/graph-api/changelog/version23.0
---

# Field renamed or replaced

Meta "renames" are usually a deprecated field plus a new field, both present for a while. Examples:

- Marketing API: `instagram_actor_id` -> `instagram_user_id`, `instagram_story_id` -> `source_instagram_media_id`, `effective_instagram_story_id` -> `effective_instagram_media_id` (v22.0, all versions 2025-09-09) ([v22.0](https://developers.facebook.com/docs/graph-api/changelog/version22.0)); ad set `exclusions` -> `excluded_custom_audiences`.
- Reach & frequency: `instagram_actor_id` -> `ig_user_id` ([v23.0](https://developers.facebook.com/docs/graph-api/changelog/version23.0)).
- Rights Manager: `reference_owner` -> `reference_owner_rh_owner` etc., with a new `RightsHolderOwner` type ([v26.0](https://developers.facebook.com/docs/graph-api/changelog/version26.0)).
- Insights: `page_fans` -> `page_follows`, `page_impressions` -> `page_media_view` ([deprecated metrics](https://developers.facebook.com/documentation/pages-api/platforminsights/page/deprecated-metrics)).

**Spotting usage.** Grep request bodies and `fields=` strings, `object_story_spec` builders, SDK constants (`AdCreative.Field.instagram_actor_id`, `'instagram_actor_id'` in dicts), and response parsing (`data["instagram_actor_id"]`). Renames touch both what you send and what you read back.

**What to check.** `meta_lookup_field` gives the replacement and dates. Then confirm the new field's type and semantics in the reference via `meta_search_docs` — `instagram_user_id` is an Instagram user ID, not the old Instagram actor ID, so stored IDs may need re-fetching (e.g. from the Page's `instagram_business_account`). Make sure the business SDK version you're on actually has the new field constant; older SDKs won't.

**Pitfalls.** Changing only the write path leaves readers expecting the old key; deprecated keys can return `null` silently rather than erroring, so tests that only check for "no error" pass while data disappears.
