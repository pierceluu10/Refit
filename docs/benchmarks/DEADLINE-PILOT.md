# Deadline exposure pilot (October 15, 2026)

A 20-repository pilot, run before deciding on a full benchmark. It asks two questions about `refit deadlines`. Do active public JavaScript/TypeScript repositories really pin a version or model from [the registry](../DEADLINES.md)? And how accurate is Refit's evidence on them? No repository code was installed or run, and no vendor API was called.

## Method

- **Frame:** 10 GitHub code searches (`gh search code`, first 100 hits each), saved in [`2026-10-15-deadline-frame.json`](2026-10-15-deadline-frame.json):
  - **OpenAI:** `"gpt-3.5-turbo"` in TS and JS, `"gpt-4-turbo"` in TS, `o1-mini` in TS (331 repositories).
  - **Meta:** `graph.facebook.com/v18.0` in TS, `/v19.0` in JS, `/v20.0` in TS (274).
  - **Shopify:** `admin/api/2025-07` in TS, `admin/api/2025-10` in TS and JS (135).
- **Draw:** each provider's repositories are sorted, then shuffled with a seeded mulberry32 (`refit-deadlines-2026-10-15:<provider>`). Repositories are taken in order until 7 OpenAI, 7 Meta and 6 Shopify pass the filters: not archived, not a fork, pushed since 2024-01-01, under 50 MB, and has a `package.json`. 31 were examined and 11 rejected: 3 stale, 6 too large, 2 without a `package.json`. Commits are pinned in [`2026-10-15-deadline-pilot-repos.json`](2026-10-15-deadline-pilot-repos.json).
- **Scan:** shallow clone at the pinned commit, then `refit deadlines --json` (Refit `7bd59f8`, v0.36.0).
- **Labels:** every reported `file:line` was read in context and given one of four labels:
  - **live:** a real pin in a live call path;
  - **option:** one entry in a model list, type union or config;
  - **test-docs:** tests, examples, comments or dev scripts;
  - **false-positive:** the string does not select a provider version or model.

  Labels are in [`2026-10-15-deadline-pilot-labels.json`](2026-10-15-deadline-pilot-labels.json). Claude did them in one pass, and they have not been second-labelled. Each repository's search-hit files were also grepped by hand for pins that Refit missed.

Intervals are 95% Wilson. The estimand is **the share of active repositories found by these searches**, not of all JS/TS repositories. Code search ranks by best match and returns at most 100 hits per query, so the frame is not a uniform sample of GitHub.

## Results

| | All (n=20) | OpenAI (7) | Meta (7) | Shopify (6) |
|---|---|---|---|---|
| **Truly exposed** (≥1 live pin) | **16/20, 80%** (58–92%) | 4/7 (25–84%) | 7/7 (65–100%) | 5/6 (44–97%) |
| Exposed, counting model lists | 19/20, 95% (76–99%) | 7/7 | 7/7 | 5/6 |
| Flagged by Refit | 19/20 | 7/7 | 7/7 | 5/6 |
| **Repository precision** (flagged and truly exposed) | **15/19, 79%** (57–92%) | 4/7 | 7/7 | 4/5 |
| Repository recall | 15/16, 94% (72–99%) | 4/4 | 7/7 | 4/5 |
| **Line precision** (live lines / reported lines) | **78/199, 39%** (33–46%) | 15/132, 11% (7–18%) | 57/58, 98% (91–100%) | 6/9, 67% (35–88%) |

The line counts include 15 matches that Refit counted past its 20-evidence cap but did not list. All 15 are Graph API calls in one repository. Without them, line precision is 63/184 (34%).

**Timing of the 15 flagged, exposed repositories,** by each one's most urgent live deadline as of 2026-10-15:

| Bucket | Repos | What |
|---|---|---|
| Past due | 10 | Meta v13.0–v19.0 (6), Shopify 2025-07 (2), OpenAI `gpt-3.5-turbo-instruct` and `gpt-5-chat-latest` (2) |
| 0–7 days | 2 | Shopify 2025-10, which stops on 2026-10-16 |
| 8–30 days | 2 | OpenAI `gpt-3.5-turbo`, which shuts down on **2026-10-23** |
| Later | 1 | Meta v21.0 |

"Past due" means different things for different providers. An OpenAI model past its shutdown date stops serving requests. Retired Meta and Shopify versions keep answering, but on a newer version:

- Meta: calls "will be defaulted to the next oldest, usable version" ([versioning](https://developers.facebook.com/docs/graph-api/guides/versioning)).
- Shopify "falls forward" to the oldest supported version ([versioning](https://shopify.dev/docs/api/usage/versioning)).

So Meta and Shopify exposure means behavior has silently changed. It does not mean an outage.

## Noise sources

1. **Model catalogs (75 of 199 lines, all OpenAI).** These are libraries' supported-model lists, picker UIs and type unions. Two SDK-wrapper libraries (`chinmaymk/aikit`, `upstash/rag-chat`) produce 93 of OpenAI's 132 lines without any live pin. This is why OpenAI line precision is 11%.
2. **Tests and examples (31 lines).**
3. **Comments (11 lines).** Examples are JSDoc `e.g. "gpt-3.5-turbo"`, commented-out URLs and commented-out alternatives. [DEADLINES.md](../DEADLINES.md) says comments do not count, but the quoted-string and URL patterns match inside comments. One Shopify repository was flagged *only* by a commented-out fetch.
4. **Tokenizers and prefixes (3 lines):** `encoding_for_model('gpt-3.5-turbo')`, and `startsWith('o1')`.

## Gaps found

- **Recall miss:** in `toolstr/shopify-seeder`, `` baseURL: `https://${shop}/admin/api/2025-07` `` was missed because the matcher needs a `/` after the version.
- **Registry coverage:** `fahadazhar1/alchemy-stock-flow` also makes live calls on Shopify `2024-01` and `2024-10`, which are long unsupported but not in the registry (it starts at 2025-04). Versions held in constants (`GQL_VERSION`) are invisible.
- **Sample character:** the sample is mostly small personal projects. 12 of 20 have 0–1 stars: all 6 Shopify repositories and 6 of the 7 Meta ones. "Active" here only means pushed since 2024.

## Verdict

Real signal exists. Meta and Shopify pins are nearly always live calls (98% and 67% line precision), and 80% of the active repositories these searches find are truly exposed, 10 of them already past due. OpenAI detection needs work. At the repository level, 3 of the 7 flagged OpenAI repositories have only model lists, tests or comments, and most OpenAI lines are noise. A full benchmark should:

- sample beyond 0-star repositories;
- fix the comment and Shopify-URL matcher bugs;
- estimate recall from the raw strings;
- add a second labeller.

## Reproduce

```sh
node scripts/deadline-benchmark-sample.mjs --frame docs/benchmarks/2026-10-15-deadline-frame.json \
  --output <new>.json   # with the saved frame, gives the same draw except for later repository changes
node scripts/deadline-benchmark-setup.mjs --root <new-dir>
node scripts/deadline-benchmark-score.mjs --results <new-dir>/results.json
```

The setup script clones at the pinned commits and runs `refit deadlines --json`. The scoring script reads the pinned labels and reports Wilson intervals and timing as of `--as-of` (default 2026-10-15).
