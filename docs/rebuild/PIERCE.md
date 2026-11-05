# Refit rebuild: Pierce (P1 to P8)

## How to run this

- **Mode:** use ultracode, Opus 5.5 at max effort, in auto mode.
- **Keep the laptop awake:** run `caffeinate -dimsu` in the background and keep the laptop plugged in.
- **Setup:** Node 24 or later, Docker running, `gh` signed in, and `ANTHROPIC_API_KEY` in a gitignored `.env`. Run `npm ci --ignore-scripts`.
- **Don't ask questions.** Furqan is asleep and nobody will answer. Whenever you have a choice, take your recommended option, log it in `docs/rebuild/DECISIONS-PIERCE.md`, and keep going.
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

Nobody is available overnight. When you'd normally ask, do this and log it in `docs/rebuild/DECISIONS-PIERCE.md`:

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

**Your spend cap:** $10 of real model runs. Almost all of this lane should cost $0.

### P1. The rule change and the contract

Open a small separate draft PR, `rebuild/rule`, that rewrites the top rule in `AGENTS.md`:

> Plain code decides what to look at. AI fixes anything new, and proven fixes become plain code. Plain code never decides that something can't be fixed.

Also update these lines:

- "Parsers, scanners, validators and codemods ... Never gates" and "a fixed list of patterns as the only way to find API usage". Scanning and comparing may now decide whether a repo needs work. The unlisted-provider queue (P3) and the AI sweep (O7) keep the list from being the only way to find things.
- "Guidance lives in prompts, playbooks and memory, not in `if` statements". Proven fixes are now allowed as code.
- "The old deterministic engine stays in git history; don't port it back". Its data may be reused, but not its design.
- "Every task ends in a PR or a 'not affected' verdict". Add "couldn't fix, with a short report" as an honest ending.

Keep "when unsure, it tries anyway and says so". All three founders must approve this PR before it merges. Keep building on your branch in the meantime.

Then add the shared types, additively, and push them first so Otabek can use them:

- `DeadApiEntry`: the list entry in P2.
- `Finding`: entry id, file, line, match class, version found.
- Scan result: findings, unlisted providers, and whether it's clean.

### P2. The list

Turn `DEAD-APIS.md` into a kept data file in `dead-apis/`, with a loader, schema and tests. Each entry holds:

- provider, what died, and when
- official source URL and the date checked
- what to look for: a string, or a field read in code using that provider
- which versions it applies to
- the replacement, which must appear on the provider's own page
- what else the replacement requires. Example: moving to Claude 4.7 or later means dropping `temperature`.

Keep future shutdowns separate, so they're never flagged as breaks.

- **Measure:** every entry has a source and date, and the tests pass. Spot-check 10 entries against provider pages by hand.

### P3. Keep the list current

- Use the shared changelog read from #483 to propose new entries, with one AI read per source and never one per repo.
- A proposed entry needs a source quote before it goes live.
- If a scan finds a provider that isn't on the list, add it to a queue so AI reads its sources once. That must never count as "nothing to do".
- Add providers from the queue, most common first, using the old registry at `c4b113a5^` where its sources are still right. Its dates are stale, so re-check them.

- **Measure:** cost per provider per day, and how many entries a hand-check agrees with.

### P4. Scanner and compare

Merge or rebase the inventory from #483 (`inventory/scan.ts`, `inventory/scanners.ts`). Add model strings, URLs, field reads and version checks, then join the scan to the list in plain code.

- A pin never makes something safe by itself. Compare the pinned version to the entry's versions.
- Use the old registry's match classes (live, catalog, test, comment) from `c4b113a5^`, so comments and catalogs don't trigger fixes. They took OpenAI line precision from 14% to 83% in PR #72.
- Send unclear matches to one small AI check, never straight to a fix.
- No match stops at about $0.

Regression fixtures. These repos have been seen, so they're checks and never the score:

| Repo and commit | Must flag |
|---|---|
| `mantou132/Spotify-Lyrics` @ `1380002c0830` | `src/common/ga.ts`: Universal Analytics `/collect` in both send paths |
| `MuhammadTanveerAbbas/Clario-ai` @ `1cb1754244fc` | Stripe webhook reads `current_period_*` and `invoice.subscription` while pinned to `2026-02-25.clover` |
| `MFaizanali2/Code-Review-Agent` @ `32fd5bb17d89` | `claude-sonnet-4-20250514`, `gemini-2.0-flash`, `llama-3.3-70b-versatile`, and dead models in the frontend picker. `temperature` is carried by the Anthropic entry |

| Repo and commit | Must stay quiet |
|---|---|
| `alanagoyal/branded` @ `cf8f84cc8bfc` | Reads fields that exist at its SDK's pinned version |
| `pretzelai/lumen` @ `c689c56b3241` | Pinned before the removal, and its `invoice.subscription` hits are the app's own objects |
| `Small-Web-Co/tinypivot` @ `69caa7e03901` | Nothing removed at its pins |

- **Measure:** all 9 required changes flagged, 0 false alarms on the three quiet repos, $0 of model spend.

### P5. Loop: make the scanner accurate

Run the scanner over the green repos in `evals/sets/dev/`, excluding the repos above. Log to `docs/rebuild/ITERATIONS-PIERCE.md`.

- For a random sample each round, read the repo by hand or with AI, and find what's really dead that the scanner missed and what it wrongly flagged.
- Each miss or false alarm becomes a scanner rule or list entry, plus a permanent fixture.
- **Targets:** at least 90% of really dead items found, at least 85% line precision, under 30 seconds a repo, and $0 of model spend on repos with no unclear matches.

### P6. Triggers

Scheduling must not depend on a person starting a run.

- Rescan when the repo changes or when the list gains an entry.
- Skip repos whose tree hasn't changed since the last clean scan.
- Report what ran and why, so we can truthfully say Refit is always watching.

- **Measure:** cost per repo per month on repos with nothing to do. Target about $0 of model spend.

### P7. Evidence for the memory layer

Memory is only as good as what it learns from. From the GitHub App, send Otabek's memory code:

- **Merged:** whether a person's commits changed our PR, and the diff between our PR and what was merged.
- **Closed:** that it was closed, plus any comment explaining why.
- **Reverted:** a later revert of the merged fix. Rescans finding the dead thing back count too.
- **Repo habits:** team rejections and repeated edits.

Post the shape on Otabek's draft PR and build it without waiting. Cover redelivered and out-of-order webhooks with tests.

Add a setting at install for whether a customer agrees to shared learning. The default is no. Without consent, nothing from that customer leaves their own store.

### P8. Anything else that makes it better

Look at what's left in your lane, and do what clearly helps. Candidates:

- speeding up scans on large repos
- reading more languages, if real repos show a gap (JS and Python are confirmed, Go and Java aren't)
- showing the scan, proof and learning results in the dashboard, so a customer can see them

Measure each one, and log it.
