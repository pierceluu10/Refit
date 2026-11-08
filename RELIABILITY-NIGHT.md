# Refit reliability night: three prompts

Drafted 2026-11-08 against `mvp` at `5231183b`. The MVP is integrated and has opened real PRs on the test org. Tonight turns it from "works when someone watches it on a laptop" into something that runs by itself and tells the truth about what it did.

`AGENTS.md` still wins over this file, above all the AI-first rule and the four hard limits.

## How to use this

Each founder opens one Claude Code session on the Refit repo and pastes their prompt from below. Each prompt splits into lanes, and each lane is a subagent in its own worktree. Lanes are in priority order, so if a plan runs out the most important work is done.

| Founder | Claude plan | Prompt                      | Owns                                                                                                             | AI cap |
| ------- | ----------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------ |
| Otabek  | 15x         | Every task runs and is true | `orchestrator/`, `harness/`, `memory/`, `evals/`, `compliance/`, `app/jobs.ts`, `app/queue.ts`, `app/lifecycle/` | $50    |
| Furqan  | 5x          | What Refit finds is right   | `providers/`, `inventory/`                                                                                       | $12    |
| Pierce  | 10x         | Refit runs as a product     | `app/` except the three paths above, `src/`, `public/`, root deploy files, `app/SETUP.md`                        | $15    |

The caps total $77, and Pierce approved them on 2026-11-08. They are API dollars for Refit's own model calls, separate from the Claude plans. $40 of Otabek's cap is the benchmark.

## Where we are

Measured on the `refit-dev` test org, on the three demo repos.

**Working**

- Install webhook, scan, queue and real draft PRs through the running App server.
- Three draft PRs are open:
  - [`demo-node-api#1`](https://github.com/refit-dev/demo-node-api/pull/1): Node 18 → 26, `runtime-eol`.
  - [`demo-python-app#1`](https://github.com/refit-dev/demo-python-app/pull/1): Werkzeug 2 → 3 with Flask, `dependency-major`, $1.76.
  - [`demo-node-api#2`](https://github.com/refit-dev/demo-node-api/pull/2): AI Act Article 50(2) marking, `regulation`, $0.12.
- The migration agent now gets only Refit's tools ([#508](https://github.com/pierceluu10/Refit/pull/508)). The same task cost $2.15 and failed before that fix.

**Not working or not proven**

| Gap                                                                                                                                                                                        | Evidence                                                                                         | Lane |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ---- |
| Four other Agent SDK callers still lack the connector settings                                                                                                                             | `inventory/agent.ts`, `inventory/surfaces/agent.ts`, `memory/ai.ts`, `orchestrator/agent-sdk.ts` | O1   |
| Past the cap, tasks now wait as `waiting-budget` ([#509](https://github.com/pierceluu10/Refit/pull/509)), but a failed match is still recorded as `failed`, and a held job needs a restart | 55 of 58 run records were "not attempted" at $0 before #509; `orchestrator/loop.ts:401,416`      | O2   |
| A $0.12 task needs a $2 hold to start                                                                                                                                                      | `MIN_TASK_USD` in `orchestrator/deps.ts`                                                         | O2   |
| All three PRs ended needs-review; nobody has traced what `verified` needs                                                                                                                  | PR bodies                                                                                        | O4   |
| A rule's PR title is a raw sentence cut off mid-word                                                                                                                                       | `demo-node-api#2`, `harness/pr.ts:47`, `app/lifecycle/open.ts:137`                               | O4   |
| No real-repo measurement since the MVP. Demo repos are small and hand-built                                                                                                                | `upgrade-dev-20` has never run                                                                   | O6   |
| A scan costs $1.26 to $2.30 per small repo                                                                                                                                                 | saved scan reports                                                                               | F2   |
| 158 findings across three small repos, 22 scan errors, some from placeholder hosts like `chat-widget.example.com`                                                                          | saved scan reports                                                                               | F3   |
| A Werkzeug major shows a "deadline" of 2023-09-30, which is a release date                                                                                                                 | `demo-python-app#1`                                                                              | F4   |
| No AI model retirement PR yet, though the demo needs one (`text-davinci-003` in `demo-node-api`)                                                                                           | no PR; the task was not attempted                                                                | F5   |
| `demo-next-web` has 0 PRs                                                                                                                                                                  | every task "not attempted", cap used                                                             | P1   |
| Merging a PR, then seeing it on the dashboard and in memory, has never run for real                                                                                                        | MVP demo checklist                                                                               | P1   |
| The server only runs on a laptop; nothing is deployed                                                                                                                                      | no Dockerfile or host config on `mvp`                                                            | P2   |
| The dashboard API has one shared service token and no customer login                                                                                                                       | `app/api/auth.ts`                                                                                | P3   |

## What "reliable" means tonight

We're done when all of these are true, or the PR says exactly which aren't and why:

1. No task is recorded as failed unless Refit tried it.
2. Killing the server mid-run and restarting it finishes the work with no duplicate PR and no double charge.
3. The dollar cap is never exceeded.
4. Refit's agents can reach only Refit's tools, on every code path.
5. A fresh install on a clean machine reaches a scan report and PRs with no hand edits.
6. A founder can log in and see only their own org's data.
7. A real-repo benchmark has a hand-checked number.

**Not tonight:** new change kinds, new languages, merging to `main`, deploying the website, billing.

## Rules for every prompt

- Branch from `origin/mvp` with `--no-track`, one branch per lane, named `rel/<lane>`. Open a **draft PR into `mvp`**. Never push to `main`, never merge, never force-push.
- Edit only the paths you own. If you need a change in someone else's path, write it in your PR's status note.
- `RunRecord.outcome` now includes `waiting-budget` (#509). Use it for work the cap couldn't cover. `shared/types.ts` changes stay additive.

- Only Pierce's session runs the real GitHub App or opens real PRs on `refit-dev`. Everyone else uses dry runs, fixtures or the benchmark workflow. Don't add repos to the install. Only a founder changes the App's settings, by hand.
- AI-first: the model reads, decides and edits. No new rule that stops or skips a task. Waiting for budget is a retry, not a stop.
- Hard limits, in code: repo code runs only in the sandbox; a run-level dollar cap; PRs only; never print or commit secrets.
- Every real model run sets `REFIT_AI_BUDGET_USD`. Lane O6's $40 is approved. Any other real benchmark needs founder approval of its cap.
- Label examples. Don't invent customers, metrics or passing checks.
- Run `npm run typecheck`, `npm run format:check`, `npm test` and `npm run build` before each commit. GitHub Actions don't start on this repo, so local checks are the record. Conventional commits, no AI attribution lines, no co-author trailers.
- Every bug fix ships with a test that fails on the old code. Reproduce on the real thing where it's free.
- End each lane with a short status note in its PR: done, not done, what to check.

---

## Otabek: every task runs and the result is true

```text
Make every Refit task run, survive failure and report the truth. Read AGENTS.md, then RELIABILITY-NIGHT.md on origin/docs/reliability-night, and follow its rules. You own orchestrator/, harness/, memory/, evals/, compliance/, app/jobs.ts, app/queue.ts and app/lifecycle/. Branch from origin/mvp. Use one subagent and worktree per lane, draft PRs into mvp, lanes in this order. AI cap: $10 for development, plus $40 for lane O6.

O1. Agents get only Refit's tools, everywhere. harness/agent.ts has strictMcpConfig: true and env ENABLE_CLAUDEAI_MCP_SERVERS=false. inventory/agent.ts, inventory/surfaces/agent.ts, memory/ai.ts and orchestrator/agent-sdk.ts don't. Move the options into one helper all five use (orchestrator/agent-sdk.ts:24 already notes a duplicate to remove). You may make the small edit in the two inventory files. Test that fails on the old code. Measure prompt tokens per call before and after in a capped real session on a machine logged in to claude.ai, and report what it saves: it may explain part of the scan cost.

O2. Finish what PR 509 started. A task the cap can't cover is now recorded as waiting-budget and its job is held until the process restarts. Still to do: a failed match is still recorded as failed with "not attempted" (orchestrator/loop.ts:401,416), and it should be retried instead. A held job should resume when budget is available, without paying for a new scan. Order tasks by deadline, then severity, so the cap goes to what matters most. Rethink the hold: real tasks have cost $0.12 to $2, and the $2 MIN_TASK_USD blocks cheap work. Let a task start on what's left and let the ledger stop it, keeping the cap exact. Test: a cap too small for all tasks gives 0 failed records, then a larger cap finishes them with no second scan.

O3. Survive crashes and cancels. Kill -9 the process during a real Docker run and restart: no duplicate PR, no double charge, no orphaned containers, the job finishes. runRepoJob must honour cancel, including uninstall mid-run. Each task gets a wall-clock limit. Reproduce each one before fixing it.

O4. PRs that are correct and readable. Trace why all three real PRs ended needs-review and what would make one verified, and write it down; keep it honest, don't loosen it to raise the number. Fix: rule PR titles (a raw sentence cut mid-word; harness/pr.ts:47, app/lifecycle/open.ts:137), the contradictory "on the old runtime" and "before on the sandbox default" wording, Node 26 missing from OFFICIAL_RUNTIMES, and kind 'other' in the lifecycle marker for rule changes. Guide the agent, in the prompt or playbook, on a target a platform doesn't offer yet (demo-node-api#1 set engines to 26 with Lambda on 24).

O5. Rules read and memory. The rules read gave 56 obligations and then 46 on the same sources: make it stable, and re-read only when a source changes. Memory must ignore any old "not attempted" records and must learn only from real attempts. Rule PRs never say "compliant".

O6. First real benchmark, only after O1 to O4 are up. Run evals/sets/dev/upgrade-dev-20.json through evals/workflows/benchmark.yml on GitHub Actions, not on a laptop or AWS, with production flags. At about $4 a repo, $40 covers the first 10: say which ten and why. Dispatch it early and don't poll. Hand-check every PR-worthy result against evals/reviews.json before quoting a number. Report attempted rate, verified, needs-review, failed, cost per repo, and every wrong patch.

Done: each lane has a draft PR into mvp with its status note, and every claim has a test or a run id behind it.
```

---

## Furqan: what Refit finds is right, sourced and cheap

```text
Make Refit's findings correct, sourced and cheap. Read AGENTS.md, then RELIABILITY-NIGHT.md on origin/docs/reliability-night, and follow its rules. You own providers/ and inventory/. Otabek's lane O1 makes a small edit to inventory/agent.ts and inventory/surfaces/agent.ts, so don't restructure the query options there. Branch from origin/mvp. Use one subagent and worktree per lane, draft PRs into mvp, lanes in this order. AI cap: $12. Use dry runs and fixtures; don't open real PRs.

F1. Ground truth first. By hand, write what each of the three demo repos and five repos from evals/sets/dev/upgrade-dev-20.json really depend on and what's really behind, without looking at Refit's output. Commit the labels. Measure inventory and finding precision and recall against them, on two runs, and report how much the runs differ. Every later lane reports against this.

F2. Scan cost. A scan costs $1.26 to $2.30 per small repo, so scanning eats the budget before any fix. Find where it goes. Reuse reads: a provider's changelog is read once a day across all repos, and a repo's inventory is cached by commit. Your r3/cost branch (PR 483, into main) did this for the old code and isn't on mvp: port what still applies. Target under $0.75 for a first scan and close to $0 for a repeat with nothing new. Report before and after on the same repos, and show recall from F1 didn't drop.

F3. Real findings, real errors. The three reports hold 158 findings and 22 errors. Read every error and fix its cause. Placeholder hosts such as chat-widget.example.com shouldn't become watch targets: fix that through the inventory agent's guidance, not a block list. A source that can't be read says so plainly, and never invents anything. Collapse duplicate findings for one underlying change.

F4. Deadlines and ranking. What's behind is sorted by deadline, but a release date is being used as one (demo-python-app#1 shows Werkzeug with a deadline of 2023-09-30). A deadline is the date something stops working or stops being supported. Fix this across watchers so the top of the list is what actually hurts first.

F5. Upgrade tools on the cases the demo lacks. Make sure the tool packs and playbooks handle: an AI model retirement (demo-node-api uses text-davinci-003), a deprecated GitHub Action (demo-next-web), a Stripe API change and a Next.js major. Prove each on a dry run. Fix the scanner shortcuts real repos will hit: inventory/scanners-models.ts:7 and inventory/scanners-platform.ts:213,289,398.

F6. Coverage list. For every change kind in MVP-PLAN.md section 2, show one live source returning a real change with a link and quote, or say that the kind has none yet and why. Don't pad it.

Done: each lane has a draft PR into mvp with a status note and before/after numbers from F1's labels.
```

---

## Pierce: Refit runs as a product, not on a laptop

```text
Finish the real demo, then make Refit run on a server that real customers can use. Read AGENTS.md, then RELIABILITY-NIGHT.md on origin/docs/reliability-night, and follow its rules. You own app/ except app/jobs.ts, app/queue.ts and app/lifecycle/, plus src/, public/, app/SETUP.md and root deploy files. Branch from origin/mvp. Use one subagent and worktree per lane, draft PRs into mvp, lanes in this order. AI cap: $15. Only this session runs the real App on refit-dev, and only on its three demo repos. Ask me before any deploy, anything that costs money, or any real run beyond its cap.

P1. Finish the demo on real GitHub, working through MVP-PLAN.md's demo checklist. List what I must do by hand first: grant Workflows read and write on the App and approve it on the install, and set the Setup URL. Then get real PRs for the AI model retirement and for demo-next-web (a CI action version, if Workflows is granted). Read every PR by hand and record in evals/reviews.json whether you'd merge it, including the blockers already known on demo-node-api#1. Merge one with my go-ahead and confirm the verdict reaches the dashboard and memory. Open Platforms and rules in a browser on real data. Export the audit CSV. Keep a list of everything that broke.

P2. Run on a server. Add a Dockerfile and host config for one app server. Keep the existing file stores on a persistent volume; that's the smallest thing that works for one worker, and the stores' shortcut comments say when to move to a database. First prove the Docker sandbox runs on the host you pick, because that decides the host. Fly was used before and its machine and volume are gone, so a volume named refit_data must exist before deploying. Secrets live in the host's secret store. Add a health check and logs that never hold secrets. Prove a restart loses nothing. Build all of it and stop before deploying for my go-ahead.

P3. Login and isolation. Add GitHub login for the dashboard. A signed-in person sees only orgs they belong to and that have installed the App, on every /api route. The service token stays for internal calls only. Write a test proving one org can't read another's reports, runs, PRs or audit log. One suspended installation must not 502 the whole list (app/api/routes.ts:129).

P4. A clean first install. From Install on GitHub through the Setup URL to onboarding, a visible first scan, then findings. Duplicate webhook deliveries do nothing twice. Uninstall deletes that org's data. Fix app/SETUP.md, which names a redelivery step GitHub no longer offers. Run it from a clean state and a clean clone.

P5. A dashboard that tells the truth. Show waiting-budget work as waiting, never as failed, on every screen (PR 509 added only the status badge). Show scan errors, cost per scan and PR state from real data, with real empty, loading and error states. Check at desktop and phone width in a browser. Polish, don't redesign (DESIGN.md).

Done: each lane has a draft PR into mvp with a status note, and the demo checklist is ticked or says exactly what's still broken.
```

---

## Morning: merging and proof

Pierce merges into `mvp`, after reading each PR against the AI-first rule, in this order:

1. O1, because it's a security fix and changes token counts everything else measures.
2. Furqan's lanes, F1 to F6.
3. O2 to O5.
4. P2 to P5.

Then one end-to-end run from a clean state on the three demo repos, with a founder-set cap, and check:

- [ ] All seven points in "What reliable means tonight" hold, or a PR says which don't.
- [ ] No `failed` record without an attempt.
- [ ] At least one PR each for a runtime, an AI model retirement, and a CI action or library major.
- [ ] One merged PR shows up on the dashboard and in memory.
- [ ] Typecheck, format check, tests and build pass on `mvp`.

O6's benchmark number goes in `evals/reports` only after the hand-check. `main` and the live website don't change until the founders decide.
