# evals

Aptitude's benchmark: frozen repo sets, the runner, scoring, hand-checks and an advisory AI
reviewer. Owner: Furqan.

## Quick start

```sh
npm run smoke -w evals
```

Runs one repo from each of three dev sets (Stripe, Shopify, Meta) through the real runner,
scoring, hand-check log and reviewer, with a fake model. It needs no network, clones nothing,
installs nothing and spends $0. Each repo is stood in for by a small synthetic fixture under
`smoke/fixtures/`. It prints `SMOKE OK` or the invariant that broke.

## Repo sets (`sets/`)

Recovered from Refit's git history as data only (`node sets/recover.ts --repo <git dir>`
regenerates them).

| Set                  | Repos | Recovered from                                  |
| -------------------- | ----- | ----------------------------------------------- |
| `shopify-dev-60`     | 60    | `docs/benchmarks/subsets/shopify-dev-60.json`   |
| `meta-dev-60`        | 60    | `docs/benchmarks/subsets/meta-dev-60.json`      |
| `stripe-dev-30`      | 30    | `docs/benchmarks/subsets/dev-30.json`           |
| `stripe-progress-30` | 30    | `docs/benchmarks/subsets/progress-30.json`      |
| `openai-dev-30`      | 30    | `docs/benchmarks/subsets/openai-dev-30.json`    |
| `anthropic-dev-30`   | 30    | `docs/benchmarks/subsets/anthropic-dev-30.json` |
| `gemini-dev-15`      | 15    | `docs/benchmarks/subsets/gemini-dev-15.json`    |

Each file keeps the set's purpose and selection criteria (they describe how Refit chose the
repos) and the repo entries: slug, frozen commit and small metadata. Agents may open, trace and
debug these freely.

One set is curated here rather than recovered:

| Set               | Repos | What it holds                                                                      |
| ----------------- | ----- | ---------------------------------------------------------------------------------- |
| `longtail-dev-20` | 20    | 15 smaller providers, through raw HTTP (11), an SDK (4), webhooks (3), GraphQL (2) |

Each entry names its provider, how the code reaches it, the pending change (kind, date, the
provider's own page and an exact quote) and every call site (file, line and the line's text) at a
pinned default-branch commit. `node evals/sets/check-callsites.ts longtail-dev-20` re-reads each
call site at its commit from GitHub and fails on any line that no longer matches. None of its
providers has a folder in `providers/`, so it runs once an any-provider watcher is passed in (see
the runner).

`sets/catalog.json` lists all 120 repo-set paths in history with their class, the commits that
wrote them and their git blob SHAs:

- **blind** (10): any path containing `holdout`, `heldout`, `held-out` or `blind`.
- **measurement** (5): `openai-100`, `anthropic-100`, `gemini-30`, `2026-10-28-stripe-new-repos`
  and `2026-10-22-deadline-fresh-repos`, which their freeze commits describe as measurement or
  fresh, unused sets.
- **dev** (7): recovered above.
- **legacy** (98): catalogued, not recovered. Several are supersets of a blind set
  (`push-279-affected` contains `heldout-30`), so copying them would leak blind repos.

Blind and measurement sets are sealed: nobody opens them, and evals/ holds only their path,
commits and blob SHAs (from `git ls-tree`, never from reading the file).
`sets/sealed.test.ts` fails if any file in evals/ matches a sealed blob, is named like a blind
set, or holds a repo list outside `sets/dev/`. `sets/recover.ts` refuses to read a sealed path.

## Runner (`runner/`)

understand (inventory) → watch → match → harness (`runTask`) → advisory review, per repo.

```sh
node evals/runner/cli.ts run --set stripe-dev-30 --budget-usd 5 --concurrency 2 [--shard 3] [--watch-cache dir]
node evals/runner/cli.ts watch --set stripe-dev-30 --budget-usd 1.5 --watch-cache dir
node evals/runner/cli.ts matrix --set stripe-dev-30 --budget-usd 120
node evals/runner/cli.ts score --in evals/results --report report.md
```

- `--budget-usd` and `--concurrency` are required and have no defaults; the runner refuses to
  start without them. The cap is a hard limit: past it, no new repo or task starts, and what's
  left is reported as unrun (not as an attempt).
- A part the run can't afford is unrun, never an attempt bug. Since #469 a task needs
  `MIN_TASK_USD` ($2) of the run free; the runner checks that before it starts a task (and reads
  the orchestrator's "not attempted" record the same way), marks that task and the repo's later
  ones unrun, and goes on to the next repo, whose inventory and match may still fit. When the run
  budget refuses an inventory or a match, no new repo starts.
- Tasks run most urgent first (priority 1 is the match agent's top task), and matching uses the
  loop's batches of 50 changes.
- `run` loads the real modules through the orchestrator's `createDeps` (`inventory/`, the match
  agent, `harness/`, `providers/`) under one run budget. Each run writes
  `<out>/<set>/run-summary.json` with the meter's and the run budget's spend and the cost by
  part.
- **Providers with no folder in `providers/`** (the Anthropic, Gemini and long-tail sets) need a
  watcher passed in: `loadRealPipeline(cap, { watchAny })` takes F4's `anyProviderWatcher`
  (`providers/core/any-watcher.ts`), holds `WATCH_USD` of the run while it reads, gives it the
  hints the inventory found for that provider, and caches the read for the UTC day under the
  loop's key. Until F4 merges, `cli.ts` passes none and those repos stop before any spend; after
  it merges, wiring it is the one `watchAny` line in `cli.ts`.
- The meta set's provider is `meta`, the folder's id (it was recovered as `meta-graph`).
- Working copies are shallow fetches of the frozen commit with hooks and submodules off. Repo
  code only ever runs inside the harness's sandbox.
- `workflows/benchmark.yml` runs one repo per GitHub Actions shard, with `concurrency` as
  `max-parallel`. Each shard is its own process, so a `watch` job first reads each of the set's
  providers once (`WATCH_USD` each, from the cap) and hands its cache to every shard
  (`--watch-cache`, same UTC day); the rest of the cap is split evenly across the shards. `matrix`
  refuses a cap whose shards would get less than `MIN_TASK_USD`, since no task could start. In the
  first benchmark a repo spent $0.17 to $0.66 on inventory and matching before its first task, so
  give a shard at least about $3. **A founder moves it to `.github/workflows/`**; it is not active
  from here.

## Scoring (`scoring/`)

- Rates of **verified**, **needs-review**, **not-affected** (and failed) over graded units: every
  task the agent ran, plus each repo the match agent found no task in.
- Repo-level outcomes, cost per repo and total cost, and the **cost by part** (inventory, watch,
  match, harness, review) per repo and in total, from the meter's labels. A provider's watch is
  read once per run (and cached for the UTC day), so its cost lands on the first repo.
- **Attempted rate**, which must be 100%. A task counts as attempted when it produced a diff or
  an explicit not-affected verdict. A throw, or a needs-review or failed with an empty diff, is
  listed as a bug, and `score` exits non-zero.
- **Hand-check log** (`evals/reviews.json`): `score` adds a pending entry for every verified and
  needs-review PR (with the files its diff touches) and never edits existing ones. A person reads
  the diff and sets `handCheck.status` to `agree` or `disagree` with the grade, `wouldMerge`
  (`yes`, `with-edits` or `no`), `reviewer`, `checkedAt` and `notes`. Read no rate without it.
  `score` writes plain JSON, so run `npm run format` before committing the log.

## AI reviewer (`reviewer/`)

A second opinion on each PR: does the diff handle the change at every call site, what behaviour
changes, what the checks don't prove, and whether the grade matches the checks. It is advisory:
its opinion is stored next to the grade and copied into the hand-check entry, and scoring never
reads it. A reviewer failure is recorded as `unavailable` and never affects the task.

The model client is injected. Tests and the smoke run use `FakeModelClient`. Real runs use
`anthropicModelClient` (`reviewer/model.ts`): the Messages API on `claude-opus-5-5` at medium
effort, with structured outputs for the reply's JSON. Every call holds its worst case (each input
token plus a full `maxTokens` of output) against the run budget that every other part holds
against, settles to what the API reports, and is refused before any request when the run can't
cover it; the review's cost is charged to the repo's meter. While a task runs, the runner sets the
review's worst case aside when the task can spare it, so the PR still gets its second opinion; an
empty diff gets no review. A refusal from the model is kept as an unsure review.

## Reports (`reports/`)

`reports/<date>.md` is a benchmark's write-up: rates, cost per repo and by part, the hand-checks
and what failed and why. `reports/<date>/` holds that run's result files (one per repo, plus
`run-summary.json`), so `node evals/runner/cli.ts score --in evals/reports/<date>` reproduces its
numbers.

## What's stubbed

- Changelog watchers exist only for providers with a folder in `providers/`. Repos in the
  Anthropic, Gemini and long-tail sets stop before any spend until F4's `anyProviderWatcher` is
  passed to the runner (the `watchAny` line in `runner/cli.ts`). Real runs otherwise go through
  the orchestrator's `createDeps`, under one run budget, and need `ANTHROPIC_API_KEY` and
  `APTITUDE_AI_BUDGET_USD`.
- PRs: the runner grades what the harness returns and never opens a PR, so `pr` is empty in
  benchmark records. The hand-check reads the diff and the PR body the harness wrote.
