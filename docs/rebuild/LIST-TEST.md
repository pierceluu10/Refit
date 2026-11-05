# List test results, and what they change

## What this changes for each lane

The first gate passed, so carry on as written, with these changes. Where this differs from your brief, this wins.

**Results:** Sonnet with the list fixed 13 of 13 required changes on 5 fresh repos for $0.59. Notes from earlier fixes didn't help on 3 test repos: both arms fixed 7 of 7, and notes cost 8% more. Three repos is only a first signal. Nothing was checked against live providers, and no no-list control was run, so don't claim the list caused the whole result.

**Pierce:**

- P2: treat each entry's "what else the replacement requires" as a core job, and check every replacement against that model's migration page. The test's one real miss was here. `claude-sonnet-5-5` thinks by default, a reply can start with `thinking` blocks, and `max_tokens` covers thinking plus text. The same page lists more changes that return a 400: thinking budgets, assistant prefill and forced tool choice. `DEAD-APIS.md` doesn't have these yet, so add them.
- P2 and P4: cover small `max_tokens` values when a replacement model reasons, and webhook fallbacks for older Stripe payloads.

**Otabek:**

- O2: expect about $0.12 a repo for the session itself, not $0.43 to $1. Sessions mostly didn't install dependencies or run checks, which is part of why they were so cheap.
- O3: plain code must run the checks after the session and feed failures back, because Claude mostly won't. Budget for that retry.
- O3: tests with mocks can't see runtime failures like the thinking change. Add an optional live smoke call per provider on a sample of fixes, using a small cap. If no provider key is available, log it. Never call anything "proven live" without one.
- O6: still build the memory layer and the ladder's evidence. Don't spend on making recipe text better for breaks the list already describes well, since this test found no gain. Put the effort into evidence, detection lessons, repo habits and proven plain-code fixes, which this test didn't measure.
- O7: test learning where it could matter: a proven fix at $0 of model spend vs Claude, and breaks the list describes poorly. Use more than 3 repos. Also compare quality, not only pass or fail, because a with-notes fix passed its test with a real defect.
- O8 and O9: some of these repos came from a GitHub code search, so they may overlap with the sealed sets. Check, and drop any overlap, when O9 is approved.

---

## The full report: does a dead-API list make Claude fix these breaks? Does learning help?

Run 2026-11-04 to 11-05 EST. Claude Code 2.1.318, Sonnet 5.5, one clean container per run. No product code changed, nothing committed or pushed, and no PRs or issues opened.

## Results

**Stage 0 passes: with the list, Sonnet fixed 13 of 13 required changes on 5 fresh repos, for $0.59.** The gate was 50%. Opus wasn't needed. A fresh grader that read every diff agreed with all 13.

**Stage 0b misses its gate: notes from earlier fixes didn't help on new repos.** Both arms fixed 7 of 7, and notes cost 8% more ($0.51 vs $0.47). The gate needed more fixes, or at least 30% less cost. On one repo, the with-notes fix was the worse one. Three repos is only a first signal, but nothing here argues for building the ladder yet.

**Total spend: $2.05** of the $10 allowed ($0.59 of $5 on stage 0, $1.46 of $5 on stage 0b).

**Two things limit how far to trust the 13 of 13:**

1. **I ran no control.** Nobody ran these 5 repos without the list, so I can't say how much of the result is the list and how much is that these repos are easier than the earlier 3. A bare-prompt control would cost about $0.35.
2. **"Fixed" means correct by tests and reading, not proven against live providers.** The clearest risk is that my list missed something: Sonnet 5.5 thinks by default, so the Anthropic fix could fail or truncate at runtime. A single live call to check this was blocked by this session's permission check, so it remains unverified. See "What failed and why".

## Numbers

### Stage 0: Sonnet with the list

| Repo | Provider | Required fixed | Time | Cost | Cost per fix | Own checks |
|---|---|---|---|---|---|---|
| vse1999/SpendScope | Stripe | 3 of 3 | 30 s | $0.1211 | $0.040 | Same as baseline (239 tests) |
| NewAcropolis/frontend | Google Analytics | 2 of 2 | 26 s | $0.1045 | $0.052 | Same (54) |
| mohcinemadkour/HealthcareRAGBOT | Anthropic | 2 of 2 | 19 s | $0.0823 | $0.041 | Same (24) |
| shaykhedeee/resurgo | Groq, Gemini | 5 of 5 | 53 s | $0.2045 | $0.041 | Same (139, typecheck) |
| sakshamd19/EcoSense | Gemini | 1 of 1 | 45 s | $0.0766 | $0.077 | Same (2, weak) |
| **Total** | | **13 of 13** | **173 s** | **$0.5890** | **$0.045** | |

- **Opus:** not run, because no Sonnet run failed.
- **By kind:** field and protocol changes (Stripe, GA) 5 of 5; model names 8 of 8.
- **For scale:** the plan estimated $0.43 to $1 per repo for the fix session. This averaged $0.12. The earlier test's 0 of 9 was on other repos with a bare prompt, so the two results aren't a direct comparison.

### Stage 0b: Stripe field removals (ST-1, ST-2)

| Group | Repo | Run | Required fixed | Time | Cost | Turns |
|---|---|---|---|---|---|---|
| Learn | tamirazrab/canvastra | No notes | 3 tests of 3 (C1, C2) | 40 s | $0.1347 | 9 |
| Learn | elsa-workflows/elsa-hub | No notes | 1 of 1 | 49 s | $0.1972 | 12 |
| Learn | msgarcha/jobberq | No notes | 2 of 2 | 30 s | $0.1486 | 8 |
| Test | Brandingpioneersgit/aihealz | Notes, ran first | 1 of 1 | 38 s | $0.1811 | 9 |
| | | No notes | 1 of 1 | 45 s | $0.1650 | 8 |
| Test | nicuk/docsflow | Notes | 4 of 4 | 48 s | $0.1914 | 10 |
| | | No notes, ran first | 4 of 4 | 42 s | $0.1605 | 7 |
| Test | glauciosellect/sincroflow-eleicoes | Notes, ran first | 2 of 2 | 27 s | $0.1384 | 8 |
| | | No notes | 2 of 2 | 37 s | $0.1462 | 9 |

| Test repos total | Fixed | Time | Cost | Cost per fix |
|---|---|---|---|---|
| With notes | 7 of 7 | 113 s | $0.5109 | $0.073 |
| No notes | 7 of 7 | 124 s | $0.4717 | $0.067 |

Learn repos: 5 of 5 required changes (the canvastra row counts C1 and C2), $0.4806, 119 s, or $0.096 per fix.

Blind quality comparison, with labels shuffled per repo and decoded afterwards:

| Repo | Better | Why |
|---|---|---|
| aihealz | **No notes** | The with-notes fix has a real defect, below. The other is correct on every payload shape the grader tried, and smaller |
| docsflow | Level | Nearly the same size, with small trade-offs each way |
| sincroflow | **With notes** | Same Stripe fix in one file. The no-notes run also touched 2 more files with changes that have no effect at this commit |

## What failed and why

### Why notes didn't help

- **There was almost nothing left to save.** With the list, Sonnet already reaches these breaks in about 8 turns and $0.15. The notes cost an extra file read, and they didn't reduce turns (27 with notes, 24 without).
- **The list already carries most of what the notes say.** It gives the fields, the replacements and the webhook caveat.
- **Notes can spread a half-right idea.** The notes advise falling back to the old field for older webhook payloads. On aihealz, the with-notes run built a fallback that only runs when the items list is empty. Older payloads have items with no period, so it gets NaN and stores nothing, while its comment says that case is handled. The test still passes, so it counts as fixed. Under a stricter reading the with-notes arm is 6 of 7. The notes didn't tell it to write it that way, so I can't call this caused by the notes, only that they didn't prevent it.

Where saving could still exist: the plan's plain-code "proven fix" rung, which spends no model money. These runs don't test that. They do suggest the recipe rung, text for Claude to read, isn't worth building for a break the list already describes well.

### Problems the grader found in fixes that still count as fixed

- **Healthcare, thinking on by default (most important).**
  - The fix moves to `claude-sonnet-5-5`, which the list names. The provider's migration page, which I read only after the runs, says this model thinks by default, that a reply can start with `thinking` blocks, and that `max_tokens` covers thinking plus text.
  - This repo has `max_tokens=1024` and returns `response.content` into `answer: str`, so it could truncate or fail validation.
  - **That's a miss in my list, not in Claude's fix.** The entry's "what else" named only sampling parameters. The same page lists more that return a 400: thinking budgets, assistant prefill and forced tool choice.
  - The locked tests mock the LLM, so they can't see any of this.
  - I tried one live call through the repo's own code to settle it. This session's permission check blocked that, so it's still unverified.
- **SpendScope, possible regression.** The fix removed the old `invoice.subscription` read. If that webhook endpoint is on a pre-Basil version, invoice events now silently do nothing, where they worked before. The list does warn about this; the criteria didn't require a fallback.
- **Resurgo, small token caps (unverified).** Some replaced Groq and Gemini calls have low `max_tokens`, such as 200 in JSON mode. If the new models use reasoning tokens, answers may be weak or empty. The grader's view that they count toward the cap comes from general knowledge, not the sources.
- **Smaller:**
  - Acropolis's API secret could reach server logs through an unhandled connection error, and `client_id` is still a constant.
  - Healthcare's `step_by_step.md` has a mangled leftover model name.
  - Resurgo's `ai-brain` page still shows `2.0-flash`, and some comments still say "free tier" for a paid model.

### Claude mostly didn't run the checks

**13 of 14 runs didn't install dependencies, and said they couldn't run the repo's checks.** Their fixes passed only because a separate grader ran them later. This is part of why the runs were so cheap. In a product, plain code must run the checks after the session, as step 6 of the plan says, and real per-repo cost may rise if the session should iterate on failures.

## Limits

- **Small and not random in effect.**
  - 5 and 6 repos, one run per arm, no repeats.
  - Picks came from a hash, but gates then required a real, confirmed break and green checks, so this says nothing about repos with nothing to fix, or about false alarms.
  - OpenAI ended up with no repo, because the rule filled the slots by hash.
- **One repo holds 5 of the 13 required changes** (resurgo). Per repo it's 5 of 5, so the conclusion is the same, but the 13 shouldn't be read as 13 independent results.
- **Required changes are my own reading,** locked before the runs (hashes in `locked/LOCK.txt`, `stage0b/LOCK.txt`). The notes' hash was appended to `stage0b/LOCK.txt` once they were written, before the test runs.
- **Test strength varies.**
  - Stage 0's Groq tests only check that dead ids are gone, so a made-up name would pass them. The grader read the names and found none.
  - One G2 check passes at baseline for its secret half, and only the `tid` check drives it.
  - In 0b, canvastra, elsa-hub, jobberq and sincroflow are static scans. Only docsflow and aihealz run the real handler with mocks.
- **Weak own checks.** EcoSense has 2 tests, one of them only `typeof`. canvastra and jobberq have 1 each. sincroflow has only a typecheck. Elsa-hub's tests don't cover the Deno file that changed.
- **One flaky repo in the learn group.** Elsa-hub passed its own tests at screening, then failed one unrelated page test (`Training.seo.test.tsx`) in 3 of 5 clean-container runs, including 2 with no change applied. By the "only count repos that pass their own CI" rule it should arguably have been replaced. I kept it because it's a learn repo, its result isn't in the gate, and its one note (the webhook fallback) also came from canvastra. This flake is not from the fix.
- **EcoSense is the weakest confirmed break.** `gemini-1.5-flash` isn't on Google's page at all, and I read that as long gone, not as a dated entry. Resurgo's Groq break applies to free and developer tiers; Groq says enterprise contracts aren't affected. Many of its calls also fall through to another provider, so failure there isn't always an outage.
- **Selection widened along the way.** The earlier test's rule left too few repos, so I added a GitHub code search, then for 0b more result pages. Each change was written down before reading new candidates. I also fixed my screen script twice, and let it run `prisma generate` and use the repo's pnpm major. Those were my script's failures, not the repos'.
- **Sealed sets not checked.** I didn't open them, so I can't prove there's no overlap with code-search picks. Compare `selection/picks.tsv` and `stage0b/criteria.md` with them when stage 7 opens them, and drop any overlap.
- **Blinding was partial.** Only stage 0b had two arms to compare. Graders knew they were grading fixes, but not the source or which arm. I decoded the labels afterwards. I wrote the criteria, tests and notes, and I knew the plan's bet. Graders didn't call any model API, so their reads aren't checked against live providers.
- **Costs cover test runs only.** My own session and the two grader subagents aren't in the $2.05. Hand-writing the list isn't counted either, and it took real reading: over 20 provider pages, and it still missed the thinking change.
- **Cache timing.** Runs were minutes apart with the same system prompt, so later runs may read more cache. Order varied as far as 3 repos allow, and one repo's order can't be separated from its arm.

## What I recommend next

1. **Take the stage 0 result to the founders' decision (stage 1).** The bet holds on these repos, and the fix step isn't the bottleneck. These results support "plain code decides what to look at, Claude fixes it", but they don't settle the moat: anyone with this list could get the same result. That's the plan's own risk, and it's now more real.
2. **Before that decision, spend about $0.35 on one control:** the same 5 repos and Sonnet, with the earlier bare prompt and no list. It tells you whether the list caused the 13 of 13, or the repos were easy. If you want a stronger version, add the earlier 3 repos with the list (about $0.30), since those are the ones where everything scored 0.
3. **Make the list's "what else" a first-class job when you build list v1.** The one real miss here was there, not in the fix. Every replacement should be checked against that model's migration page.
4. **Add one live smoke call per provider** on a sample of fixes before calling anything "Fixed". Rescans and mocks can't see the thinking problem. This needs a person to allow it here, since it was blocked in this session.
5. **Don't build the recipe rung yet.** Re-test learning only where it might matter: a break the list describes poorly, or a proven plain-code fix that spends $0. Measure it on more repos than this.
6. **Plain code should run the checks after the session,** because Claude mostly won't, and budget for iteration when they fail.

The rebuild itself hasn't been started, as instructed.

Key scan: all 143,727 files here, including transcripts and this report's folder, were checked for the exact key and for Anthropic, OpenAI, Stripe live, GitHub, Google and Groq key patterns, without printing any value. The exact key has no hits, and no pattern hits exist in the test's own output. The only hits were in 58 files of third-party public-repo clones under `scratch/read/`, placeholders or things those repos committed. I didn't examine them and deleted those clones afterwards. A second scan isn't needed, since nothing else was written after this one apart from this line.
