# Refit overnight 3: Stripe launch (15 lanes)

Fifteen lanes, **5 each for Pierce, Otabek and Furqan**, one Claude Code session per lane, all night. Every lane works on **Stripe only**. Tonight is about depth, not breadth: by morning, a team that installs the Refit Agent GitHub App on a TypeScript or JavaScript Stripe repository should get a correct, validated draft PR, or a clear explanation of why not, with Refit's **default** settings and no operator in the loop.

This file replaces the October 22 plan (60 lanes) and supersedes PR #244. Every lane reads it from the root of `main`.

- **Benchmarks run on GitHub Actions** in `refit-dev/refit-bench` ([guide](docs/GITHUB-BENCHMARKS.md)), never on a laptop and never on AWS tonight.
- **Production tests run on Fly** (`refit-hosted`), and only lane P1 touches Fly.
- **Lane P5 integrates**: it merges lanes' PRs into `main` overnight when they meet the bar below, so the night ends with one tested `main`, not 15 open branches.

## Contents

1. [Launch bar](#launch-bar-what-ready-means-in-the-morning)
2. [Owner decisions for tonight](#owner-decisions-for-tonight)
3. [Where Stripe stands tonight](#where-stripe-stands-tonight)
4. [Shared rules](#shared-rules)
5. [Benchmark protocol (GitHub Actions)](#benchmark-protocol-github-actions)
6. [The decision bar for changing a default](#the-decision-bar-for-changing-a-default)
7. [Slices, merging and the board](#slices-merging-and-the-board)
8. [File ownership](#file-ownership)
9. [Preflight](#preflight-each-person-before-starting)
10. Lanes: [Pierce](#pierce-production-ai-customer-path-integration), [Otabek](#otabek-production-gate-validation-evidence-preparation-truth-benchmarks), [Furqan](#furqan-tracing-rules-and-upgrades)
11. [Ready to paste](#ready-to-paste)
12. [Morning checklist](#morning-checklist-for-the-owner)

## Launch bar: what "ready" means in the morning

Measured by P5's final GitHub Actions run of the merged `main`, with **default settings** (the same defaults a hosted customer gets: full contract diff on, no AI in the benchmark), on the four frozen Stripe sets (597 repositories) and on the [night set](#the-night-set) nobody tuned on:

1. **Zero wrong edits.** Every validated fix on the merged `main` is read in full and labelled in `docs/benchmarks/fix-reviews.json`. Any `wrong` verdict blocks launch; the lane that caused it fixes it before cutoff, or P5 reverts it.
2. **Production mode is the headline.** The number reported is what a customer gets with `fullDiff` on, not the benchmark-only mode. Today these differ (see [where Stripe stands](#where-stripe-stands-tonight)); tonight they must match, or the gap is explained per repository.
3. **Fix rate.** At least **70% of affected repositories with runnable checks** end in a validated draft (the [Stripe plan](docs/STRIPE-PLAN.md#goal-finish-the-stripe-agent-set-october-20-2026) target), and the night set lands within 10 points of the tuned sets. If the rate falls short, every remaining stop is a named reason with a count, and none is "not built yet".
4. **The customer path works unattended on Fly.** At least 25 `refit-dev` forks go through install, approval, validation and draft publication on the hosted worker, with outcomes matching the benchmark's predictions, no operator edits to `.refit.json`, and no job lost to throttling or a deploy.
5. **Every number is reproducible.** Each figure in `docs/BENCHMARKS.md` names its GitHub Actions run id, the pinned commit and the command, and has a claim in `docs/benchmarks/claims.json`.

Stretch: a second consecutive Stripe release is handled without anyone moving the baseline by hand (P4).

## Owner decisions for tonight

Pierce (owner) decided these on 2026-10-24 before the run. Quote them when you rely on them.

1. **Gate changes with evidence.** Pierce signed off "on everything that will improve Refit towards being an automated API fixer". A lane may change a default or widen an automatic edit **only** when it meets [the decision bar](#the-decision-bar-for-changing-a-default), and it records the change in `AGENTS.md` as an owner decision dated 2026-10-24 that cites this sign-off and links the evidence. Below the bar, the change stays behind an off-by-default flag and goes to the morning list.
2. **Overnight merges.** Lane P5 merges PRs into `main` overnight after its review and checks. No other lane merges, pushes to `main` or force-pushes.
3. **AI budget: three $40 OpenAI keys, one per person.** Any lane may use AI where it measures something; spend it on evidence, not on repeating the same full pass. Past runs cost cents (531 repositories for $0.07; 17 coding-agent runs for $6.45), so the caps below are ceilings, not targets.
   - **Pierce's key ($40):** P2 $20 locally, P1 $10 on the Fly worker, $10 for AI runs on GitHub Actions by any lane. The key is the `OPENAI_API_KEY` secret of `refit-dev/refit-bench`; dispatch with `-f ai=true -f ai_budget=<N>`, N at most $5 per run (the workflow refuses more than $20 and splits N across shards, so a run cannot exceed it).
   - **Otabek's key ($40):** $8 for each of O1 to O5, locally. **Furqan's key ($40):** $8 for each of F1 to F5, locally.
   - **Local setup, once per person:** the person (not an agent) writes `~/.refit/overnight-ai.env` (mode 600) with `OPENAI_API_KEY=…` and `OPENAI_MODEL=gpt-5.6-luna`. Each lane copies it to `~/.refit/overnight-ai-<lane>.env` with `cp`, appends `REFIT_AI_BUDGET_USD=8` and `REFIT_AI_BUDGET_DIRECTORY=$HOME/.refit/ai-budget-<lane>`, and passes it with `--env`. Never print or `cat` either file.
   - **Each person also sets a $40 monthly limit on their key's project in the OpenAI dashboard**, so a bug cannot spend past it.
   - Post every AI run's spend on the board (`AI <lane> $<spent> <run id or command>`). P5 stops further AI runs on a key whose posted total passes $35.
4. **Fly is for production tests, by P1 only.** P1 may deploy merged `main`, scale the machine, set the AI cap within its $10, fork benchmark repositories into `refit-dev`, approve them and let Refit Agent open draft PRs on those forks. Nobody else runs a Fly command that changes state.
5. **PR #244** (Otabek's 90-lane plan) is superseded by this file. Its general-finder ideas wait until Stripe is launched.

These earlier decisions stay in force, whatever a lane finds:

- Refit never merges a customer's PR, and never drops or silently changes a removed request parameter. The `payment_method_types` card rule and the `keep-listed` opt-in in `AGENTS.md` stand unless lane F2 meets the decision bar for a specific, documented widening.
- Webhook reads are never rewritten to the new shape only. A webhook payload arrives at the endpoint's API version, not the client's.
- No live call to Stripe, OpenAI or any vendor API from a lane, except OpenAI model requests within the AI budget above. Reading public documentation pages is fine.
- Every other decision recorded in `AGENTS.md`.

## Where Stripe stands tonight

Read this before your lane, then check it against the repository: numbers move as PRs merge.

- **Fix rate, benchmark mode.** On October 20, 102 of 231 affected repositories in the 531 older-set repositories validated (44%), plus 1 of 22 on the 66-repository active-teams set ([Stripe plan](docs/STRIPE-PLAN.md)). That count uses the benchmark's `fullAdapter` scan, which **turns the full contract diff off**.
- **Production mode stops nearly everything.** A hosted customer's `.refit.json` defaults to `fullDiff: true` (`pipeline/watch.ts`), and the benchmark records that mode separately as `productionMode` in each `results.json` row. In the October 23 held-out rerun, every one of the 9 validated repositories had 1 to 4 `operationImpacts` in production mode: oasdiff breaking changes on operations the code calls, with no verified rule. Under full diff those stop before a patch. The October 24 hosted fork test only produced drafts because the operator set `fullDiff: false` by hand. **This is lane O1, and the most important gap.**
- **What stops the rest** ([ranked](docs/MINED-RULES.md#what-stops-refit-ranked), [plan](docs/STRIPE-PLAN.md)):
  - `payment_method_types` outside the card rule (49 to 88, depending on the run): F2;
  - refused at dependency preparation (41 to 54): O3;
  - validation regressions from the stripe-node major upgrade (9 to 12): F3;
  - unparseable sources, declared-type and pin conflicts, and unresolved reads: F1, F4;
  - no runnable checks (the benchmark validates only repositories with a `test` script): O2.
- **Tracing.** 71% of likely Stripe calls on the active set are traced and 51% on the fresh set. Untraced same-named reads make a draft `[Needs review]` (F1).
- **Webhooks.** Confirmed webhook findings always stop automation through the incoming-version gate ([guide](docs/STRIPE-WEBHOOKS.md)), though the most common breaking reads (`current_period_end`, `invoice.subscription`) often sit in webhook handlers (F5).
- **Hosted.** The Fly worker published 5 deterministic drafts on 8 forks (October 24, [results](docs/BENCHMARKS.md#hosted-fork-test-october-24)). The operator wrote every `.refit.json` and check, AI repair never ran there, shared CPU throttled checks past the 120-second limit, and a rerun opened a duplicate draft instead of updating the first one.
- **Correctness.** Of 20 hand reviews in `docs/benchmarks/fix-reviews.json`, none is wrong. Most of the 102 validated fixes have never been read in full.

## Shared rules

Every lane follows these. Read them before anything else.

- **Read first.** Read `AGENTS.md`, `docs/READINESS.md` (top three checkpoints), `docs/ARCHITECTURE.md`, `docs/STRIPE-PLAN.md`, `docs/GITHUB-BENCHMARKS.md` and the docs and code your lane names before writing anything. Reuse existing modules and patterns. Add no dependency unless your lane says so.
- **Isolation.** `$REFIT` is the folder your session started in, a clone of `pierceluu10/Refit`. Work in your own worktree:
  - `git -C "$REFIT" fetch origin && git -C "$REFIT" worktree add -b <branch> "$REFIT-<lane>-<n>" origin/main`, then `npm ci` inside it. Branches are `feat/o1-<slice>`, `fix/f3-<slice>` and so on: the lane id comes first after the type.
  - Never touch another lane's worktree, branch or PR, except P5 as integrator. Never touch Pierce's website checkout `~/Repos/Refit`.
- **Owned files.** Each lane edits the files it owns ([table](#file-ownership)). In a file owned by another lane, keep edits small and additive (a call into your own module, an export), and say so in the PR. If you need more than that, ask on the [board](#the-board).
- **Your findings live in your doc.** Each lane writes `docs/overnight/<LANE>.md` (for example `docs/overnight/O1.md`): what it measured, which design choices it evaluated and why it chose what it chose, decisions taken under the bar, and what is left. Shared docs (`README.md`, `docs/READINESS.md`, `docs/BENCHMARKS.md`, `docs/LAUNCH-CHECKLIST.md`, `docs/CLI.md`) are edited only by P5. The one exception is `AGENTS.md`: a lane that takes a decision under the bar adds its one bullet there in the same PR.
- **Staying current.** Before every push, `git fetch origin && git merge origin/main`. Never rebase a pushed branch. Resolve JSON-list conflicts by keeping both sides' entries, then rerun the checks.
- **Commits.** Commit at every working checkpoint, at least hourly, with Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `perf:`, `chore:`) and no co-author trailers or "Generated with" lines. Push after each commit.
- **PRs.** Open a PR against `main` as soon as a slice has its first real commit, and keep its description current: a few bullets on what changed and why, how it was tested (exact commands, counts and GitHub Actions run ids), what was not verified, decisions taken under the bar, requests for other lanes and anything Blocked.
- **Checks before each push.** `npm run typecheck`, `npm run format:check`, `npm test -- --maxWorkers=2` and `npm run build`. Always pass `--maxWorkers=2` to vitest: five sessions share a laptop. Report gated suites (Docker, Postgres, oasdiff, real SDKs; see `AGENTS.md`) separately: ran and passed, ran and failed, or skipped.
- **Tests stay strict.** Never loosen an assertion, skip or delete a test, raise a timeout or add a retry to make something pass. Fix the cause, or leave the failure and report it.
- **Validated is not correct.** A patch that passes a repository's checks can still be wrong. Every diff you count as a fix is read in full and labelled `correct`, `correct-partial` or `wrong` with the checklist in `docs/FIX-REVIEW.md`, and the label goes in `docs/benchmarks/fix-reviews.json`. Report the wrong ones first.
- **Stripe facts come from Stripe.** A migration rule cites the docs.stripe.com changelog or API reference page someone read tonight, with the URL and date in the code comment or rule table. Never write a rule from memory or from a search summary. A page you cannot reach is Blocked, not guessed.
- **Honesty.** Simulations are labelled as simulations. Never claim a live, repository or AI result you did not observe. Benchmark numbers come only from a pushed, pinned commit and a named GitHub Actions run. Skipped is never reported as passing.
- **Untrusted code stays in the sandbox.** Benchmark repositories are strangers' code. Never run their installs, scripts, tests or binaries outside Refit's offline Docker sandbox or a GitHub Actions runner. Clone with `--depth 1` at the pinned commit, without submodules. Delete local clones when you finish.
- **Local Docker: one validation at a time per machine.** Before any local step that runs repository code in Docker (`--validate`, gated Docker suites, dependency preparation):
  - take the lock with `mkdir /tmp/refit-docker.lock 2>/dev/null && echo "<lane> $(date -u +%FT%TZ)" > /tmp/refit-docker.lock/owner`;
  - if `mkdir` fails, do other work and retry every 5 minutes; an owner file older than 2 hours is stale, so remove it and take the lock;
  - release with `rm -rf /tmp/refit-docker.lock` as soon as the step ends, including on failure.

  Never stop, prune or recreate shared containers, images or volumes. Prefer GitHub Actions for anything that validates more than one repository.

- **Secrets.** Never commit, print, log or paste secrets or account identifiers: `.env` contents, API keys, tokens, database URLs, the Supabase project ref, Fly secret values. This repository will become public. Read a key file only by passing its path to a tool (`--env`) or through `"$(cat file)"` inside a command that does not echo it.
- **No live hosted access, except P1.** Nobody but P1 runs a Fly command that changes state (`deploy`, `secrets`, `scale`, `machine`, `ssh` with a write), or `refit hosted approve`, `retry` or `serve` against Supabase. Hosted code is tested against a local Postgres container (`docs/HOSTED-ONBOARDING.md`), each test in its own schema.
- **No publishing, except P1.** Never use `--publish`, `--publish-draft` or `gh pr create` against any repository but `pierceluu10/Refit`. Never push to, open issues on or comment on third-party repositories. Only P1 creates forks in `refit-dev` and lets Refit Agent publish drafts there.
- **Subagents.** Use them for wide, parallel, read-heavy work: reading 100 diffs, classifying stops, searching Stripe docs, reviewing your own PR. Give each a self-contained brief, never let two edit the same files, and verify what they report before you rely on it. You are responsible for their output.
- **Blocked is an ending, not a loop.** If a step needs the owner (expired credentials, a page you cannot reach, a decision above the bar), retry once, record it under **Blocked** in the PR with the exact error and what would unblock it, and move to your next item. Spend at most 45 minutes on any single blocker, flaky test or repository.
- **Depth.** Do not sprinkle small fixes across the codebase. Take the biggest stop in your lane, understand every repository it affects, build the complete fix with tests on real snippets, measure it on every set, then take the next one.
- **Cutoff.** Each lane starts no new slice after **6 hours** and hands off by **7 hours** from P5's start time on the board: last PR pushed, checks green, summary current, doc written, worktrees removed (branches stay). P5's merge cutoff is 7 hours; its final report is due by 9 hours.

## Benchmark protocol (GitHub Actions)

All benchmark runs go through `refit-dev/refit-bench` ([guide](docs/GITHUB-BENCHMARKS.md)). The workflow checks out Refit at a pinned commit, runs `stripe-benchmark-setup` and `benchmark:stripe --validate` one shard per runner, and uploads `shard-<n>` artifacts plus one `merged` artifact (`results.json` for the whole run, and `summary.md` listing the affected repositories with their outcome and reason).

```sh
git push origin HEAD                       # the commit must be on GitHub
gh workflow run benchmark.yml -R refit-dev/refit-bench \
  -f commit=$(git rev-parse HEAD) \
  -f list=2026-10-16-stripe-fresh-repos.json \
  -f offset=0 -f count=381 -f size=3 \
  -f flags=''                              # optional extra benchmark flags; never --ai, --env or --publish
gh run list -R refit-dev/refit-bench -L 5   # find your run id
gh run download <run-id> -R refit-dev/refit-bench -n merged -D <dir>
```

### The sets

| Set          | List in `docs/benchmarks/`             | Repositories | Use                                            |
| ------------ | -------------------------------------- | ------------ | ---------------------------------------------- |
| Original     | `2026-10-14-stripe-repos.json`         | 100          | Tuning and measurement                         |
| Held out     | `2026-10-15-stripe-heldout-repos.json` | 50           | Measurement                                    |
| Fresh        | `2026-10-16-stripe-fresh-repos.json`   | 381          | Tuning and measurement                         |
| Active teams | `2026-10-16-stripe-active-repos.json`  | 66           | Current code; tuning and measurement           |
| Night (new)  | made by O4 in hour 1                   | about 100    | **Blind.** Only O4 freezes it; only P5 runs it |

### The night set

O4 freezes a new set of active Stripe repositories that no Refit run has ever seen, in its first hour, and P5 merges it at once. Nobody else runs Refit on it, reads its repositories' code or looks at its results until P5's final run. It exists to show whether tonight's changes generalise or were fitted to the four tuned sets.

### Subsets

To measure on part of a set (for example only the affected repositories), commit a subset list on your branch under `docs/benchmarks/subsets/<lane>-<name>.json` and pass `list=subsets/<lane>-<name>.json`. Until O5 ships `scripts/benchmark-subset.mjs`, build one with:

```sh
jq --argjson names "$(jq -R . names.txt | jq -sc .)" \
  '.repos |= map(select(.repo as $r | $names | index($r)))' \
  docs/benchmarks/2026-10-16-stripe-fresh-repos.json > docs/benchmarks/subsets/f3-regressions.json
```

### Sharing the runners

The `refit-dev` organization gets about 20 concurrent jobs, shared by all 15 lanes. Each repository takes from 10 seconds to about 6 minutes.

- **One run at a time per lane.** Never dispatch while your previous run is queued or running.
- **At most 60 shards per run** for lanes (raise `size` to fit), and **at most 150** for O5's baselines and P5's final runs.
- Run full sets only when your change can move them. For most slices, run the affected subset before and after.
- Post every run id you will cite on the board, with its commit and purpose.
- A shard that fails for an infrastructure reason (network, Docker pull, runner loss) is rerun once. If it fails again, record it as infrastructure, never as a Refit outcome.

### Before and after

Your "before" is the most recent baseline of `main` on the board (O5 posts one in hour 1 and after each merge batch), or your own run of your branch's merge base on the same subset. Compare per repository with `scripts/stripe-benchmark-compare.mjs <before>/results.json <after>/results.json` and report every changed row, not only totals. A run that compares two different commits on different subsets proves nothing.

### Local runs

Use local runs only for fast loops on a handful of repositories (`npm run benchmark:stripe -- --root <dir> --output <run>` without `--validate`, or `npm run benchmark:coverage`, which reads source only). Local `--validate` needs the Docker lock. AI runs are local by design (P2 only).

## The decision bar for changing a default

A lane may make a new behaviour the default, or turn a review-only rule into an automatic edit, only when **all** of the following hold. Otherwise it ships behind an off-by-default flag, with the same evidence so far, under "Needs owner decision" in its PR.

1. **Measured on every tuned set.** A GitHub Actions run of the branch and of its merge base, same flags, on all four tuned sets (or every repository the change can reach, chosen by a rule you state, not by hand), compared per repository.
2. **Zero wrong.** Every diff the change creates or alters is read in full and labelled in `docs/benchmarks/fix-reviews.json`. No `wrong`. Each `correct-partial` says what a person must still do, and the draft body says it too.
3. **Nothing lost silently.** Every repository that was validated before and is not now is explained as a correct new stop with its named reason.
4. **Semantics proven.** For a Stripe edit: the docs.stripe.com page that proves the replacement equivalent for the case you edit, and unit tests on real snippets taken from the benchmark repositories, covering what moves and what keeps stopping.
5. **Recorded.** One bullet in `AGENTS.md`, in the style of the existing decisions: "Owner decision (2026-10-24, overnight sign-off): …", naming what now happens by default, what still stops, the evidence (run ids, results files, review counts) and "do not widen without a new decision".
6. **Reviewed by P5** before merge. P5 may send it back or keep it behind a flag.

Never cleared by the bar, whatever the evidence: deleting a removed request parameter, rewriting webhook reads to the new shape only, choosing among several Stripe objects where the code's intent is not provable (for example which subscription item's period to use when there are several, beyond what the existing helper already does), AI patches published without validation, and anything that sends data to a new service.

## Slices, merging and the board

### Slices

A lane ships in slices. Each slice is one coherent change with its tests and measurement, small enough for P5 to review in 20 minutes, ending in a PR. When P5 merges it, start the next slice on a new branch from fresh `origin/main`. Keep working on the next slice while a PR waits for review; branch from your open PR's branch only if you must, and say so in the next PR's first line ("Builds on #N; merge after it").

When a slice meets its done criteria, comment `READY <commit>` on its PR. P5 merges only PRs with a current `READY` comment.

### What P5 checks before merging

1. The PR's `READY` commit is its head, merges cleanly with `main`, and the merge result passes `typecheck`, `format:check`, `npm test -- --maxWorkers=2` and `build` locally (Actions is disabled on `pierceluu10/Refit`, so local checks are the CI), plus the gated suites the PR touches.
2. Behaviour changes carry before/after GitHub Actions runs, and every new or changed fix diff is reviewed.
3. Any default change meets [the decision bar](#the-decision-bar-for-changing-a-default) and adds its `AGENTS.md` bullet.
4. Nothing in the diff breaks the shared rules (secrets, untrusted code, ownership).

P5 merges with `git merge --no-ff origin/<branch> -m "feat: merge #<n> <title>"` from a clean checkout of `origin/main`, pushes `main`, and comments on the PR with the merge commit. After each batch of merges, O5 posts a fresh baseline of `main` on the board.

### The board

P5 opens one issue on `pierceluu10/Refit` at the start, titled **"Overnight 3 board"**, and posts the start time (T0). Every lane finds it with `gh issue list -R pierceluu10/Refit --search "Overnight 3 board in:title"` and uses it for:

- run ids worth sharing (`O5 baseline main@<sha>: run <id>, all four sets`);
- requests between lanes (`@F1 from O4: 7 wrong verdicts trace to destructured clients; list in docs/overnight/O4.md`);
- decisions taken under the bar (one line with the PR link);
- Fly requests to P1 (`@P1 from P4: please rerun fork X after #N merges`).

Read the board when you start each slice. Keep comments short and factual. No secrets. If the board does not exist yet, keep working and check again in 15 minutes.

## File ownership

| Lane | Owns                                                                                                                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1   | `fly.toml`, `Dockerfile`, `pipeline/hosted-*.ts`, `pipeline/fly-machines.ts`, `docs/HOSTED-*.md`, the `refit-dev` forks                                                                                                                                                         |
| P2   | `pipeline/ai-patches.ts`, `pipeline/ai-budget.ts`, `pipeline/ai-patch-eval*.ts`, `pipeline/ai-eval*.ts`, `pipeline/patch-context.ts`, `pipeline/substitution-guard.ts`, `docs/AI-*.md`                                                                                          |
| P3   | `pipeline/repository-enrollment.ts`, `pipeline/enrollment-*.ts`, `pipeline/readiness*.ts`, `pipeline/workflow-configuration.ts`, `docs/APP-ONBOARDING.md`, `docs/INSTALL.md`, `docs/FIRST-RUN.md`                                                                               |
| P4   | `pipeline/review.ts`, `pipeline/publication.ts`, `pipeline/workflow-presentation.ts`, `pipeline/migration-review.ts`, `pipeline/watch.ts`, `pipeline/github*.ts`, `docs/PULL-REQUESTS.md`, `docs/AUTOMATION.md`                                                                 |
| P5   | `README.md`, `docs/READINESS.md`, `docs/BENCHMARKS.md`, `docs/LAUNCH-CHECKLIST.md`, `docs/CLI.md`, `docs/benchmarks/claims.json`, merges                                                                                                                                        |
| O1   | `pipeline/openapi-diff.ts`, `pipeline/openapi-operations.ts`, `pipeline/provider-operations.ts`, `pipeline/provider-operation-replacements.ts`, the operation-impact gate in `pipeline/run.ts`                                                                                  |
| O2   | `pipeline/validation*.ts`, `pipeline/generated-checks.ts`, `pipeline/check*.ts`, `pipeline/docker-sandbox.ts`, `docs/GENERATED-CHECKS.md`                                                                                                                                       |
| O3   | `pipeline/dependency-*.ts`, `pipeline/manager-install.ts`, `pipeline/pnpm-*.ts`, `pipeline/yarn-*.ts`, `pipeline/npm-lock.ts`, `pipeline/lockfiles.ts`, `pipeline/preparation-*.ts`, `docs/DEPENDENCIES.md`, `docs/PREPARATION-FAILURES.md`                                     |
| O4   | `scripts/stripe-active-select.mjs`, the night-set list, `docs/benchmarks/fix-reviews.json` (others append), `docs/FIX-REVIEW.md`, `pipeline/stripe-ground-truth*.ts`, label files                                                                                               |
| O5   | `refit-dev/refit-bench`, `pipeline/stripe-benchmark*.ts`, `scripts/benchmark-*.mjs`, `scripts/stripe-benchmark-*.mjs`, `docs/GITHUB-BENCHMARKS.md`, `docs/BENCHMARK-*.md`                                                                                                       |
| F1   | `pipeline/analyzer.ts`, `pipeline/factory-clients.ts`, `pipeline/class-clients.ts`, `pipeline/helper-clients.ts`, `pipeline/source-*.ts`, `pipeline/sdk-constructors.ts`, `pipeline/sdk-coverage*.ts`, `pipeline/stripe-type-evidence.ts`                                       |
| F2   | `pipeline/request-removals.ts`, `pipeline/request-migration.ts`, `pipeline/api-version.ts`, `pipeline/declared-api-versions.ts`, `docs/STRIPE-PAYMENT-METHOD-TYPES.md`, `docs/API-VERSIONS.md`                                                                                  |
| F3   | `pipeline/stripe-package-upgrade.ts`, `pipeline/stripe-open-enums.*`, `pipeline/stripe-types.ts`, `pipeline/stripe-sdk-metadata.json`                                                                                                                                           |
| F4   | `pipeline/stripe-field-moves.ts`, `pipeline/stripe-request-moves.ts`, `pipeline/stripe-invoice-preview.ts`, `pipeline/stripe-operations.ts`, `pipeline/provider-renames.ts`, `pipeline/provider-request-renames.ts`, `docs/MINED-RULES.md`, `docs/benchmarks/stripe-changelog/` |
| F5   | `pipeline/stripe-webhook-payloads.ts`, `pipeline/stripe-subscription-periods.ts`, `docs/STRIPE-WEBHOOKS.md`, `docs/STRIPE-SUBSCRIPTION-PERIODS.md`, the webhook fixtures                                                                                                        |

Shared by everyone, small additive edits only: `pipeline/run.ts` (O1 owns its gate), `pipeline/workflow.ts`, `pipeline/patches.ts`, `pipeline/cli.ts`, `pipeline/workflow-cli.ts`, `AGENTS.md`. Files not listed belong to nobody tonight: edit them only additively and say so in the PR.

## Preflight (each person, before starting)

Do these once, in order. A lane that hits a missing item records it as Blocked and moves on, so a skipped step costs a whole lane.

1. **Plugged in and awake.** Run `caffeinate -dimsu` in a terminal tab and leave it, or use the app's keep-awake setting.
2. **Permissions.** Start each session in a mode that does not stop for approvals, with your main clone as its folder. A session waiting on a prompt does nothing all night.
3. **GitHub.** `gh auth status` works; `gh repo view pierceluu10/Refit --json viewerPermission` says WRITE or ADMIN; `gh workflow list -R refit-dev/refit-bench` lists `Stripe benchmark`.
4. **Docker.** Docker runs with about 8 GB for its VM, at least 40 GB of disk is free (`df -h ~`), and `docker image inspect node:22-alpine postgres:17-alpine` succeeds (pull them if not).
5. **This file.** In your main clone: `git checkout main && git pull`, then `ln -sf "$PWD/OVERNIGHT-AGENTS.md" ~/OVERNIGHT-AGENTS.md`.
6. **Pierce only.**
   - `fly auth whoami` works and `fly status -a refit-hosted` shows the machine started.
   - `~/.refit/hosted/database-url` exists (mode 600) and `~/.refit/benchmark.env` exists with an `OPENAI_API_KEY` line (check with `grep -c '^OPENAI_API_KEY=' ~/.refit/benchmark.env`, never by printing it).
   - Start P5 first: it opens the board and sets T0.

---

# Pierce: production, AI, customer path, integration

Pierce's machine holds the Fly access, the hosted database URL and the OpenAI key, so the lanes that need them live here. P2 is the only lane on this machine that runs local Docker for long; the others mostly read code, write tests and dispatch Actions runs.

## P1: Production on Fly, at customer scale

**Why.** The launch claim is "install the App and Refit handles Stripe". The only evidence for that is the hosted worker doing it, on real repositories, with nobody fixing things by hand. So far it has done 8 hand-configured forks.

**Read first.** `docs/HOSTED-ONBOARDING.md`, `docs/HOSTED-RUNBOOK.md`, `docs/HOSTED-TENANCY.md`, `docs/CAPACITY.md`, the [October 24 fork test](docs/BENCHMARKS.md#hosted-fork-test-october-24), `pipeline/hosted-service.ts`, `pipeline/hosted-runner.ts`, `fly.toml`, `Dockerfile`.

**Owns.** Fly (`refit-hosted`), `fly.toml`, `Dockerfile`, `pipeline/hosted-*.ts`, `pipeline/fly-machines.ts`, `docs/HOSTED-*.md`, the `refit-dev` forks.

**You may (tonight only).** Deploy **merged `main`** (never a branch) when no job is running, scale the machine, set the hosted AI cap up to **$10** for the night, fork benchmark repositories into `refit-dev`, approve them, add them to the Refit Agent installation, retry jobs, and let Refit Agent open draft PRs on the forks. Use `fly ssh console -a refit-hosted -C "refit hosted …"` for operations where you can, so the database URL stays on the machine; where you need it locally, use `REFIT_DATABASE_URL="$(cat ~/.refit/hosted/database-url)"` inside the command and never echo it.

**Work.**

1. **Baseline the worker.** Record `fly status`, the VM size, the image, `refit hosted jobs`, the health check and the AI cap. Read the last 24 hours of logs for errors. Post a one-line state on the board.
2. **Pick 30 forks with predicted outcomes.** From the four tuned sets (never the night set), choose 30 repositories that cover every outcome: validated (correct and partial), each stop class, no checks, preparation refusal, a webhook repository, a pnpm and a Yarn repository, a JavaScript-only one. Write each repository's predicted hosted outcome from the latest `main` baseline **before** running. Fork them into `refit-dev` (keep the existing 8).
3. **Zero operator configuration.** Customers will not hand-write `.refit.json`. Use the path a customer would use (`refit enroll` and whatever P3 ships). Where a fork still needs a hand edit, record exactly which and why, and give the list to P3 on the board. Never set `fullDiff: false` by hand: the defaults are what you are testing.
4. **Run at production speed.** Scale up only while jobs run (check prices with `fly platform vm-sizes`; keep the night's Fly compute under $15), and make sure no check is killed by throttling. Measure per-job time by stage (checkout, doctor, preparation, baseline checks, patch, patched checks, publication) from the logs. Return to `shared-cpu-2x` with 4 GB at the end. A deploy resets the size to `fly.toml`, so pass the size again or rescale after each deploy.
5. **Compare against the prediction.** For each fork: predicted outcome, hosted outcome, benchmark outcome on the same commit. Every mismatch is a bug until explained. Fix hosted-side bugs yourself in slices (tests against a local Postgres; Linux-only problems need a Linux check, so reproduce in a `node:22` container or on Fly), and send pipeline-side bugs to the owning lane on the board.
6. **Exercise what never ran on Fly.** AI patch and repair on at least 5 forks where deterministic rules stop for a reason AI may address (coordinate with P2; within your $10). Approval from a GitHub issue (#196) if it is on `main`. A push to a fork after its draft exists: the draft must be updated, not duplicated (with P4). Removing a repository from the installation cancels its target.
7. **Redeploy after merges.** When P5 merges a batch that changes pipeline behaviour, wait until no job runs, deploy that `main` commit, retry the affected forks and compare again. Note on the board which commit is live.

**Design questions (answer in `docs/overnight/P1.md`).** Is one machine per job (`pipeline/fly-machines.ts`, #176) needed before a first customer, or is one performance machine enough for N installations? What is the cost per job and per installation per month at the measured times? What should the 120-second check limit be on hosted hardware? What happens to a running job during a deploy, and should deploys drain first?

**Measure.** A table of all 38 forks: predicted, hosted, benchmark, time per stage, AI spend, draft link. Jobs lost to infrastructure (target 0).

**Done when.** At least 25 forks reach their predicted outcome with no operator edits, every mismatch is explained or fixed, AI repair ran on Fly with its spend recorded, and `docs/overnight/P1.md` has the table and answers. Fly is back on `shared-cpu-2x`, 4 GB, AI cap restored to $2.

**Keep going.** More forks from categories with mismatches; a staged second Stripe release on two forks (with P4); a drain-before-deploy step in the runbook; alerting on throttled checks.

## P2: AI where deterministic rules stop, safely

**Why.** Rules cover the common moves. The long tail (unresolved reads, upgrade regressions, odd shapes) needs a bounded assistant. In the October 21 comparison, an unconstrained agent validated 8 patches, and 7 were wrong: each deleted `payment_method_types`. Refit's AI path must be measurably better than that, or stay off.

**Read first.** `docs/AI-PATCH-GUARD.md`, `docs/AI-PATCH-RELIABILITY.md`, `docs/AI-EVALUATION.md`, the [agent comparison](docs/BENCHMARKS.md#a-coding-agent-on-the-repositories-refit-did-not-fix-october-21), `pipeline/ai-patches.ts`, `pipeline/substitution-guard.ts`, `pipeline/ai-budget.ts`.

**Owns.** The AI files in [the table](#file-ownership). **Budget: $20** of Pierce's key, on your own ledger: set up `~/.refit/overnight-ai-P2.env` as in [owner decision 3](#owner-decisions-for-tonight) with `REFIT_AI_BUDGET_USD=20`. Local runs hold the Docker lock one repository at a time; for a wider sample, use an Actions AI run from the shared $10.

**Work.**

1. **Find the AI-eligible set.** From the latest `main` baseline, list every affected repository where deterministic rules stop for a reason the AI path is allowed to address (read `pipeline/run.ts` for when `useAi` is true), and why the others are not eligible. Expect 30 to 70.
2. **Run the AI path on them** at the baseline commit (`npm run benchmark:stripe -- --root <dir> --output <run> --env ~/.refit/overnight-ai-P2.env --ai --validate`, on a subset list, sliced with `--offset` and `--limit`). The benchmark makes 1 repair attempt where the hosted worker makes 2 (`--repair-attempts 2`); measure the second attempt's value on a sample with `refit run`. Record spend per repository.
3. **Read every AI diff that validated or was repaired.** Label each in `fix-reviews.json`. Classify every wrong or partial one: invented field, dropped parameter, wrong item choice, version semantics, type-only workaround (`as any`), unrelated edits.
4. **Make the guard catch every wrong class** you found, deterministically: the patch is refused, never "fixed" by another model call. Give the model the owner policies it must follow (the card rule, never drop a parameter, dual-version webhook reads). Tests from the real diffs.
5. **Rerun and compare.** Same repositories, same commit plus your change: validated correct up, wrong to zero.
6. **Help P1** run AI repair on Fly forks (they spend their own $10).

**Design questions.** Should an AI patch ever publish as a normal draft, or always as `[Needs review]`? Is repair worth its cost (fixes per dollar)? Is `gpt-5.6-luna` the right model, measured, not assumed (try one stronger model on the 10 hardest cases within budget)? Where does AI beat a rule we could write instead? Send those to F4.

**Measure.** Before/after table on the eligible set: validated, correct, partial, wrong, refused by the guard, spend.

**Done when.** No AI patch that passes the guard is wrong on the eligible set, the guard's new refusals have tests, the spend is recorded and under $30, and `docs/overnight/P2.md` answers the design questions with numbers.

**Keep going.** The AI eval suite (`pipeline/ai-eval-cases.ts`) gets a case for each wrong class; held-out evaluation on repositories you did not tune on.

## P3: The first run for a stranger's repository, with zero configuration

**Why.** Every published draft so far needed an operator to write `.refit.json`, pick checks or turn the full diff off. A customer installs the App and expects it to work. If enrollment needs a human, Refit is not launched.

**Read first.** `docs/APP-ONBOARDING.md`, `docs/FIRST-RUN.md`, `docs/INSTALL.md`, `docs/REPOSITORY-SETUP.md`, `pipeline/repository-enrollment.ts`, `pipeline/readiness.ts`, `pipeline/workflow-configuration.ts`, `pipeline/hosted-approval.ts`.

**Owns.** The enrollment and readiness files in [the table](#file-ownership).

**Work.**

1. **Measure today's path on 60 repositories.** From the tuned sets (spread across npm, pnpm, Yarn, TypeScript, JavaScript, monorepos), run the customer path with no hand edits: `refit enroll` (or what a hosted approval uses), then `refit doctor`. Use GitHub Actions where it validates; enrollment and doctor without validation can run locally on shallow clones (read-only, no installs). Record where each one ends: ready-for-validation, needs a hand edit (which), refused (why).
2. **Fix the defaults, in slices.** The proposed `.refit.json` should carry checks that run (take O2's check selection when it lands; until then, measure), the target API version, the right package manager and workspace, and production defaults. Each default change goes through the decision bar.
3. **Make "why not" readable.** Where enrollment cannot proceed, the customer sees one plain sentence and the exact fix, not a stack trace or a code. Snapshot tests for each message.
4. **The approval step.** A customer approves from GitHub (#196 issue approval, if on `main`), not the CLI. Walk the whole flow on a test repository against local Postgres and on one Fly fork with P1. Record every place a human must still act.
5. **Write the customer guide** in `docs/INSTALL.md` from what you measured: what happens after install, what Refit needs, how long it takes, what it will and will not change.

**Design questions.** Should Refit enroll with no approval at all for read-only scans, and ask approval only before validation or publication? Should the enrollment default be `fullDiff: true` (with O1's gate) or false, and what does the evidence say? What is the minimal check that makes a validated claim honest when a repository has no tests?

**Measure.** Share of the 60 that reach `ready-for-validation` with zero edits, before and after (target ≥ 80% of those whose dependencies can be prepared), and each hand edit still needed, by count.

**Done when.** That share meets the target or every miss has a named cause and owner, P1's forks enroll with zero edits, and `docs/INSTALL.md` matches what you measured.

**Keep going.** Monorepo workspace selection; repositories with two Stripe clients on different versions; the readiness report the customer sees after install.

## P4: The draft PR, from first push to the next Stripe release

**Why.** A customer judges Refit by the draft PR: whether it explains the change, whether its evidence is honest, whether it updates instead of duplicating, and whether Refit keeps going after the merge. The Stripe plan's part 2 (unattended across two releases) depends on baseline advancement, which does not exist yet.

**Read first.** `docs/PULL-REQUESTS.md`, `docs/PR-TEMPLATE.md`, `docs/PR-BODY-EXAMPLES.md`, `docs/AUTOMATION.md` (especially "Use a real upstream source"), `pipeline/review.ts`, `pipeline/publication.ts`, `pipeline/watch.ts`, the duplicate draft on `refit-dev/full-stack-starter-kit`.

**Owns.** The review, publication and watch files in [the table](#file-ownership).

**Work.**

1. **Draft identity.** One draft per repository, integration and target version. A rerun, a retry or a push updates the existing draft (body and branch) instead of opening another. Reproduce the full-stack-starter-kit duplicate in a test with simulated GitHub, fix it, and ask P1 to verify on Fly.
2. **Honest evidence in the body.** The body states which checks ran, before and after, and how strong they are (a full test suite, a type check only, or `node -e 0`), plus which Stripe docs pages justify each edit, every unresolved read and every decision the reviewer must make. Grade evidence strength in a way the customer understands. Snapshot tests on the bodies of real benchmark patches.
3. **After the merge.** When the customer merges the draft, the next run treats the target version as the new baseline, with no operator. When they close it unmerged, Refit does not reopen it for the same target. When upstream fixes it themselves, Refit closes its draft with a note. Tests for each.
4. **Two releases in a row.** Using the replay lists (`docs/benchmarks/2026-10-22-replay-stripe-basil-repos.json` and `…-endive-repos.json`), simulate basil, then the next version, then endive on a local service with simulated GitHub. Refit should produce one draft per release, advance after each merge, and stay quiet when nothing changes.
5. **Quiet by default.** Nothing affected means no PR, no issue and no comment. A stop that needs a person produces one clear issue or report entry, not one per run.

**Design questions.** Should one draft carry several version jumps, or one per release? What does the customer see when the draft is `[Needs review]`: a checklist, or one summary paragraph? How should a draft behave when the customer pushes their own commits to its branch?

**Measure.** Simulated scenarios that pass end to end; bodies reviewed for 20 real patches; on Fly (via P1), duplicates 0.

**Done when.** No duplicates, the two-release replay passes unattended in tests, the body grades evidence honestly, and `docs/PULL-REQUESTS.md` describes the lifecycle as built.

**Keep going.** Draft updates when a later Refit fixes a previous `[Needs review]` item; a short weekly status comment, off by default.

## P5: Integrator (start this session first)

**Why.** Fifteen lanes produce changes that interact. Without one person merging, re-measuring and writing down what is true, the morning is a pile of branches and conflicting numbers.

**Read first.** All of this file; `docs/LAUNCH-CHECKLIST.md`; `docs/BENCHMARKS.md`; `docs/benchmarks/claims.json` and `scripts/benchmark-claims.mjs`.

**Owns.** `README.md`, `docs/READINESS.md`, `docs/BENCHMARKS.md`, `docs/LAUNCH-CHECKLIST.md`, `docs/CLI.md`, `docs/benchmarks/claims.json`, and merging into `main`.

**Work.**

1. **T0.** Open the board issue ("Overnight 3 board"), post T0 (UTC) and the `main` commit. Fast-track O4's night-set PR and O5's tooling PRs as soon as they are `READY`.
2. **Merge loop, all night.** Every 20 minutes, list PRs with a current `READY` comment, and review and merge them following [the checks](#what-p5-checks-before-merging), one at a time, smallest first. Send back anything below the bar with a precise comment. For a PR whose lane has ended, you may fix small problems on its branch yourself; otherwise ask the lane. Never merge a PR whose checks fail on the merge result.
3. **Re-measure after behaviour merges.** Ask O5 on the board for a baseline after each batch. If a merge loses a validated fix or produces a `wrong`, revert it with `git revert -m 1 <merge>` and tell the lane.
4. **Cutoff at T0 + 7 hours.** Merge what is `READY` and safe. Then run the final GitHub Actions benchmark of `main` on the four tuned sets and the night set, with default flags (production mode is the default), and on the tuned sets again (determinism).
5. **Write down what is true.**
   - A `docs/READINESS.md` checkpoint for the night.
   - A `docs/BENCHMARKS.md` section with the final numbers (run ids, commit, command), each with a claim; `node scripts/benchmark-claims.mjs` and `node scripts/benchmark-results.mjs --committed` pass.
   - `docs/LAUNCH-CHECKLIST.md` rewritten for launch: each item of the [launch bar](#launch-bar-what-ready-means-in-the-morning), met or not, with evidence; every decision taken under the bar tonight; every open owner decision, with what the evidence says.
   - Commit the final results files (registered in `docs/benchmarks/schemas/files.json`).
6. **Morning summary.** As the last board comment: what merged, the launch-bar table, the top five things that still stand between Refit and launch, and what the owner must decide.

**Done when.** The final runs are committed and documented, every lane's PRs are merged, sent back with a reason or listed as open, and the board ends with the morning summary.

---

# Otabek: production gate, validation evidence, preparation, truth, benchmarks

Otabek's lanes decide whether the numbers mean what they say: that production mode is the mode measured, that a validated fix was really checked, that a refusal was right, that the diffs are correct and that the benchmark can be trusted. None needs Fly or AI.

## O1: Production mode without false stops (the full contract diff)

**Why.** This is the biggest gap between the benchmark and a customer. Customers default to `fullDiff: true`, under which oasdiff's breaking changes on any called operation become `operationImpacts`, and any impact without a verified rule stops the repository. In the October 23 held-out rerun, all 9 validated repositories had 1 to 4 impacts. Some of those impacts matter to the code; many probably do not (a response enum gaining a value the code never switches on, a property the code never reads, a change in an unexpanded object). Turning the full diff off hides real breaks; leaving it on blocks every fix.

**Read first.** `pipeline/run.ts` (from `findBreakingOperationImpacts` to the patch decision), `pipeline/openapi-diff.ts`, `pipeline/openapi-operations.ts`, `pipeline/provider-operations.ts`, `docs/API-VERSIONS.md`, `docs/ENDPOINT-MIGRATIONS.md`, and the `AGENTS.md` decisions on `--full-diff` (the enum relaxation and the unexpanded-object decisions of 0.25.0 and #84).

**Owns.** The files in [the table](#file-ownership), and the gate in `pipeline/run.ts`.

**Work.**

1. **Inventory every impact.** From the latest `main` baseline on all four tuned sets, extract every `productionMode.operationImpacts` entry (add detail to the results row if it only holds a count: that edit to `pipeline/stripe-benchmark-cli.ts` is yours, coordinate with O5). Group by oasdiff change kind, operation and path. Expect a few dozen distinct kinds across hundreds of rows.
2. **Classify each kind against the code.** For each, decide with evidence from the repositories that have it: does the code reach the changed part? A request parameter the code sends, a response field it reads (traced), an enum it switches on, a status code it handles. Use F1's tracing, not text search.
3. **Build the gate from the classification.** An impact blocks only when the traced code reaches the changed part and no rule handles it. Anything else is recorded in the draft as "changed but unused by traced code" with the exact path, so the reviewer can see it. Keep stopping where tracing is incomplete for that operation: unknown reach is a stop, not a pass.
4. **Make production mode the benchmark's headline**, with O5: `results.json` rows report the default mode's outcome first.
5. **Measure under the bar.** Before and after on all four tuned sets: production-mode validated must approach benchmark-mode validated, and every repository that still differs is listed with its blocking impact. Every newly reached diff is reviewed. Then record the decision.

**Design questions.** Is "block only on traced reach" safe where tracing is partial (an escaped client, an untraced read of the same name)? How should a multi-year jump (2022 to endive, 30 versions) be gated: one diff of the endpoints, or a chain of per-version diffs, and does the choice change any outcome? Should a response enum addition block only where the code switches over the field (the open owner decision in `AGENTS.md`)? Measure it, and give the owner the numbers.

**Measure.** Production-mode validated on all four sets, before and after; impacts by class; repositories still blocked, with the reason.

**Done when.** The production-mode gap is closed or explained per repository, the gate change meets the decision bar (or sits behind a flag with the evidence), and `docs/overnight/O1.md` holds the impact classification with counts.

**Keep going.** oasdiff time and failures on 30-version jumps; cache the per-version diff; a test per impact class from real specifications.

## O2: Validation that proves something

**Why.** "Validated" means a repository's checks passed before and after the patch. Today: the benchmark validates only repositories with a `test` script; the hosted forks used `tsc` or `node -e 0` chosen by an operator; generated `stripe-mock` checks often cannot load a Next.js route; one suite never finishes in 120 seconds; some baselines fail. A customer reading "validated" deserves to know what was actually exercised.

**Read first.** `pipeline/validation.ts`, `pipeline/generated-checks.ts`, `pipeline/check.ts`, `docs/GENERATED-CHECKS.md`, `docs/FIX-REVIEW.md`, the "weak checks" notes in `docs/BENCHMARKS.md` (Signl, the fork test).

**Owns.** The validation files in [the table](#file-ownership).

**Work.**

1. **Census of checks.** On all four tuned sets (from the latest baseline plus a source read), record for each affected repository: which checks exist (`test`, `typecheck`, `lint`, `build`, a `tsc` config), which ran, which passed on the original code, and what each check touches in Stripe code. Use subagents to read the repositories' scripts and tests.
2. **One check-selection function** that a customer's enrollment (P3), the hosted worker and the benchmark all use: prefer what exercises the Stripe code (tests importing it, a type check that includes it), fall back to a type check, and never call `node -e 0` validation. Hand it to P3 early with a `READY` slice.
3. **Generated `stripe-mock` checks that load.** Find why routes fail to load alone (framework imports such as `@clerk/nextjs`, path aliases, ESM and CJS) and fix the largest causes, keeping the sandbox offline. Measure how many affected repositories get a generated check that actually reaches a Stripe call.
4. **Time limits and baselines.** Measure check durations on GitHub runners and on Fly (from P1); propose the limit from data, and make a slow suite's partial result visible rather than silent. A failing baseline should name the failing check and stop clearly.
5. **Evidence grade.** Each validated outcome records a grade (Stripe code exercised by tests; type-checked only; generated check only; no meaningful check). P4 shows it in the draft body. The benchmark reports the fix rate per grade.

**Design questions.** Is a type check alone enough to call a field move validated, given that stripe-node's types encode the target shape? Should a draft without a meaningful check be published at all, or only as `[Needs review]`? What is the right check limit on hosted hardware?

**Measure.** Affected repositories with a runnable meaningful check, before and after; fix rate by evidence grade.

**Done when.** Check selection is shared by enrollment, hosted and benchmark, every validated outcome carries a grade, generated checks reach Stripe code in measurably more repositories, and the decision on weak checks is taken under the bar or listed for the owner.

**Keep going.** Run the patched code's own tests twice to catch flaky passes; per-check timing in the receipt.

## O3: Dependency preparation, refuse only what must be refused

**Why.** 41 to 54 affected repositories never reach validation because their dependencies cannot be prepared offline. Some refusals are right (non-registry sources, patched dependencies, lockfiles without integrity); others are buildable (npm `ERESOLVE` peer conflicts, tracked symlinks or submodules, lockfile drift, Yarn's optional binaries). Each wrong refusal is a customer who gets nothing.

**Read first.** `docs/DEPENDENCIES.md`, `docs/PREPARATION-FAILURES.md`, `docs/NPM-WORKSPACES.md`, `docs/PNPM-WORKSPACES.md`, `pipeline/dependency-preparation.ts`, `pipeline/manager-install.ts`, `pipeline/pnpm-inputs.ts`, `pipeline/yarn-inputs.ts`, and the owner decisions on workspace and memory sizes in `AGENTS.md`.

**Owns.** The preparation files in [the table](#file-ownership).

**Work.**

1. **Every refusal, with its cause.** From the baseline, list each refused repository with the exact error and the lockfile facts behind it. Group them, and decide per group: correct refusal (say why it protects the customer), buildable (the fix), or out of scope tonight.
2. **Build the buildable groups, largest first.** For example: peer-conflict resolution matching what the repository's own CI does (read their workflow files), symlinks and submodules handled without following them out of the checkout, Yarn 1 optional binaries trimmed for the target platform. Every change keeps installs offline after preparation, with lifecycle scripts off and integrity verified.
3. **Measure on Actions.** Before and after on the refused subset, then on all four sets (nothing that prepared before may stop preparing).
4. **Sizes.** Measure what the 2 GiB workspace and 3 GiB memory profile refuses on GitHub runners and on Fly (with P1). If the evidence supports a larger default, take it through the decision bar; the owner decided the current sizes in 0.28.0 and 0.33.0, so cite them.
5. **Clear stops.** A refusal tells the customer what to change in their repository, in one sentence (with P3).

**Design questions.** Is matching the repository's own CI install flags (for example `--legacy-peer-deps`) safe to adopt by default? Where is the line between a lockfile Refit may repair and one it must refuse? Should Refit ever regenerate a lockfile?

**Measure.** Refused at preparation, by group, before and after; validated fixes gained.

**Done when.** Every refusal group is classified with counts, the largest buildable groups are built and measured, and no correct refusal was loosened.

**Keep going.** pnpm `patchedDependencies` support with integrity checks; private-registry detection with a clear message.

## O4: Correctness and the night set (start this session first)

**Why.** The launch bar says zero wrong edits. Of more than 100 validated fixes, 20 have been read in full. And every set but one has been tuned on for a week, so tonight needs a set nobody has seen.

**Read first.** `docs/FIX-REVIEW.md`, `docs/benchmarks/fix-reviews.json`, `docs/STRIPE-FRESH-RECALL.md`, `scripts/stripe-active-select.mjs`, the [active-teams selection](docs/BENCHMARKS.md#active-teams-frozen-october-16).

**Owns.** The night set, `scripts/stripe-active-select.mjs`, `docs/benchmarks/fix-reviews.json` (other lanes append), `docs/FIX-REVIEW.md`, the ground-truth files.

**Work.**

1. **Hour 1: freeze the night set.** `stripe-active-select.mjs` hardcodes its freeze date and does not exclude the active-teams list. Add `--frozen-at` and `--exclude <list>` (repeatable) options with a test, then select about 100 active TypeScript or JavaScript Stripe repositories by the same criteria as the active-teams set, excluding all four tuned sets. Commit `docs/benchmarks/2026-10-24-stripe-night-repos.json` with every exclusion recorded, open the PR, comment `READY`, and post it on the board. **Never run Refit on it, and never open its repositories' code.**
2. **Read every validated fix on `main`.** From the latest baseline, take every validated patch (the diffs are in the run artifacts), read each in full with the `docs/FIX-REVIEW.md` checklist, and add a review per repository. Use subagents to read in parallel, then check a sample of their verdicts yourself and correct the method if any is wrong. Each verdict names the Stripe page that supports it.
3. **Find the patterns.** Group partial and wrong verdicts by cause, and send each cause to the owning lane on the board with the repositories. Write a failing test for each wrong pattern in the owning lane's test file only if that lane agrees; otherwise give them the snippet.
4. **Review the night's changes.** As lanes' slices merge, review every new or changed validated diff from O5's baselines. You are the second reader for every decision taken under the bar.
5. **Recall.** Rescore the fresh-set labels (`2026-10-22-stripe-fresh-labels.json`, 159 of 222 breaking reads at `7b2c86a`) on the latest `main`, and give F1 the misses by cause.

**Design questions.** Is `correct-partial` acceptable for launch (for example when the pin cannot move)? Which verdicts need a human, not an agent, and how many can a human check by morning (pick the sample)? Are the labels themselves biased toward what Refit already finds?

**Measure.** Reviewed of validated (target: all), by verdict; recall before and after the night.

**Done when.** The night set is frozen and merged in hour 1 to 2, every validated fix on the final `main` has a verdict, no `wrong` remains unreported to its lane, and `docs/overnight/O4.md` lists the patterns and the human-review sample.

**Keep going.** Label 50 more active-set repositories blind; precision of confirmed findings.

## O5: The benchmark on GitHub Actions, trusted

**Why.** Every lane decides from GitHub Actions runs tonight. If a run is flaky, a shard silently drops repositories, or two runs of the same commit disagree, every decision is wrong. O5 also produces the baselines every lane compares against.

**Read first.** `docs/GITHUB-BENCHMARKS.md`, `.github/workflows/benchmark.yml` in `refit-dev/refit-bench` (clone it), `pipeline/stripe-benchmark-cli.ts`, `scripts/benchmark-harness.mjs`, `scripts/stripe-benchmark-compare.mjs`, `docs/BENCHMARK-DETERMINISM.md`, `docs/BENCHMARK-HARNESS.md`.

**Owns.** `refit-dev/refit-bench` (the only lane that pushes to it), the benchmark CLI and scripts in [the table](#file-ownership), `docs/GITHUB-BENCHMARKS.md`.

**Work.**

1. **Hour 1: baselines.** Run the latest `main` on all four tuned sets (at most 150 shards per run, one run at a time), and post the run ids on the board. Then run the same commit again: the two must match per repository except for documented non-determinism. Post the comparison.
2. **Tooling every lane needs.** `scripts/benchmark-subset.mjs` (subset lists from a results file and a filter, across several source lists, keeping `specs` consistent); a compare that takes two GitHub run ids and prints changed rows; a per-repository outcome class in `merged/summary.md` with totals by class. Ship each as a small `READY` slice.
3. **Correct shards.** A shard that fails at setup must show up as missing repositories in `merged`, not vanish. Make the merge job report expected versus present repositories, and fail loudly on a gap. Add a `repos` input if subset lists prove clumsy.
4. **Production mode first** in the results and summary, with O1.
5. **Baselines after merges.** Whenever P5 posts a merge batch, run the affected sets on the new `main` and post the run ids. Keep a table in `docs/overnight/O5.md`: commit, sets, run ids, totals by class.
6. **Time and capacity.** Measure wall time and queueing with 15 lanes sharing about 20 runners; propose the shard size that finishes all four sets fastest.

**Design questions.** Does the Actions runner (4 vCPUs, Linux) change outcomes against the October laptop and EC2 runs, and which repositories differ? Should results files carry the runner image and the Docker and Node versions? Is one run enough for a decision, or should a decision need two matching runs?

**Measure.** Determinism (matching repositories of total), missing-repository rate, wall time per full set.

**Done when.** Baselines exist for every merge batch, two runs of one commit match (or every difference is explained), the subset and compare tooling is merged and used by other lanes, and missing shards can no longer go unnoticed.

**Keep going.** Shopify on Actions (`benchmark:shopify` needs the saved Admin schema snapshots); a scheduled nightly run of `main`.

---

# Furqan: tracing, rules and upgrades

Furqan's lanes change what Refit sees and what it edits in Stripe code. Every one of them must clear [the decision bar](#the-decision-bar-for-changing-a-default) before an edit becomes automatic. None needs Fly or AI.

## F1: See every Stripe call and read

**Why.** Refit edits only what it traces. It traces 71% of likely Stripe calls on the active set and 51% on the fresh set, and untraced same-named reads make a draft `[Needs review]`. Recall of labelled breaking reads is 159 of 222. Every untraced call is a possible missed break, and every untraced read is a draft a customer must check by hand.

**Read first.** `pipeline/analyzer.ts`, `pipeline/factory-clients.ts`, `pipeline/class-clients.ts`, `pipeline/helper-clients.ts`, `docs/CLASS-CLIENTS.md`, `docs/CLIENT-MODULES.md`, `docs/HELPER-CLIENTS.md`, `docs/STRIPE-FRESH-RECALL.md` and its misses file, the [lazy-client rescan](docs/BENCHMARKS.md#lazy-stripe-clients-on-the-active-teams-set-october-21).

**Owns.** The tracing files in [the table](#file-ownership).

**Work.**

1. **Where tracing stops, by cause.** Run `npm run benchmark:coverage` (source only, local, fast) on all four tuned sets and classify the untraced likely calls by cause: per-organization client caches, injectable overrides (`options.stripe || getStripe()`), destructured clients (`const { customers } = stripe`), clients passed as parameters, class fields, re-exports, framework containers. Same for unresolved same-named reads, and for O4's recall misses.
2. **Fix the largest causes, one per slice.** Each with tests on real snippets from the benchmark repositories, and with escapes still stopping: a client that leaves traced code is unknown, not safe.
3. **Measure each slice.** Coverage before and after (local, source only), then affected and validated on Actions. New traced reads can turn "not affected" into "affected": that is the point, and every newly affected repository is checked against the code.
4. **Unresolved reads.** For each common unresolved pattern, decide whether tracing can prove it is not a Stripe object (an app's own `user.subscription`), so it stops making drafts `[Needs review]`. Proving it is not Stripe must be as strict as proving it is.

**Design questions.** Is a type-checker-based trace (TypeScript's checker over the whole program, as `docs/ARCHITECTURE.md` describes for the shared analyzer) more reliable than syntactic tracing for the remaining causes, and at what cost per repository? Where should tracing give up, and how does the customer see that?

**Measure.** Traced of likely calls per set, unresolved reads per repository, recall on the fresh labels; each before and after.

**Done when.** The three largest untraced causes are built and measured, recall rises with no precision loss on O4's checks, and `docs/overnight/F1.md` ranks what is left.

**Keep going.** JavaScript-only repositories (no types), monorepo packages that wrap the client.

## F2: `payment_method_types` and clients whose version cannot move

**Why.** The single largest stop: 49 to 88 affected repositories send `payment_method_types`, which `2026-09-30.endive` removed from Checkout Session, PaymentIntent and SetupIntent creation. Refit moves only an exact `['card']` (and literal lists with `card` under the `keep-listed` opt-in). Several more repositories send `['card']` but their client's API version cannot move (a `lazy()` Proxy, a class field, a spread into request arguments, `as unknown as`).

**Read first.** `docs/STRIPE-PAYMENT-METHOD-TYPES.md`, `pipeline/request-removals.ts`, `pipeline/request-migration.ts`, the `AGENTS.md` decisions of 2026-10-16 and 2026-10-21 on this parameter, the agent comparison's finding that deleting it is wrong, and Stripe's pages on `allowed_payment_method_types`, dynamic payment methods and the endive changelog (read them tonight; cite them).

**Owns.** The request-removal and version files in [the table](#file-ownership).

**Work.**

1. **Every value, counted.** From the baseline, list every `payment_method_types` site on all four sets with its value shape: literal `['card']`, literal list with card, literal list without card (`['us_bank_account']`), `card_present`, constant reference, computed, spread, conditional. Count repositories per shape, and why each stops today.
2. **Prove semantics per shape from Stripe's docs.** For which shapes is `allowed_payment_method_types` with the same list behaviour-preserving in endive (same methods offered, same ordering effects, same errors)? Write down what the docs say and what they do not settle.
3. **Widen only what is proven.** Candidates: `keep-listed` as the default for literal lists with `card` (today an opt-in), constant references that resolve to a literal list in the same module, conditional literals where every branch is a proven shape. Each under the decision bar, with tests from real snippets. Shapes the docs do not settle keep stopping, with the stop telling the customer exactly what to decide.
4. **Make versions movable.** For each version-unmovable client shape, decide whether the pin can be moved safely and build it, or make the stop say why.
5. **The customer's decision, written for them.** For shapes that must stop, the draft or report explains in two sentences what changed in endive and the one question the customer must answer.

**Design questions.** Should Refit propose a `[Needs review]` draft that moves the list and asks the customer to confirm, instead of stopping? This is the only route to most of these repositories; take it to the owner with numbers if it does not clear the bar. Is `card_present` (Terminal) ever in scope?

**Measure.** Repositories stopped on this parameter, by shape, before and after; validated fixes gained; reviews.

**Done when.** Every shape is counted and classified with its Stripe evidence, every proven widening is built and measured under the bar, and the rest stop with a customer-ready explanation.

**Keep going.** `coupon` on `promotionCodes.create` and `subscriptions.update` (with F4).

## F3: The stripe-node upgrade without regressions

**Why.** Moving to endive's pin needs the stripe-node major that knows it, and that upgrade breaks some apps' type checks: widened `OtherString` enums stored in narrow database types (six forks of one Supabase subscription starter), removed fields such as `Charge.dispute` and `trial_from_plan`, `event.type` strings the closed event union rejects, and `@types/node` 18 against stripe-node 23's need for 20 or later. Validation catches these, so Refit proposes nothing: a correct field move is lost because of the package.

**Read first.** `pipeline/stripe-package-upgrade.ts`, `pipeline/stripe-open-enums.ts` and `.json`, `docs/DEPENDENCIES.md#stripe-node-upgrade-in-a-patch`, the rejected candidates in `docs/MINED-RULES.md`, the regression rows in the baseline.

**Owns.** The upgrade and type files in [the table](#file-ownership).

**Work.**

1. **Every regression, with its type error.** From the baseline (and P2's AI runs), collect each regression's compiler output after the patch and classify the errors.
2. **Evaluate the design before building.** Is the major upgrade needed at all for each case? Options: upgrade the SDK and fix types (today); keep the SDK and pin with a typed escape (`apiVersion` through `Stripe.StripeConfig` or a cast), which keeps the old response types but sends the new header (is that honest? the code then reads new shapes through old types); upgrade the SDK and add narrowly scoped, documented type adapters at the reported sites. Measure each option on the regression set, and write down which one is correct per error class and why.
3. **Build the chosen approach for the largest classes,** with tests that compile real snippets against the actual stripe-node versions (`REFIT_STRIPE_SDK=1` suites), and never with `any` or blanket casts that hide a real break.
4. **`@types/node`.** When stripe-node 23 needs `@types/node` 20 or later, decide whether Refit may raise `@types/node` in the same patch (evidence: how many repositories, what else breaks).
5. **Measure under the bar** on all four sets: regressions down, nothing previously validated lost.

**Design questions.** Is one patch with the field moves and the SDK upgrade better than two drafts (moves first, upgrade second)? The answer changes what a customer reviews.

**Measure.** Validation regressions by class, before and after; validated fixes gained.

**Done when.** Every regression class has a decided approach with evidence, the largest are built and measured, and `docs/overnight/F3.md` records the decision.

**Keep going.** JavaScript repositories, where the upgrade has no type check to catch a break.

## F4: A rule for every endive and basil change Stripe code actually hits

**Why.** Deterministic rules made every validated fix so far, and the coding agent's correct edits (`shipping_details` to `collected_information`, `invoice.subscription` to `parent.subscription_details`, `current_period_*` to items) show what rules should cover. #201 built four mined rules that are review only. Several removed fields have no rule at all (`invoice.payment_intent`, `subscription.discount`, `charge.invoice`, `payment_intent.invoice`), and `invoices.retrieveUpcoming` was invisible until mined.

**Read first.** `docs/MINED-RULES.md`, `pipeline/stripe-field-moves.ts` (`STRIPE_MOVE_REVIEW`), `pipeline/stripe-request-moves.ts`, `pipeline/stripe-invoice-preview.ts`, `docs/benchmarks/stripe-changelog/`, and every endive and basil changelog page on docs.stripe.com for the fields involved.

**Owns.** The rule files in [the table](#file-ownership).

**Work.**

1. **The full list.** Every breaking read and removed request parameter confirmed on the four sets, with its count and its rule status: automatic, review only, rejected (with the reason) or missing.
2. **Review-only to automatic.** For each of #201's four rules, apply the decision bar: Stripe page, real-snippet tests, measured on all sets, every resulting diff reviewed. Make automatic what clears it.
3. **Rejected and missing, reconsidered.** For each, read the Stripe page tonight. Where the docs give a one-to-one replacement for the case the code uses, build the rule; where the replacement needs a choice (several payments per invoice, several discounts), keep the stop and write the customer's question.
4. **Methods that move.** `invoices.retrieveUpcoming` to `createPreview` and any other renamed or removed method the code calls: confirm Refit detects every call site, then decide about the edit under the bar.
5. **Measure each rule** on Actions and review every new diff.

**Design questions.** How should a rule treat a read whose replacement can be absent (nullable in the new shape)? When the replacement has several values (`discounts[]`), is "the first" ever provably right? Prove it from the code, or stop.

**Measure.** Confirmed reads with an automatic rule, before and after; validated fixes gained; reviews.

**Done when.** Every confirmed read on the four sets has a rule status with its Stripe evidence, every rule that clears the bar is automatic, and `docs/MINED-RULES.md` reflects it.

**Keep going.** Rules for the next Stripe release after endive, if its changelog is published.

## F5: Webhook handlers that work on both versions

**Why.** The most common breaking reads (`subscription.current_period_end`, `invoice.subscription`) often sit in webhook handlers. A webhook payload is rendered at the endpoint's API version, which a client pin does not change, so a handler rewritten to the new shape breaks until the customer also moves the endpoint. Refit therefore stops on every confirmed webhook finding. The safe edit reads the new location when present and falls back to the old one, so the handler works before and after the endpoint moves. The AI path is told to do this; no deterministic rule does it.

**Read first.** `docs/STRIPE-WEBHOOKS.md`, `docs/STRIPE-SUBSCRIPTION-PERIODS.md`, `pipeline/stripe-webhook-payloads.ts`, `pipeline/stripe-subscription-periods.ts` (the generated period helper already returns the old field when present), the webhook SDK fixture and its gated test (`REFIT_STRIPE_SDK=1`), and Stripe's pages on webhook versioning and the Event object.

**Owns.** The webhook files in [the table](#file-ownership).

**Work.**

1. **How many repositories stop only on webhooks.** From the baseline, count affected repositories whose only blocking findings are webhook reads, by field. This is the size of the prize; post it on the board.
2. **Dual-version reads, deterministic.** For each moved field with a one-to-one replacement, generate a helper that returns the new location when present and the old one otherwise, typed so it compiles against both stripe-node versions, and route webhook reads through it. Reuse the period helper's pattern; do not duplicate it.
3. **Prove it on both shapes.** Extend the gated SDK fixture: deliver old-version and new-version events (signed locally, simulated, labelled as such) to the patched handler, and show the same behaviour for both. Unit tests on real handler snippets from the benchmark repositories.
4. **The incoming-version gate.** If the dual-read edits prove safe, take the gate change through the decision bar: confirmed webhook reads covered by a dual-version helper no longer stop; uncovered ones still do. The draft tells the customer that the endpoint version can move later, independently.
5. **Measure** on all four sets on Actions; review every new diff.

**Design questions.** Should Refit also tell the customer to move the webhook endpoint's version, and when? Is a dual-read helper the right permanent shape, or should a follow-up draft remove the fallback once the endpoint is on the new version (with P4)?

**Measure.** Repositories stopped only on webhooks, before and after; validated fixes gained; reviews.

**Done when.** Dual-version reads are built for every one-to-one webhook move on the sets, proven on both event shapes, measured, and either default under the bar or behind a flag with the evidence.

**Keep going.** Thin events and `previous_attributes`; handlers that parse unsigned JSON (stay review, but explain).

---

# Ready to paste

Start each session in your main clone of `pierceluu10/Refit` (its folder is `$REFIT`), in a mode that does not stop for approvals, after the [preflight](#preflight-each-person-before-starting). Paste one block per session, replacing `<LANE>`.

| Person | Sessions, in start order                                   |
| ------ | ---------------------------------------------------------- |
| Pierce | P5 (first: it opens the board), P1, P2, P3, P4             |
| Otabek | O4 (first: the night set is due in hour 1), O5, O1, O2, O3 |
| Furqan | F1, F2, F3, F4, F5                                         |

Every lane:

```
/goal Do lane <LANE> in OVERNIGHT-AGENTS.md at the root of origin/main (read the whole file first, then your lane twice), with $REFIT being the folder this session started in. Follow its shared rules, the benchmark protocol (GitHub Actions in refit-dev/refit-bench), the decision bar, the slices-and-merging rules, the file ownership table and the board. Go deep: take the biggest problem in your lane, understand every repository it affects, build the complete fix with real-snippet tests, measure it before and after on GitHub Actions, read every diff it produces, then take the next one. Use subagents for wide read-only work and verify their output. Answer your lane's design questions with evidence in docs/overnight/<LANE>.md. Ship in slices: each slice is a PR against main with a current summary, and a READY <commit> comment when it meets its done criteria; after P5 merges it, continue from fresh origin/main. Do not stop to ask: record assumptions in the PR and keep going; record anything that needs the owner as Blocked with the exact error and move on. Start no new slice after 6 hours from T0 on the board, and hand off by 7 hours. This goal is met when the lane's "Done when" holds with evidence in merged or READY PRs (or each unmet item is recorded as Blocked with its cause), its "Keep going" items have been worked in order until the cutoff, docs/overnight/<LANE>.md is complete, every PR summary is current, and every worktree this session created is removed.
```

P5 adds one sentence to the end: "You are the integrator: open the board first, then run the merge loop all night, and end with the final runs, the docs and the morning summary by 9 hours from T0." O5 adds: "Post the first baselines of main on the board within your first 90 minutes." O4 adds: "Freeze, commit and mark READY the night set within your first hour, before anything else."

# Morning checklist for the owner

1. Read the last comment on the board (P5's morning summary) and `docs/LAUNCH-CHECKLIST.md` on `main`.
2. Read every `AGENTS.md` bullet dated 2026-10-24: each is a default changed under your sign-off. Revert any you disagree with (`git revert -m 1 <merge>`) before deploying.
3. Check the launch-bar table: zero wrong edits, production-mode fix rate, night-set gap, Fly forks.
4. Check Fly: `fly status -a refit-hosted` shows `shared-cpu-2x` and 4 GB, the AI cap is back to $2, and `fly ssh console -a refit-hosted -C "refit hosted jobs --status running"` is empty. Check the night's Fly and OpenAI spend.
5. Close sessions that ended; restart any stopped on a usage limit with the same goal, if their lane still matters.
6. Decide the items P5 lists as needing you, then decide on launch.
