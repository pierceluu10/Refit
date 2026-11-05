# Refit rebuild: Otabek (O1 to O10)

## How to run this

- **Mode:** use ultracode, Opus 5.5 at max effort, in auto mode.
- **Keep the laptop awake:** run `caffeinate -dimsu` in the background and keep the laptop plugged in.
- **Setup:** Node 24 or later, Docker running, `gh` signed in, and `ANTHROPIC_API_KEY` in a gitignored `.env`. Run `npm ci --ignore-scripts`.
- **Don't ask questions.** Furqan is asleep and nobody will answer. Whenever you have a choice, take your recommended option, log it in `docs/rebuild/DECISIONS-OTABEK.md`, and keep going.
- **Do the tasks in order.** Commit each one as `<id>: what changed`, for example `P2: add the dead-API list`, and push after every task.

## The goal

Make Refit (called Aptitude in parts of the code) find more real API breaks, cost far less, and get better with use. Plain code finds what's dead, Claude fixes anything new, plain code proves the fix, and every merged fix teaches Refit something.

Read these before you start. They're in `docs/rebuild/` on the `docs/rebuild` branch:

- `REBUILD-PLAN.md`: the full plan and reasons.
- `TEST-2026-11-04.md`: the test that started this. Refit fully fixed 0 of 9 required changes at $12.44.
- `DEAD-APIS.md`: the hand-written dead-API list.
- `LIST-TEST.md`: whether Claude fixes these breaks when given the list, and whether notes from earlier fixes help. It may not exist yet. Furqan's session pushes it to `origin/docs/rebuild` when that test finishes.

**Check for `LIST-TEST.md`:** run `git fetch origin` before each task and merge `origin/docs/rebuild` once it's there.

| Test result | What to do |
|---|---|
| Not there yet | Keep building, and do all the $0 work. Otabek holds paid runs until it arrives, unless a paid run is needed to prove the code works at all, and keeps those small |
| Claude with the list fixed at least 50% | Carry on as written |
| Under 50% | The fix step is the problem. Pierce carries on, because the list and scanner are needed either way. Otabek spends up to $10 finding out why fixes fail, writes it up, and tries the changes that fix it before O8 |

## Who does what

| Lane | Who | Branch | Folders |
|---|---|---|---|
| P | Pierce | `rebuild/pierce` | `inventory/`, `app/`, new `dead-apis/`, the rule PR |
| O | Otabek | `rebuild/otabek`, `rebuild/integration` | `harness/`, `orchestrator/`, `memory/`, `evals/` |

- Branch from `origin/docs/rebuild`, which is `main` plus these docs, and open your draft PR into `main` early.
- Stay in your own folders. Keep any edits to `orchestrator/deps.ts` small. Otabek resolves conflicts in `rebuild/integration`.
- Talk through comments on each other's draft PR: repo, task, and what went wrong. Don't wait for a reply. Make your best choice and adjust when one comes.
- Fetch the other lane often, and code against `shared/types.ts`, using a local stub until the real module lands.
- Build on open PRs #483, #484 and #485 where they fit, instead of redoing them. Don't rename anything: #486 handles that.

## Self-iterate until it's right

After building, each lane runs this loop on the task marked **Loop**:

1. Measure.
2. Read every failure and sort it into a cause.
3. Fix the biggest cause that belongs to your lane. Send the others to the other lane.
4. Measure again, on repos you haven't tuned against whenever you can.
5. Log it in your lane's iteration file: time, commit, numbers, cost, top causes, what changed.

Stop when the targets are met, after two rounds in a row with no gain, or at the spend cap. Write down what's blocking if you stop short.

Keep the numbers honest:

- Never hard-code a repo name, path or test answer to raise a score.
- Never edit a locked test to make it pass.
- Only count repos that pass their own checks before any edit. Log every exclusion and the reason.
- Before a paid run, remove repos with the same tree, and ask whether the change could actually move a result. If not, skip the run.
- Hand-check at least 10 results per measurement, or all of them if there are fewer. Report how often you agree.
- If a number looks too good, assume it's wrong until a hand-check backs it up.
- Measured or not stated.

Before finishing each task, review your own diff for bugs and simplify it. If you spot something else that would clearly improve fixes, cost, speed or learning, and it stays in your lane, do it and log it.

## Rules

- **Spend:** real model runs need a cap in `APTITUDE_AI_BUDGET_USD`. Your lane's total is below. Report every run's cost.
- **Hard limits:** untrusted repo code runs only in the sandbox. PRs only. The product never pushes to a default branch and never merges.
- **Git:** never force-push. If you need to rebase, push under a new branch name. Never push to or merge into `main`. All work lands as draft PRs.
- **Commits:** before every commit, run `npm run typecheck`, `npm run format:check`, `npm test` and `npm run build`. Use conventional commits, authored as yourself, with no co-author trailers, "Generated with" lines or session links.
- **Secrets:** never print or commit a key or env value. Before each commit, check that `.env` is ignored and grep the staged diff for secrets.
- **Contract:** change `shared/types.ts` additively only.
- **Sealed sets:** never open one. Otabek's last task covers this, and it needs approval.
- **Public repos:** don't open PRs or issues on repos we don't own. Measure in local containers.
- **Don't invent** customers, metrics or passing checks.

## Never wait for an answer

Nobody is available overnight. When you'd normally ask, do this and log it in `docs/rebuild/DECISIONS-OTABEK.md`:

| Situation | What to do |
|---|---|
| A choice between options | Take your recommended one |
| An open PR conflicts with this plan | Follow this plan, and don't edit that PR's branch |
| The spend cap is reached | Stop paid runs, and keep doing $0 work |
| You'd need to break `shared/types.ts` | Find an additive way |
| You'd need a paid service | Use a free or local option |
| You'd need to change a hard limit | Don't. Log what you wanted and why |
| A target is badly missed after the loop ends | Write down why, and move to the next task |
| You're blocked by something outside your control | Log it, and do whatever isn't blocked |

Never get around a rule, a sealed set or a spend cap to keep going.

## When you finish

Push, update your draft PR body with what works, the measured numbers, what's unproven, every decision you made, and what's left. Answer every comment from the other lane. Nothing merges until the founders review it.

## Your tasks

**Your spend cap:** $50 of real model runs. O9 needs its own approved cap and doesn't run overnight.

Pierce pushes the shared types first in P1. Start with a local stub if they aren't up yet.

### O1. Set up the integration branch

- Bring #484 and #485 in where they fit. If one conflicts with this plan, follow the plan and log it.
- Create `rebuild/integration`. At the start of each measurement, merge the latest `rebuild/pierce` and `rebuild/otabek` into it, and run the four checks.
- Settle on one price table. The cache-read prices disagree across `harness/ledger.ts`, `orchestrator/budget.ts` and `providers/core/model.ts`. Use the provider's published prices, and say whether earlier cost numbers were affected.

### O2. One session per repo

Replace per-task agents with one session per repo that gets every finding from the scan.

- Sonnet by default. Opus only after a failed check.
- The cap is $1 a repo, replacing the $5 hold per task.
- Check `MIN_TASK_USD` in `orchestrator/deps.ts`. On `main` it's a $2 floor, which would stop every task under a $1 cap. #485 may already handle this.
- Use prompt caching for the system prompt, list and tools, so retries and repeats cost less. Check that it's actually hitting.
- Reuse install layers in the sandbox where it's safe, so setup doesn't dominate the time.

Give the session these rules:

- The list is the scope. "Out of scope" isn't an answer for anything on it.
- No major upgrade unless a list entry requires it.
- If a fix needs a secret or an ID, read it from config and say in the PR what a person must set. Don't decline.
- Change defaults and live paths, not only tests.
- Replacements must come from the list entry, so names can't be made up.
- Don't edit existing tests just to go green.

**Measure:** required changes fixed, cost and time per repo on fresh repos, and cost per required change fixed. Use the 3 repos in P4 only as a regression check.

### O3. Proof and labels

Rerun Pierce's scanner after each fix, then apply these labels:

| Label | Means | Action |
|---|---|---|
| Fixed | Rescan clean, checks no worse than baseline | PR |
| Needs a look | Partly clean, or checks don't touch the changed code | Draft PR that says so |
| Couldn't fix | New failures, or the entry is still there | No PR, short report |

- Change `orchestrator/loop.ts`, which currently opens a normal PR for needs-review.
- Keep the existing outcome names if that's the smallest change, and tighten what they mean.
- Say in the PR body that a clean rescan shows the dead thing is gone, not that a live call succeeds.
- Make the PR easy to accept: what died, the source, what changed, what was proven, and what a person must do.

**Measure:** hand-check at least 10 "Fixed" results. Target at least 90% agreement.

### O4. Move memory and review off the fix path

- Memory and review run in batches after the fix, and can't delay or block it.
- Memory extraction and the reviewer default to Opus today. Use a cheaper model unless a test shows Opus is worth it, and use batch pricing where you can.
- Memory stays out of the $1 per-repo fix cap, with its own small budget.

**Measure:** per-repo cost split into fix and learning. Target about $0.50 a repo for the fix, never above $1.

### O5. Fix what memory learns from

`memory/` learns from "verified", which was unreliable in the 2026-11-04 test. Change it:

- A fix counts as a success only if its PR was merged and the rescan was clean. "Verified" alone can't create or promote anything.
- Until a fix has real merges, it can only be a low-confidence recipe, marked as such. For benchmarks with no real merges, passing a locked test is the stand-in, and it must be labelled that way.
- Use Pierce's evidence from P7. An edit no longer counts as a plain success: store what the person changed, and feed it into the recipe's pitfalls.
- Reverts and closes count against a fix.
- Turn misses and false alarms into detection lessons, and send them to Pierce's scanner as rules and fixtures.
- Keep each repo's habits: install steps, checks that work, and what the team rejected. Use them on the next run.

### O6. The ladder

Each list entry has a level, kept in the store with its evidence:

1. **New:** Claude fixes it from the entry.
2. **Recipe:** steps and pitfalls from a merged fix go to Claude next time.
3. **Proven fix:** after at least 3 merged fixes on different repos with few edits and no reverts, write a plain-code transform in `providers/<provider>/`, with tests built from those real fixes. It runs with no model.
4. **Dropped:** a close or revert moves it down a level, and the evidence stays.

A proven fix runs first and still has to pass the rescan and checks. If it fails, Claude takes over, so a proven fix can never block an attempt. Roll new ones out to a few repos before the rest.

For benchmarks, a locked-test pass can stand in for a merge to test the mechanics. Label those fixes as benchmark-only, so they never count as proven for customers.

Also split the store:

- **Per customer:** runs, transcripts, repo habits. Never shared.
- **Shared:** general patterns with no customer code, names or secrets, only from customers who agreed. Add a test that proves the scrubbing works.

Move off local JSON if needed, because two processes can't safely write to it. Use something free or local, not a new paid service.

### O7. Prove that learning works

Replace self-eval, which reruns past tasks and may use recipes learned from those same tasks.

- From the same commits, run fresh repos with memory on and memory off. Vary the order, and grade blind. Never test a repo that fed the memory under test.
- Add a small AI sweep on a sample of repos each month, to measure what the scanner missed.
- **Target:** more fixed, or at least 30% less cost, with memory on.
- Report the result even if memory doesn't help. If it doesn't, stop writing proven fixes and say why.

Track these from now on: share of fixes needing no model, PRs merged without edits, reverts, and scanner misses found by the sweep.

### O8. Loop: run it end to end

Run the whole product from `rebuild/integration` on fresh green repos from `evals/sets/dev/`, picked by a written rule. Log to `docs/rebuild/ITERATIONS-OTABEK.md`.

Lock required changes and tests before each round, and prove they fail at baseline and can pass.

**Targets, on repos with real breaks:**

| Metric | Target |
|---|---|
| Required changes fixed | At least 70%, then push as high as it will go |
| "Fixed" that a hand-check agrees with | At least 90% |
| Cost, repo with no match | About $0 |
| Cost, repo with matches | About $0.50, never above $1 |
| Time, repo with matches | Under 5 minutes |
| Unneeded major upgrades | None |

Use fresh repos each round, so you don't tune to the ones you've seen. Send scanner and list causes to Pierce through the draft PR.

### O9. Score it once: don't run this overnight

This needs Furqan's approval and a cap, so don't run it. Make it ready to run, and go on to O10. When it's approved, it runs:

1. Fresh repos picked by a written rule.
2. The sealed set, once. Tune nothing after opening it.
3. An independent run against Claude Code, with the bare prompt and with a detailed prompt, plus a Refit row with empty memory.

Lock tests first, grade blind, hand-check a sample, and write it up in plain language, including wherever Refit loses. Report cost per required change fixed.

### O10. Anything else that makes it better

Look at what's left in your lane, and do what clearly helps. Candidates:

- smarter retries that feed a failed check back to the session, instead of starting over
- one PR per repo that groups related changes cleanly
- cheaper models for simple breaks like a plain model swap

Measure each one, and log it.
