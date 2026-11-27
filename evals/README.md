# evals

Refit's eval harness: frozen sets of real public repos, a runner that takes each one through the full pipeline (inventory, watch, match, migrate, prove), scoring, and an AI reviewer for every PR the agent writes.

## Quick start

```sh
npm run smoke -w evals
```

Runs a few repos end to end with a fake model and synthetic fixtures. No network, no installs, $0. Prints `SMOKE OK` or the invariant that broke.

## Repo sets (`sets/`)

Each set pins every repo to an exact commit, so a run is reproducible.

| Set                 | Repos | What it holds                                                           |
| ------------------- | ----- | ----------------------------------------------------------------------- |
| `six-providers-780` | 780   | 130 repos each for Shopify, Stripe, OpenAI, Meta, Twilio and GitHub     |
| `shopify-dev-60`    | 60    | Shopify apps on deprecated REST endpoints or unsupported versions       |
| `meta-dev-60`       | 60    | Graph API and Marketing API callers                                     |
| `stripe-dev-30`     | 30    | Stripe integrations on old API versions                                 |
| `openai-dev-30`     | 30    | OpenAI callers on retiring models and SDK majors                        |
| `upgrade-dev-20`    | 20    | JS/TS and Python repos on an end-of-life runtime or old framework major |

`node evals/sets/build-six.ts` rebuilds `six-providers-780`: repos from the provider sets first, then GitHub code search over dependency manifests and source, skipping forks and archives.

## Running

```sh
node evals/runner/cli.ts run --set six-providers-780 --limit 10 --concurrency 2 --budget-usd 10
node evals/runner/cli.ts score --in evals/results/six-providers-780
```

`--limit` samples round-robin across providers. Each repo writes one result file to `evals/results/<set>/`; `score` turns them into rates by outcome, provider and cost. `run` needs `ANTHROPIC_API_KEY` and refuses to start without a dollar cap.

## Scoring (`scoring/`)

Each task is graded verified (build, type check and tests pass with no new failures), needs-review, not-affected or failed, and `score` reports the rate of each, overall and by change family, with cost per repo. `evals/reviews.json` logs the hand-checks of verified and needs-review PRs.

## AI reviewer (`reviewer/`)

Reads each PR's diff against the change it claims to handle and returns an advisory verdict. `cli.ts review` reruns it on saved results without rerunning the agent.
