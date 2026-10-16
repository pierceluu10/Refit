# Deadline exposure benchmark

This measures how many active public JavaScript/TypeScript repositories depend on an API version or model in Refit's [deadline registry](DEADLINES.md), and how accurate `refit deadlines` is on them.

- **Sample:** 100 repositories drawn from GitHub code search, balanced across OpenAI, Meta Graph API and Shopify.
- **Labels:** 32 repositories were hand-labelled line by line (274 lines). The OpenAI 2026-10-23 shutdown was judged for all 34 OpenAI repositories.
- **Runs:** Refit `7bd59f8` (v0.36.0, "before") and the matcher fix in this change ("after").
- **Safety:** no repository code was installed or run, no vendor API was called, and no scanned repository was contacted.

It extends the 20-repository [pilot](benchmarks/DEADLINE-PILOT.md), whose draw is the first 20 of these 100.

## Summary

- **Most of the active repositories these searches find are really exposed.** 28 of 32 labelled repositories (88%, 95% CI 72–95%) have a live call path that pins a registry version or model. 17 of the 28 are already past the date.
- **OpenAI's 2026-10-23 shutdown:** 15 of the 34 sampled OpenAI repositories (44%, 29–61%) send one of the models OpenAI retires that day from a live call path. The models include `gpt-3.5-turbo`, `gpt-4`, `gpt-4-turbo`, `o1`, `o3-mini` and `o4-mini`.
- **Refit finds the exposed repositories:**
  - **Repository recall:** 28/28 (88–100%) after this change.
  - **Repository precision:** 28/31 (75–97%).
- **Line-level evidence is noisy for OpenAI:**
  - **OpenAI:** only 14% of reported lines are live pins. The rest are mostly model lists, tests and examples.
  - **Meta and Shopify:** 100% and 79% of reported lines are live pins.

## Method

1. **Frame.** The frame is ten `gh search code` queries, keeping the first 100 hits of each. The queries and hits are in [`benchmarks/2026-10-15-deadline-frame.json`](benchmarks/2026-10-15-deadline-frame.json):

   | Provider | Queries | Repositories |
   |---|---|---|
   | OpenAI | `"gpt-3.5-turbo"` in TS and JS, `"gpt-4-turbo"` in TS, `o1-mini` in TS | 331 |
   | Meta | `graph.facebook.com/v18.0` in TS, `/v19.0` in JS, `/v20.0` in TS | 274 |
   | Shopify | `admin/api/2025-07` in TS, `admin/api/2025-10` in TS and JS | 135 |

2. **Draw.** Each provider's repositories are sorted, then shuffled with a seeded mulberry32 (`refit-deadlines-2026-10-15:<provider>`). Repositories are taken in that order until 34 OpenAI, 33 Meta and 33 Shopify pass the filters:
   - not archived and not a fork;
   - pushed since 2024-01-01;
   - under 50 MB;
   - has a `package.json`.

   140 were examined and 40 were rejected: 21 too large, 12 stale and 7 without a `package.json`. Repositories and commits are pinned in [`benchmarks/2026-10-16-deadline-repos.json`](benchmarks/2026-10-16-deadline-repos.json).
3. **Scan.** Each repository is shallow-cloned at its pinned commit, then `refit deadlines --json` runs from a pinned Refit worktree. One repository, `ozzyonfire/shopify-next-app`, exceeds Refit's scan limits (10,000 files or 50 MiB) and counts as not flagged.
4. **Labels.** The labelled subset is the first 11 OpenAI, 11 Meta and 10 Shopify repositories in the seeded order, so it is a random subsample. Every line was read in context, from three sources: either run's evidence, plus an independent loose search (below). Each line got one of four labels:
   - **live:** a real pin in a live call path, including defaults and env-var fallbacks;
   - **option:** one entry in a model list, type union, pricing table or codegen config;
   - **test-docs:** tests, examples, comments, help text or dev scripts;
   - **false-positive:** the string does not select the provider's version or model.

   Labels are in [`benchmarks/2026-10-16-deadline-labels.json`](benchmarks/2026-10-16-deadline-labels.json). For the 23 unlabelled OpenAI repositories, one witness line or a reason decides whether a live path uses a 2026-10-23 model.
5. **Recall.** `scripts/deadline-benchmark-grep.mjs` searches every JS/TS file for registry versions and models, quoted or not, in code or comments, plus Shopify date strings on lines mentioning a version. Live lines it finds that Refit does not list are misses. Recall is relative to this search. Values built at runtime and pins in `.env`, YAML or other languages are out of reach for both.

**What the rates estimate:** the share of active repositories *that GitHub code search returns for these strings*, not of all JS/TS repositories. Code search ranks by best match, returns 100 hits per query, and the strings were picked because they are common.

Intervals are 95% Wilson. "Active" only means pushed since 2024. The repositories are small:

- OpenAI's median is 23 stars; Meta's and Shopify's median is 0 (24 of 33 and 29 of 33 have none).
- Exposure stays high in the more active part of the sample: 16 of the 17 labelled repositories pushed in 2026 are exposed, and so are all 6 pushed since July 15.

## Results

### Exposure (labelled subset)

| | All | OpenAI | Meta | Shopify |
|---|---|---|---|---|
| **Truly exposed** (≥1 live pin) | **28/32, 88%** (72–95) | 8/11, 73% (43–90) | 11/11 (74–100) | 9/10, 90% (60–98) |
| Exposed, counting model lists | 31/32, 97% (84–99) | 11/11 | 11/11 | 9/10 |

**Timing:** each exposed repository is placed by its most urgent live deadline, as of 2026-10-15.

| Past due | 0–7 days | 8–30 days | 31–90 days | Later |
|---|---|---|---|---|
| **17** | 5 | 4 | 0 | 2 |

- **Past due:**
  - 11 Meta repositories on v13.0–v20.0;
  - 4 Shopify repositories on 2025-04 or 2025-07;
  - 2 OpenAI repositories on `gpt-3.5-turbo-instruct` and `gpt-5-chat-latest`.
- **0–7 days:** Shopify 2025-10, which stops being accessible on 2026-10-16.
- **8–30 days:** OpenAI `gpt-3.5-turbo` on 2026-10-23.
- **Later:** `whisper-1` (2027-02-26).

Over all 97 repositories Refit flags, by the most urgent *flagged* deadline (an upper bound, since not every flag is live): 63 past due, 16 in 0–7 days, 17 in 8–30 days, 0 in 31–90 days, 1 later.

**"Past due" does not mean the same thing for every provider:**

- **OpenAI:** a shut-down model stops serving requests.
- **Meta:** calls to a retired Graph API version "will be defaulted to the next oldest, usable version" ([versioning](https://developers.facebook.com/docs/graph-api/guides/versioning)).
- **Shopify:** it "falls forward" to the oldest supported version ([versioning](https://shopify.dev/docs/api/usage/versioning)).

So Meta and Shopify exposure means behavior silently changed underneath the code, not an outage.

### OpenAI shutdown on 2026-10-23

| | Repositories |
|---|---|
| OpenAI repositories in the sample | 34 |
| Flagged by Refit for a 2026-10-23 model | 31 |
| **Live call path uses a 2026-10-23 model** | **15/34, 44%** (29–61) |
| Precision of the 2026-10-23 flag | 15/31, 48% (32–65) |

The 15 use the model as a hard-coded call argument, a default setting, a CLI default or an env-var fallback (`process.env.MODEL || "gpt-3.5-turbo"`). The 16 flagged repositories that are not exposed have the models only in:

- picker lists and type unions;
- pricing or context-window tables;
- library catalogs, tests and examples.

One flag is a `gpt-3.5-turbo` default sent to T-Systems' OpenAI-compatible endpoint, not OpenAI.

### Accuracy before and after the matcher fix (labelled subset)

| | Before (`7bd59f8`) | After |
|---|---|---|
| **Repository precision** | 26/30, 87% (70–95) | **28/31, 90%** (75–97) |
| **Repository recall** | 26/28, 93% (77–98) | **28/28, 100%** (88–100) |
| Repository × deadline recall | 35/37, 95% (82–99) | 36/37, 97% (86–99.5) |
| **Line precision** | 79/211, 37% (31–44) | **81/199, 41%** (34–48) |
| Line recall | 94/107, 88% (80–93) | 96/107, 90% (82–94) |
| Reported lines: live / option / test-docs / false-positive | 79 / 85 / 44 / 3 | 81 / 85 / 33 / 0 |
| Flagged, all 100 | 94 | 97 |

| After, by provider | OpenAI | Meta | Shopify |
|---|---|---|---|
| Repository precision | 8/11 (43–90) | 11/11 (74–100) | 9/9 (70–100) |
| Line precision | 19/133, **14%** (9–21) | 47/47, **100%** (92–100) | 15/19, 79% (57–92) |
| Line recall | 19/19 (83–100) | 62/63, 98% (92–100) | 15/25, **60%** (41–77) |

Lines past the 20-line evidence cap count as found when Refit reports their deadline: 15 Graph API calls in one repository.

## What the fix changed

Covered by tests in `pipeline/deadlines.test.ts`:

- **Comments no longer count.** [DEADLINES.md](DEADLINES.md) already said a model named only in a comment does not count. The quoted-string and URL patterns still matched inside comments, such as a JSDoc `e.g. "gpt-4"` or a commented-out fetch. The matcher now parses the file and counts a version only inside a source token. This removed 11 test-docs lines. One Shopify repository was flagged only by a commented-out fetch, and it is no longer flagged.
- **Tokenizer and prefix checks are not pins.** A string argument of `encoding_for_model`, `encodingForModel`, `startsWith`, `endsWith`, `includes` or `indexOf` no longer counts. This removed all 3 false positives.
- **Shopify URLs that end at the version match.** `` baseURL: `https://${shop}/admin/api/2025-07` `` was missed because the pattern needed a `/` after the version. This added 2 repositories (recall 77% to 100% on Shopify).

No safety gate changed. Alerts, registry validation and the rule that unsourced entries are never matched are untouched.

One side effect: `shreevalikushe/facebook-test` was matched for Graph API v20.0 only through a commented-out URL. Its real pin is `FB.init({ version: 'v20.0' })`, which Refit does not read. After the fix the repository is still flagged (for v21.0), but its v20.0 deadline is the one repository-and-deadline miss.

## Remaining noise and gaps

1. **Model catalogs: 85 of 199 reported lines, almost all OpenAI.** These are picker lists, type unions, pricing tables and SDK-wrapper catalogs. They name a dead model a user can still pick, so they are reported, not dropped. Separating them from live pins, for example as a separate evidence kind, is a product decision and is not made here.
2. **Tests, examples and dev scripts: 33 lines.** They are still reported.
3. **Recall gaps:**
   - Shopify version constants and env-var fallbacks are not read, such as `SHOPIFY_API_VERSION = '2025-07'` and `process.env.SHOPIFY_ADMIN_API_VERSION || '2025-10'`. They cause 10 of the 11 missed live lines, 9 of them in one repository. Each of those repositories is still flagged through another line.
   - The Meta JS SDK's `FB.init({ version })` is not read.
4. **Registry coverage.** The loose search finds Shopify versions older than the registry's 2025-04 in 10 of 33 Shopify repositories: 2023-10, 2024-01, 2024-10 and 2025-01. Those lines are unlabelled. In the labelled `fahadazhar1/alchemy-stock-flow`, live calls use 2024-01 and 2024-10. `fayez-nazzal/TestGPT` defaults to `gpt-3.5-turbo-16k`, which is not in the registry.
5. **OpenAI-compatible endpoints.** A model ID sent to another provider's OpenAI-compatible API, such as T-Systems' LLM hub, matches an OpenAI deadline it may not have.

## Limits

- The labels were made by Claude in one pass and have not been checked by a second labeller. Furqan is the intended second labeller. Until then, treat the labels as one reviewer's reading.
- The frame is code-search hits for common strings. These rates do not generalize to all repositories, and they likely overstate exposure compared with a random sample of active repositories.
- Recall is measured against a deliberately loose string search, not against the full set of runtime values. Pins in non-JS files are out of scope for both.
- 32 labelled repositories give wide per-provider intervals. Small cells, such as Shopify line recall, are dominated by single repositories.

## Reproduce

```sh
# Rebuild the clones at the pinned commits and scan them with pinned Refit checkouts.
git worktree add --detach <before> 7bd59f8 && git worktree add --detach <after> be587f1
# (each worktree needs `npm ci`)
node scripts/deadline-benchmark-setup.mjs --root <dir> --refit <before> --output before.json
node scripts/deadline-benchmark-setup.mjs --root <dir> --refit <after> --output after.json
node scripts/deadline-benchmark-grep.mjs --root <dir>
node scripts/deadline-benchmark-score.mjs --root <dir>
```

The draw itself:

```sh
node scripts/deadline-benchmark-sample.mjs --frame docs/benchmarks/2026-10-15-deadline-frame.json \
  --per openai=34,meta-graph=33,shopify=33 --output <new>.json
```

With the saved frame and seed, this gives the same order. The repositories that pass the filters can drift as they change on GitHub, which is why the drawn list and commits are pinned.

## Public summary (draft for Furqan)

> spent today checking whether refit's api deadline tracker finds real stuff. pulled 100 active js/ts repos from github code search that mention openai models, meta graph api versions or shopify admin api versions, hand-labelled 32 of them line by line.
>
> 28 of 32 (88%, ci 72 to 95%) actually call a version or model with a published sunset. 17 of those are already past it. meta and shopify keep answering on old versions but quietly bump you to a newer one, openai just stops.
>
> openai shuts down gpt-3.5-turbo, gpt-4, o1, o3-mini and a bunch more on oct 23. 15 of the 34 openai repos i sampled still send one of those from a live code path.
>
> refit caught all 28 exposed repos, but for openai only 14% of the lines it points at are real calls. the rest are model dropdowns, pricing tables and tests. fixed the comment and tokenizer false positives today, the dropdown problem is next.
>
> caveat: these are repos code search surfaces for those strings, mostly small projects, so it's not "x% of github". labels are one pass so far.
