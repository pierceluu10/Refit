# Round 3: make Aptitude fix 90% of real repos

Written 2026-11-03 at 03:30 EST, from `main` at `d0b93178` (round 2 #479, #481 and #480 merged).
Hard stop at **12:00 EST today**. Every lane reads this file first, then its own file:

| Lane | Who | Plan | Share | File | Branch |
| --- | --- | --- | --- | --- | --- |
| L1 loop | Otabek, account 1 | 10x | half | [`OTABEK-10X.md`](OTABEK-10X.md) | `r3/loop` (and `r3/integration`) |
| L2 match and memory | Otabek, account 2 | 5x | a quarter | [`OTABEK-5X.md`](OTABEK-5X.md) | `r3/match-memory` |
| L3 cost | Furqan, his laptop | 5x | a quarter | [`FURQAN-5X.md`](FURQAN-5X.md) | `r3/cost` |

## Why

F6's first real benchmark (`evals/reports/2026-11-03.md`) graded 6 tasks:

- None verified, because both repos failed their own checks before any edit.
- 33 found tasks never ran, because of the $2 per-task floor.
- One Stripe upgrade became four overlapping tasks.
- The inventory and changelog read cost more than the fixes.

We need a product that really fixes repos before we can measure anything for the PearX interview.

## The goal

Fix **90% of the eligible practice repos**. Then run a sealed set once and report that score honestly, whatever it is.

- **A repo is fixed when** every change that affects it is applied, the repo's own checks pass after the edit, and the test the harness wrote for the change passes, where one can be written. In the grader's words: `verified`.
- **Eligible means** both of these:
  - the repo's own checks pass in the sandbox before any edit (a **green baseline**);
  - at least one watched change really affects it.
- **The score** is verified eligible repos divided by eligible repos.
- **Not eligible, so left out of every score and number:**
  1. **Red baseline:** the repo fails its own checks before any edit, even after the sandbox runs the repo's known codegen (see L1).
  2. **Outside our authority:** fixing it needs something we can't or shouldn't touch. Examples: real credentials or a live paid service in its tests, a private dependency, a toolchain the sandbox can't run, or an archived or read-only repo.
- **Every exclusion is logged** in `evals/reports/round-3/exclusions.json` with the repo, commit, class and one-line reason. The reasons are fixed now and can't be widened mid-run.
- **Exclusion limit:** if "outside our authority" exceeds 20% of the affected repos, stop and write it down as a blocker. Don't keep excluding.
- **Evals only:** this screen applies to benchmark sets, never to the product. Per `AGENTS.md`, the product still attempts every affected repo and says honestly what it couldn't prove.

## How the loop runs

Only L1 runs benchmarks. L2 and L3 test with fixtures and recorded responses, and push to their branches as they go.

One **iteration** (L1):

1. Merge the latest `origin/r3/match-memory` and `origin/r3/cost` into `r3/integration`, run the four checks, and push.
2. Run the practice set from `r3/integration`.
3. Score it, read every failure, and sort each into a cause.
4. Fix what's in L1's folders. Send causes in L2's or L3's folders to that lane via its draft PR, as a comment with the repo, task and what went wrong.
5. Record the iteration in `evals/reports/round-3/iterations.md`: the time, commit, eligible count, verified count, score, cost, top causes and what changed.

**When to stop practising:**

- the score reaches 90%;
- or **two iterations in a row with no gain**: write the blocker down and stop practising;
- or it's **10:30 EST**.

Whichever comes first, L1 then runs the **sealed run** (below), even if the score is below 90%.

**The sealed run** happens once, at the end:

- Use the sealed sets for the providers practised on. They're the paths `evals/sets/sealed.ts` names.
- Apply the same eligibility screen and log.
- Report:
  - the raw score;
  - the eligible score;
  - a cause-by-cause breakdown with the fix for each cause.
- Nothing is tuned after a sealed set has been opened.

**At 12:00:**

- every lane commits, pushes and opens or updates its draft PR into `main`;
- L1 writes `evals/reports/round-3/REPORT.md`.

## Rules for every lane

- **Model:** Opus 5.5 at max effort, in auto mode. Keep the laptop awake (`caffeinate -dimsu`).
- **No budget limit for this round.**
  - Remove the $2 per-task floor (`MIN_TASK_USD` in `orchestrator/deps.ts`); L1 owns that change.
  - Set run caps high enough that they never decide anything. The cap mechanism stays in code, because it's one of `AGENTS.md`'s hard limits.
  - Still report every run's cost in the iteration log.
- **AI-first:** follow `AGENTS.md`. Scanners, caches and recipes are evidence and shortcuts for the agent, never gates. Nothing silently stops a task.
- **Your folders only.**
  - `orchestrator/deps.ts` is shared. Change only your own lines and keep the diff small. L1 resolves conflicts in `r3/integration`.
  - Add dependencies to your folder's own `package.json`.
- **Sandbox:** untrusted repo code runs only in the sandbox, with install scripts off. The exception is L1's codegen step, which runs inside the sandbox.
- **Commits:** before every commit, run `npm run typecheck`, `npm run format:check`, `npm test` and `npm run build`.
  - Use conventional commits, authored as yourself.
  - No Co-Authored-By, no "Generated with", no session links.
- **Secrets:** read only `.env` templates in product code. Never print or commit a key.
  - Pass your own key to a single command only.
  - Before each commit, check that `.env` is ignored and grep the staged diff for secrets.
- **Git safety:** never force-push. Never push to or merge into `main`. All work lands as draft PRs.
- **Sealed sets:** never open one, except in L1's single sealed run at the end.
- **Honest numbers:** measured or not stated. Hand-check a sample of verified PRs, at least 10, or all of them if there are fewer, so "verified" can't hide a bad edit like deleted code or skipped tests. Record the agreement rate.

## Setup (each laptop)

```bash
git clone https://github.com/pierceluu10/Refit.git   # or git fetch in an existing clone
cd Refit && git fetch origin
git switch -c <your branch> --no-track origin/main
npm ci --ignore-scripts
```

- Node 24 or later.
- Docker running.
- `ANTHROPIC_API_KEY` in a gitignored `.env`, passed to a single command only.
