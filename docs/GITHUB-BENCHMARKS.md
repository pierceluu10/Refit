# GitHub Actions benchmarks

The public repository `refit-dev/refit-bench` runs the Stripe benchmark on GitHub-hosted runners, one job per shard. It costs nothing while the repository is public, needs no AWS sign-in and does not load a laptop. Prefer it to [AWS benchmarks](AWS-BENCHMARKS.md) for runs without AI, and whenever EC2 is unavailable.

Its workflow, `.github/workflows/benchmark.yml`, checks out this repository at a pinned commit with a read-only token (`REFIT_READ_TOKEN`), installs dependencies and oasdiff, then runs per shard the same commands as an AWS shard:

```sh
node scripts/stripe-benchmark-setup.mjs --root <root> --list docs/benchmarks/<list> --offset <start> --limit <size>
REFIT_DOCKER_IMAGE=node:22-alpine npm run benchmark:stripe -- --root <root> --output <out>/run --validate
```

## Run it

```sh
gh workflow run benchmark.yml -R refit-dev/refit-bench \
  -f commit=$(git rev-parse HEAD) \
  -f list=2026-10-16-stripe-fresh-repos.json -f offset=0 -f count=50 -f size=1
gh run list -R refit-dev/refit-bench -L 1
gh run watch <run-id> -R refit-dev/refit-bench
```

| Input    | Meaning                                                                                 |
| -------- | --------------------------------------------------------------------------------------- |
| `commit` | Full 40-character commit SHA. A short SHA fails at checkout. The commit must be pushed. |
| `list`   | A frozen list in `docs/benchmarks/` at that commit.                                     |
| `offset` | First repository of the list to run.                                                    |
| `count`  | How many repositories from `offset`. Blank runs the rest of the list.                   |
| `size`   | Repositories per shard. The first job sizes the matrix as `count / size`, rounded up.   |

## Collect the results

Each shard uploads its output as the artifact `shard-<n>`, holding `run/results.json`, `run/summary.md`, `run/harness.json` and per-repository files under `run/repos/`. Shards that fail still upload what they wrote.

```sh
gh run download <run-id> -R refit-dev/refit-bench -D <dir>
jq -s add <dir>/shard-*/run/results.json > <dir>/results.json
```

The merged `results.json` reads like a single-process run, so `scripts/stripe-benchmark-compare.mjs` and the recording steps in [Benchmarks](BENCHMARKS.md) apply unchanged. Record the GitHub run id and the commit with each outcome.

## Limits

- No AI. The workflow passes no OpenAI key and `--ai` is not wired in. Logs and artifacts of a public repository are public, so an AI run would need a dedicated, capped key and a private repository.
- Stripe only. Shopify needs its saved Admin schema snapshots and is not wired in.
- A run holds at most 256 shards (GitHub's matrix limit); raise `size` for longer lists. About 20 jobs run at once on the free plan; the rest queue.
- A shard times out after 300 minutes. Runners are 4-vCPU Linux machines, so validation times differ from a laptop or EC2; compare outcomes, not seconds, across environments.
- Changing the workflow is a push to `refit-dev/refit-bench`. A run uses the workflow as it was when dispatched.
