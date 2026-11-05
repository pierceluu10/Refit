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
