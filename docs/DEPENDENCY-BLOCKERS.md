# Dependency blockers

This page is a census of every blocker on today's main, taken so each dependency lane knows how many repositories it can unlock. It also records why the committed-source limit was raised (founders' decision, 2026-10-27: Refit must get past dependency blockers so more fixes are tested and validated).

The per-row census is [`benchmarks/2026-10-27-blocker-census.json`](benchmarks/2026-10-27-blocker-census.json). Each row lists every blocker it has, with the evidence for it, not only the first one that stopped it.

## How it was taken

The baseline runs were made on refit-dev/refit-bench with `benchmark.yml` at main `89f1c0ed59809eedfd247526f7f1a770af7447d6`:

| Set            | Run         | Inputs                                                                 |
| -------------- | ----------- | ---------------------------------------------------------------------- |
| l2-push-249    | 40624045392 | `-f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249` |
| l2-push-249 AI | 40624062726 | same, `-f ai=true -f ai_budget=200`                                    |
| heldout-30     | 40624069371 | `-f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30`    |
| heldout-30 AI  | 40624075884 | same, `-f ai=true -f ai_budget=30`                                     |

For each run, the `merged` and `shard-*` artifacts were downloaded and this was run:

```bash
node scripts/validation-funnel.mjs <merged>/results.json --all-blockers --artifacts <download dir> --json
```

`--all-blockers` reads each row of `results.json`. For causes the results do not record (finding reasons, the stripe-node upgrade, the type oracle, baseline output), it reads the row's `report.json.gz` from the shard artifacts. Where neither has the cause, the evidence says `not recorded`. That happened once: pretzelai/stripe-no-webhooks's baseline failure in both l2-push-249 runs.

Rows without a report (15 of 249 and 3 of 30) are rows where the scan stopped before writing one. The census reads them from `results.json` alone.

## Census

"Rows" counts the rows that have a blocker. "Only" counts the rows where it is the only blocker, so clearing it alone would unblock them. Every row in both sets is affected. Rows with no blocker are the validated ones: a validated row lists none, including in the AI runs, where the AI patch cleared untraced reads under D2b on 4 l2-push-249 rows and 1 heldout-30 row.

Two blockers sit outside the dependency lanes but hold drafts with passing checks. `kept-untyped-property` is the `subscription_data.trial_from_plan` restore of decision 4 (#285), read from the report's `validation.repair.keptProperties`. `checks-miss-changed-code` is a passing grade-D draft, where no check reached the changed code. `review-not-recorded` would catch any other `[Needs review]` row with no named blocker; none remains.

| Blocker                                   | l2-push-249: rows | only | l2-push-249 AI: rows | only | heldout-30: rows | only | heldout-30 AI: rows | only |
| ----------------------------------------- | ----------------: | ---: | -------------------: | ---: | ---------------: | ---: | ------------------: | ---: |
| source-archive-limit                      |                 0 |    0 |                    0 |    0 |                0 |    0 |                   0 |    0 |
| dependency-tree-too-large                 |                 1 |    0 |                    1 |    0 |                0 |    0 |                   0 |    0 |
| no-lockfile                               |                18 |    5 |                   18 |    5 |                1 |    0 |                   1 |    0 |
| lockfile-out-of-sync                      |                10 |    4 |                   10 |    4 |                1 |    1 |                   1 |    1 |
| lockfile-integrity                        |                 7 |    1 |                    7 |    1 |                0 |    0 |                   0 |    0 |
| non-registry-source                       |                 6 |    2 |                    6 |    2 |                2 |    0 |                   2 |    0 |
| conflicting-dependency-files              |                 7 |    2 |                    7 |    2 |                3 |    0 |                   3 |    0 |
| unsupported-lockfile-or-workspace         |                 4 |    0 |                    4 |    0 |                0 |    0 |                   0 |    0 |
| stripe-outside-root-package               |                 2 |    0 |                    2 |    0 |                0 |    0 |                   0 |    0 |
| peer-dependency-conflict                  |                 0 |    0 |                    0 |    0 |                0 |    0 |                   0 |    0 |
| install-timeout                           |                 0 |    0 |                    0 |    0 |                0 |    0 |                   0 |    0 |
| submodule                                 |                 5 |    1 |                    5 |    1 |                0 |    0 |                   0 |    0 |
| preparation-other                         |                 0 |    0 |                    0 |    0 |                0 |    0 |                   0 |    0 |
| stripe-upgrade-refused-peer               |                 5 |    0 |                    5 |    0 |                0 |    0 |                   0 |    0 |
| stripe-upgrade-refused-dependency-changes |                 0 |    0 |                    0 |    0 |                0 |    0 |                   0 |    0 |
| stripe-upgrade-refused-other              |                21 |    0 |                   21 |    0 |                4 |    0 |                   4 |    0 |
| new-type-errors-after-upgrade             |                12 |    0 |                   12 |    0 |                0 |    0 |                   0 |    0 |
| baseline-failed-prisma-client             |                 0 |    0 |                    0 |    0 |                0 |    0 |                   0 |    0 |
| baseline-failed-next-env                  |                 0 |    0 |                    0 |    0 |                0 |    0 |                   0 |    0 |
| baseline-failed-other                     |                 9 |    2 |                   10 |    2 |                1 |    0 |                   1 |    0 |
| no-runnable-check                         |                 6 |    4 |                    6 |    4 |                2 |    2 |                   2 |    2 |
| check-timeout                             |                 1 |    0 |                    1 |    0 |                0 |    0 |                   0 |    0 |
| check-error                               |                 0 |    0 |                    0 |    0 |                0 |    0 |                   0 |    0 |
| patched-check-failed                      |                 3 |    0 |                    4 |    0 |                0 |    0 |                   0 |    0 |
| pmt-rename-dropped-api-version-kept       |                 9 |    0 |                    8 |    0 |                0 |    0 |                   0 |    0 |
| pmt-rename-dropped-configured-migration   |                 0 |    0 |                    0 |    0 |                0 |    0 |                   0 |    0 |
| pmt-rename-dropped-unresolved-api-version |                 5 |    0 |                    5 |    0 |                0 |    0 |                   0 |    0 |
| pmt-rename-dropped-no-literal-pin         |                 0 |    0 |                    0 |    0 |                0 |    0 |                   0 |    0 |
| pmt-rename-dropped-stripe-upgrade         |                18 |    0 |                   18 |    0 |                3 |    0 |                   3 |    0 |
| pmt-rename-dropped-other                  |                 0 |    0 |                    0 |    0 |                0 |    0 |                   0 |    0 |
| pmt-outside-creation-call                 |                 4 |    0 |                    4 |    0 |                0 |    0 |                   0 |    0 |
| removed-request-parameter-other           |                 7 |    0 |                    7 |    0 |                1 |    0 |                   1 |    0 |
| untraced-api-version                      |                15 |    0 |                   16 |    0 |                0 |    0 |                   0 |    0 |
| api-version-default                       |                 4 |    0 |                    4 |    0 |                0 |    0 |                   0 |    0 |
| api-version-unconfirmed                   |                 7 |    0 |                    7 |    0 |                0 |    0 |                   0 |    0 |
| api-version-kept                          |                13 |    0 |                   12 |    0 |                0 |    0 |                   0 |    0 |
| contract-change                           |               102 |   10 |                  102 |   10 |                9 |    0 |                   9 |    0 |
| untraced-reads                            |                82 |   17 |                   78 |   13 |               10 |    6 |                   9 |    5 |
| source-evidence-other                     |                30 |    1 |                   30 |    1 |                0 |    0 |                   0 |    0 |
| webhook-version                           |                 8 |    0 |                    9 |    0 |                0 |    0 |                   0 |    0 |
| kept-untyped-property                     |                 4 |    4 |                    5 |    4 |                0 |    0 |                   0 |    0 |
| checks-miss-changed-code                  |                 9 |    0 |                    8 |    0 |                1 |    1 |                   1 |    1 |
| ai-patch-review                           |                 0 |    0 |                    1 |    0 |                0 |    0 |                   0 |    0 |
| infrastructure                            |                 1 |    0 |                    2 |    0 |                0 |    0 |                   0 |    0 |
| no-patch                                  |                 6 |    0 |                    6 |    0 |                1 |    0 |                   1 |    0 |
| review-not-recorded                       |                 0 |    0 |                    0 |    0 |                0 |    0 |                   0 |    0 |
| (no blocker)                              |                84 |    – |                   88 |    – |               10 |    – |                  11 |    – |

By lane:

| Lane group                                                   | l2-push-249: rows | only | heldout-30: rows | only |
| ------------------------------------------------------------ | ----------------: | ---: | ---------------: | ---: |
| Dependency preparation (source limit to `preparation-other`) |                60 |   15 |                7 |    1 |
| Preparation and the stripe-node upgrade                      |                78 |   18 |                7 |    2 |

The AI runs have the same counts by lane. Most rows have several blockers: clearing one preparation blocker gives a validation run, and the row's other blockers then decide its draft.

### Reading the catch-all rows

- **stripe-upgrade-refused-other (21):**
  - 8 have no root lockfile Refit can upgrade ("Only root npm, pnpm or Yarn 1 projects … are upgraded").
  - 5 lock stripe only below the project root.
  - 2 have two lockfiles that lock different stripe releases.
  - 1 is a yarn.lock that locks stripe for more than the root declaration.
  - 1 is a pnpm-lock.yaml not in pnpm formatting.
- **stripe-upgrade-refused-peer (5):**
  - stripe 23.0.0 needs `@types/node >=20`, which the repository does not provide.
- **source-evidence-other (30):**
  - 24 are clients or responses that may be mutated or escape through an alias.
  - 4 are declared-type reads that may be mutated.
  - 1 is an expand of a removed field.
  - 1 is `invoices.retrieveUpcoming`.
- **baseline-failed-other (9):**
  - The repositories' own failing tests (one per row).
  - One `native-build-required`.
  - One not recorded.
  - No row failed its baseline on a missing Prisma client or `next-env.d.ts`.
- **dependency-tree-too-large (1):**
  - marketstandard/onix: Yarn 1 ran out of space in the 4g workspace.
- **infrastructure (1):**
  - SimplerDevelopment/SimplerDevelopment wrote no manifest; the harness time limit killed it, or it crashed. The artifacts do not say which.

## Committed source limit

Validation copies the committed source (`git archive`) into the sandbox workspace beside the unpacked dependency archive. It buffers the source once on the host to hash it. The limit protects both. The previous limits were 256 MiB under the `4g` profile and 50 MiB under the others.

### Measured sizes

The committed trees of the 597 tuned-set repositories in `f5-tuned-sets.json` were measured with `git archive` at the pinned commits:

- 596 trees were read.
- The largest is kipp9165/codex-labs-homepage at 155.5 MiB.
- 16 are over 50 MiB and none over 256 MiB. Those 16 are frozen as [`subsets/source-limit-50.json`](benchmarks/subsets/source-limit-50.json).
- No run in the 159 recent refit-bench runs searched refused a row at 256 MiB.

So at the default `4g` profile the limit stopped nothing measured. It stopped rows only under `--validation-workspace 2g` and smaller.

### New limits

| Profile        | Workspace      | Dependency archive | Source limit before | Source limit now |
| -------------- | -------------- | ------------------ | ------------------: | ---------------: |
| `4g` (default) | 4 GiB          | 2 GiB              |             256 MiB |          512 MiB |
| `2g`           | 2 GiB          | 1 GiB              |              50 MiB |          256 MiB |
| `1g`, `512m`   | 1 GiB, 512 MiB | 512 MiB, 256 MiB   |              50 MiB |           50 MiB |

Why these limits:

- **`4g`:** a full dependency archive plus 512 MiB of source leaves 1.5 GiB of the workspace for build and test output. 512 MiB is 3.3 times the largest tree measured.
- **`2g`:** 256 MiB of source leaves 768 MiB beside a full 1 GiB archive, and covers every tree measured.
- **Smaller profiles** keep 50 MiB; they have little room left after the archive.
- A limit is kept everywhere: a repository that commits build output or media past it still gets the refusal message, which says what to remove.

Not measured: the host-side buffer is about the size of the archive, up to 512 MiB under `4g`, and has not been measured on the Fly worker. The test `pipeline/validation-source-limit.test.ts` archives 300 MiB under `4g` and refuses it under `2g`.

### Before and after

- **2g subset:**
  - Runs: before 40625949948 at `fffa3ad5`, after 40625956831 at `2d6f499c`, both on `subsets/source-limit-50.json` with `--validation-workspace 2g`, no AI.
  - Before, 8 of the 16 rows were refused with "Committed source exceeds the 50 MiB validation archive limit." After, none were. The other 8 stop before validation in both runs.
  - Shefaul-22/AgriFlow validates at grade C.
  - mouhamedanflosse/digitalHome and shivamm-55/HippoSphere pass their checks at C, and CRONANANI/EzanaFinance3 at D. All three stay `[Needs review]` on their other blockers.
  - Traviseric/arxmint and Eziox-Development/eziox-web reach preparation and stop on lockfile integrity and an out-of-sync lockfile.
  - RaulRicco/CashBack's preparation fails.
  - SimplerDevelopment/SimplerDevelopment writes no manifest, as it does at `4g`.
  - The four passing patches are reviewed in `benchmarks/fix-reviews.json`.
- **Default `4g`, both sets:**
  - Runs: after 40625964049 (l2-push-249) and 40625971542 (heldout-30) at `2d6f499c`, against the no-AI baselines above.
  - 0 outcome changes in 249 and 30 rows.
  - heldout-30's 27 patches are byte-identical. In l2-push-249, 233 of 234 are; kondax-com/Bocker differs because its own tests are flaky. The two baselines at the same commit already disagree on it (a regression in 40624045392, a baseline failure in 40624062726). Its patch differs only in where the subscription-period helper is written, inline or in its own file; the source limit does not touch that.
  - The AI runs were not repeated after the change: the limit is checked before any patch is validated and changes nothing at `4g`.
