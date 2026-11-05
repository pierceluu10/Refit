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
