# Refit rebuild plan

Written 2026-11-04, revised the same day. Not started. Not committed.

Evidence: `/Users/furqan/Documents/PROJECTS/refit-vs-claude-2026-11-04/REPORT.md` and `evals/reports/round-3/` on `origin/r3/loop`.

## The goal

Plain code finds what's dead in a repo. One Claude session fixes the whole list. Plain code then proves it's gone.

Every fix also teaches Refit something, so the next repo with the same break is cheaper and more likely to pass. Without that, this is a list plus a Claude wrapper, and anyone could copy it.

Judge it on two numbers:

- **Cost per required change really fixed.** Today that number doesn't exist, because Refit fully fixed none of the 9.
- **How much the second repo with a break beats the first.** Nobody has measured this.

## What's wrong today

Across 3 repos and 9 required changes, measured 2026-11-04 with cold caches:

| | Time | Cost | Fixed |
|---|---|---|---|
| Refit | 33.4 min | $12.44 | 0, plus 1 partly |
| Claude Code, Opus 5.5 | 8.8 min | $1.56 | 0 |
| Claude Code, Sonnet 5.5 | 2.7 min | $0.21 | 0 |

- **Refit looks in the wrong place.** It starts from recent changelogs. Nothing asks "what in this code is already dead?"
- **It trusts pins.** Clario pins a Stripe version but reads fields that version removed.
- **Agents stay inside their task.** One saw the dead Google Analytics code, then called it out of scope.
- **It upgrades what doesn't need it.** Unneeded major upgrades on 2 of 3 repos.
- **"Verified" overstates.** 9 tasks were labelled verified, and none fully fixed a required change. One test still hard-coded the retired model.

Plain Claude failed differently: it never looked up a provider's changes. Neither side had a list of what's dead, so that list is the piece to build.

## The new flow

| Step | Today | Rebuild | AI? |
|---|---|---|---|
| 1. Trigger | Full run each time | Run only when the repo changes or the list gains an entry | No |
| 2. Know what's dead | AI reads changelogs per repo | One shared list per provider, including what's already dead | Once per source |
| 3. Find usage | AI inventory with some scanning | Plain-code scan at file and line | No |
| 4. Compare | AI match on Opus | Plain-code join, including the version check. No match: stop at $0 | Only when unclear |
| 5. Fix | One agent per task | Proven plain-code fixes first. One Sonnet session per repo for the rest, with recipes. Opus only after a failed check | Only when no proven fix works |
| 6. Prove | Agent's checks and own test | Rescan must be clean, and checks no worse than baseline | No |
| 7. Learn and review | Every run, on the fix path, judged by "verified" | Off the fix path, in batches, judged by rescans and what people did with the PR | Rarely |

### What a list entry holds

- Provider, what died, when, and the official source URL with the date it was checked.
- **What to look for:** a string, or a field read in code using that provider.
- **Which versions it applies to.** This is what catches Clario and clears the healthy repos.
- **The replacement,** which must appear on the provider's own page. This blocks made-up model names.
- **What else the replacement requires.** Example: moving to a newer Claude model means dropping `temperature`.

### Would this catch the 9?

My reading, in hindsight, not measured:

| Kind | Changes | Caught by |
|---|---|---|
| Plain string | 6: G1, G2 (dead analytics URL), A1, A3, A4, A5 (dead model names) | String match |
| Field plus version | 2: S1, S2 (Stripe fields) | Field match, only if the pin is at or after the removal |
| Follows from a fix | 1: A2 (`temperature`) | Carried by the A1 entry's "what else" note |

### Rules for the fix session

- The list is the scope. "Out of scope" is not an answer for anything on it.
- No major upgrade unless a list entry requires it.
- If a fix needs a secret or an ID, read it from config and say in the PR what a person must set. Don't decline. That's why the analytics fix was refused.
- Change defaults and live paths, not only tests.

### Labels

| Label | Means | Action |
|---|---|---|
| Fixed | Rescan clean, checks no worse | PR |
| Needs a look | Partly clean, or the checks don't touch the changed code | Draft PR that says so |
| Couldn't fix | New failures, or the entry is still there | No PR, short report |

Today `orchestrator/loop.ts:285` opens a normal PR for needs-review too, so this needs changing. Versyka says it opens a PR only if nothing new fails, so this is also where we have to match them.

## How Refit gets better with time

### What exists today

`memory/` already stores runs, turns good runs into recipes, promotes a recipe to a skill after 3 repos, and records whether people merge, edit or close PRs. Four problems:

- **Its effect has never been measured.** The 2026-11-03 benchmark ran with empty memory, and the 2026-11-04 test started each repo with a fresh store. I found no report showing it helps.
- **It learns from a label we've shown is unreliable.** Recipes come from "verified" runs, and in the test 9 verified tasks fully fixed none of the required changes. Some of what it learns could be wrong.
- **It never gets cheaper.** A recipe is text the agent reads, so every repeat still costs a full AI session.
- **Its self-eval can flatter it.** It reruns past tasks with today's memory, and those recipes may have come from the same tasks. It needs fresh repos.

### What compounds

A single Claude user only sees their own repo. Refit sees the same break across many repos and sees what people did with each fix. That's the data to collect:

| Learned | From | What gets better |
|---|---|---|
| **Fixes** | Fixes that passed the rescan and got merged | Repeat breaks get cheaper and more reliable |
| **Detection** | Misses, false alarms and closed PRs | Each becomes a scanner rule and a permanent test |
| **People's edits** | The difference between our PR and what was merged | Shows exactly what we got wrong. Today an edit only counts as a success |
| **Lasting fixes** | Whether a merged fix got reverted | Removes fixes that looked right and weren't. Not tracked today |
| **Each repo's habits** | Install steps, checks that work, what the team rejected | Faster setup and fewer rejected PRs. A customer would lose this by leaving |

### The ladder

Each break climbs as evidence builds:

1. **New:** Claude fixes it from the list entry. Full cost.
2. **Recipe:** after a fix passes the rescan and gets merged, the steps and pitfalls go to Claude next time. Should cost less and pass more.
3. **Proven fix:** after several merged fixes with few edits, it becomes plain code that runs with no model. About $0 of model spend.
4. **Dropped:** closes or reverts move it back down a level.

The rescan and checks still prove every fix. If a proven fix fails on a repo, Claude takes over, so a proven fix can never block an attempt. That avoids the old engine's narrowness.

Promotion needs a merged PR and a clean rescan. "Verified" no longer counts.

### What this needs and doesn't solve

- **It needs usage.** With no customers, nothing compounds. Public repos can seed fixes and detection, but only real merges prove a fix is wanted.
- **Breaks must repeat.** Model retirements clearly do. Okapi counts 636 of its 827 breaking changes as model shutdowns. Those are also the easiest fixes to copy, so the harder breaks like Stripe's are where learning has to show up.
- **Customer code can't leak.** Recipes hold diff sketches and runs hold transcripts. Anything shared across customers must be a general pattern with no customer code, and customers must agree to it.
- **It's a head start, not a wall.** A bigger company with more usage could learn faster, so speed to real usage matters.

## Where the money goes

Average per repo, from the 2026-11-04 test:

| Part | Today | Rebuild | Why |
|---|---|---|---|
| Fix agents | $2.08 | About $0.43 to $1 | One session. $0.43 was measured in iteration 2 on other repos, and real migrations may cost more |
| Changelog reads | $0.73 | Near $0 per repo | Shared across repos |
| Inventory and match | $0.67 | About $0 | Plain code |
| Memory and review | $0.67 | $0 on the fix path | Batched separately |
| **Total** | **$4.15** | **About $0.50 to $1** | Repos with no match cost about $0 |

- **Hard cap:** $1 a repo, replacing the $5 hold per task.
- **Not checked:** the cache-read prices disagree across `harness/ledger.ts`, `orchestrator/budget.ts` and `providers/core/model.ts`. Settle on one table before trusting any new baseline.
- **Plain Claude may stay cheaper per run.** Sonnet averaged $0.07 a repo, but it fixed nothing. Our saving comes from repos and days with nothing to do, and our claim has to be cost per real fix.

## Order of work

Each stage ends with a measurement. Stop if a stage doesn't move its number.

### 0. Test the bet first (cap $5, no product code)

This plan assumes Claude fixes these breaks once it's told exactly what's dead. Nobody has tested that, and it's the cheapest thing to find out.

1. Write the list by hand for 6 providers from official pages: Stripe, OpenAI, Anthropic, Gemini, Groq, Google Analytics.
2. Pick 5 fresh repos by rule, all passing their own CI. Don't touch the sealed set.
3. Lock the required changes and tests before running.
4. Run Claude Code on Sonnet with the list and the fix rules. Rerun on Opus only where Sonnet fails.

| Result | Meaning | Next |
|---|---|---|
| At least 50% fixed | The bet holds | Continue |
| Under 50% | The fix step is the problem, and a scanner won't help | Stop and find out why |

If this works, anyone with the same list gets the same result. That's why stage 0b matters.

### 0b. Test whether learning helps (cap $5, no product code)

1. Pick one break type and 6 fresh repos that have it, all passing their own CI.
2. Fix 3 of them and write down what worked, using only fixes that pass.
3. Run the other 3 twice from the same commit: with those notes and without them.
4. Lock the tests before running, and grade blind.

| Result | Meaning | Next |
|---|---|---|
| Fixes more, or costs at least 30% less, with notes | Learning has a real effect | Build the ladder |
| No clear difference | Memory isn't the advantage, at least for this break | Find out why before spending on it |
| Can't find 6 repos with the same break | Breaks may not repeat enough | Try another break type, then rethink |

3 repos is a first signal, not proof. Stage 7 is the real measure.

### 1. Decide

`AGENTS.md` makes AI-first "the rule above all others". Scanners are "never gates", and any branch that ends a task without an attempt gets rejected in review. "No match: stop at $0" breaks that.

Furqan, Pierce and Otabek decide with stage 0's result in hand. Suggested rule: **plain code decides what to look at. AI fixes anything new, and proven fixes become plain code.** `AGENTS.md` also says guidance lives in prompts, playbooks and memory, "not in `if` statements", so proven fixes need this change too. Pick an owner per stage.

### 2. List v1

Turn the hand-written list into a kept file with the entry format above. Reuse the old registry's sources where they're still right.

- Measure: every entry has a source and date, and a second person spot-checks a sample.

### 3. Scanner and compare

Merge the `r3/cost` inventory, then add model strings, URLs, fields and version checks.

- Measure, $0 of model spend:
  - **Must flag:** the 9 required changes on the 3 test repos, with A2 carried by A1's entry.
  - **Must stay quiet:** `alanagoyal/branded`, `pretzelai/lumen`, `Small-Web-Co/tinypivot`. Those were healthy Stripe repos by reading, so they're ready-made false-alarm tests. Check the pinned commits in `criteria.md` first.

### 4. One session per repo

Feed the list to one session, drop per-task agents, and apply the fix rules and the $1 cap.

- Measure: required changes fixed, cost and time per repo.

### 5. Proof and labels

Rerun the scanner after the fix, apply the new labels, and change `loop.ts:285`.

- Measure: hand-check a sample of "Fixed".

### 6. Triggers, then memory and review off the fix path

- Measure: cost per repo per month on repos with nothing to do.
- This would also make "always watching" true. I found no watch schedule in the code I searched, so Pierce should confirm what exists.

### 6b. The learning layer

Only if stage 0b showed an effect. Reuse `memory/` where it fits.

1. Learn only from merged fixes with a clean rescan.
2. Store people's edits and track reverts.
3. Turn misses and false alarms into scanner rules and tests.
4. Add proven plain-code fixes for the most common breaks, with Claude as the fallback.
5. Keep per-repo habits, and strip customer code from anything shared.

- Measure: on fresh repos, memory on vs off, from the same commits. Repeat monthly as the learning curve.

### 7. Score it once

Fresh repos picked by rule, then the sealed set, then an independent run against Claude Code. Run Claude twice: once with the bare prompt, and once with a detailed prompt. The second is the comparison a smart customer would actually make. Add a Refit row with empty memory, so the gap shows what learning adds.

## Targets

These are goals, not measurements.

| Metric | Today | Target |
|---|---|---|
| Required changes flagged, 3 test repos | Not measured; 0 fully fixed | All 9 |
| False alarms, 3 healthy Stripe repos | Not measured | 0 |
| Required changes fixed, fresh repos | 0 of 9 on the test repos | At least 70% |
| "Fixed" that a hand-check agrees with | Not measured; 0 of 9 "verified" fully fixed a required change | At least 90% |
| Cost, repo with no match | About $4.15 | About $0 |
| Cost, repo with matches | About $4.15 | About $0.50, never above $1 |
| Time, repo with matches | 10 to 12 min | Under 5 min |
| Unneeded major upgrades | On 2 of 3 repos | None |
| Memory on vs off, fresh repos | Never measured | Fixes more, or costs at least 30% less |
| Share of fixes needing no model | 0 | Rising each month |
| Cost, break Refit has a proven fix for | No proven fixes exist | Near $0 of model spend |
| PRs merged without edits | No customer data | Rising each month |

The 3 test repos have now been seen, so they're only a regression check, never the score.

## What already exists

Nothing here has been re-tested against current main. Check each piece before reusing it.

- **Deterministic inventory:** `inventory/scan.ts` and `inventory/scanners.ts` on `r3/cost` (PR #483, open). Measured: $1.41 down to $0.74 on 8 repos, $0 to rerun.
- **Old dead-API registry:** at `c4b113a5^` (deleted 2026-10-31): `data/deadlines.json`, `pipeline/deadline-exposure.ts`, `pipeline/deadline-sources.ts`, `pipeline/model-retirements.ts`.
  - Deadlines were reviewed by hand, each with a source URL and a checked date. It's stale and needs refreshing.
  - It classified matches as live, catalog, test, comment and so on. OpenAI line precision went from 14% to 83%, with repo recall 28 of 28 (PR #72, Claude labels, single pass).
- **Shared changelog read:** the any-provider watcher and `--watch-cache` from rounds 2 and 3. It needs to feed a kept list, not a per-run cache.
- **Harness and sandbox:** keep them.

## Don't repeat the old engine's mistake

The old engine was precise but narrow: 17 validated fixes, all hand-checked and none wrong, 2 partial, across 781 repos including repos we'd no longer count. It stopped too often, which is why the AI-first rebuild happened.

- Plain code finds and compares. It doesn't decide what can be fixed. Once something matches, Claude always attempts it.
- A provider that isn't on the list isn't a dead end. If the scan sees an unlisted SDK or API host, that provider joins the queue, and AI reads its sources once.

## Risks

- **A scanner misses what it doesn't know about.** $0 on no match can mean a silent miss. Run an AI sweep on a small sample each month and track how often it finds something the scanner missed. If that rate is high, the list isn't good enough.
- **The list is now the product.** Keeping it fresh and correct is ongoing work, and Okapi already tracks 1,145 providers. Go deep on the providers that matter, and don't race them on count.
- **Field matching can be noisy.** An app's own objects can share a provider's field names, as in lumen. Unclear matches go to a small AI check, not straight to a fix.
- **Rescans prove less than a live call.** A clean rescan shows the dead thing is gone, not that the new call works. Replacements coming from the provider's own page and the repo's checks reduce that risk but don't remove it.
- **Claude Code can use a list too.** Routines and GitHub Actions already run on a schedule, so stage 0's result may strengthen that alternative. The list and scanner alone are copyable. The results of many real fixes aren't, unless someone else gets the same usage.
- **Better models could shrink the gain.** If Claude fixes most breaks unaided, recipes add less. Repeat the memory on vs off test after big model releases.
- **Bad learning spreads.** One wrong proven fix could hit many repos. Roll new ones out slowly, and rely on the rescan, the checks and the drop rule.

## Not in scope

- Changing the numbers already measured.
- Opening any sealed set before stage 7.
