# Benchmark determinism

Whether running the Stripe benchmark twice at one Refit commit gives the same result for every repository: the same outcome, stop reason, proposed patch and check results. A benchmark that moves between identical runs cannot measure a change to Refit.

## Result

The run outputs behind these counts are not committed; the counts are not backed by a committed results file.

- **Scans and proposed patches are deterministic.** Repeated at one commit, every run of each set gave the same value in every compared field for every repository, apart from the wording of one environment error. Every `scan.json` was byte-identical across runs, and so was every proposed patch.
  - Held-out set (50): four runs, two scan-only and two with `--validate`. Identical in every field; 21 `scan.json` files and 18 proposed patches identical.
  - Active set (66): three runs with `--validate`. A and B identical in every field; pass 1 differs only in the Docker error text on the 10 repositories that reached validation. 21 `scan.json` files and 10 proposed patches identical across all three.
- **Check results were not measured.** No baseline, patched or generated check ran in any pass: the laptop's Docker daemon stopped answering at about 10:18 UTC, and AWS refused every launch (see [Not measured](#not-measured)).
- **One Refit cause, now fixed.** A repository deleted upstream left an empty checkout that the benchmark read as a repository with no Stripe calls. It did not change between these runs, which share one root, but it silently changed that repository's row against the committed 2026-10-16 results. See [Differences and causes](#differences-and-causes).
- **One comparison gap, now fixed.** `scripts/stripe-benchmark-compare.mjs --details` could not compare the patch of a run that stopped before validation wrote `report.json`, which is every run in these passes. It now hashes `scan.json` and the patch inside it.

## Method

- **Commit.** Every run used one clean, detached worktree at `0935392`, so each `refit run` child loaded the same source. Node v25.8.2 on an Apple M5 laptop (macOS, APFS), 2026-10-22.
- **Sets.** The active set ([`2026-10-16-stripe-active-repos.json`](benchmarks/2026-10-16-stripe-active-repos.json), 66 repositories) and the held-out set ([`2026-10-15-stripe-heldout-repos.json`](benchmarks/2026-10-15-stripe-heldout-repos.json), 50). `node scripts/stripe-benchmark-setup.mjs` built one root per set once. Every run of a set read the same clones and contracts, so a difference cannot come from cloning or downloading again.
- **Compared fields.** `node scripts/stripe-benchmark-compare.mjs <run> <run> --details` compares, per repository:
  - outcome, traced calls, confirmed fields;
  - workflow stage, stop reason, error, patch status, SDK upgrade;
  - baseline, patched and validation statuses, type errors, generated checks;
  - the SHA-256 of `scan.json` and a hash of the full proposed patch.

  A leaf-by-leaf diff of every `results.json` field except the two timings (`seconds`, `validationSeconds`) found nothing the comparison above missed.

### Runs

| Run    | Sets             | Mode                                                                                                                                 | Time (UTC)                                                   |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Scan 1 | active, held-out | Benchmark without `--validate`                                                                                                       | 08:31–11:09 (active resumed at row 19 after the disk filled) |
| Scan 2 | held-out         | Benchmark without `--validate`                                                                                                       | 08:41–08:51                                                  |
| Pass 1 | active           | `--validate`, one repository per hold of the shared Docker lock. The daemon hung, so every validation ended at its first Docker call | 11:09–12:28                                                  |
| A      | active, held-out | `--validate` with `DOCKER_HOST` set to a socket that does not exist                                                                  | 14:42–15:25                                                  |
| B      | active, held-out | As A                                                                                                                                 | 15:25–16:02                                                  |

With `DOCKER_HOST` pointing nowhere, every `refit run` reads the repository, scans, decides its stops, proposes its patch and writes `scan.json`, then fails at its first Docker call (`docker image inspect`). The shared daemon is never contacted. Passes A and B therefore cover everything up to validation.

## Results by set

| Set      | Runs compared                | Identical in every field                       | `scan.json` identical | Proposed patches identical |
| -------- | ---------------------------- | ---------------------------------------------- | --------------------- | -------------------------- |
| Held out | Scan 1, Scan 2 (scan fields) | 50/50                                          | (no workflow)         | (no workflow)              |
| Held out | A, B                         | 50/50                                          | 21/21                 | 18/18                      |
| Held out | Scan 2, B (scan fields)      | 50/50                                          | (no workflow)         | (no workflow)              |
| Active   | Pass 1, A                    | 56/66; 10 differ only in the Docker error text | 21/21                 | 10/10                      |
| Active   | A, B                         | 66/66                                          | 21/21                 | 10/10                      |
| Active   | Scan 1, A (scan fields)      | 66/66                                          | (no workflow)         | (no workflow)              |

Outcomes in pass A:

| Outcome                                                               | Held out | Active |
| --------------------------------------------------------------------- | -------- | ------ |
| Not affected                                                          | 18       | 40     |
| No mapped Stripe methods                                              | 8        | 4      |
| Affected, no checks to run                                            | 3        | 0      |
| Refit cannot read the repository (over the scan limits)               | 0        | 1      |
| Needs review at the scan: removed request parameter                   | 3        | 8      |
| Needs review at the scan: helper callers, client origins or mutations | 0        | 2      |
| Needs review at the scan: unparseable source files skipped            | 0        | 1      |
| Needs review at the scan: no deterministic migration rule             | 1        | 0      |
| Reached validation (ended at the missing Docker socket)               | 17       | 10     |

## Differences and causes

| Difference                                                                                                                                                                            | Repositories | Cause                                                                                                                                                                                                                                                           | Kind                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `workflow.error` between pass 1 and A or B: `Command failed: docker image inspect …` alone, against the same line plus `failed to connect to the docker API at unix:///nonexistent/…` | 10 (active)  | Pass 1 reached a daemon that hung; A and B had no socket at all. Same stage, same stop, same `scan.json`.                                                                                                                                                       | Environment                              |
| `unique-point/car-trailers`: 8 SDK calls in the committed 2026-10-16 results, 0 in every run here, with the same `no-mapped-methods` outcome                                          | 1 (active)   | The repository was deleted upstream (`Repository not found`). Setup recorded the failed fetch but left the `git init` directory behind; a rerun of setup skipped it as cloned, and the benchmark read the empty directory as a repository with no Stripe calls. | Repository, exposing a Refit bug (fixed) |

### Third pass

Pass C (16:03–16:11 UTC) reran the 11 repositories that differed, the 10 above and `unique-point/car-trailers`, at the same commit and in the same mode as A and B, from a root holding only them. A, B and C are identical in every field for all 11. Across all four runs, only pass 1's `workflow.error` text differs; every `scan.json` and proposed patch matches. `unique-point/car-trailers` is `no-mapped-methods` in all four, as the old benchmark reads its empty checkout.

With the fixes below, rerunning `scripts/stripe-benchmark-setup.mjs` on the active root reports `unique-point/car-trailers` as a failure again (`remote: Repository not found`, exit 1) and leaves no checkout, where the old setup skipped it and exited 0.

### Fixes

- **Checkouts.** `scripts/stripe-benchmark-setup.mjs` and `scripts/shopify-benchmark-setup.mjs` now use the AI-app setup's `shallowCheckout`. It reuses a clone only when its `HEAD` is the pinned commit, and removes a clone whose fetch failed, so a rerun retries it and reports the failure again. Both benchmark CLIs check every checkout with the harness's `checkoutError` (`scripts/benchmark-harness.mjs`) before reading it; an empty checkout or one at another commit is recorded as a clone infrastructure error, not as a repository with no calls.
- **Comparison.** `--details` hashes `scan.json` (content-addressed: its run id hashes the contracts, repository and settings) and the proposed patch inside it when a run stopped before `report.json`. `pipeline/stripe-benchmark-compare.test.ts` covers it and failed before the change.

## Not measured

- **Check results.** Baseline, patched and generated `stripe-mock` checks need Docker. At about 10:18 UTC the laptop's daemon stopped answering after the disk filled; by 15:25 UTC its socket answered `Docker Desktop is unable to start`. Restarting Docker Desktop affects every agent on the machine, so it was left to the owner. On AWS, every `ec2:RunInstances` has been refused since about 08:20 UTC by an organization service control policy. Dependency installs, repository tests that read the clock, network or random values, and the generated checks are where check results could still vary between runs.
- **Another machine.** Every run was on macOS. The repository reader sorts directory entries (`pipeline/repository.ts`), so the scan does not depend on the file system's listing order, but no run compared macOS with Linux. CI and the AWS shards use Node 22; these runs used Node 25.
- **AI patches.** No run used `--ai`. Model output varies between calls by design; see [AI patch guard](AI-PATCH-GUARD.md).
- **Timings** (`seconds`, `validationSeconds`) vary by design and are excluded.

## Reproduce

```bash
git worktree add --detach ../refit-determinism <commit>
cd ../refit-determinism && npm ci
node scripts/stripe-benchmark-setup.mjs --root <root> --list docs/benchmarks/2026-10-16-stripe-active-repos.json
mkdir -p <runs>
for run in a b; do
  npm run benchmark:stripe -- --root <root> --output <runs>/$run --validate
done
node scripts/stripe-benchmark-compare.mjs <runs>/a/results.json <runs>/b/results.json --details
```

Prefix the benchmark with `DOCKER_HOST=unix:///nonexistent.sock` to stop every run before validation, as passes A and B did, or run it with Docker (or on AWS, [AWS benchmarks](AWS-BENCHMARKS.md)) to compare check results too. Run from a pinned worktree: each `refit run` child loads the current source files.
