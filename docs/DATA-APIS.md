# Data and productivity APIs

Refit detects and monitors fifteen data and productivity providers: Google Maps Platform, Mapbox, Algolia, HubSpot, Intercom, Mailchimp, Zoom, Dropbox, Notion, Airtable, Segment, Sentry, Discord, Contentful and Cloudinary. All are catalog entries with `adapter: null`: Refit finds them and reports deadlines, and has no agent that edits their code.

```
refit agents --repository <root>      # packages, hostname lines and HTTP requests per provider
refit deadlines --repository <root>   # exposure to the announced deadlines below
```

## Catalog entries

Package names are the ones the npm registry returned on 2026-10-22; `raven-js` is deprecated on npm ("Please upgrade to @sentry/browser") and kept so older repositories are found. API hosts come from each provider's API reference. `refit agents` lists, per provider, `packages` (declared or locked), `hostnames` (every source line that contains the host) and `requests` (calls sent to the host through an HTTP client, from `pipeline/api-hosts.ts`; tests, docs, assets and allowlists are left out). A host also covers its subdomains, so `abc-dsn.algolia.net` is Algolia.

| Provider             | Packages                                                                                                                  | Hosts                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Google Maps Platform | `@googlemaps/google-maps-services-js`, `@googlemaps/js-api-loader`, `@react-google-maps/api`, `@vis.gl/react-google-maps` | `maps.googleapis.com`, `places.googleapis.com`, `routes.googleapis.com` |
| Mapbox               | `mapbox-gl`, `@mapbox/mapbox-sdk`, `@mapbox/search-js-react`                                                              | `api.mapbox.com`                                                        |
| Algolia              | `algoliasearch`, `@algolia/client-search`, `instantsearch.js`, `react-instantsearch`                                      | `algolia.net`, `algolianet.com`                                         |
| HubSpot              | `@hubspot/api-client`                                                                                                     | `api.hubapi.com`, `api.hubspot.com`                                     |
| Intercom             | `intercom-client`                                                                                                         | `api.intercom.io`                                                       |
| Mailchimp            | `@mailchimp/mailchimp_marketing`, `@mailchimp/mailchimp_transactional`                                                    | `api.mailchimp.com`, `mandrillapp.com`                                  |
| Zoom                 | `@zoom/meetingsdk`, `@zoom/videosdk`, `@zoomus/websdk`                                                                    | `api.zoom.us`                                                           |
| Dropbox              | `dropbox`                                                                                                                 | `api.dropboxapi.com`, `content.dropboxapi.com`                          |
| Notion               | `@notionhq/client`                                                                                                        | `api.notion.com`                                                        |
| Airtable             | `airtable`                                                                                                                | `api.airtable.com`                                                      |
| Segment              | `@segment/analytics-node`, `@segment/analytics-next`, `analytics-node`                                                    | `api.segment.io`, `cdn.segment.com`                                     |
| Sentry               | `@sentry/node`, `@sentry/browser`, `@sentry/react`, `@sentry/nextjs`, `raven-js`                                          | `sentry.io/api`                                                         |
| Discord              | `discord.js`, `discord-api-types`                                                                                         | `discord.com/api`, `discordapp.com/api`                                 |
| Contentful           | `contentful`, `contentful-management`                                                                                     | `cdn.contentful.com`, `api.contentful.com`, `preview.contentful.com`    |
| Cloudinary           | `cloudinary`, `@cloudinary/url-gen`, `@cloudinary/react`                                                                  | `api.cloudinary.com`                                                    |

`res.cloudinary.com` is not listed: it serves images, and in the sample every line naming it was a picture URL.

## Registry entries

Each entry's `source` is a page that was read on 2026-10-22 (`checkedAt`). The date is the one the page gives. The matchers are in `pipeline/data-api-matchers.ts` (Algolia is in `scanDeadlines`, whose `sdk` entries now accept `package@<major>`).

| Entry                          | Date       | What the page says                                                                                                                                                                                                                                            | What Refit matches                                                                                            |
| ------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `algolia-javascript-client-v4` | 2026-08-14 | "JavaScript client v4 reaches the end of Algolia support on August 14, 2026"; the v5 compatibility layer is to be removed on 2027-02-14 ([changelog](https://changelog.algolia.com/label/80880))                                                              | `algoliasearch` declared below major 5 (locked version first) in a repository whose source names it           |
| `zoom-meeting-sdk-key`         | 2026-06-27 | "As of June 27, 2026, migration from the legacy Meeting SDK Key and Secret to the Client ID and Client Secret will be enforced" ([page](https://developers.zoom.us/docs/meeting-sdk/sdk-key-migration/))                                                      | an `sdkKey:` property in a file that uses `@zoom/meetingsdk`, `@zoomus/websdk` or `ZoomMtg`                   |
| `mailchimp-export-api`         | 2023-06-01 | "We retired API Export 1.0 and API 2.0 on June 1, 2023 … HTTP 410" ([release notes](https://mailchimp.com/developer/release-notes))                                                                                                                           | `api.mailchimp.com/export/1.0` or `/export/2.0`                                                               |
| `airtable-user-api-keys`       | 2024-02-01 | "completing the deprecation process on Feb 1, 2024, meaning: API Keys can no longer access the Airtable API" ([notice](https://support.airtable.com/docs/airtable-api-key-deprecation-notice))                                                                | a legacy key (`key` plus 14 letters or digits) written as a string in a file that uses the `airtable` package |
| `hubspot-api-v4`               | 2027-03-30 | "Support for v4 is ending separately on March 30, 2027" ([changelog](https://developers.hubspot.com/changelog/legacy-apis-and-legacy-apps-whats-going-unsupported-and-when)); the page says endpoints on numbered paths `/v1/`, `/v2/`, `/v3/` go unsupported | `api.hubapi.com/…/v4/…`                                                                                       |

Two matcher paths are inferences from the page, not words on it: the Mailchimp Export API path `/export/1.0` (the page names "Export 1.0", and Mailchimp's own root URL is `…api.mailchimp.com/3.0/`) and HubSpot's `/v4/` (by analogy with the page's `/v1/` to `/v3/`). The Airtable matcher is deliberately narrow: `new Airtable({ apiKey })` also takes personal access tokens, so an `apiKey` property cannot show a legacy key.

### Checked, nothing announced (that Refit can match)

| Provider             | Pages read                                                                                                        | Result                                                                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Maps Platform | [developers.google.com/maps/deprecations](https://developers.google.com/maps/deprecations)                        | Deprecations with only a month (Heatmap Layer and Drawing Library "May 2026") or no sunset date (`google.maps.Marker`, KML Layer); the dated rows are completed deprecations from 2010–2025. No registry-usable day. |
| Mapbox               | [docs.mapbox.com/api/changelog](https://docs.mapbox.com/api/changelog/)                                           | Only past removals (Legacy Static Images 2021, Distance API 2018).                                                                                                                                                   |
| Intercom             | [API versions page](https://developers.intercom.com/docs/build-an-integration/learn-more/rest-apis/api-changelog) | Lists release dates 1.0 to 2.17 and no deprecation or sunset dates.                                                                                                                                                  |
| Dropbox              | [HTTP documentation](https://www.dropbox.com/developers/documentation/http/documentation)                         | Page held no deprecation; the changelog URL tried returned 404.                                                                                                                                                      |
| Notion               | [changelog](https://developers.notion.com/page/changelog)                                                         | Private-alpha Agent API routes (migrate by 2026-09-30) and an undated `cursor` deprecation. The alpha routes are not public, so no matcher.                                                                          |
| Sentry               | [blog post](https://blog.sentry.io/deprecating-our-legacy-javascript-sdk/)                                        | `raven-js` deprecated in 2020 with no end date: "deprecation doesn't mean raven-js will stop working".                                                                                                               |
| Discord              | [API reference](https://docs.discord.com/developers/reference)                                                    | API versions 6 to 8 "Deprecated", 3 to 5 "Discontinued", no dates.                                                                                                                                                   |
| Cloudinary           | [SDK guide](https://cloudinary.com/documentation/cloudinary_sdks)                                                 | No end-of-support dates found; search results named only an undated `/sse` MCP endpoint deprecation.                                                                                                                 |
| Segment              | Page returned 403 (see Blocked)                                                                                   | Not readable.                                                                                                                                                                                                        |
| Contentful           | Page returned 429 (see Blocked)                                                                                   | Not readable.                                                                                                                                                                                                        |

**Blocked.** Segment's `analytics-node` deprecation (search snippet: "will deprecate this version of Node on December 31, 2023") and Contentful's legacy usage endpoints (search snippet: removal 2027-02-28) are not entered: the Segment docs answered 403 and the Contentful API-changes page answered 429 on every try (curl and the fetch tool), so no page was read. Search snippets are not sources. Unblock by reading the pages in a browser.

## Measurement

Pinned Refit commit: `5bec50d`, clean tree (`refit` in the results file).

**Sample.** [`2026-10-22-data-apis-repos.json`](benchmarks/2026-10-22-data-apis-repos.json): 208 public JS/TS repositories at pinned commits, 14 per provider (12 for Intercom). `scripts/data-apis-select.mjs` finds them with GitHub code search (the query shape `"<package>" filename:package.json path:/` for every package of the provider, up to 3 pages of 100, in result order), keeps a repository only if it is not a fork or archived, was pushed since 2025-10-21, is under 60 MB, is not the provider's own organisation, and its root `package.json` at HEAD declares the package. Intercom's package search returned only eight, so `scripts/data-apis-supplement.mjs` added four repositories whose source names `api.intercom.io`. Exact queries, counts and the search date are in the file. Fetched with `git fetch --depth 1`, no submodules, nothing installed or run.

`scripts/data-apis-benchmark.mjs` scans each with `refit agents` and `refit deadlines`: 196 scanned, 12 stopped with the repository reader's size limit (10,000 files, 2 MiB per file, 50 MiB total).

| Provider             | Sampled | Scanned | Detected by package | Detected by host only | Repos with an HTTP request | Deadline exposure |
| -------------------- | ------- | ------- | ------------------- | --------------------- | -------------------------- | ----------------- |
| Google Maps Platform | 14      | 13      | 13                  | 0                     | 1                          | none              |
| Mapbox               | 14      | 14      | 14                  | 0                     | 1                          | none              |
| Algolia              | 14      | 13      | 13                  | 0                     | 0                          | 9 of 13           |
| HubSpot              | 14      | 13      | 13                  | 0                     | 0                          | none              |
| Intercom             | 12      | 11      | 8                   | 3                     | 1                          | none              |
| Mailchimp            | 14      | 14      | 14                  | 0                     | 0                          | none              |
| Zoom                 | 14      | 14      | 14                  | 0                     | 4                          | 6 of 14           |
| Dropbox              | 14      | 13      | 13                  | 0                     | 3                          | none              |
| Notion               | 14      | 14      | 14                  | 0                     | 4                          | none              |
| Airtable             | 14      | 14      | 14                  | 0                     | 2                          | none              |
| Segment              | 14      | 10      | 10                  | 0                     | 0                          | none              |
| Sentry               | 14      | 12      | 12                  | 0                     | 0                          | none              |
| Discord              | 14      | 14      | 14                  | 0                     | 2                          | none              |
| Contentful           | 14      | 14      | 14                  | 0                     | 0                          | none              |
| Cloudinary           | 14      | 13      | 13                  | 0                     | 0                          | none              |
| Total                | 208     | 196     | 193                 | 3                     | 18                         |                   |

"Detected by package" counts a repository whose own provider is found from a manifest or lockfile, which the selection guarantees, so it measures that the catalog package names and the reader agree (193 of 208: the 12 that stopped at the size limit count as misses, and the three others are Intercom repositories chosen by host). "Deadline exposure" is the repositories in the provider's own sample that match its deadline entry. No sampled repository matched `mailchimp-export-api`, `hubspot-api-v4` or `airtable-user-api-keys`; those matchers are tested on fixtures only, so their recall in real code is not measured.

**Precision**, [`2026-10-22-data-apis-labels.json`](benchmarks/2026-10-22-data-apis-labels.json). Each hit was read in the clone with the code around it. The labels are not blind to the fact that Refit reported the hit.

| Hits                                                                 | Read                                                                                               | Correct                                                                                                        |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Matcher lines (10 Algolia dependencies, 6 Zoom `sdkKey:` properties) | 16 (all)                                                                                           | 16                                                                                                             |
| HTTP requests (`requests`, 15 providers)                             | 72 (all)                                                                                           | 72                                                                                                             |
| Hostname lines (`hostnames`, 15 providers)                           | 40, a seeded sample of the first run's lines (its total of 151 is not in a committed results file) | 22 (55%); 7 of the 18 wrong ones (`res.cloudinary.com`) are no longer reported, so 22 of 33 (67%) at `5bec50d` |

The 18 wrong hostname lines are links, image URLs, an OAuth invite link, CSP allowlists, detector patterns, a test, a mock and vendored SDK files. Cloudinary and Mapbox account for most. This is the reason for `requests`: it left out every one of those 18 in the sample read, but it is also narrower (it needs a client call with a resolvable URL), and recall of `requests` against all real calls is not measured.

**The first run.** The first version of two matchers over-matched, and they were rewritten before the numbers above were taken. The results of that run are kept in `2026-10-22-data-apis-results-first-run.json`: `zoom-meeting-sdk-key` matched every `sdkKey` token (16 lines, only 7 a property), and `airtable-user-api-keys` matched every `apiKey:` in a file using the `airtable` package (40 lines in 11 repositories, 5 read variables named TOKEN or ACCESS_TOKEN, none shown to hold a legacy key, because the package accepts personal access tokens in that property).

## Not verified

- Recall of hostname lines, `requests` and every matcher outside the sample, and any match for the Mailchimp, HubSpot and Airtable entries in real code.
- Whether a repository whose `algoliasearch` is below 5 actually calls the v4-only API (`initIndex`): the deadline is about the package version.
- Provider pages that returned 403, 404 or 429, listed above.
