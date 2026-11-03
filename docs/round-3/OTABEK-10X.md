# L1: the loop (Otabek, 10x account, half the work)

Read [`README.md`](README.md) first. You run the benchmark loop, so you're the only lane that runs benchmarks.

- **Branch:** `r3/loop`.
- **Integration branch:** `r3/integration`. You merge `r3/loop`, `r3/match-memory` and `r3/cost` into it, and never into `main`.
- **Folders:** `harness/`, `evals/`, and the `MIN_TASK_USD` and budget lines in `orchestrator/deps.ts`.

## Before the first iteration

1. **Remove the $2 floor.** Delete `MIN_TASK_USD` and its checks in `orchestrator/deps.ts` and `evals/runner/real.ts`, and update their tests.
   - A task starts whenever the run cap has room for its overshoot reserve.
   - Set `--budget-usd` high enough per run that the cap never decides anything.
2. **Green baselines.**
   - Before the baseline check, the harness runs the repo's own codegen inside the sandbox: `prisma generate`, `graphql-codegen`, `buf generate`, `protoc` steps, or whatever its `postinstall`, `prepare` or build docs name.
   - Install scripts stay off for dependencies. Only the repo's own codegen runs.
   - The agent decides which steps to run, and the PR records them.
3. **Proof of each fix.**
   - The harness writes a small test for the change wherever one can be written: for example, a test that the webhook reads `items.data[0].current_period_end`.
   - It runs the test with the repo's own checks.
   - `verified` needs both to pass.
4. **The eligibility screen** (evals only).
   - A runner step checks each set repo's baseline in the sandbox and records it.
   - It writes `evals/reports/round-3/exclusions.json` with the classes from the README.
   - The practice set is every eligible repo from `stripe-dev-30`, `openai-dev-30`, `anthropic-dev-30`, `gemini-dev-15` and `longtail-dev-20`.
   - Raise `--concurrency` as far as the machine allows.
5. **Wire `watchAny`** in `evals/runner/cli.ts`, F6's one line, so the Anthropic, Gemini and long-tail sets run.

## Each iteration

Follow the README's loop.

- Read every failed or needs-review task yourself, not just the score.
- Fix causes in `harness/` and `evals/` yourself.
- Comment causes in match or memory on L2's draft PR, and causes in inventory or the changelog read on L3's.
- Log each iteration in `evals/reports/round-3/iterations.md`.

## Ending

When the score reaches 90%, or after two iterations with no gain, or at 10:30 EST:

1. Run the sealed sets once, for the providers practised on, with the same screen.
2. Write `evals/reports/round-3/REPORT.md`, using measured numbers only:

   | Item | What to include |
   | --- | --- |
   | Practice | the final score, with eligible, verified and excluded counts by class |
   | Iterations | the iteration table |
   | Sealed | the raw score and the eligible score |
   | Causes | every failure cause, with how many repos it hit and the fix, or "not fixed: why" |
   | Cost | per repo and per task, by part (watch, inventory, match, harness, review) |
   | Wall time | per repo and per task |
   | Hand-checks | the sample's agreement rate |
   | Blockers | anything the two-no-gain rule stopped on |

3. By 12:00, push `r3/loop` and open a draft PR into `main`.
4. Leave `r3/integration` pushed so we can reproduce the final run.
