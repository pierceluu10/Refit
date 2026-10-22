# Validation speed

Where validation time goes on real repositories, what was cut, and proof the cuts change no outcome. Measured locally on October 22, 2026 with `node:22-alpine`, no AI and no network during checks. Data: [`2026-10-22-validation-speed.json`](benchmarks/2026-10-22-validation-speed.json).

## Method

15 affected Stripe repositories from the frozen fresh set (`2026-10-16-stripe-fresh-repos.json`), each at its pinned commit, replayed with the exact `run.json` the October 16 fix-rate benchmark used (`refit run --config <run.json> --quiet --json`): `prepareDependencies`, the benchmark's check command, `compareTypeErrors` for type checks and stripe-mock generated checks. They cover npm and pnpm, type checks and test suites, patches with and without a stripe-node upgrade, and one repository that regressed in the October 16 run (`psykat1116/Spotify`; it passes on both sides here, which run on top of #186). Each repository ran once with an empty dependency cache (cold) and once reusing it (warm), one repository per Docker lock hold.

- **Stages** come from `validation.timings`, which this change adds to every report: wall-clock milliseconds for the committed snapshot, dependency preparation and its validation copy, baseline checks, the patch proposal, candidate builds and their own dependency preparation, patched checks and generated checks. Stages that overlap each count their own time.
- **Image start and archive extraction** are not separate stages in a run, so probe containers measured them on each repository's own dependency archive: the same sandbox with the command reading `/proc` for the time since the container's first process started, with and without the archive.

Before is Refit `5493ffa` (this branch's first commit, on top of #186); after is `00b411e`. `4130de3` then adds the Docker-host memory check below, which leaves this host (Docker Desktop with 7.75 GiB) on the measured path.

## Where the time goes

Sums over the 15 repositories:

| Stage                                          | Cold before | Cold after | Warm before | Warm after |
| ---------------------------------------------- | ----------: | ---------: | ----------: | ---------: |
| Dependency preparation                         |       565 s |      725 s |         8 s |       23 s |
| Patched dependency preparation                 |       563 s |      687 s |        23 s |       27 s |
| Baseline checks                                |       143 s |      134 s |       138 s |      129 s |
| Patched checks                                 |       154 s |      151 s |       153 s |      144 s |
| Generated checks                               |        38 s |       22 s |        37 s |       22 s |
| Patch proposal                                 |        21 s |       16 s |        19 s |       16 s |
| Candidate build (without its preparation)      |        12 s |       16 s |        10 s |       17 s |
| Dependency snapshot                            |        11 s |       12 s |        10 s |       13 s |
| Committed snapshot                             |         1 s |        1 s |         1 s |        1 s |
| Image start (probe, median per sandbox)        |      0.09 s |     0.09 s |      0.09 s |     0.09 s |
| Archive extraction (probe, median per sandbox) |      1.00 s |     0.94 s |      1.00 s |     0.94 s |
| **Wall clock, whole run**                      |  **1552 s** |  **968 s** |   **445 s** |  **260 s** |

Before, one validation was a straight line: install the baseline's dependencies, run the baseline checks, propose the patch, install the patched lockfile's dependencies from scratch (14 of the 15 patches change package files), run the patched checks, then the generated checks for each contract version. Cold, the two installs were 72% of the time (9.5 to 59 s each); warm, the two check runs were 65% (0.8 to 25 s each). Starting a sandbox (0.09 s), copying the source into it (0.05 s) and extracting the dependency archive (median 1.0 s, at most 1.9 s, for archives of 121 to 986 MiB) were small at every step.

## What changed

1. **The patched side runs alongside the baseline** (`d5a6222`). Without AI the patch proposal does not depend on the baseline, so validation proposes the patch while the baseline's dependencies are prepared, installs a patched lockfile's dependencies at the same time, and runs the patched checks beside the baseline checks. Results the sequential order would not have used are discarded unread: a failed baseline still reports the patched checks as not run, and a candidate's errors surface only when its baseline passed. Anything still running when validation returns is cancelled and awaited. AI proposals and repairs keep the sequential order, because they depend on the baseline. Test: `validation-overlap.test.ts` (fails on the sequential code).
2. **The generated Stripe checks for both contract versions run at once** (`00b411e`). Each has its own sandbox and stripe-mock. Test: `validation-overlap.test.ts`.
3. **Only when the operator opts in, on a Docker host with room for two sandboxes** (`4130de3`). The overlap, including the generated Stripe checks, is off unless `REFIT_VALIDATION_OVERLAP=1` is set (owner decision, 2026-10-22), because the memory check reads the host's total, not what other validations on it already use. The measurements below were taken with the overlap on. Two sandboxes at once peaked at 4.5 GiB here, and each may claim its 3 GiB limit. Validation overlaps only when `docker info` reports at least twice the larger of the preparation and validation memory limits plus 1 GiB (7 GiB with the default profile); otherwise, as on the hosted worker's 4 GB machine, it runs one sandbox at a time exactly as before. Test: `validation-overlap.test.ts`.
4. **Stage timings** (`5493ffa`): `validation.timings` in every report, which is how the stages above were measured. Test: `validation-untested.test.ts`.

The work each stage does is unchanged; it now overlaps. Running two installs or two type checks at once makes each a little slower (dependency preparation went from 565 to 725 s of work cold), but the wall clock fell **38% cold (1552 → 968 s, median 102 → 65 s) and 42% warm (445 → 260 s, median 26.5 → 15.8 s)**.

### Considered and not changed

- **Cloning the archive instead of copying it.** On this Mac a copy of an 853 MiB archive took about 300 ms whether or not copy-on-write was requested, so there was nothing to save.
- **Extracting dependencies once for every sandbox.** Each sandbox gets its own writable copy so the baseline, the patch and each generated run cannot see each other's changes; sharing one extraction would weaken that, to save about 1 s per sandbox.
- **Hashing the archive once instead of twice on a cache hit.** Under 1 s per validation, now overlapped with the other side's work, and the second hash checks the private copy validation actually uses.

## Same outcomes

Every repository ended the same way before and after, cold and warm: the same workflow status, validation status, baseline, patched and generated check statuses, committed-source archive hash, patch hash, and baseline and patched dependency signatures.

| Repository                           | Check      | Cold before → after | Warm before → after | Outcome before and after                               | Peak per sandbox / at once (after, warm) |
| ------------------------------------ | ---------- | ------------------: | ------------------: | ------------------------------------------------------ | ---------------------------------------: |
| Hombre2014/Genius                    | type check |           83 → 48 s |       21.4 → 13.1 s | validated, passed, patch `5e0fbd4f2325` (identical)    |                           986 / 1917 MiB |
| TechWithEmmaYT/Social-X-Clone-Course | type check |          110 → 62 s |       30.9 → 16.9 s | needs-review, passed, patch `4fab95908595` (identical) |                          1169 / 2334 MiB |
| abhiya492/ticket-saas-app            | type check |           88 → 58 s |       23.6 → 11.9 s | needs-review, passed, patch `331b1428df2b` (identical) |                          1157 / 2261 MiB |
| SudoKMaar/leaf                       | type check |          132 → 74 s |       40.4 → 18.4 s | validated, passed, patch `0a332597ea2c` (identical)    |                          1807 / 3533 MiB |
| DhavalDudheliya/DuoLingo_Clone       | type check |          104 → 62 s |       30.3 → 15.8 s | validated, passed, patch `62dee4484a0e` (identical)    |                          1437 / 2850 MiB |
| palashb01/DocuChat                   | type check |          102 → 66 s |       25.4 → 12.7 s | needs-review, passed, patch `2fd3e7da83b4` (identical) |                          1395 / 2704 MiB |
| thangtran3112/next-marketplace       | type check |          142 → 90 s |       28.0 → 14.8 s | needs-review, passed, patch `51322892c4b6` (identical) |                          1797 / 3548 MiB |
| cdinnison/goal-reminder              | type check |          102 → 65 s |       26.5 → 14.9 s | needs-review, passed, patch `7e7ab33fbc76` (identical) |                          1511 / 2953 MiB |
| Anuradha-Herath/Pinnacle             | type check |          143 → 82 s |       46.2 → 26.6 s | needs-review, passed, patch `36ce2aa187b5` (identical) |                          1876 / 3706 MiB |
| MuhammadTanveerAbbas/Clario-ai       | pnpm test  |           98 → 68 s |       14.9 → 10.1 s | validated, passed, patch `e4437c6710bd` (identical)    |                           864 / 1054 MiB |
| profullstack/vibe-stack              | pnpm test  |           48 → 30 s |       26.3 → 20.1 s | needs-review, passed, patch `c9d2151ff3fe` (identical) |                            232 / 561 MiB |
| Honey-Bagel/Milanote-Clone           | type check |          138 → 88 s |       46.1 → 26.8 s | validated, passed, patch `4288473d3995` (identical)    |                          1818 / 3518 MiB |
| vinroger/onellm-frontend             | type check |          149 → 93 s |       54.4 → 36.9 s | needs-review, passed, patch `193288fa7689` (identical) |                          1873 / 3838 MiB |
| Shivamrai15/Spotify-Clone            | node -e 0  |           34 → 30 s |         7.2 → 4.8 s | needs-review, passed, patch `e31216300a90` (identical) |                            190 / 201 MiB |
| psykat1116/Spotify                   | type check |           80 → 52 s |       23.7 → 16.3 s | needs-review, passed, patch `df8c84b867c6` (identical) |                           971 / 1874 MiB |

`needs-review` is the workflow's existing outcome when checks pass but findings remain unresolved; it is the same on both sides.

## Memory (keep going)

Peak `docker stats` memory per sandbox, sampled every second during each run, after the change:

- Dependency preparation: at most 1655 MiB (`thangtran3112/next-marketplace`, cold).
- Baseline and patched checks: at most 1913 and 1900 MiB (`Anuradha-Herath/Pinnacle`, type checks).
- Generated checks: at most 1264 MiB (`vinroger/onellm-frontend`).
- Every sandbox stayed under the 3 GiB validation limit set in 0.33.0, with at least 1.1 GiB to spare.
- Sum across the sandboxes running at the same moment: at most 4538 MiB (`SudoKMaar/leaf`, cold, both installs at once). This is why the overlap needs room for two sandboxes on the Docker host.

Sampling once a second can miss a shorter spike.

## Not verified

- Hosts other than this Mac's Docker Desktop (7.75 GiB, Apple silicon). On a smaller host validation runs one sandbox at a time, which is the before path.
- AI proposals and repairs, which still run in the sequential order.
- Network variance: cold installs fetch from the npm registry, so their times move with the network; both sides ran within the same afternoon.
