# Round 3, L1: the loop

Written 2026-11-03 by lane L1 (`r3/loop`, draft PR #485), from `r3/integration`. Every number
here was measured. Anything not measured says so.

## The headline

**Practice score 72.6%: 45 of 62 eligible repos verified in iteration 1. No sealed run yet.** The
key holder passed `ANTHROPIC_API_KEY` to each run's command, so the model ran from the afternoon
on. Iterations 2 and 3 reran 10 repos Refit had verified, each verified 9 of 9 eligible, and each
was compared with plain Claude on the same repos: the blind judge preferred plain Claude 5 to 3
both times, with 2 ties. Neither side broke a check that passed before. Refit cost $1.44 a repo in
iteration 3 against plain Claude's $0.15. See [`iterations.md`](iterations.md).

Everything the brief asked L1 to build before the first iteration is built, tested and on
`r3/integration`, and one command runs an iteration with a key passed to it:

```sh
ANTHROPIC_API_KEY=... sh evals/scripts/round3.sh 1        # screen, run every set's green repos, score
ANTHROPIC_API_KEY=... sh evals/scripts/round3-sealed.sh   # the one sealed run, after practice
```

## What L1 built

| Brief item                                      | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Where                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| Remove the $2 floor                             | Done. A task starts once the run has room for the harness's overshoot reserve (`TURN_RESERVE_USD`, $1). The runner no longer serialises spending calls; each hold charges the meter of the repo that took it, so repos run at once.                                                                                                                                                                                                                    | `ed721d60`                         |
| Green baselines: the repo's own codegen         | Done. A model (Sonnet) reads the repo's scripts, codegen config, env templates and README and names the steps install scripts off never ran, plus placeholder env. The harness runs them in the sandbox, snapshots what they wrote so it stays out of the PR, and lists them in the PR. When a check still fails, it plans once more with the failing output in hand. It never edits source; any repo file the preparation changed is named in the PR. | `3d3cf6a9`, `10b9026a`, `df952add` |
| Proof of each fix                               | Done. The agent writes a small test of the change and registers it as a check; `verified` needs it to pass, or a stated reason no test can be written.                                                                                                                                                                                                                                                                                                 | `3d3cf6a9`                         |
| Eligibility screen                              | Done. `cli.ts screen` runs the harness's own install, codegen and checks on each repo before any edit, caches the record per repo and commit, classifies each red one (red-baseline or outside-authority) and writes `exclusions.json`. A green baseline is judged on the repo's own checks. `run --screen` runs only green repos; `score3` scores verified eligible repos over eligible repos.                                                        | `19207887`, `320cec2a`             |
| A per-task ceiling                              | Added. One task holds at most `MAX_TASK_USD` ($25) however big the run, so round 3's high run caps can't let an endless agent loop spend a quarter of the run.                                                                                                                                                                                                                                                                                         | `287c1506`                         |
| Wire `watchAny`                                 | Done.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `ed721d60`                         |
| Memory learns between iterations (L2's request) | Done. The runner calls `recordRun` after each task, and one process runs every set so the memory store has one writer.                                                                                                                                                                                                                                                                                                                                 | `ce165a0f`                         |
| The sealed run                                  | Ready, not run. `sealed:<provider>` reads that provider's sealed set from git history at run time, in memory, once.                                                                                                                                                                                                                                                                                                                                    | `1d5af784`, `5b81e18e`             |

## Practice

Iteration 1 is the only run over the whole practice set. The screen, with the codegen planner,
left 86 of 125 repos green; 39 were excluded (33 red baseline, 6 outside our authority, 8.8% of
affected repos), each logged in [`exclusions.json`](exclusions.json). Of the green repos, 69 were
scored before the run was stopped: 45 verified, 17 needs-review, 7 not affected. Score: 45 of 62
eligible, 72.6%.

The dry screens before it, with no model:

| Screen                                           | Green of 125 | Notes                                                     |
| ------------------------------------------------ | ------------ | --------------------------------------------------------- |
| Dry screen 1 (no model)                          | 47           | stripe 2, openai 13, anthropic 17, gemini 6, long tail 9  |
| Dry screen 2 (no model, after the install fixes) | 55           | stripe 2, openai 15, anthropic 18, gemini 7, long tail 13 |

Without a model, the screen has no codegen planner and no placeholder env. Of the 70 still red,
the planner targets 47: 24 need a build-time env var, 13 need the Prisma client generated, and
about 10 need a subfolder install, a workspace build or a template config. With the planner, the
real screen had 86 green, 31 more than dry screen 2's 55.

## Iterations

| #   | Repos                                  | Score           | Cost a repo | Against plain Claude (judge) |
| --- | -------------------------------------- | --------------- | ----------- | ---------------------------- |
| 1   | the practice set, stopped at 69 scored | 45 of 62, 72.6% | $1.07       | not compared                 |
| 2   | 10 Refit verified in iteration 1       | 9 of 9          | $0.43       | Claude 5, Refit 3, 2 ties    |
| 3   | the same 10, every provider each uses  | 9 of 9          | $1.44       | Claude 5, Refit 3, 2 ties    |

Iterations 2 and 3 can't be compared with iteration 1: their repos were picked from its verified
ones. [`iterations.md`](iterations.md) has each iteration's commit, causes and changes, the code
check of both sides' PRs, and the two dry screens.

## Sealed

Not run. No sealed set was opened.

## Causes

Every cause the dry screens found, with its fix. These are sandbox causes, found with no model. The
causes of iteration 1's 17 needs-review repos, and of losing to plain Claude, are in
[`iterations.md`](iterations.md) with the commits that fixed them; those repos were read by hand,
not counted per cause.

| Repos   | Cause                                                                   | Fix                                                                   |
| ------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 3       | npm can't resolve a peer conflict the repo's lockfile settled           | `--legacy-peer-deps` fallback (`b3f2699b`)                            |
| 2       | Bun repos: the image has no bun                                         | bun's own release in the container (`10b9026a`)                       |
| 1       | A win32-only binding as a direct dependency                             | `--force` fallback (`65d72356`)                                       |
| 1       | A half-written `node_modules` after `npm ci` (ENOTEMPTY)                | clean it before the fallbacks (`2c1fd7b5`)                            |
| 1       | Node 12 engine pin under Yarn                                           | engine pins ignored in the sandbox (`2c1fd7b5`)                       |
| 8       | Only the harness's own fallback `tsc` fails                             | the screen judges the repo's own checks (`320cec2a`)                  |
| n/a     | Repo scripts call `pnpm` or `yarn` by name; the image has only corepack | corepack shims on PATH (`289024d7`)                                   |
| 24      | Env var read at build or test time                                      | the planner's placeholder env: not fixed until a real run proves it   |
| 13      | Prisma client never generated                                           | the planner's `prisma generate`: not fixed until a real run proves it |
| ~10     | Subfolder app, workspace package not built, template config             | the planner: not fixed until a real run proves it                     |
| 21      | The repo's own code, types or tests fail                                | not fixed: genuine red baselines                                      |
| 2       | npm crashed; a dependency missing from the registry                     | not fixed: the second is outside our authority                        |
| 1 (e2e) | The agent's own checks ran without the placeholder env                  | fixed (`df952add`), found by the Docker end-to-end                    |

## Cost

| Iteration | Total  | Repos | A repo |
| --------- | ------ | ----- | ------ |
| 1         | $73.99 | 69    | $1.07  |
| 2         | $4.29  | 10    | $0.43  |
| 3         | $14.39 | 10    | $1.44  |

Iteration 1's total covers the scored repos, not the screen or the stopped runs. Iteration 3 by
part, a repo: harness $0.45, match $0.34, memory $0.30, watch $0.28, review $0.08, inventory $0.00.
Its 34 tasks averaged $0.42 each, all parts included. Plain Claude cost $0.15 a repo; the judge
$0.72 for 10.

## Wall time

Screens only, at concurrency 5 to 6 in Docker on this laptop (14 CPUs, 7.7 GB for Docker):

- dry screen 1: 125 repos in about 57 minutes;
- dry screen 2: the 78 red ones in 51 minutes;
- one repo took 3 seconds to 11 minutes, mostly install and `next build`.

Iteration 3, checkout to graded result: 17.5 minutes a repo, of which the agent worked 6.0. Its
34 tasks ran one after another within each repo, about 5 minutes each; the slowest repos were
t2-chat (46 min, 4 tasks), backend_AgentAi (41 min, 8), lamp-bot (35 min, 5) and buddy_connect
(33 min, 5). In iteration 2, with one task a repo, every repo took 1 to 9 minutes. Plain Claude's
agent took 44 seconds a repo.

## Hand-checks

None yet: no PR has been hand-checked, so there is no agreement rate. The blind judge is not a
hand-check.

## Blockers

1. **The sealed run has not run.** No sealed set was opened.
2. **The two-no-gain rule did not decide the stop.** Iterations 2 and 3 scored a 10-repo subset at
   100%, so neither could gain; the full practice set was not rerun after iteration 1.
