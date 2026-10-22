# Benchmark claims

Every number Refit publishes should trace to data. `scripts/benchmark-claims.mjs` reads [`benchmarks/claims.json`](benchmarks/claims.json), recomputes each claim it can from committed results, and checks that every number in the covered documents belongs to a claim.

```sh
node scripts/benchmark-claims.mjs            # exit 1 on a claim that differs, a stale quote or an unclaimed number
node scripts/benchmark-claims.mjs --json     # every value with its status
```

## What it covers

| Document | Scope |
|---|---|
| [BENCHMARKS.md](BENCHMARKS.md) | the whole document |
| [DEADLINE-BENCHMARK.md](DEADLINE-BENCHMARK.md) | the whole document |
| [READINESS.md](READINESS.md) | the five latest checkpoints on 2026-10-22, named by heading |
| [PROVIDER-GOALS.md](PROVIDER-GOALS.md) | the OpenAI and Anthropic, Gemini and PayPal progress checklists |
| [SHOPIFY-BENCHMARK.md](SHOPIFY-BENCHMARK.md) | the whole document |
| [STRIPE-BENCHMARK.md](STRIPE-BENCHMARK.md) | the whole document |

Headings and code blocks are skipped. Within the scope, the checker reads every number in prose, lists and tables: counts, percentages, fractions, ranges and money. It does not count numbers that are dates, versions (`x.y.z`, `v25.0`), pull request references, years, or anything inside inline code or a link target.

## How a claim is written

A claim quotes one sentence, list item or table row exactly as the document has it. Runs of whitespace count as one space, so padded tables can be quoted compactly. Every number in the quote is then one of three things:

- **A value with a query.** `says` is the number as written; the query recomputes it from committed files under `docs/benchmarks/`. A count, sum, distinct count, median, mean, maximum, percentile, range, rate, fraction, Wilson interval or a single value is computed over rows selected with conditions (`equals`, `in`, `notIn`, `matches`, `exists`, `nonEmpty`, `includes`, `gt`/`gte`/`lte`, `some`, `any`, `not`, `equalsField`, and `inQuery`, a join on another query's values). The comparison uses the document's own precision: "45%" matches 44.9, and "86–99.5" compares 86 and 99.5 separately.
- **A value that is not checkable,** with the reason, usually that the run it describes left no committed results.
- **An ignored number,** with the reason it is not a claim: a configured limit (120 seconds, 50 MiB), a version in a name (stripe-node 23), an item number, an HTTP status, a target ("at least 90%") or a confidence level ("95% Wilson").

The checker fails when a recomputed value differs from what the document says, when a quote is no longer in its document, or when a covered number belongs to no claim. So a document edit that changes a number fails until its claim is updated.

## Results on 2026-10-22

582 claims cover 1,579 numbers: 1,403 values and 176 ignored numbers that are not claims. The commit this was run at is in the pull request.

| Document | Reproduce | Differ | Not checkable |
|---|---|---|---|
| BENCHMARKS.md | 324 | 3 | 215 |
| DEADLINE-BENCHMARK.md | 74 | 0 | 239 |
| READINESS.md (5 checkpoints) | 29 | 0 | 8 |
| PROVIDER-GOALS.md (3 checklists) | 58 | 0 | 17 |
| SHOPIFY-BENCHMARK.md | 93 | 0 | 88 |
| STRIPE-BENCHMARK.md | 29 | 0 | 226 |
| **All** | **607** | **3** | **793** |

Every covered number is in a claim, so nothing is unaccounted for.

### Claims that do not reproduce

| Document | Says | Recomputed | Why | Replacement |
|---|---|---|---|---|
| BENCHMARKS.md, the coding-agent comparison | a median of 39 s | 37 s | The 17 recorded agent runs in [`2026-10-21-agent-comparison-results.json`](benchmarks/2026-10-21-agent-comparison-results.json) took 22 to 172 s; the 9th of 17 is 37 s, and 39 s is the 10th. | "That is $0.16–1.25 per repository, with a median of 37 s." |
| BENCHMARKS.md, API deadlines on the fresh sets | Shopify, due within 7 days: 29 | 34 | In [`2026-10-16-deadline-fresh-results.json`](benchmarks/2026-10-16-deadline-fresh-results.json), 29 fresh Shopify apps are on `2025-10`, due that day. 6 send a model OpenAI retires on 2026-10-23, 7 days later, and 1 of those is also on `2025-10`, so 5 more apps are due that the row does not count. | "\| Due within 7 days \| 34: 29 on Shopify `2025-10` (due today) and 5 more on OpenAI 2026-10-23 retirements (6 in all) \| 51 (OpenAI 2026-10-23 retirements) \|" |
| BENCHMARKS.md, Meta Graph API requests | the path and edge for 158 | 116 | In [`2026-10-20-meta-graph-call-results.json`](benchmarks/2026-10-20-meta-graph-call-results.json), 158 live calls have a path, but only 116 have an edge, and every call with an edge has a path. | "The version was read for 157 (the other 5 are unversioned), the path for 158, the edge for 116, and `fields` for 113." |

Two checker bugs were fixed before this run, and tests cover both:

- A median of an even count was the lower middle value, so the deadline benchmark's "OpenAI's median is 23 stars" first showed as 22. It is now the mean of the two middle values.
- The two ends of an interval such as "86–99.5" were compared at one precision. The checker's own test found this one.

### What cannot be checked, and what would make it checkable

Most unchecked numbers describe runs whose results were never committed. Committing these files would turn them into checked claims:

| Not committed | Numbers | Would need |
|---|---|---|
| The deadline benchmark's Refit runs (`7bd59f8`, `be587f1`, `0e911e5`) and the loose search | 221 | `before.json`, `after.json`, `classified.json` and `grep.json` from the Reproduce section. The labels are committed, so every label-only count and interval already reproduces. |
| The October 21 active-teams rescan (`cc426fe`) and its `--validate` runs | 36 | Its `results.json`, condensed like the October 16 file |
| The October 20 Shopify runs at `0b5480b`, with the REST call details | 57 | Its condensed rows and REST call counts. The committed tracing run is at `4a99c1e`, before the REST reclassification. |
| The October 16 reruns of the original and held-out sets at `5f94ab4` | 27 | Their condensed rows |
| The October 21 coverage rescan of 10 active-team repositories | 16 | The `benchmark:coverage` output |
| The runs right after the card-only policy (`6d02116`) | 14 | Their condensed rows |
| Deadline dates as the registry stood on 2026-10-15 | 21 | The registry at that date beside the labels; the score script reads today's registry |
| The October 14–15 Stripe runs on the original 100 (`03648a6` and the phase-2 work) | 135 | Their `results.json`. The frozen list and labels are committed, so list and label counts already reproduce. |
| Ground-truth scores (recall and precision against the Stripe labels) | 48 | The scored runs' `results.json`; the score itself is recomputed by `npm run benchmark:stripe-score` |
| The held-out Stripe runs before the card policy | 34 | Their condensed rows |

The rest are judgements from reading code, prose-only records (selection counts kept in a frozen list's `criteria` text), timings and AI spend (kept in each run's ledger outside the repository), and the checklists' own percentages. Each value's reason is in `claims.json`.

A value can be "not checkable" even when committed data agrees with it, because the agreeing data comes from a different run. Where it is known, the reason names the run that agrees. For example, the October 16 fixrate runs also count 234 affected Stripe repositories, but the summary row it backs describes the 0.38.0 run. The checker never reports a value as reproduced from another run's results.

## Keeping claims current

- Change a covered number, and the checker fails on its claim: update `says` and, if needed, the query, or record the new reason it cannot be checked.
- Add a sentence with numbers, and the checker names it as unclaimed. Quote it in a new claim.
- To cover another document, add it to `scope`, run the checker, and claim each line it names.

Reproducing a value means the committed data gives that number. It does not mean the number is the right thing to report, or that the data is right. Labels and hand reviews remain one reviewer's reading, as each benchmark says.

## Proposal: run it in CI

A proposal for OG9, the CI lane. It is not wired in here.

```yaml
  benchmark-claims:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<pinned sha>
      - uses: actions/setup-node@<pinned sha>
        with:
          node-version: 22
      - run: node scripts/benchmark-claims.mjs
```

- **Trigger.** Pull requests that touch `docs/BENCHMARKS.md`, `docs/DEADLINE-BENCHMARK.md`, `docs/READINESS.md`, `docs/PROVIDER-GOALS.md`, `docs/SHOPIFY-BENCHMARK.md`, `docs/STRIPE-BENCHMARK.md`, `docs/benchmarks/**` or `scripts/benchmark-claims.mjs`. It needs no `npm ci`, network or secrets, and runs in about a second.
- **Not required at first.** The three claims above fail until PP10 applies the replacements. Once they pass, make the job required, so a number cannot change without its claim.
- **New checkpoints.** The READINESS scope names five checkpoints. A new checkpoint is not covered until it is added to `scope`. A later step could cover each new checkpoint automatically.
