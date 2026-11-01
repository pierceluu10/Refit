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
node evals/runner/cli.ts run --set stripe-dev-30 --budget-usd 5 --concurrency 2 [--shard 3]
node evals/runner/cli.ts matrix --set stripe-dev-30 --budget-usd 40
node evals/runner/cli.ts score --in evals/results --report report.md
```

- `--budget-usd` and `--concurrency` are required and have no defaults; the runner refuses to
  start without them. The cap is a hard limit: past it, no new repo or task starts, and what's
  left is reported as unrun (not as an attempt).
- `run` loads the real modules (`inventory/`, `orchestrator/` match, `harness/`,
  `providers/`) and stops before any spend if one hasn't merged yet. See `runner/real.ts` for
  the export names it expects.
- Working copies are shallow fetches of the frozen commit with hooks and submodules off. Repo
  code only ever runs inside the harness's sandbox.
- `workflows/benchmark.yml` runs one repo per GitHub Actions shard, with `concurrency` as
  `max-parallel` and the cap split evenly across shards. **A founder moves it to
  `.github/workflows/`**; it is not active from here.

## Scoring (`scoring/`)

- Rates of **verified**, **needs-review**, **not-affected** (and failed) over graded units: every
  task the agent ran, plus each repo the match agent found no task in.
- Repo-level outcomes, cost per repo and total cost.
- **Attempted rate**, which must be 100%. A task counts as attempted when it produced a diff or
  an explicit not-affected verdict. A throw, or a needs-review or failed with an empty diff, is
  listed as a bug, and `score` exits non-zero.
- **Hand-check log** (`evals/reviews.json`): `score` adds a pending entry for every verified PR
  and never edits existing ones. A person reads the PR and sets `handCheck.status` to `agree` or
  `disagree`, with `reviewer`, `checkedAt` and `notes`. Read no verified rate without it.

## AI reviewer (`reviewer/`)

A second opinion on each PR: does the diff handle the change at every call site, what behaviour
changes, what the checks don't prove, and whether the grade matches the checks. It is advisory:
its opinion is stored next to the grade and copied into the hand-check entry, and scoring never
reads it. A reviewer failure is recorded as `unavailable` and never affects the task.

The model client is injected. Tests and the smoke run use `FakeModelClient`. No real client is
wired yet (`unwiredModelClient` throws), so nothing in evals/ can spend by accident; the real one
should come from the harness so it charges the same budget ledger.

## What's stubbed

- Changelog watchers exist only for providers with a folder in `providers/`. Repos in the
  Anthropic and Gemini sets stop before any spend until those exist. Real runs otherwise go
  through the orchestrator's `createDeps`, under one run budget, and need `ANTHROPIC_API_KEY`.
- The real reviewer model client.
- No real benchmark has been run. The founders approve the first one and its budget.
