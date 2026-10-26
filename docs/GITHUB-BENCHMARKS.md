# GitHub Actions benchmarks

The public repository `refit-dev/refit-bench` runs the Stripe and Shopify benchmarks on GitHub-hosted runners, one job per shard. It costs nothing while the repository is public, needs no AWS sign-in and does not load a laptop. Owner decision (2026-10-26): every benchmark, with or without AI, runs here. [AWS benchmarks](AWS-BENCHMARKS.md) remain documented but are not the default route.

Its Stripe workflow, `.github/workflows/benchmark.yml`, checks out this repository at a pinned commit with a read-only token (`REFIT_READ_TOKEN`), installs dependencies and oasdiff, then runs per shard:

```sh
node scripts/stripe-benchmark-setup.mjs --root <root> --list docs/benchmarks/<list> --offset <start> --limit <size>
REFIT_DOCKER_IMAGE=node:22-alpine npm run benchmark:stripe -- --root <root> --output <out>/run --validate
```

The same repository runs `stripe-release.yml`, which prepares a PR for each new `stripe/openapi` release: see [Stripe release PRs](RELEASE-PRS.md).

## Run it

```sh
gh workflow run benchmark.yml -R refit-dev/refit-bench \
  -f commit=$(git rev-parse HEAD) \
  -f list=2026-10-16-stripe-fresh-repos.json -f offset=0 -f count=50 -f size=1
gh run list -R refit-dev/refit-bench -L 1
gh run watch <run-id> -R refit-dev/refit-bench
```

| Input    | Meaning                                                                                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commit` | Full 40-character commit SHA. A short SHA fails at checkout. The commit must be pushed.                                                                                             |
| `list`   | A frozen list in `docs/benchmarks/` at that commit.                                                                                                                                 |
| `offset` | First repository of the list to run.                                                                                                                                                |
| `count`  | How many repositories from `offset`; `all` runs the rest of the list. `gh workflow run` drops an empty `-f count=`, which then means the default of 5, so pass `all` or the number. |
| `size`   | Repositories per shard. The first job sizes the matrix as `count / size`, rounded up.                                                                                               |
| `flags`  | Extra `benchmark:stripe` options, such as `--validation-workspace 2g` (sandbox profile).                                                                                            |

## Collect the results

Each shard uploads its output as the artifact `shard-<n>`, holding `run/results.json`, `run/summary.md`, `run/harness.json`, `run/images.txt` (the digests of `node:22-alpine` and `stripe/stripe-mock` it pulled) and per-repository files under `run/repos/`. Shards that fail still upload what they wrote. Each shard pulls `stripe/stripe-mock`, because the checks Refit generates for a Stripe repository run against it; without it every validated row ends as an error.

A final `merge` job waits for every shard, merges their rows into the artifact `merged` (`results.json`, `summary.md`) and compares the repositories the plan expected with the ones present. It writes `expected.txt`, `present.txt`, `missing.txt`, `unexpected.txt` and `duplicated.txt`, puts an "Incomplete run" line in the job summary, and fails the run when any list but `expected` and `present` is non-empty. A run whose merge job failed is not a complete measurement: rerun the missing repositories before comparing it. The job summary starts with the commit, list, range and images, then the rows by outcome class and the benchmark's own summary, which reports production mode (the full contract diff on, as a hosted worker runs it, with the benchmark's SDK-spec adapter) before benchmark mode. Each row's `customerMode` holds the same scan with the built-in adapter a hosted worker uses; in baseline run 40117208880 it stopped in the same class as production mode in 511 of the 515 rows that have both, and was stricter in the other 4. Another 64 rows, for which the benchmark adapter mapped no Stripe method (so production mode did not run), stopped at the contract gate in customer mode.

```sh
gh run download <run-id> -R refit-dev/refit-bench -n merged -D <dir>
```

The merged `results.json` reads like a single-process run, so `scripts/stripe-benchmark-compare.mjs` and the recording steps in [Benchmarks](BENCHMARKS.md) apply unchanged. Record the GitHub run id and the commit with each outcome.

### Merge on a laptop

The merge job needs a free runner, and while other runs hold all of them it can stay queued after every shard finished. If it is still queued 15 minutes after the last shard ended, force-cancel the run and merge its shard artifacts locally:

```sh
gh api -X POST repos/refit-dev/refit-bench/actions/runs/<run-id>/force-cancel
gh run download <run-id> -R refit-dev/refit-bench -p 'shard-*' -D <dir>/shards
git fetch origin <commit>    # the script reads the list at the run's commit
node scripts/benchmark-merge.mjs --shards <dir>/shards --list <list> --offset <offset> --end <offset + count> --commit <commit> --output <dir>/merged
```

`scripts/benchmark-merge.mjs` writes the same files as the merge job: `results.json`, the `expected`, `present`, `missing`, `unexpected` and `duplicated` lists, `images.txt` and `summary.md` (the outcome classes, the benchmark's `summaryTable` and the AI spend). The merge job itself runs it whenever the benchmarked commit has it, and keeps its older inline steps for commits that do not; for run 40143839963 both wrote byte-identical files. `summary.md` uses the checkout's own `summaryTable`, so run the script from a checkout at the run's commit when the summary must match the job's exactly. Without `--end` the range runs to the end of the list. It prints the missing, unexpected and duplicated counts; a run with any of them is incomplete, as above.

## Shopify

`.github/workflows/shopify.yml` runs `npm run benchmark:shopify` with the same plan, shard and merge jobs and the same inputs, without AI (the Shopify benchmark has none) and with no secret but `REFIT_READ_TOKEN`. A `snapshots` job reads each Admin API schema the list names once from Shopify's public documentation proxy (`refit shopify-snapshot`; no store or credentials) and uploads them as the artifact `snapshots`. Each shard downloads those saved files and runs:

```sh
node scripts/shopify-benchmark-setup.mjs --root <root> --list <list with the snapshot hashes> --offset <start> --limit <size>
REFIT_DOCKER_IMAGE=node:22-alpine npm run benchmark:shopify -- --root <root> --list <root>/list.json --output <out>/run --validate
```

Shopify changes published schemas in place: on 2026-10-26 none of the four schemas matched either frozen list's hashes. `contracts=current`, the default, runs on the schemas read in the run and names the changed versions in the merged summary, beside each schema's hash (`merged/schemas.json`); compare only runs with the same hashes. `contracts=pinned` stops in the `snapshots` job unless Shopify still serves the frozen hashes. `flags` passes extra `benchmark:shopify` options, such as `--sdk-upgrade`.

```sh
gh workflow run shopify.yml -R refit-dev/refit-bench \
  -f commit=$(git rev-parse HEAD) \
  -f list=2026-10-16-shopify-fresh-repos.json -f offset=0 -f count=50 -f size=5
```

## Shards

A run has `count / size` shards, rounded up. Which repositories each shard runs comes from their measured durations: the merge job of every run without AI keeps each repository's newest `seconds` in a cache (`refit-timings-v1-…`, shared by every list), the plan job fills repositories the cache lacks from recent runs' `merged` results (newest first, up to 50), and then `.github/scripts/plan-shards.mjs` in refit-bench assigns repositories longest first to the least-loaded shard, counting a repository without a timing as the median. It balances only when at least half of the slice has a timing; otherwise, and if the planner fails, shards are the contiguous slices runs always had. A balanced plan is reused for the same list slice (list content, offset, count and size) for 24 hours, so a rerun of a commit, or a run of a nearby one, gets the same shards and so the same per-shard caches. Each shard runs setup on a list file of its own entries; the merged results list rows shard by shard, as before. On run 40144503063's timings the plan's slowest shard is 1,341 seconds, one repository on its own, where the contiguous slices' slowest took 3,545.

## Caches

Shards keep two caches with `actions/cache`. Both are restored before the benchmark and saved after it, even when it failed, and both are keyed on the `node:22-alpine` image ID and the shard's repositories at their pinned commits, so a shard of another list, size or offset never shares them.

- **Dependency bundles** (`REFIT_DEPENDENCY_CACHE_DIRECTORY`): the archives dependency preparation builds, for the original and the patched lockfile. The key ends with the Refit commit, and a run of a later commit restores the newest bundles of the same repositories. Refit names each bundle by the digest of its recipe, the image and the committed inputs, and checks every file's SHA-256 against the bundle's manifest and the recipe before reusing it; a bundle for other inputs is never read, and one whose bytes do not match is refused, not rebuilt. So that a restore cut short never turns into a refused bundle, the shard first drops any restored bundle whose files do not match its manifest. Before saving it removes what a killed process leaves (locks, staging directories, bundles without a manifest) and saves only when it built a bundle the restored cache lacked.
- **Baseline check results** (`REFIT_BASELINE_CHECK_CACHE_DIRECTORY`, off unless set): validation stores the original code's check result under the repository revision, the check command, the image ID, the dependency bundle's signature (its recipe, image and committed inputs; a rebuilt archive differs only in tar bytes), the sandbox limits and a digest of the code that runs checks, and an identical rerun reuses it instead of running the check again. Only passed and failed results are kept; timeouts, Docker errors and skipped checks always run again. The report marks a reused result as `validation.baselineReused` with the time it was recorded. refit-bench also keys this cache on the Refit commit, so there only a rerun of the same commit reuses results.

GitHub keeps 10 GB of caches for this repository (`GET /repos/refit-dev/refit-bench/actions/cache/storage-limit`); use beyond that is billed, caches unused for 7 days are deleted, and when the total passes the limit GitHub deletes the least recently used caches first. Dependency archives are large (a few hundred MiB to 1 GiB each, uncompressed), so each run saves at most `DEPENDENCY_CACHE_RUN_MIB` (12 GiB uncompressed) of them, split evenly across its shards; a shard over its share drops its largest bundles first and logs each one it did not save. A run of up to a few shards caches everything; a 20-shard run keeps only each shard's smallest bundles. Refit commits from before the baseline setting ignore it, and those caches stay empty.

## Limits

- AI is off by default. `-f ai=true -f ai_budget=<USD>` (more than 0, at most 1000, the most Refit accepts) adds `--ai` with the repository's `OPENAI_API_KEY` secret and the `model` input. `-f ai_scope=behaviour-tests` passes `--behaviour-tests` instead of `--ai`, so the budget pays only for generated behaviour tests; the benchmarked commit must have that flag. The default, `patches`, is the `--ai` run. The budget is split evenly across shards, each with its own ledger, so a run cannot spend more than `ai_budget`; the merged summary reports the spend. The key goes to a file under the runner's temporary directory, not the environment of the benchmark, and GitHub masks it in logs. Logs and artifacts are public, so never pass a key through `flags`; the workflow refuses `--ai`, `--env` and `--publish` there.
- A run holds at most 256 shards (GitHub's matrix limit); raise `size` for longer lists. About 20 jobs run at once on the free plan; the rest queue.
- A shard times out after 300 minutes. Runners are 4-vCPU Linux machines, so validation times differ from a laptop or EC2; compare outcomes, not seconds, across environments.
- Changing the workflow is a push to `refit-dev/refit-bench`. A run uses the workflow as it was when dispatched.

## How this matches production

Production is the hosted worker on Fly (`fly.toml`, `Dockerfile`). The Stripe workflow matches it in what can change an outcome, except where noted:

- **Same:** Node 22, oasdiff 1.33.0, validation in offline Docker on `node:22-alpine` with `stripe/stripe-mock:latest` for generated checks (each run records the digests; the worker pulls `latest` on boot, so digests can differ), the default validation sandbox profile, and the default publication policy (stops become `[Needs review]` findings unless `--publish-validated-only`).
- **AI repairs:** with `--ai` the benchmark passes `--repair-attempts` `HOSTED_REPAIR_ATTEMPTS` (2, in `pipeline/validation-options.ts`), the value in `REFIT_HOSTED_FLAGS`; a test fails if the two drift. `--repair-attempts 0|1|2` overrides it for experiments. Runs of earlier commits used 1.
- **Checks (accepted difference):** the worker runs the approved `.refit.json` checks. Benchmark repositories have none, so the benchmark selects a check itself and adds the checks Refit generates.
- **Model (not closed):** the worker's model is the `OPENAI_MODEL` Fly secret, which no document records. The workflow offers only `gpt-6.1-sol`; until the production model is written down, an AI run is not known to use it.
- **AI budget:** the worker caps each installation at `REFIT_AI_BUDGET_USD` (`fly.toml`) in one ledger across its repositories. The workflow splits `ai_budget` evenly across shards, so each shard's repositories share a smaller ledger; set `ai_budget` to about the per-installation cap times the shard count to match.
- **Vendor notes:** the benchmark attaches the pinned Stripe changelog pages in `docs/benchmarks/stripe-changelog/` to AI requests. The worker attaches only documentation snapshots from a repository's configured documentation sources.
- **Contracts and adapter:** the benchmark uses the frozen list's API versions and pinned Stripe specs, and reports production mode with its SDK-spec adapter; `customerMode` repeats the scan with the built-in adapter the worker uses (see [Collect the results](#collect-the-results)).
- **Not exercised:** the worker's doctor and approval steps, draft publication (`--publish-draft --supersede-drafts`; the workflow refuses `--publish`), polling, and its dependency-bundle cache, which reuses only bundles whose inputs match.
- **Runtime:** the worker runs the packaged CLI on a 2-vCPU, 4 GB Fly machine; shards run the source at the pinned commit with `tsx` on 4-vCPU, 16 GB runners. Compare outcomes, not seconds.

Shopify runs differ the same way, without AI, and on the Admin schemas read in the run (see [Shopify](#shopify)).

## Checked

On October 24, run `40067644474` at `502b8c0` ran the first 5 repositories of `2026-10-16-stripe-fresh-repos.json`, one per shard, in 7 minutes end to end. The slowest shard, `hackerai-tech/hackerai`, took 333 seconds in the benchmark; the others took 8 to 91 seconds. Setup before the benchmark took about 20 seconds per shard. The `jq` merge above produced one `results.json` with all 5 rows.

On October 25, `subsets/l2-push-249.json` (249 repositories, size 13, 20 shards) ran three ways. Run `40144503063` at `c8a224f`, contiguous shards and no caches: 3,587 s from dispatch to merged, its slowest shard 3,545 s. Run `40166506002` at `4aff06b` (the same code plus the baseline cache and the merge script), balanced shards and empty caches: 1,701 s, shards 1,020 to 1,650 s. Run `40168273227`, the same commit again, reused that plan and both caches: shards ran 786 to 1,509 s and the benchmark steps took 7.8% less in total; all 104 decided baseline checks and 38 of 206 dependency bundles were reused (the rest were over the per-run cap), but its wall time was 1,967 s because shards waited up to 453 s for a free runner. All three runs gave every repository the same outcome; the only differing field was the timestamped npm log path in two preparation errors. The cache steps cost 98 s across 20 shards in the cold run; zstd shrank the saved dependency archives about 4.7 times (7,664 MiB to 1,638 MiB).

Run `40116749076` checked the merge job's gap check: with `--limit 0` neither repository produced a row, and the merge job failed with "Missing 2" and both names, recording the `stripe/stripe-mock` digest.
