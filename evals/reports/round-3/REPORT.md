# Round 3, L1: the loop

Written 2026-11-03 by lane L1 (`r3/loop`, draft PR #485), from `r3/integration`. Every number
here was measured. Anything not measured says so.

## The headline

**No scored iteration ran, and no sealed run ran.** This session has no `ANTHROPIC_API_KEY`, and
the laptop's secret-file guard stops the agent from loading one from any `.env`. Every part that
calls a model needs it: inventory, match, the codegen planner, the harness agent and the reviewer.
So there is no practice score, no sealed score, no cost per repo and no hand-check sample from this
round. What did run cost $0: two screens of all 125 practice repos without a model, unit tests,
and a Docker end-to-end of the harness with a scripted agent.

Everything the brief asked L1 to build before the first iteration is built, tested and on
`r3/integration`, and one command runs an iteration once a key is passed to it:

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

Not scored: no iteration ran. The screen is the only measurement of the practice sets.

| Screen                                           | Green of 125 | Notes                                                     |
| ------------------------------------------------ | ------------ | --------------------------------------------------------- |
| Dry screen 1 (no model)                          | 47           | stripe 2, openai 13, anthropic 17, gemini 6, long tail 9  |
| Dry screen 2 (no model, after the install fixes) | 55           | stripe 2, openai 15, anthropic 18, gemini 7, long tail 13 |

Without a model, the screen has no codegen planner and no placeholder env. Of the 70 still red,
the planner targets 47: 24 need a build-time env var, 13 need the Prisma client generated, and
about 10 need a subfolder install, a workspace build or a template config. That is what the
planner is for, not what it achieved: it has never run on a real repo.

No exclusions file was written, because the screen's classifier is a model call too.
`exclusions.json` comes from the first real screen.

## Iterations

None. See [`iterations.md`](iterations.md) for the two dry screens and every cause found.

## Sealed

Not run. No sealed set was opened.

## Causes

Every cause the dry screens found, with its fix. These are sandbox causes, found with no model.

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

$0 of model spend by L1. Nothing that calls a model ran. There is no cost per repo, per task or by
part to report.

## Wall time

Screens only, at concurrency 5 to 6 in Docker on this laptop (14 CPUs, 7.7 GB for Docker):

- dry screen 1: 125 repos in about 57 minutes;
- dry screen 2: the 78 red ones in 51 minutes;
- one repo took 3 seconds to 11 minutes, mostly install and `next build`.

No task wall time: no task ran.

## Hand-checks

None: no PR was produced, so there is nothing to hand-check and no agreement rate.

## Blockers

1. **No API key in this session.** It blocks every iteration and the sealed run. The fix is
   for the key holder to run `evals/scripts/round3.sh` with the key passed to that one command.
2. **The two-no-gain rule never ran,** since there was no iteration to compare.
