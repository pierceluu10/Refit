# Iterations, Otabek's lane

Every paid run, with its time, commit, numbers, cost, top causes and what changed. Times are EST. Costs are the Agent SDK's own estimate, because paid runs use the machine's login (see `DECISIONS-OTABEK.md`), and they're capped by `APTITUDE_AI_BUDGET_USD`.

Lane total so far is tracked at the bottom. The cap is $50.

## O2: one session per repo

**When:** 2026-11-05, 01:31 to 01:44. **Commit:** `37a0f32c`. **Locks:** `evals/rounds/o2/`. **Spend:** $0.84 of a $6 cap.

Scan: the labelled stand-in (`evals/runner/standin-scan.ts`), because P4 isn't up. Model: Sonnet 5.5 at medium effort. Opus never ran.

| Repo                                 | Required fixed | Cost        | Time      | Setup | Session | Re-checks | Cache read / write (tokens) |
| ------------------------------------ | -------------- | ----------- | --------- | ----- | ------- | --------- | --------------------------- |
| `hachanimohamedsaid/backend_AgentAi` | 4 of 5         | $0.1365     | 89 s      | 41 s  | 31 s    | 13 s      | 61,928 / 18,251             |
| `Devanshjain2110/QueryPDF`           | 2 of 2         | $0.1454     | 149 s     | 80 s  | 46 s    | 17 s      | 63,225 / 18,786             |
| `swharr/TrailblazerAI`               | 7 of 7         | $0.2582     | 239 s     | 93 s  | 107 s   | 31 s      | 351,479 / 32,119            |
| `Miguel07Alm/text2question`          | 4 of 4         | $0.1887     | 198 s     | 97 s  | 68 s    | 28 s      | 117,204 / 24,309            |
| `RaizenStyx/lore-forge`              | 4 of 4         | $0.1065     | 115 s     | 44 s  | 53 s    | 15 s      | 109,968 / 10,635            |
| **Total**                            | **21 of 22**   | **$0.8353** | **790 s** |       |         |           |                             |

- **Per repo:** $0.17 and 158 s on average. Every repo stayed under the $1 cap and under 5 minutes.
- **Cost per required change fixed:** $0.04.
- **The one miss:** `R5` on `backend_AgentAi`, the `OpenAI-Beta: realtime=v1` header. It's a scanner miss, not a fix miss: the stand-in never flagged it, so the session was never told. Sent to Pierce on #489.
- **Caching hits:** reads are 3 to 11 times writes on every repo, with almost no uncached input. Setup is a third to a half of the time.
- **Regression check on the 3 test repos (P4):** not run yet. They need Pierce's scanner to mean anything.
- **Limits:** the locks are static, so they show the dead name is gone and a listed replacement is there, not that a call works. These repos were also in round 3, though nothing in this lane was tuned on them. 5 repos is a small sample.

## O3: proof and labels

**When:** 2026-11-05, 01:45 to 02:03. **Commit:** `877666a1`. **Locks:** `evals/rounds/o3/`. **Spend:** $0.89 of an $8 cap.

This round ran with the rescan on. O2's 5 repos were labelled afterwards from their saved diffs, with nothing run and no spend.

| Repo                                            | Required fixed | Label        | Cost        | Time      |
| ----------------------------------------------- | -------------- | ------------ | ----------- | --------- |
| `4lbatr0s/jiro`                                 | 2 of 2         | Fixed        | $0.1732     | 199 s     |
| `liamstamper/lamp-bot`                          | 4 of 4         | Fixed        | $0.1704     | 192 s     |
| `Anassarwar14/Chat-Nest-AI`                     | 1 of 1         | Fixed        | $0.1397     | 247 s     |
| `adeojoemmanuel/EDD-Kafka-Rest-Api`             | 2 of 2         | Needs a look | $0.1633     | 104 s     |
| `smartflow-systems/smartflow-hub`               | 1 of 1         | Fixed        | $0.0917     | 68 s      |
| `nfindler/playbook-pipeline`                    | 1 of 1         | Fixed        | $0.0914     | 41 s      |
| `souravdas2003/Chatbot-Using-Anthropic-Api-Key` | 1 of 1         | Fixed        | $0.0607     | 87 s      |
| **Total**                                       | **12 of 12**   |              | **$0.8904** | **938 s** |

**Hand-check of "Fixed": 10 of 11 agree (91%), target at least 90%.** I read every diff below against `DEAD-APIS.md`, with no model involved.

| Repo                                            | Agree? | Why                                                                                                                                                                                          |
| ----------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hachanimohamedsaid/backend_AgentAi`            | **No** | The `OpenAI-Beta: realtime=v1` header is still there, and it's dead. The scanner missed it, so the rescan was clean and the label was wrong. Everything the session was told about is right. |
| `Devanshjain2110/QueryPDF`                      | Yes    | Model moved, `temperature` removed.                                                                                                                                                          |
| `swharr/TrailblazerAI`                          | Yes    | Every default, allow-list and picker moved. It removed some retired picker options rather than mapping each one, which is a product choice worth a reviewer's glance.                        |
| `Miguel07Alm/text2question`                     | Yes    |                                                                                                                                                                                              |
| `RaizenStyx/lore-forge`                         | Yes    | Moved to Chat Completions, and raised the token limit for a model that reasons.                                                                                                              |
| `4lbatr0s/jiro`                                 | Yes    |                                                                                                                                                                                              |
| `liamstamper/lamp-bot`                          | Yes    |                                                                                                                                                                                              |
| `Anassarwar14/Chat-Nest-AI`                     | Yes    |                                                                                                                                                                                              |
| `smartflow-systems/smartflow-hub`               | Yes    | It already reads the text block by type, so thinking blocks are safe here.                                                                                                                   |
| `nfindler/playbook-pipeline`                    | Yes    |                                                                                                                                                                                              |
| `souravdas2003/Chatbot-Using-Anthropic-Api-Key` | Yes    | Moves to Haiku 4.5, which doesn't think by default, so `content[0].text` still holds.                                                                                                        |

The one "Needs a look" was also right: `EDD-Kafka-Rest-Api`'s only check fails before and after, so nothing proves the change. It also bumped `openai` from 4.55 to 4.104, which it didn't need. That's a minor bump, so it isn't an unneeded major upgrade, but it's unwanted lockfile churn. The rule now covers it only for majors.

**Unneeded major upgrades: none** on all 12 repos, by `majorUpgrades`. **Live smoke:** no repo was sampled in this round, and no provider key is readable in this session, so nothing here is proven live.

**Limit:** `jiro` and `Chat-Nest-AI` had a `build` that failed at baseline in this run, though the round-3 screen passed them with its placeholder env. Both still had a passing typecheck and proof test, so the labels stand, but they aren't strictly green repos on this run.

## O4: memory and review off the fix path

**When:** 2026-11-05, 02:03. **Commit:** `6ebda088`, then `1f695c79`. **Spend:** $0.06 on memory's own budget.

| Per repo, 12 repos from O2 and O3 | Cost |
| --- | --- |
| Fix, average | $0.144 |
| Fix, highest | $0.258 |
| Learning, 5 runs on Haiku 5.5 | $0.012 |

- **Target met:** about $0.50 a repo for the fix and never above $1. It's well under, in line with the $0.12 `LIST-TEST.md` measured.
- **Learning cost:** full price, because this session's login path can't use the Batch API. With an API key the batch path halves it. `BatchModel` is tested on a fake client only, never on the real Batch API.
- **Review:** the product loop has no review step. `evals/reviewer` runs from the eval pipeline and `rereview`, so it doesn't touch a fix.
- **Haiku vs Sonnet:** I read one Haiku recipe and it kept the exact IDs and steps. One recipe isn't a test, and `LIST-TEST.md` says not to spend more on recipe text.

## O5 and O6: what memory learns from, and the ladder

**When:** 2026-11-05, 01:52 to 02:05. **Commits:** `d1c8b864`, `08e24105`. **Spend:** $0.

No paid run. These are unit-tested, and fed real records from O2 and O3:

- 12 runs went in. `gemini-1` reached `proven` on `benchmarkLevel` from 3 locked repos, and stayed `new` for customers.
- `backend_AgentAi` counted for `gemini-1` but not for the header it missed, because a locked test only counts for the entries it covered.

## O7: does memory help?

**When:** 2026-11-05, 02:06 to 03:18. **Commits:** `ef439ded` for the locks, `68c3b475` for the runner. **Locks:** `evals/rounds/o7/`. **Spend:** $3.70: $0.62 on the learn repos, $0.09 of that on a run lost to my own bug, $0.75 on the proven arm, $2.16 on the recipes arm, and $0.16 writing recipes. The blind grader was a fresh subagent and isn't in this figure.

**Result: the target isn't met on what the locks show.** Memory on cost more and fixed the same. A blind read leans slightly the other way, on too few repos to prove anything.

| Eligible repos | Fixed, locks (on / off) | Cost (on / off) | Blind: fully fixed (on / off) | Blind: better |
| --- | --- | --- | --- | --- |
| Proven arm, 3 repos | 7 of 7 / 7 of 7 | $0.30 / $0.25 | 3 of 3 / 2 of 3 | On 1, level 2 |
| Recipes arm, 3 repos | 3 of 6 / 3 of 6 | $1.21 / $0.96 | 1 of 3 / 1 of 3 | On 2, off 1 |
| **Total, 6 repos** | **10 of 13 / 10 of 13** | **$1.51 / $1.21, 25% more** | **4 of 6 / 3 of 6** | **On 3, off 1, level 2** |

The target was more fixed, or at least 30% less cost. By the locks it's a tie at 25% more cost. By the blind read it's one more repo fully fixed, which on 6 repos is noise until repeated.

**Excluded:** `jackstonemedia/StoneAIOMainSystem`, whose baseline was red. It fixed 1 of 1 in both arms, at $0.10 each.

**Proven fixes, on their own:**

| Repo | With memory | Without | What happened |
| --- | --- | --- | --- |
| `palashb01/DocuChat` | $0.0028 | $0.0620 | Finished with no session. 95% less, and the two diffs are byte-identical |
| `PRIYESHSINGH24/buddy_connect` | $0.2189 | $0.1324 | Fixed 3 of 4 files, and Claude finished the file that sets `temperature`. It cost more, but the blind read preferred it, because Claude removed the setting the other run left |
| `AyeletHillel/fine-tune` | $0.0786 | $0.0587 | Rightly handed to Claude: it's fine-tuning, so the fix stood aside. The extra cost is noise |

So a proven fix helps a lot when it finishes the repo, and doesn't help when it only does part of it. Its guards stop it finishing most repos, and those guards are what keep it safe.

**Recipes:** on the Assistants API, which the list describes poorly, recipes cost 27% more. The blind read preferred them on 2 of 3 repos. One of those 3 runs had a recipe and still left `temperature` on the production path. Three repos is a first signal only, the same size as the one `LIST-TEST.md` warned about.

**What I decided:** I'm stopping at the two proven fixes I've written. No more until real merges exist. The ladder, evidence and habits stay, because they're what real merges would feed.

**Limits:**

- All the "merges" are locked tests, so `benchmark: true` let these fixes run. Nothing here counts for customers.
- The recipes came from 2 repos, and `LIST-TEST.md` says recipe text isn't worth more spend.
- The Assistants locks turned out too narrow. `alive` wanted `responses.create`, but real fixes used `responses.cancel` and helper files. All the "misses" I read were this, in both arms, so I left them as locked and scored them that way. The blind read is the better measure there.
- `learn-lock.json`'s first run lost $0.09 to my own bug: an edit adding the Assistants entry to the stand-in hadn't applied.

**What the blind read found about labels:** all 12 runs said Fixed, and it fully agreed on 7. The other 5 were "partly": real defects like a random UUID passed as a thread id, and `temperature` left on a model that rejects it. See `evals/rounds/o7/results/grades.md`. That's a far worse number than O3's 10 of 11 and it's the most useful thing this round found. A clean rescan says nothing about whether a rework works. So Fixed now also needs:

- for a rework, a check that imports the changed code
- nothing left in the fix's own hunks that the entry says to remove

Replayed over these runs with no spend, every Assistants rework becomes Needs a look, and the 3 Fixed that remain are all ones the blind read agrees with.

**The AI sweep:** 6 repos the stand-in scan called clean, $0.52 in all, about $0.09 a repo, on Sonnet. It found 1 miss: `bricefrisco/NamesLoL` calls Riot's by-name summoner lookup, from a provider that isn't on the list. It said it was going on its own knowledge of Riot's changes, so it's a lead, not a checked break. That's 1 of 6 on a small sample and a stand-in scan, so it needs repeating on the real scanner. It's sent to Pierce's unlisted-provider queue.

**Tracked numbers:** `learningMetrics` and `memory/scripts/report.ts` report the share of fixes needing no model, PRs merged without edits, reverts and scanner misses. With no real merges yet, three of them read zero.

## O8 round 1: the whole product

**When:** 2026-11-05, 03:15 to 03:31. **Commit:** `b9c436b9` on `rebuild/integration`. **Locks:** `evals/rounds/o8-1/`. **Spend:** $1.44 of an $8 cap.

Scan: the labelled stand-in, on Pierce's real list. Memory started empty. No PR opened. The Stripe planner screen and the O7 grader were running on the same machine, so times may be a little high.

| Repo | Required fixed | Label then | Cost | Time |
| --- | --- | --- | --- | --- |
| `rainmana/cursorify` | 4 of 4 | Fixed | $0.2714 | 77 s |
| `vadik88888-prog/beauty-saas` | 3 of 3 | Fixed | $0.3195 | 342 s |
| `djnightmare9909/Dungeon-master-OS-WFGY` | 1 of 1 | Fixed | $0.1096 | 73 s |
| `jasperapp/jasper` | 2 of 2, not counted | Fixed | $0.1930 | 86 s |
| `edwinsatya/llm-output-guard` | 1 of 1 | Fixed | $0.1697 | 119 s |
| `XDTerminated/t2-chat-t3c-2025` | 3 of 3 | Fixed | $0.3796 | 292 s |
| **Total, counted** | **12 of 12** | | **$1.25** | |

**Excluded:** `jasperapp/jasper`. Its only check, a fallback `tsc`, fails before any edit on a missing generated file, so it has no working check of its own. Its 2 of 2 aren't counted.

| Target | Result |
| --- | --- |
| Required changes fixed, at least 70% | 12 of 12, by static locks |
| Cost with matches, about $0.50, never above $1 | $0.25 on average, $0.38 at most |
| Time with matches, under 5 minutes | 5 of 6. `beauty-saas` took 5 min 42 s |
| Cost with no match, about $0 | $0.00 and 1 s, on 3 repos |
| Unneeded major upgrades | None |
| "Fixed" a hand-check agrees with, at least 90% | **5 of 6, 83%. Missed.** |

**Cost per required change fixed:** $0.10.

**The hand-check.** I read all 6 diffs, since there are fewer than 10:

| Repo | Agree? | Why |
| --- | --- | --- |
| `cursorify` | Yes | It kept `temperature` only for effort `none`, which the list allows, and said so. It also edited `lib/` by hand to match `src/`. |
| `beauty-saas` | Yes | It also maps stored retired ids to a live model, which is what a live path needs. |
| `Dungeon-master-OS-WFGY` | Yes | It moved from `generateImages` to `generateContent` with an image response, and read the new shape. |
| `llm-output-guard` | Yes | It left a real false alarm alone and said why: `ada` is an Indonesian word in a test. |
| `t2-chat-t3c-2025` | Yes, with a caveat | It says the legacy SDK may not send what Gemini 3.6 needs. That's honest, and it's a limit of the list's scope. |
| `jasper` | **No** | It's a full rework of an Electron renderer that reads the API secret from the environment, and the list says never to put that in client code. It said so, but only under "unproven". |

**Top cause:** a rework labelled Fixed. It's the same cause the O7 blind read found, and `37974dc0` already fixes it: replayed over this round, `jasper` becomes Needs a look.

**What changed for round 2:** Fixed now needs a check that imports the changed code when the fix is a rework, and nothing left in its own hunks that the entry says to remove.

**For Pierce:** `OA-1.base-ada` matched the Indonesian word `ada`, which is a false alarm the session handled.

## O10: what else helps

### Haiku for plain model swaps

**When:** 2026-11-05, 04:05 to 04:42. **Commit:** `539fd7c4`. **Locks:** `evals/rounds/o10/`. **Spend:** $0.75.

| 6 repos, same locks | Fixed, locks | Fixed / Needs a look / Couldn't fix | Cost | Time |
| --- | --- | --- | --- | --- |
| Haiku 5.5 | 10 of 12 | 3 / 2 / 1 | $0.14 | 1,554 s |
| Sonnet 5.5 | 12 of 12 | 5 / 1 / 0 | $0.61 | 661 s |

**Decision: Sonnet stays the default.** Haiku cost 77% less, but it left a live use behind on `Chat-Nest-AI`, broke a build on `lamp-bot`, and took more than twice as long. One of its two misses is a lock artefact: `smartflow-hub`'s fix is right, but it kept the dead name in a comment. Even so, at $0.10 a repo Sonnet is cheap enough that a wasted review costs more than it saves. Haiku's runs were sharing the machine with O8, so the time gap may be smaller than this. Repeat after a new Haiku release.

### The setup plan on Haiku

$0.0013 a plan, against $0.035 on Sonnet, which was 24% of fix spend. On 12 repos the first-pass steps matched. This one stays.

### Faster runs on big repos

`nametag` took 30 minutes for less than a minute of model time, because the suite ran several times. Now:

- Adding a check runs that check, not the whole suite.
- A check that passed on the same code doesn't run again, in the session or after it.
- The baseline's second pass reruns only what failed.

Measured so far, on repos already seen and with layers restored: `Chat-Nest-AI` 247 s to 165 s, `text2question` 198 s to 148 s. Layers and the changes above both play a part, so this isn't a clean number for either.

**Install layers:** the same repo's second arm in O7 set up 21% faster, 622 s to 494 s over 7 repos. It's a rough figure: the order was also the only thing that differed, and other work was on the machine.

### Smarter retries

These were built in O3: failed checks and what the rescan still finds go back to the same session. 5 of the first 26 runs needed a second pass. The retry cost $0.05 on `buddy_connect`. I didn't test running without it, so I can't say how many fixes it rescued.

### One PR per repo

One session gives one PR per repo by construction. The PR body lists each entry, its source and how many uses it had.

## O8 round 2: Stripe field breaks

**When:** 2026-11-05, 03:34 to 04:51. **Commit:** `37974dc0` on `rebuild/integration`. **Locks:** `evals/rounds/o8-2/`. **Spend:** $0.95 of a $6 cap.

| Repo | Required fixed | Label | Cost | Time |
| --- | --- | --- | --- | --- |
| `mattogodoy/nametag` | 3 of 3 | Needs a look | $0.2452 | 1,807 s |
| `anvveber/hyperion` | 2 of 3 | Needs a look | $0.2465 | 2,172 s |
| `0-CYBERDYNE-SYSTEMS-0/quorum` | 2 of 2 | Fixed | $0.1684 | 343 s |
| `atrueempire/yk` | 4 of 4 | Fixed | $0.2946 | 264 s |
| **Total** | **11 of 12** | | **$0.9548** | |

| Target | Result |
| --- | --- |
| Required changes fixed, at least 70% | 11 of 12, 92%, by static locks |
| Cost with matches, about $0.50, never above $1 | $0.24 on average, $0.29 at most |
| Time with matches, under 5 minutes | **Missed on 3 of 4.** 264 s, 343 s, and 30 and 36 minutes. All were before the time fixes in O10 |
| Unneeded major upgrades | None |
| "Fixed" a hand-check agrees with, at least 90% | 2 of 2 |

**Reading every failure:**

- **`hyperion` R3:** a real partial fix. It reads `invoice.payments` but never expands it, so on a current webhook the payment intent stays null. The session said so under "unproven". Needs a look is the right label.
- **`nametag`:** all 3 locks pass, and this is the best fix of the night: it retrieves the invoice with `payments` expanded and keeps a fallback for older payloads. It's Needs a look only because the rescan still sees the deliberate fallback the list asks for. That's the safe way round.
- **`hyperion`, leftover rescan hits:** one is its deliberate fallback. The other, `app/api/billing/cancel/route.ts:58`, already reads `items.data[0]`, so that's a false alarm from the stand-in scan.
- **`yk`:** it moved Azure deployment names too, which aren't OpenAI-hosted model ids. It's a stand-in scan problem, and it's unclear whether those needed moving. Also the build was killed once with exit 137 during the session, then passed on the harness's own run, so the sandbox's 4 GB is tight for this repo.

**Top cause of the misses: time.** Baselines took 12 to 14 minutes and the suite ran several times. O10's changes target that, and round 3 reruns `hyperion` to measure it.

**The label rules, replayed:** the tighter rules came after round 1. Replayed over rounds 1 and 2 with no spend, 5 of 10 repos stay Fixed, and the hand-check agrees with all 5. It's a replay, so round 3 is the real test.

**Quiet repos, round 2:** $0.42 for 2 repos that already read both Stripe shapes. The scan flagged them, and neither session left them alone. `gridster` reordered its reads to prefer the new field and removed two debug reads, which is harmless, and landed on Needs a look. `actors-copilot` made the same small change plus Gemini test renames, then failed a check it had added itself, so it ended as Couldn't fix with no PR. Nothing bad would ship, but false alarms cost about $0.20 each. It's mostly a scanner cause: a field read behind a `??` fallback isn't dead. Sent to Pierce.

## Regression check: the 3 test repos on the real scanner

**When:** 2026-11-05, 05:31 to 05:40. **Commit:** `0a1384c4` on `rebuild/integration`. **Locks:** `evals/rounds/regression/`. **Spend:** $0.74 of a $4 cap.

This is the first run on Pierce's scanner instead of the stand-in. These repos have been seen, so it's a check and never the score.

| Repo | Required fixed | Label | Cost | Time | Refit on 2026-11-04 |
| --- | --- | --- | --- | --- | --- |
| `mantou132/Spotify-Lyrics` | 2 of 2 | Fixed | $0.2293 | 166 s | $4.28, 587 s, `ga.ts` untouched |
| `MuhammadTanveerAbbas/Clario-ai` | 6 of 6 | Needs a look | $0.2255 | 182 s | $4.46, 694 s |
| `MFaizanali2/Code-Review-Agent` | 5 of 5 | Needs a look | $0.2814 | 137 s | $3.70, 723 s |
| **Total** | **13 of 13** | | **$0.7362** | | **$12.44** |

The 2026-11-04 numbers are from `TEST-2026-11-04.md`. That test ran several tasks per repo and graded them by hand, so the cost and time compare, but the 13 locks are this run's.

**Reading every label:**

- **`Spotify-Lyrics`, Fixed. I agree.** It moved both send paths to GA4's `/mp/collect` with a JSON body and read the IDs from config, and its test checks the URL and the body. The PR says what a person must set, and that the secret ships inside the extension, as the list asks.
- **`Clario-ai`, Needs a look.** The one rescan hit is `?? invoice?.subscription`, the fallback `ST-2`'s `requires` asks for. That's a scanner case, sent to Pierce on his draft PR. The label stands, because it comes from the rescan and not from the session's word.
- **`Code-Review-Agent`, Needs a look. That label was too cautious.** The session dropped `temperature`, `top_p` and `top_k` from the Anthropic and Gemini calls. The rule tripped on `LLMConfig`, a typed config next to the edit, and the list allows a shared config to hold them. `requiredRemovals` now skips a typed field or parameter.

The Docker baseline and session each took 1 to 1.5 minutes, so all 3 repos beat the 5-minute target.

## O8 round 3: real scanner, new kinds of break

**When:** 2026-11-05, 06:42 to 06:56. **Commit:** `cf5378da` on `rebuild/integration`. **Locks:** `evals/rounds/o8-3/`. **Spend:** $0.89 of a $9 cap.

The first scored round on Pierce's scanner, and the first with Shopify and Meta breaks. Every repo is fresh.

| Repo | Required fixed | Label | Cost | Time |
| --- | --- | --- | --- | --- |
| `tungbinzzz/instagram-app-shopify` | 2 of 2 | Fixed | $0.1722 | 112 s |
| `sabbir-noyon/wishkit-app-shopify` | 2 of 2 | Fixed | $0.0928 | 89 s |
| `ksyp-7/shopify-theme-app-extension-vite-react` | 2 of 2 | Fixed, **I disagree** | $0.1950 | 219 s |
| `diegocsrdias/postmedia` | 2 of 2 | Fixed | $0.1055 | 41 s |
| `imran-farooq7/next-gen-ai-yt` | 1 of 1 | Fixed | $0.0930 | 98 s |
| `Cap-go/videoclub` | 1 of 1 | Fixed | $0.0968 | 112 s |
| `newfold-labs/wp-module-facebook` | 1 of 1 | Fixed | $0.0772 | 69 s |
| `hridoyhossain1001/buykori-client-portal` | 2 of 2 | Fixed, no real break | $0.0567 | 47 s |
| **Total** | **13 of 13** | | **$0.8894** | |

| Target | Result |
| --- | --- |
| Required changes fixed, at least 70% | 13 of 13 by static locks, or 11 of 11 without `buykori`, which has no real break |
| "Fixed" a hand-check agrees with, at least 90% | **Missed: 7 of 8, 88%** |
| Cost with matches, about $0.50, never above $1 | $0.11 on average, $0.20 at most |
| Time with matches, under 5 minutes | Met on all 8. The slowest took 219 s |
| Unneeded major upgrades, none | **Missed on 1 of 8.** `ksyp-7` moved 5 packages |

Eight Fixed labels out of eight looked too good, so I read all 8 diffs, and the code around them, by hand. These locks show a name moved, so a pass says little without that read.

**Reading every result:**

- **`ksyp-7`, Fixed. I disagree.** The list says the replacement version is 2026-10, and the installed SDK has no enum value for it. This session moved `shopify-app-remix` 3 to 6, `shopify-api` 11 to 15, `session-storage-prisma` 5 to 11 and Prisma 5 to 6, which raises the Node minimum to 22. It also rewrote `customShopDomains` as a regex, and it says the app was never run on Prisma 6. `tungbinzzz` and `wishkit` faced the same gap and passed `"2026-10"` as a string, with no upgrade. The upgrade was unneeded, and the label had no way to see it.
- **`tungbinzzz`, Fixed. I agree.** It leaves `restResources` importing `rest/admin/2024-10`. The session says so, and nothing in the app uses a name from the entry's `requires` lines.
- **`wishkit`, Fixed. I agree.** The `"2026-10" as ApiVersion` cast is ugly but honest, and the PR says so. It also moved `shopify.app.toml` from 2026-04, which wasn't dead. That's harmless. Its one `requires` hit, `productVariantsBulkUpdate`, comes from the template and sends no quantities.
- **`postmedia`, Fixed. I agree.** Both sizes the repo sends, 1024x1024 and 1024x1536, meet the new rules.
- **`next-gen-ai-yt`, Fixed. I agree.** It keeps the legacy SDK, which the entry allows unless the call needs the new one.
- **`videoclub`, Fixed. I agree.** The session also reported that this oEmbed call has no access token, so it may fail for a reason older than this fix. It isn't on the list.
- **`wp-module-facebook`, Fixed. I agree.** The repo commits `build/`, so the rebuilt bundle belongs in the diff. It also moved a profile image to a field the same component already prints, on the word of the scan's check.
- **`buykori`, Fixed. I agree with the edit, but the break isn't real.** Both hits are display strings holding the literal `pixel_id`, in a simulator and in `mock-data.ts`. No call is made. It cost $0.06, and it goes to Pierce as a false alarm.

**Top cause: a session can take a major upgrade the list didn't ask for, and the label can't see it.** The prompt already said no, but the entry's own line, that the enum needs a newer package, pushed the other way.

**What changed:** plain code now finds a major upgrade no entry asks for, sends it back to the session once, and gives one it keeps Needs a look. The prompt also says a missing constant isn't a reason, and tells the session to search for each API name in the `requires` lines, because 2 of the 3 Shopify sessions said they hadn't read the code against the versions crossed.

**Does the fix work?** I reran `ksyp-7` on the new prompt, not for score: 2 of 2 locks, no major upgrades, $0.1144, 104 s, against $0.1950 and 219 s. It passed the version as a string. To check that path I ran `@shopify/shopify-api` 11.0.0 and 12.2.0 in a container with a mocked fetch: on both, a plain `"2026-10"` reaches `/admin/api/2026-10/` for GraphQL and REST. That shows the SDK sends it, not that Shopify answers.

**The scan's AI check,** measured on all 26 repos where the scan was only unsure: $0.0163 in all, about $0.0006 a repo, and 7.6 s on average. It ruled out every match on 1 repo and some matches on 5 others. Across 196 repos the scan averaged 1.6 s, and took 18 s at most.
