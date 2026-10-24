# GitHub Actions benchmarks

The public repository `refit-dev/refit-bench` runs the Stripe benchmark on GitHub-hosted runners, one job per shard. It costs nothing while the repository is public, needs no AWS sign-in and does not load a laptop. Prefer it to [AWS benchmarks](AWS-BENCHMARKS.md) for Stripe runs, and whenever EC2 is unavailable.

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

Each shard uploads its output as the artifact `shard-<n>`, holding `run/results.json`, `run/summary.md`, `run/harness.json`, `run/images.txt` (the digests of `node:22-alpine` and `stripe/stripe-mock` it pulled) and per-repository files under `run/repos/`. Shards that fail still upload what they wrote. Each shard pulls `stripe/stripe-mock`, because the checks Refit generates for a Stripe repository run against it; without it every validated row ends as an error.

A final `merge` job waits for every shard, merges their rows into the artifact `merged` (`results.json`, `summary.md`) and compares the repositories the plan expected with the ones present. It writes `expected.txt`, `present.txt`, `missing.txt`, `unexpected.txt` and `duplicated.txt`, puts an "Incomplete run" line in the job summary, and fails the run when any list but `expected` and `present` is non-empty. A run whose merge job failed is not a complete measurement: rerun the missing repositories before comparing it. The job summary starts with the commit, list, range and images, then the rows by outcome class and the benchmark's own summary, which reports production mode (full contract diff on, what a hosted customer gets) before benchmark mode.

```sh
gh run download <run-id> -R refit-dev/refit-bench -n merged -D <dir>
```

The merged `results.json` reads like a single-process run, so `scripts/stripe-benchmark-compare.mjs` and the recording steps in [Benchmarks](BENCHMARKS.md) apply unchanged. Record the GitHub run id and the commit with each outcome.

## Limits

- AI is off by default. `-f ai=true -f ai_budget=<USD>` (more than 0, at most 1000, the most Refit accepts) adds `--ai` with the repository's `OPENAI_API_KEY` secret and `gpt-5.6-luna`. The budget is split evenly across shards, each with its own ledger, so a run cannot spend more than `ai_budget`; the merged summary reports the spend. The key goes to a file under the runner's temporary directory, not the environment of the benchmark, and GitHub masks it in logs. Logs and artifacts are public, so never pass a key through `flags`; the workflow refuses `--ai`, `--env` and `--publish` there.
- Stripe only. Shopify needs its saved Admin schema snapshots and is not wired in.
- A run holds at most 256 shards (GitHub's matrix limit); raise `size` for longer lists. About 20 jobs run at once on the free plan; the rest queue.
- A shard times out after 300 minutes. Runners are 4-vCPU Linux machines, so validation times differ from a laptop or EC2; compare outcomes, not seconds, across environments.
- Changing the workflow is a push to `refit-dev/refit-bench`. A run uses the workflow as it was when dispatched.

## Checked

On October 24, run `40067644474` at `502b8c0` ran the first 5 repositories of `2026-10-16-stripe-fresh-repos.json`, one per shard, in 7 minutes end to end. The slowest shard, `hackerai-tech/hackerai`, took 333 seconds in the benchmark; the others took 8 to 91 seconds. Setup before the benchmark took about 20 seconds per shard. The `jq` merge above produced one `results.json` with all 5 rows.

Run `40116749076` checked the merge job's gap check: with `--limit 0` neither repository produced a row, and the merge job failed with "Missing 2" and both names, recording the `stripe/stripe-mock` digest.
