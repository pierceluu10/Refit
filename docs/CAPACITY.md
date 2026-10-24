# Capacity and cost

How much work one hosted worker (`refit hosted serve`, Fly app `refit-hosted`) can do, what it costs, and how many machines 10, 50 and 200 customers need. Every measured number comes from a committed JSON file below, and every price from Fly's pages read on 2026-10-22. `node scripts/capacity-model.mjs` recomputes each derived number from those files ([model output](benchmarks/2026-10-22-capacity-model.json)).

The measurements were taken on a laptop, not on Fly or AWS hardware. The per-stage validation profiles this model was meant to rest on were not taken (see [Not measured](#not-measured)), so validation figures come from Refit's configured limits and earlier end-to-end runs.

## Measurements

| What                                                                                                                                                                                                 | Result                                                                                                                                                                                                     | Raw data                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static inventory: `refit deadlines --json` then `refit agents --json` on 94 repositories: 25 from each of the frozen Stripe active, OpenAI app and Shopify lists, and 19 from the Anthropic app list | 91 measured; 3 refused by Refit's scan limits in 0.4 s. Per repository: wall **p50 1.5 s**, p90 5.6 s, max 15.9 s; CPU p50 1.7 s, p90 6.1 s, max 14.4 s; peak memory p50 256 MiB, p90 472 MiB, max 650 MiB | [inventory](benchmarks/2026-10-22-capacity-inventory.json)                                                                                                                                                      |
| Cold dependency preparation: the 90 bundles of the current recipe (72 npm, 16 pnpm, 2 Yarn) that benchmark runs prepared on this laptop between 2026-10-20 and 2026-10-22                            | Install time the package manager printed: **p50 14 s**, p90 33 s, max 67 s. Archive: p50 508 MiB, p90 957 MiB, max 1.3 GiB. Excludes container start and archiving                                         | [preparation](benchmarks/2026-10-22-capacity-preparation.json)                                                                                                                                                  |
| Validated Stripe migrations from the 2026-10-16 benchmark (`7238e46`, Yarn at `fecd935`)                                                                                                             | 74 repositories, end to end (four scans, then `refit run` with preparation, baseline, patched and generated checks): **p50 33 s**, p90 72 s, max 153 s. Dependency cache state was mixed                   | [fresh](benchmarks/2026-10-16-stripe-fixrate-fresh-results.json), [original](benchmarks/2026-10-16-stripe-fixrate-original-results.json), [held out](benchmarks/2026-10-16-stripe-fixrate-heldout-results.json) |
| Yarn 1 repositories under the 4 GiB profile, same day                                                                                                                                                | 3 validated in 147–246 s                                                                                                                                                                                   | [Yarn 4g](benchmarks/2026-10-16-stripe-fixrate-yarn-4g-results.json)                                                                                                                                            |

The inventory ran from a clean pinned worktree at `fda92e5` on an Apple M5 (10 cores, 16 GB, Node 25.8.2), one repository at a time. Other lanes kept the load average at 9.6–13.6, so these times are slower than on an idle machine. Wall time includes Node startup, an upper bound for the in-process scans the worker runs. Five repositories (`OpenCoworkAI/open-cowork`, `yayasoumah/pocket-server`, `babarot/oksskolten`, `vual/lobe-chat-pro`, `backenly/backenly`) are in both AI samples and were measured twice, so the 94 rows are 89 distinct repositories and the 91 measured rows cover 86. Six rows were removed on 2026-10-22 with the 12 repositories of the Anthropic app list that are copies of leaked proprietary Claude Code source, and every number on this page was recomputed without them.

## Not measured

- **Per-stage validation profiles** (wall time, peak memory, CPU, disk and network for checkout, doctor, preparation, baseline and patched checks on 20 repositories). AWS refused every launch (an organization service control policy denies `ec2:RunInstances`), and the laptop's Docker daemon stopped answering at about 10:18 UTC after the disk filled. Both are recorded as Blocked in the PR.
- **Anything on Fly hardware.** The model takes a Fly performance vCPU to be as fast as one core of this laptop under the recorded load.
- **A real hosted poll**, which needs the GitHub App. Its cost is assumed below.

## What one worker does

These facts are read from the code and set the shape of the model:

- **One job at a time.** The worker claims a job and awaits it before claiming the next (`pipeline/hosted-service.ts`), so more vCPUs do not add throughput today.
- **Every enrolled repository is polled every 300 s** (`DEFAULT_INTERVAL_SECONDS`). Each poll fetches the repository, captures the contract and runs a full scan, whether or not anything changed (`pipeline/watch.ts`).
- **A migration runs only when the contract changed.** Preparation, baseline and patched checks each run in a container limited to one CPU and 3 GiB of memory, with a 2 GiB tmpfs workspace (`pipeline/docker-sandbox.ts`). Linux charges tmpfs pages to the container's memory limit, so the workspace counts inside the 3 GiB.
- **Stage time limits:**

  | Stage               | Limit                                               |
  | ------------------- | --------------------------------------------------- |
  | Repository fetch    | 60 s                                                |
  | Other git commands  | 30 s                                                |
  | Dependency install  | 300 s (`REFIT_DEPENDENCY_TIMEOUT_SECONDS`, 60–1800) |
  | Each check command  | 120 s                                               |
  | Each Docker command | 30 s                                                |

  The scan has no limit, and neither does the job as a whole: its lease renews for as long as it runs.

- **Prepared dependency bundles are never evicted.** `fly.toml` does not set `REFIT_DEPENDENCY_CACHE_DIRECTORY`, so bundles go to `/root/.refit/dependencies` on the machine's root filesystem, not the `/data` volume. Every deploy or restart therefore starts cold. Fly's pricing page does not state the root filesystem's size, and it was not checked.

## Fly facts used

From [pricing](https://docs.fly.io/about/pricing), [CPU performance](https://docs.fly.io/machines/cpu-performance) and [machine sizing](https://docs.fly.io/machines/guides-examples/machine-sizing), read on 2026-10-22 (iad prices; Fly's monthly prices are 720 hours):

- **Shared vCPUs have a quota.** Each one is guaranteed 6.25% of a core (5 ms per 80 ms period), pooled across the machine's vCPUs, and may burst to 100% for up to 500 s of saved balance. Performance vCPUs run at 100%.
- **Memory limits.** Shared presets allow at most 2 GB per vCPU; performance presets allow 2–8 GB per vCPU, in 2 GB steps.
- **Other prices.** Memory beyond the preset costs $6.00/GB/month and volumes cost $0.15/GB/month. Outbound data in North America costs $0.02/GB; inbound data is free.

| Size                                  | Memory            | Price per month | Sustained CPU for one job                           |
| ------------------------------------- | ----------------- | --------------- | --------------------------------------------------- |
| `shared-cpu-2x` (in `fly.toml` today) | 4 GB, its maximum | $25.39          | 0.125 of a core                                     |
| `shared-cpu-4x`                       | 8 GB              | $50.78          | 0.25                                                |
| `performance-1x`                      | 8 GB              | $69.00          | 1                                                   |
| `performance-2x`                      | 8 GB              | $90.00          | 1 (the second vCPU is idle for a sequential worker) |

## Model

### Jobs per hour

A job holds the worker for its wall time or, on shared vCPUs once the burst balance is spent, for its CPU seconds divided by the quota. A migration's CPU time is taken as its wall time, because its container has one CPU and the worker waits on it.

| Size                      | Inventory p50 / p90 | Inventories per hour | Validated migration p50 / p90 | Migrations per hour |
| ------------------------- | ------------------- | -------------------- | ----------------------------- | ------------------- |
| `shared-cpu-2x`           | 14 s / 49 s         | 264 / 74             | 264 s / 576 s                 | 13 / 6              |
| `shared-cpu-4x`           | 7 s / 24 s          | 529 / 148            | 132 s / 288 s                 | 27 / 12             |
| `performance-1x` or `-2x` | 1.7 s / 6.1 s       | 2,117 / 594          | 33 s / 72 s                   | 109 / 50            |

The shared rows are the sustained case. A quiet machine bursts at full speed for up to about 500 s of saved balance, but a machine polling every 5 minutes is never quiet.

### Memory headroom

A validation can grow to its container's 3 GiB. The worker process runs the same scanners as the inventory commands, whose peak was 650 MiB. That leaves:

- **0.36 GiB on today's 4 GB machine** for `dockerd`, git, the kernel and the page cache. That is no margin: a large repository can push the worker or `dockerd` out of memory during a validation.
- **No room for the opt-in 4 GiB profile** (`REFIT_VALIDATION_WORKSPACE=4g`, a 5 GiB container), which the Yarn 1 repositories above need.
- **4.36 GiB on any 8 GB size.**

### Job timeout

The bounded stages of one migration add up to 1,200 s:

| Stage                                                                                                                                                                               | Seconds   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Repository fetch                                                                                                                                                                    | 60        |
| Dependency install                                                                                                                                                                  | 300       |
| Six check commands at 120 s each: baseline and patched, the generated stripe-mock checks before and after, and the two repair reruns the hosted flags allow (`--repair-attempts 2`) | 720       |
| Open-enum restoration check (`pipeline/validation.ts`, 120 s)                                                                                                                       | 120       |
| **Total**                                                                                                                                                                           | **1,200** |

Container starts, archiving, AI calls and the unbounded scan come on top. The largest committed scan figure is 409 s for one repository's four benchmark scans (a `not-affected` row in the fresh fix-rate results).

**Recommendation:** a 30-minute job timeout, about 12% above 1,200 s plus that scan (1,609 s). The slowest validated run in the committed results took 246 s. On `shared-cpu-2x`, CPU-bound stages run up to 8 times slower once the burst is spent, so a long validation can exceed any reasonable limit there.

### Cost per job

The worker never idle-stops, so machines are a fixed monthly cost. The per-job figure is the share of machine time a job holds.

| Size             | Per inventory, p50 / p90 | Per validated migration, p50 / p90 |
| ---------------- | ------------------------ | ---------------------------------- |
| `shared-cpu-2x`  | $0.00013 / $0.00047      | $0.0026 / $0.0056                  |
| `performance-1x` | $0.00005 / $0.00016      | $0.0009 / $0.0019                  |
| `performance-2x` | $0.00006 / $0.00021      | $0.0011 / $0.0025                  |

On top of machine time:

- **AI.** When a job asks a model, each call costs $0.002–0.006 on `gpt-5.6-luna` ([benchmarks](BENCHMARKS.md#speed-and-cost)). The worker's ledger is capped by `REFIT_AI_BUDGET_USD` ($2 today).
- **Dependency cache on the volume.** Keeping one repository's prepared bundle there costs about $0.08 a month (508 MiB at $0.15/GB/month).
- **Network.** Checkouts, contracts and packages are inbound and free; outbound traffic is API calls and draft PRs.

### Machines for 10, 50 and 200 customers

Assumptions:

- 3 repositories per customer.
- 2 validated migrations per repository per month, at the p90 time.
- A poll costs one inventory's p90 CPU time (6.1 s). It runs a full scan, as an inventory does.
- Machines are planned to be at most 50% busy.

Each row also includes a 20 GB volume per machine.

| Size             | Poll interval | 10 customers            | 50 customers | 200 customers |
| ---------------- | ------------- | ----------------------- | ------------ | ------------- |
| `shared-cpu-2x`  | 300 s         | 10 machines, $284/month | 49, $1,391   | 195, $5,536   |
| `shared-cpu-2x`  | 1 hour        | 1, $28                  | 5, $142      | 17, $483      |
| `performance-1x` | 300 s         | 2, $144                 | 7, $504      | 25, $1,800    |
| `performance-1x` | 1 hour        | 1, $72                  | 1, $72       | 3, $216       |

**Polling, not migrations, sets the size.** At a 300 s interval each repository costs 12 scans an hour, about 73 CPU seconds, while its migrations average about 0.2 s an hour. The scan is content-addressed (its run id hashes the contract, repository and adapter), so a poll whose repository commit and contract hash both match the last one could skip the scan entirely. That would make a poll cost only its fetches.

On Fly, a hosted scheduled poll now skips everything, the managed fetch included, when the base branch head, approval and worker build match the last finished job and the contracts are committed files ([unchanged polls](HOSTED-RUNBOOK.md#unchanged-polls)). It costs one GitHub API read and two database queries. The rows above still describe a poll after a push, a deploy or an approval change, and every poll of a target whose contract is fetched from upstream.

These rows assume jobs spread across machines. Today one machine serves one owner (`REFIT_HOSTED_OWNER`); several machines need the job distribution and isolation PG3 and PG10 are building.

## `fly.toml` against the measurements

Today: `shared-cpu-2x` with 4 GB ($25.39/month plus a 20 GB volume). Against the measurements:

- **Memory.** Worst-case headroom is 0.36 GiB, and the 4 GiB profile cannot run at all.
- **CPU.** The sustained quota is 0.125 of a core, so a p90 validated migration holds the worker for about 10 minutes once the burst is spent, instead of 72 s.

**Needs owner decision:** move to `performance-1x` with 8 GB ($69.00/month in iad). It holds a 3 GiB validation container plus the measured worker peak with 4.36 GiB to spare, and runs the sequential worker at full speed.

- `performance-2x` with 8 GB costs $21 more for a second vCPU the worker cannot use today.
- `shared-cpu-4x` with 8 GB ($50.78) fixes memory but still sustains only a quarter of a core.

## Needs owner decision

1. **VM size**, as above.
2. **Poll interval.** 300 s polling needs about 10 times the machines of hourly polling. The alternative is skipping the scan when nothing changed (see the request to PP5).
3. **Dependency cache.**
   - Where the bundles live: the root filesystem today, lost on each deploy, or `/data` via `REFIT_DEPENDENCY_CACHE_DIRECTORY`.
   - How much they may use: one repository's bundle is 0.5–1.3 GiB, so the 20 GB volume holds roughly 30 at the median beside Docker's images and the evidence.
4. **Job timeout:** 30 minutes, as above.

## Requests for other lanes

- **PP5 (hosted operations).**
  - Add a job-level timeout.
  - Skip a poll's scan when the repository commit and contract hash match the last poll.
  - Bound the dependency cache with eviction.
- **PG3 (one machine per job).** A job machine needs one performance vCPU and 8 GB, or 6 GB for the default profile alone (3 GiB container, 0.8 GiB scanners). It also needs room for a 0.5–1.3 GiB dependency archive per job when it starts cold.

## Reproduce

```bash
node scripts/capacity-inventory.mjs --take 25 --root <checkouts> --output inventory.json \
  --list docs/benchmarks/2026-10-16-stripe-active-repos.json \
  --list docs/benchmarks/2026-10-21-openai-app-repos.json \
  --list docs/benchmarks/2026-10-21-anthropic-app-repos.json \
  --list docs/benchmarks/2026-10-16-shopify-repos.json
node scripts/capacity-preparation.mjs --output preparation.json
node scripts/capacity-model.mjs
```

`capacity-inventory.mjs` fetches each repository at its frozen commit and only reads files. `capacity-preparation.mjs` reads bundle metadata from Refit's dependency cache and copies nothing that identifies a repository. Run the inventory from a pinned worktree, because each `refit` command loads the current source files.
