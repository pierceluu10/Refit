# Meta Graph change table

Meta publishes no machine-readable contract, only prose changelogs. So for Meta, `data/meta-graph/changes.json` plays the part an OpenAPI diff plays for Stripe: a versioned list of what each change removes or changes, with the passage of Meta's changelog that states it. `data/rules/meta-graph/` holds a rule for every change whose changelog names a replacement.

Built on 2026-10-29. No benchmark was run.

## Sources

`node scripts/meta-graph-pages.mjs` saves each page as a documentation snapshot in `docs/benchmarks/meta-graph-changelog/pages/`. It uses the Markdown view where Meta serves one. The list of pages is `META_PAGE_SOURCES` in `pipeline/meta-graph-rules.ts`:

- the Graph API changelog for v10.0 to v26.0, and its index;
- the Marketing API changelog for v18.0 to v26.0 (before v18.0, the Graph API page carries the Marketing API section);
- the Graph API out-of-cycle changes since 2021, 27 dated pages;
- the Instagram Platform, WhatsApp Business Platform (including the Cloud API) and Messenger Platform changelogs.

v10.0 (February 2021) is the oldest version that benchmark repositories pin. v26.0 is the latest: v27.0 returned 404 on 2026-10-29.

## How entries were made

Each step can be rerun.

1. **Mine.** Every page was read for changes that can break an existing integration. One entry per name, each with a verbatim quote.
   - `scripts/meta-graph-mine.mjs` does this with OpenAI (`OPENAI_API_KEY`, `OPENAI_MODEL`, capped by `REFIT_AI_BUDGET_USD`).
   - **On 2026-10-29 the OpenAI key was not available to this session,** so the same brief ran through separate agents instead. Eight agents found 1,011 candidates; the same agents also quoted the 281 entries written by hand on 2026-10-20.
2. **Verify.** A second, independent pass judged every candidate against its page: the kind, the version or all-versions date, the name and the replacement. It refused 82 candidates. The most common reasons:
   - wrong or undated versions, such as the 15 January 19, 2021 iOS 14 changes, whose date depends on Apple;
   - additions or relaxations rather than breaking changes;
   - the 12 WhatsApp On-Premises client-version entries, which are not Graph versions;
   - names the text does not print (`objective` for "objectives", `timeframe` for "timeframes"), delayed changes and wrong replacements.
3. **Check by rule.** `scripts/meta-graph-merge.mjs` keeps a candidate only when all of these hold:
   - the second pass supported it;
   - its quote is in the saved page (whitespace aside);
   - the quote names the entry's name and replacement (`_`, `-` and spaces count as the same);
   - its version is v10.0 to v26.0.
     Duplicates of an entry already in the table, or found on two pages, are dropped. The merge then writes the table and the rules.
4. **`refit rules check`** repeats step 3's quote check on every change and rule, and fails if a change that names a replacement has no rule.

Two entries written by hand named a parameter the page never prints. They were rewritten to what the page states:

- `creative_features_spec` became the v22.0 `adcreatives` edge change for `STANDARD_ENHANCEMENTS`.
- The v24.0 `/search` `type` parameter became an `endpoint-changed` change on `/search`. It no longer stops WhatsApp requests that send a `type` field, the over-stop [META-PLATFORM-CHANGELOGS.md](META-PLATFORM-CHANGELOGS.md) raised.

## Entry shape

Each change has these fields:

- `version`: the Graph API version it applies from. `null` means it applies to every version from `appliesToAll`, so no version move crosses it.
- `appliesToAll`: the date it applies to every version, when Meta gives one.
- `node`, `edge`, `path`: where the change applies.
- `name`: the field, metric, breakdown, parameter, webhook field, error code, permission or product.
- `replacement`: what the changelog says to use instead.
- `summary`.
- `quote`.
- `source`.
- `checkedAt`.

Each version record adds `released`, the date its page prints.

Kinds:

- the original nine:
  - `endpoint-removed`
  - `edge-removed` and `edge-changed`
  - `field-removed` and `field-changed`
  - `metric-removed` and `metric-changed`
  - `parameter-removed` and `parameter-changed`
- `endpoint-changed`
- `product-removed`
- `parameter-required`
- `breakdown-removed`
- `webhook-field-removed` and `webhook-field-changed`
- `error-changed`
- `permission-changed`

How `refit meta-graph --propose-version-moves` uses each kind (`changesUsedBy`):

- **Stops a move on a match:**
  - endpoint, required-parameter, error and permission changes, when a request uses their edge or path;
  - breakdown removals, for insights requests that send breakdowns.
- **Never stop a move; they are alerts:**
  - webhook changes follow the app's webhook version, not the request's;
  - product shutdowns name no path.

## Rules

A rule has the same provenance fields as `data/rules/stripe`: `source`, `quote`, `checkedAt`, `status` and `origin`. It points at its change with `change` and states `from` and `to`. Every rule is `review` and nothing applies it yet; tracing and fixes (ME3) consume them. There are two families:

- **`<kind>-replacement` (85):** one identifier for another, such as `instagram_actor_id` to `instagram_user_id`, `potential_reach` to `estimated_audience_size`, the 40 renamed Conversion Lift and Page metrics, and error `2` to `200`.
- **`<kind>-migration` (20):** the replacement is a product, a pair of fields or an endpoint, so it needs a plan, not a rename. Examples: `audience_size` to `audience_size_lower_bound and audience_size_upper_bound`, and Instagram Basic Display to the Instagram API.

## Coverage on 2026-10-29

|                                              |                                                                                  Count |
| -------------------------------------------- | -------------------------------------------------------------------------------------: |
| Candidates mined                             |                                                                                  1,011 |
| Refused by the second pass or the rule check |                                                                                     83 |
| Changes in the table                         |                            805 (281 written by hand on 2026-10-20 and quoted, 524 new) |
| Rules (documented replacement)               |                                                     105 (85 replacement, 20 migration) |
| Alert-only (no replacement)                  | 700, each dated: 310 by an all-versions date, the rest by their version's release date |
| Alert-only still ahead                       |                                                          1 (v21.0 removal, 2027-01-21) |

By source:

| Source                       | Changes |
| ---------------------------- | ------: |
| Graph API version pages      |     580 |
| Graph API out-of-cycle pages |     130 |
| WhatsApp Business Platform   |      48 |
| Instagram Platform           |      24 |
| Messenger Platform           |      16 |
| Marketing API pages          |       7 |

The Marketing API and Instagram pages mostly repeat entries already on the Graph API pages, so most of their candidates were dropped as duplicates.

By kind:

| Kind                    | Changes |
| ----------------------- | ------: |
| `metric-removed`        |     236 |
| `edge-changed`          |     110 |
| `parameter-changed`     |      91 |
| `edge-removed`          |      78 |
| `field-removed`         |      73 |
| `field-changed`         |      47 |
| `metric-changed`        |      45 |
| `endpoint-removed`      |      27 |
| `error-changed`         |      24 |
| `permission-changed`    |      23 |
| `parameter-removed`     |      17 |
| `product-removed`       |      14 |
| `parameter-required`    |       8 |
| `webhook-field-changed` |       5 |
| `endpoint-changed`      |       5 |
| `webhook-field-removed` |       2 |

### Unmapped

- **The 83 refused candidates.** The merge writes them, with reasons, to `refused.json` beside its input.
- **Marketing API out-of-cycle changes.** The saved page only links to dated subpages, which were not captured.
- **WhatsApp On-Premises client versions (v2.39 to v2.45).** The table has no field for a client version, so these stay out.
- **No On-Premises shutdown entry.** The saved WhatsApp changelog starts in October 2021 and has no shutdown entry.
- **No breakdown deprecations.** No page stated one, so no `breakdown-removed` entry exists. The kind is ready for one.
- **Changes the pages never name.** Some entries use a printed prose name ("Handover Protocol", "TLS"), so they never match a request; they still alert.

## Deadlines

`data/deadlines.json` keeps its Meta version entries for v13.0 to v25.0, synced from the changelog index; v26.0 has no end date.

- **v10.0 and v11.0** print end dates on their own pages: June 8, 2023 and September 14, 2023. They are not added, because the deadline sync reads the index, which no longer lists them, and both ended years ago.
- **Marketing API v24.0** has two end dates. The Graph API index says October 6, 2026; the Marketing API v24.0 page says November 10, 2026. No entry is added until Meta's pages agree.

## Open owner decisions

- **WhatsApp and Messenger requests still stop every move** (`separateChangelog` in `pipeline/meta-graph-moves.ts`), although their changelogs are now in the table. Letting the move rule use them widens it, which needs an owner decision.
- **Mined-by-agent provenance.** Stripe's generated rules record the model and response ID. These record `origin: "mined"` and rely on the quote check. Rerunning `scripts/meta-graph-mine.mjs` with the OpenAI key would add a model-recorded pass.
