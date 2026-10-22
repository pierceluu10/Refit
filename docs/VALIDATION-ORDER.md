# Validation order

On the 2026-10-22 AWS smoke run (commit `87a33d7`, one `c7i.large` shard), `hackerai-tech/hackerai` at `49c12ea` took 3,317 seconds. The row put 3,090 of them in `validationSeconds` and ended as `workflow missing-manifest`. This page records why, how much time scan-stage stops cost across the committed results, and what changed.

## What happened

**hackerai never reached validation.** `refit run` stops it at the scan stage, before dependency preparation or any check runs. Its traced `checkout.sessions.create` call still sends `payment_method_types` with values other than the reviewed `['card']` rename, and the endive contract removed that parameter. Locally, with Docker unreachable, `refit run` on the same repository, contracts and `run.json` the harness writes returned `needs-review` at stage `scan`: in 86 seconds at `main` (`7b2c86a`) and in 112 seconds at `87a33d7`, with the same run id. Docker was never contacted.

**`validationSeconds` is the whole `refit run` child.** The harness starts a timer before it spawns `refit run`, and stops it after the child ends (`pipeline/stripe-benchmark-cli.ts:306–342` at `7b2c86a`). The child scans the repository again with the workflow's options, then applies the workflow's stops. On a scan-stage stop, `validationSeconds` is a second scan and the cost of starting a process, not validation.

**`missing-manifest` means the child ended without writing a manifest.** At `7b2c86a`:

- `refit run` writes `manifest.json` only in `finish` (`pipeline/workflow.ts:93–113`). It calls `finish` on every return, and on every `Error` it catches (`workflow.ts:309`).
- The harness runs the child with a 20-minute `execFile` timeout, which sends `SIGTERM` (`stripe-benchmark-cli.ts:27` and `:330`). Its `catch {}` discarded the exit (`:332`).
- It then read the manifest with a `'{}'` fallback (`:335–336`). It recorded `outcome.status ?? 'missing-manifest'` (`:344`).

So the child was killed by a signal or crashed, and the row could not say which. `refit run` installs no `SIGTERM` handler. Locally, a child stopped by the same kind of timeout ended about 100 ms after its limit (20,106 ms with a 20-second limit) and left no manifest.

**Why it took 51 minutes on `c7i.large` is not proven.** The child ran 3,090 seconds against a 1,200-second limit, so it lived about 31 minutes past its `SIGTERM`. A local scan takes 44 to 112 seconds. Starvation fits these numbers better than a slow scan:

- A `c7i.large` has 2 vCPUs and 4 GiB of memory and no swap.
- During the child's scan, two Node processes were alive. The harness peaked at 1.32 GB resident after its own three scans, and it holds its heap while it waits. The child peaks at 1.33 to 1.45 GB.
- The kernel, `dockerd` and the page cache for two Node runtimes also share the 4 GiB. Without swap, Linux evicts the executables' pages and processes stall, sometimes for minutes, before the OOM killer acts.

The V8 heap limit is not the cause on its own. Under the 2,096 MiB limit Node picks on a 4 GiB host, hackerai's `refit run` finished in 44.5 seconds at 1.45 GB.

Two checks that would settle the cause were not run:

- A container emulating the instance (`--memory 4g --memory-swap 4g --cpus 2`): Docker Desktop on the lane's host stopped starting on 2026-10-22.
- The shard's `boot.log` or kernel log from S3: this lane has no AWS access.

The harness's own comment already sizes validation for an 8 GiB host at concurrency 2. Each validation container may use 3 GiB, so `--validate` on a 4 GiB instance cannot fit a container next to the harness at all.

## The order inside the workflow

`runWorkflow` scans once (`workflow.ts:177` at `7b2c86a`). It then stops, in this order, before validation:

1. A migration review reason: removed request parameters, unparseable sources, or declared types without SDK evidence.
2. API-version applicability.
3. Call sites traced to unresolved breaking operations.
4. Breaking changes outside the supported rules.
5. No confirmed usage.
6. With publication only, an existing Refit PR.
7. No deterministic patch without AI.

Every one of these is decided on the scan alone, and every one comes before `validateMigration` (`workflow.ts:248`). Dependency preparation and checks run only inside `validateMigration`.

Inside `validateMigration`, two static stops follow the baseline check (`pipeline/validation.ts`, owned by OP4 and not changed here):

- "No supported patch proposal" (`validation.ts:556`). For deterministic runs the workflow's step 7 already stops these, unless the committed snapshot scans differently from the working tree.
- The API-version weakening check on the candidate (`validation.ts:598`).

Neither message appears in any committed results file, so this order costs nothing measurable today.

The Shopify benchmark already starts `refit run` only for repositories whose in-process scan proposed a patch (`pipeline/shopify-benchmark-cli.ts:173`).

## What changed

- `pipeline/workflow.ts` exports the scan-stage stops as `scanReviewReason` (steps 1–5) and `proposalReviewReason` (step 7). `runWorkflow` calls them in the same places, so its behavior does not change.
- The Stripe benchmark makes the workflow's own scan in-process, with the inputs `run.json` gives `refit run`, and applies those two functions (`workflowScanStop` in `pipeline/stripe-benchmark.ts:216`). On a stop, it records the same `workflow` summary `refit run` would have written (`needs-review`, stage `scan`, the reason) and starts no child. It starts `refit run` only for repositories that get past every scan-stage stop. If the in-process scan fails, the decision is left to `refit run`, which records the error.
- When `refit run` leaves no manifest, `workflow.error` now says why (`workflowExitReason`, `stripe-benchmark.ts:238`):
  - stopped at the harness limit, with the signal;
  - killed by a signal, such as `SIGKILL` from the OOM killer;
  - exited with a code and its last stderr line, such as a V8 heap crash;
  - a spawn or output-buffer failure.
- Each row has `stageSeconds`, the seconds per harness stage, each measured from the end of the previous stage:

  | Stage            | What runs                                                                    |
  | ---------------- | ---------------------------------------------------------------------------- |
  | `read`           | Reading the repository.                                                      |
  | `coverage`       | SDK call-site coverage.                                                      |
  | `shippedAdapter` | Scan with Refit's shipped Stripe adapter.                                    |
  | `fullAdapter`    | Scan with the repository's generated adapter.                                |
  | `productionMode` | `--full-diff` scan.                                                          |
  | `workflowScan`   | The workflow's scan and its scan-stage stops (`--validate`, checkable only). |
  | `workflow`       | The `refit run` child (validation), the same span as `validationSeconds`.    |

  A row that ends early has only the stages it reached.

`validationSeconds` keeps its meaning and is present only when `refit run` ran.

The cost: a repository that reaches validation is now scanned with the workflow's options twice, once in the harness and once in `refit run`. On the 20 repositories below, that added 6.0 seconds across the 9 that reached validation. The harness process also peaks higher: its largest resident size in the run rose from 1.56 GB to 2.01 GB on macOS. During validation that process stays alive next to `refit run` and its container, as it did before.

## Waste in the committed results

No committed results file has `validationSeconds` or a `missing-manifest` row. The table counts rows whose `refit run` stopped on its scan alone after the harness had spawned it (checks other than `none`), from each row's recorded reason. Rows record only total seconds, so the last two columns are an upper bound on the time the second scan cost.

| Set (Refit commit)                               | Rows | Spawned `refit run` | Stopped at scan | Their total seconds | Slowest, seconds                 |
| ------------------------------------------------ | ---: | ------------------: | --------------: | ------------------: | -------------------------------- |
| `2026-10-16-stripe-fresh` (`6733a99`)            |  381 |                 146 |             136 |                 968 | thematters/matters-server, 47    |
| `2026-10-16-stripe-fixrate-fresh` (`7238e46`)    |  381 |                 154 |              61 |                 537 | thematters/matters-server, 54    |
| `2026-10-16-stripe-active` (`7238e46`)           |   66 |                  11 |               8 |                 440 | qesmsep/noir-crm-dashboard, 88   |
| `2026-10-16-stripe-fixrate-original` (`7238e46`) |  100 |                  35 |              10 |                  57 | pretzelai/stripe-no-webhooks, 14 |
| `2026-10-16-stripe-fixrate-heldout` (`7238e46`)  |   50 |                  20 |               6 |                  31 | kalibani/HireFazz, 9             |
| `2026-10-16-stripe-fixrate-yarn-4g` (`fecd935`)  |    4 |                   4 |               0 |                   0 | –                                |

On a well-sized host the second scan cost at most 16 minutes per 381-repository set, a few seconds per repository. The 51 minutes on hackerai came from the instance, not from the order. A static preparation refusal (`refused-for-validation`, 29 rows and 710 seconds in fixrate-fresh) is decided inside `validateMigration` before any container starts. It still pays for the preflight re-scan, the image lookup and the snapshot extraction.

## Before and after on 20 repositories

20 repositories from `2026-10-16-stripe-fresh-repos.json`, hackerai first among them:

- 8 checkable ones that stop at the scan stage;
- 9 that reach validation;
- 3 the harness never validates.

Both runs used one pinned, clean detached worktree, at `7b2c86a` (before) and at `de776bb` (after):

```bash
node scripts/stripe-benchmark-setup.mjs --root <root> --list <20-repository list>
DOCKER_HOST=unix:///nonexistent/refit-pp2-no-docker.sock npm run benchmark:stripe -- --root <root> --output <new-dir> --validate
```

`DOCKER_HOST` pointed at a missing socket, so no repository code ran, and the 9 repositories that reached validation ended at the Docker image check in both runs. The comparison covers every row field except `seconds`, `validationSeconds` and `stageSeconds`. **All 20 rows are identical.**

| Repository                                                           | Outcome           | Before, s | After, s | `refit run` before, s | `refit run` after, s |
| -------------------------------------------------------------------- | ----------------- | --------: | -------: | --------------------: | -------------------: |
| hackerai-tech/hackerai                                               | needs-review/scan |       179 |      151 |                    43 |                    – |
| zainulabedeen123/Best-Saas-Kit--V2                                   | needs-review/scan |         8 |        6 |                     3 |                    – |
| RicardoGEsteves/next-digital-marketplace                             | needs-review/scan |         4 |        3 |                     2 |                    – |
| helloworld9912/Stripe-Account-Migration                              | needs-review/scan |         4 |        3 |                     1 |                    – |
| KiranRevanna1/taxonomy                                               | needs-review/scan |         5 |        4 |                     1 |                    – |
| tomsoderlund/login-as-a-service                                      | needs-review/scan |         4 |        3 |                     1 |                    – |
| mouhamedanflosse/digitalHome                                         | needs-review/scan |         4 |        3 |                     1 |                    – |
| ARCPrivus2026/ARCPrivus-AI-Madre                                     | needs-review/scan |         6 |        6 |                     2 |                    – |
| Shivamrai15/Spotify-Clone                                            | error/validation  |         4 |        4 |                     1 |                    1 |
| DeepRahangdale/Concierge-AI                                          | error/validation  |         4 |        4 |                     2 |                    1 |
| PedroPini/ScaleNext                                                  | error/validation  |         7 |        6 |                     2 |                    2 |
| krishvsoni/Scrimble                                                  | error/validation  |         5 |        5 |                     1 |                    1 |
| gjlander/backend-lazypress                                           | error/validation  |         4 |        4 |                     1 |                    1 |
| mahin67580/FoodieFrog                                                | error/validation  |         7 |        9 |                     2 |                    3 |
| MeldinRadoncic/TriboAI                                               | error/validation  |         5 |        5 |                     2 |                    1 |
| Neddie28/Spotify-Clone                                               | error/validation  |         5 |        5 |                     2 |                    1 |
| 4NDR3S-01/StyleHub                                                   | error/validation  |        15 |       18 |                     5 |                    5 |
| workos/next-b2b-starter-kit                                          | no `refit run`    |         1 |        1 |                     – |                    – |
| szymontex/donata                                                     | no `refit run`    |         3 |        3 |                     – |                    – |
| removisionscodefindersplatform-art/RemoVisions-Code-Finders-Platform | no `refit run`    |         2 |        3 |                     – |                    – |
| **Total**                                                            |                   |   **276** |  **246** |                **72** |               **16** |

The whole run took 277 seconds before and 245 after. The 8 scan-stage stops spent 54 seconds in `refit run` before; after, their in-process workflow scans took 40.3 seconds and no child started. hackerai's stages after the change were:

| Stage            | Seconds |
| ---------------- | ------: |
| `read`           |     0.4 |
| `coverage`       |    19.8 |
| `shippedAdapter` |    53.2 |
| `fullAdapter`    |    20.4 |
| `productionMode` |    20.6 |
| `workflowScan`   |    36.4 |

Timings come from a laptop shared with other agents, so differences of a second or two between rows are noise.

## Not verified

- The memory explanation for the 3,090 seconds on `c7i.large`: neither the instance emulation nor the shard's logs were available (see above).
- Outcomes with Docker validation: the 9 rows that reached validation ended at the image check in both runs. The change does not alter what `refit run` does once it starts, but no validation ran in this comparison.
