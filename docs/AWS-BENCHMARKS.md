# Benchmarks on AWS

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

- The command after `--` is one quoted string run with `bash` in the source checkout. `{offset}`, `{limit}`, `{shard}` and `{run}` are filled in per shard. Whatever it writes under `/work/out` is uploaded to `runs/<run>/shard-<n>/out`, next to `boot.log` and `exit-code`.
- The source is `git archive` of `--commit` (default `HEAD`), so commit or pin what you want measured; uncommitted changes are not uploaded. `run.json` records the commit, command and slices.
- `--env <file>` uploads a `.env` (for `--ai` runs) to the run's prefix. `collect` and `stop` delete it; delete it yourself if you abandon a run.
- `--images` lists validation images to pull on boot (default `node:22-alpine`), because validation runs with `--pull never`.
- `stop --run <id>` terminates a run early.

## Cost and limits

- Every instance runs `shutdown -h +<hours×60>` on boot and terminates on shutdown, so a hung shard costs at most `--hours` (default 2, maximum 6). Its 100 GiB disk is deleted with it.
- The account is on the AWS free plan: spot launches are denied by policy, so use `--market on-demand` until it is upgraded. The default `c7i.2xlarge` has 8 vCPUs; the on-demand quota is 16 vCPUs and the spot quota 32, shared by every run. `launch` refuses a run that would exceed the quota, counting every running instance in the account, including ones launched by hand.
- The project has a $20 monthly spend limit and $120 of credits. One `c7i.2xlarge` hour costs about $0.36 on demand. Check `status` and the Billing page before large runs, and never leave a run without either collecting or stopping it.

## Running in parallel

- Pick a unique `--run` id per run, such as `<benchmark>-<date>-<agent>`. `launch` refuses an id that already exists in S3 or has running instances.
- Shard by repository count: on demand, two `c7i.2xlarge` shards (or four `c7i.xlarge`) fill the 16-vCPU quota. If the quota is full, `launch` says how many vCPUs are in use; wait or use fewer shards.
- `collect` concatenates the shards' `results.json` arrays into `<dir>/merged/<same path>`, so compare as before: `node scripts/stripe-benchmark-compare.mjs <run-a>/merged/run/results.json <run-b>/merged/run/results.json`.
