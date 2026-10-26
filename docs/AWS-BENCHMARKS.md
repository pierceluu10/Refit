# Benchmarks on AWS

Not the default route: every benchmark runs on [GitHub Actions](GITHUB-BENCHMARKS.md) (owner decision, 2026-10-26). This guide stays for reference and is used only when the owner asks for an AWS run.

`scripts/aws-benchmark.mjs` runs a benchmark as parallel shards on EC2, one instance per shard, so validation in Docker does not load a laptop. Each instance builds Refit from a pinned commit, runs its slice, uploads its results to S3 and terminates itself. Nothing needs SSH or an open port.

## One-time setup

```sh
aws login --region us-east-2 --profile refit
export AWS_PROFILE=refit AWS_REGION=us-east-2
node scripts/aws-benchmark.mjs setup
```

`setup` is idempotent. It creates a private bucket `refit-benchmarks-<account>-<region>` (public access blocked, `runs/` expires after 30 days), an instance role that can read and write only that bucket's `runs/`, and a security group with no inbound rules. Credentials from `aws login` last 12 hours and renew for 90 days.

## Run a benchmark

```sh
node scripts/aws-benchmark.mjs launch --run stripe-fresh-2026-10-22 --total 381 --shards 2 \
  --market on-demand --hours 3 -- \
  'node scripts/stripe-benchmark-setup.mjs --root /work/root --list docs/benchmarks/2026-10-16-stripe-fresh-repos.json --offset {offset} --limit {limit} && REFIT_DOCKER_IMAGE=node:22-alpine npm run benchmark:stripe -- --root /work/root --output /work/out/run --validate'
node scripts/aws-benchmark.mjs status --run stripe-fresh-2026-10-22
node scripts/aws-benchmark.mjs collect --run stripe-fresh-2026-10-22 --to <dir>
```

Shopify shards the same way. Its setup writes the shard's part of the frozen list to `<root>/list.json`, and the benchmark reads that list:

```sh
node scripts/aws-benchmark.mjs launch --run shopify-fresh-2026-10-22 --total 200 --shards 2 \
  --market on-demand --hours 3 -- \
  'node scripts/shopify-benchmark-setup.mjs --root /work/root --list docs/benchmarks/2026-10-16-shopify-fresh-repos.json --offset {offset} --limit {limit} && REFIT_DOCKER_IMAGE=node:22-alpine npm run benchmark:shopify -- --root /work/root --list /work/root/list.json --output /work/out/run --validate'
```

- The command after `--` is one quoted string run with `bash` in the source checkout. `{offset}`, `{limit}`, `{shard}` and `{run}` are filled in per shard. Whatever it writes under `/work/out` is uploaded to `runs/<run>/shard-<n>/out`, next to `boot.log` and `exit-code`.
- `/work/out` is synced to S3 every 10 minutes while the command runs and once more when it ends, so a shard stopped by its deadman shutdown loses at most the last 10 minutes of results. The Stripe and Shopify benchmarks rewrite `results.json` after every repository.
- The source is `git archive` of `--commit` (default `HEAD`), so commit or pin what you want measured; uncommitted changes are not uploaded. `run.json` records the commit, the archive's SHA-256, the command, the instance settings (including the instance type's memory, `memoryMib`) and the slices. A command with `--validate` on an instance under 8 GiB gets a warning, because the harness, `refit run` and a 3 GiB validation container share that memory. Each instance checks the archive it downloads against that SHA-256 before building it.
- `--env <file>` uploads a `.env` (for `--ai` runs) to the run's prefix. `collect` and `stop` delete it; delete it yourself if you abandon a run.
- `--images` lists validation images to pull on boot (default `node:22-alpine`), because validation runs with `--pull never`.
- `stop --run <id>` terminates a run early.
- `--offset` and `--limit` of both setup scripts must be whole numbers; anything else stops the setup instead of silently selecting the whole list.

## Status, failures and retries

`status --run <id>` prints each shard's state and the run's active instances:

| State      | Meaning                                                                                                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `finished` | The shard uploaded its exit code, with `exit` and `stage`. Its instance may still be shutting down.                                                                                                         |
| `running`  | No exit code yet, and the shard's instance is pending or running.                                                                                                                                           |
| `lost`     | No exit code and no pending or running instance: the deadman shutdown or a crash ended it before it could upload one, or it was never launched (for example, credentials expired partway through `launch`). |

A finished shard's `stage` says where it ended. Boot stages exit with their own code, so an infrastructure failure never looks like a benchmark result:

| Stage      | Exit              | What failed                                                                                    |
| ---------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| `packages` | 70                | `dnf install` of Docker, git and tar, or starting Docker                                       |
| `node`     | 71                | Node download, its SHA-256 check or unpacking                                                  |
| `oasdiff`  | 72                | oasdiff download                                                                               |
| `source`   | 73                | Source download from S3 or its SHA-256 check against `run.json`                                |
| `npm-ci`   | 74                | `npm ci` in the source checkout                                                                |
| `images`   | 75                | `docker pull` of an `--images` entry                                                           |
| `command`  | the command's own | The benchmark command. 143 means the instance was terminated while it ran (deadman or `stop`). |
| `upload`   | 76                | The final upload of `/work/out` after the command                                              |

`boot.log` next to the exit code has the full output, and `kernel.log` the kernel log (`dmesg`), where an out-of-memory kill leaves its only trace. Both are uploaded every 10 minutes while the command runs and again at the end, so a shard the deadman shutdown ended still has them up to its last sync. Exit codes uploaded before this change hold only the number, so their `stage` is empty.

`retry --run <id> --shard <n>` relaunches one `failed` or `lost` shard with the slice, commit, command and instance settings in `run.json`. It refuses while the shard still has an instance (wait until it terminates, or `stop` the run) and refuses a shard that succeeded. It deletes the shard's earlier `exit-code`, `boot.log`, `kernel.log` and `out/` before relaunching, so download anything you want to keep first. A run launched with `--env` needs `--env` again.

`list` prints every run in the bucket, newest first, with its commit and how many shards succeeded, failed, are running or are lost.

When `aws login` credentials expire or are missing, every command stops with `AWS credentials expired or missing`, the AWS error, and how to sign in again. A `launch` or `retry` that stops this way may have launched some shards: check `status` (lost shards were never launched or did not finish) and `retry` the ones that are missing.

Before uploading or deleting anything, `launch` and `retry` ask EC2 for a dry run of the launch (`run-instances --dry-run`). When EC2 would refuse it (a missing permission, a service control policy, an instance type the region lacks), the command stops with `The launch dry run failed, so nothing was uploaded or changed` and the AWS error, and the run id stays free.

## Cost and limits

- Every instance runs `shutdown -h +<hours×60>` on boot and terminates on shutdown, so a hung shard costs at most `--hours` (default 2, maximum 6). Its 100 GiB disk is deleted with it.
- The account is on the AWS free plan: spot launches are denied by policy, so use `--market on-demand` until it is upgraded. The default `c7i.2xlarge` has 8 vCPUs; the on-demand quota is 16 vCPUs and the spot quota 32, shared by every run. `launch` and `retry` refuse to exceed the quota, counting every running instance in the account, including ones launched by hand.
- `cost --run <id>` prices every launch of the run, retries included: instance hours (per second, one-minute minimum) times the on-demand price plus the 100 GiB gp3 disk. A launch ends when its shard uploaded its exit code, or now while it still runs. A `lost` launch's end is unknown, so it is charged up to its deadman shutdown and marked `estimated`; spot launches are charged the on-demand price and also marked `estimated`. Runs launched before launch records existed show no launches.
- The price table in `scripts/aws-benchmark.mjs` has `c7i.large` ($0.08925/h), `c7i.xlarge` ($0.1785/h), `c7i.2xlarge` ($0.357/h) and gp3 ($0.08 per GiB-month) on-demand Linux prices for `us-east-2`, read through the AWS Price List API on 2026-10-22. `cost` refuses other regions and instance types until they are added.
- The project has a $20 monthly spend limit and $120 of credits. Check `cost`, `status` and the Billing page before large runs, and never leave a run without either collecting or stopping it.

## Running in parallel

- Pick a unique `--run` id per run, such as `<benchmark>-<date>-<agent>`. `launch` refuses an id that already exists in S3 or has running instances.
- Shard by repository count: on demand, two `c7i.2xlarge` shards (or four `c7i.xlarge`) fill the 16-vCPU quota. If the quota is full, `launch` says how many vCPUs are in use; wait or use fewer shards.
- `collect` downloads the run, concatenates the shards' `results.json` arrays into `<dir>/merged/<same path>` and prints how many shards succeeded, failed, are running or are lost. A shard whose exit code is uploaded counts as finished even while its instance shuts down. Compare as before: `node scripts/stripe-benchmark-compare.mjs <run-a>/merged/run/results.json <run-b>/merged/run/results.json`.
