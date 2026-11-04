# Round 3 iterations (L1)

Each row is one practice iteration run from `r3/integration`, scored by
`node evals/runner/cli.ts score3`. Times are EST on 2026-11-03.

| #   | Time                                           | Commit                                                     | Eligible | Verified | Score | Cost                           | Top causes                                                                                                                                                                                                                                                  | What changed                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------- | ---------------------------------------------------------- | -------- | -------- | ----- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | from 13:53; stopped before every repo finished | `a02bb8a7`; Stripe and OpenAI rerun at 15:38 on `657e0905` | 62       | 45       | 72.6% | $73.99 for the 69 scored repos | All 17 misses were needs-review. Read by hand: the agent's own caveats (`unproven`) held back verified; a validator that could not run counted as a failure; flaky checks; type errors matched by the types tsc prints; edits beyond what the change forced | First scored run. Screen of all 125 practice repos: 33 red baseline and 6 outside our authority excluded (8.8% of affected repos)                                                                                                                                                                                                                                                                                                              |
| 2   | 17:38 to 17:47                                 | `b661ece4`                                                 | 9        | 9        | 100%  | $4.29 ($0.43 a repo)           | None failed. Against plain Claude, judged blind: Claude 5, Refit 3, 2 ties                                                                                                                                                                                  | One harness run per repo and provider (`a25423df`); memory and review on Sonnet (`81d42265`); match on Sonnet (`a25423df`); tool descriptions out of the system prompt (`d0681bd5`); finish refuses a report that would miss verified (`5c150798`); the fixes for iteration 1's misses (`5710e830`, `c9109a3e`, `ef8e49d0`, `346c06c9`, `3f873db7`, `e75ed7c2`)                                                                                |
| 3   | 18:00 to 18:48                                 | `380043d1`                                                 | 9        | 9        | 100%  | $14.39 ($1.44 a repo)          | None failed. Against plain Claude: Claude 5, Refit 3, 2 ties. Refit missed providers it doesn't watch (OpenRouter and Groq on t2-chat, Tableau's sign-in) and made changes nothing required (lamp-bot's Stripe major upgrade)                               | Every provider a repo uses, not only its set's (`8f611c7c`): 34 tasks where iteration 2 had 10, so cost and wall time rose (lamp-bot 5 to 35 min, t2-chat 9 to 46 min); act on what breaks now or within 90 days, let not-affected stand, keep proof tests tidy (`463a0557`); match on Opus again (`a77eedf7`); rebuilt tsbuildinfo out of diffs (`4bcffbee`); a finish that drops a secret-guarding `.gitignore` line is refused (`ba1d8832`) |

Iterations 2 and 3 ran only 10 repos, picked from the ones Refit verified in iteration 1 (`--repos`).
Their scores are not comparable with iteration 1's, and their 40% outside-authority share is over
that subset, not the screen. Iteration 1's cost covers the scored repos; it does not include the
screen or the runs that were stopped.

## Refit against plain Claude (iteration 3)

Both start from the repo alone, each in its own sandbox. Plain Claude (Sonnet 5.5) gets one prompt
with the same job (what breaks now or within 90 days), file, shell and web tools, one session and
no retries. A blind judge (Opus 5.5) reads both diffs. The code check applies each PR to a fresh,
prepared copy and runs the repo's checks plus a syntax check of every changed file; broken means a
check that passed before fails after. It ran with no model key, so it has no codegen planner.

|                                        | Refit                     | Plain Claude |
| -------------------------------------- | ------------------------- | ------------ |
| Judge prefers (10 repos)               | 3                         | 5 (2 ties)   |
| API changes handled correctly          | 26 of 30                  | 22 of 23     |
| Code check: clean                      | 8                         | 7            |
| Code check: broken                     | 0                         | 0            |
| Code check: no check covers the change | 1                         | 2            |
| Code check: nothing changed            | 1                         | 1            |
| Cost per repo                          | $1.44 ($1.06 for the fix) | $0.15        |
| Agent time per repo                    | 6.0 min                   | 44 s         |
| Checkout to result per repo            | 17.5 min                  | not measured |

Refit's cost per repo by part: harness $0.45, match $0.34, memory $0.30, watch $0.28, review $0.08.
Its agent ran on Sonnet 5.5, the same model as plain Claude; it worked for 34% of the wall time.
Plain Claude installed no packages and ran no repo's tests in any of the 10 repos.

The first code check reported Refit's backend_AgentAi PR 3 of 5 as broken. That was the checker:
`reset()` kept `node_modules`, so PR 3 (Crunchbase) ran against the packages PR 2 (the Gemini SDK
upgrade) had installed. The checker now reinstalls the original packages after a PR that changed
them (`efa4cebf`), and all four multi-PR repos came back clean.

## Since iteration 3, not yet measured

- A repo's tasks run at once, match runs one call per provider in parallel, and memory learns in
  the background (`b4412695`).
- `--verify`, the code check above (`efa4cebf`), on `Sandbox.reset()` (`301ed203`).
- Env-var references are no longer scrubbed as secrets (`6fae24be`).

## Dry screens ($0, not iterations)

The screen run with no key: install, the repo's checks and nothing else. No codegen planner and no
placeholder env, so a repo that needs `prisma generate` or a build-time env var stays red here.
They measure the sandbox, not the product.

### Dry screen 1: 04:23 to 05:20, `r3/loop` from `19207887` to `289024d7`

47 of 125 practice repos green (stripe-dev-30 2 of 30, openai-dev-30 13 of 30, anthropic-dev-30
17 of 30, gemini-dev-15 6 of 15, longtail-dev-20 9 of 20). The 78 red ones, by cause:

| Red baselines | Cause                                                                                                                                                                                 | Fix                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20            | An env var read at build time (`OPENAI_API_KEY`, Supabase, Upstash, a webhook secret)                                                                                                 | The codegen planner names placeholder env, and looks again with the failing output in hand (`3d3cf6a9`, `10b9026a`). Needs the key.                                              |
| 15            | Prisma client never generated (install scripts off)                                                                                                                                   | The planner runs the repo's own `prisma generate` (`3d3cf6a9`). Needs the key.                                                                                                   |
| 10            | Type errors in the repo's own code                                                                                                                                                    | None: a genuine red baseline.                                                                                                                                                    |
| 8             | Only the harness's own fallback `tsc --noEmit` fails                                                                                                                                  | The screen judges the repo's own checks; the fallback still proves edits (`320cec2a`).                                                                                           |
| 7             | The repo's own tests fail                                                                                                                                                             | None: a genuine red baseline.                                                                                                                                                    |
| 7             | A tool or module missing: an app in `client/`, `bun`, `pytest` deps                                                                                                                   | Bun's release in the container (`10b9026a`); the planner may install a subfolder project (`2c1fd7b5`).                                                                           |
| 8             | Install failed: 3 npm peer conflicts, 2 `bun: not found`, 1 half-written `node_modules` after `npm ci` (ENOTEMPTY), 1 Node 12 engine pin, 1 win32-only binding as a direct dependency | `--legacy-peer-deps` and `--force` fallbacks after a clean `node_modules`, bun's release in the container, engine pins ignored (`b3f2699b`, `10b9026a`, `65d72356`, `2c1fd7b5`). |
| 1             | A dependency missing from the registry (`@radix-ui/react-skeleton@^0.0.5`)                                                                                                            | None: outside our authority.                                                                                                                                                     |
| 2             | A build that recurses into itself; 10 type-check issues                                                                                                                               | None: genuine red baselines.                                                                                                                                                     |

The bucketing is by regex over each check's output, then read by hand for the tool, install and
other rows.

### Dry screen 2: 05:23 to 06:14, `r3/loop` at `2c1fd7b5`

The 78 red repos again, on the fixed install and the fallback-tsc rule: 55 of 125 green
(stripe-dev-30 2, openai-dev-30 15, anthropic-dev-30 18, gemini-dev-15 7, longtail-dev-20 13). Every
install that failed for a sandbox reason now succeeds. Of the 70 still red:

| Red baselines | Cause                                                                                                                                                                                                      | What would fix it                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 24            | An env var read at build or test time                                                                                                                                                                      | The codegen planner's placeholder env. Needs the key.               |
| 11            | Prisma client never generated, plus jiro and QueryPDF, where untyped Prisma results show up as implicit `any`                                                                                              | The planner's `prisma generate`. Needs the key.                     |
| 12            | A module or tool missing: a subfolder app, a workspace package not built, a gitignored config with a template, and two that need files we don't have (`firebase-credential.json`, a missing source module) | The planner, for the first three. Needs the key.                    |
| 9             | The repo's own tests fail                                                                                                                                                                                  | None: genuine red baselines, unless the planner finds an env cause. |
| 8             | Type or build errors in the repo's own code (Next 15 async `params`, removed exports)                                                                                                                      | None: genuine red baselines.                                        |
| 4             | Type errors in the repo's own code                                                                                                                                                                         | None.                                                               |
| 2             | Install: npm itself crashed (`jorkun`), a dependency missing from the registry (`UNC-GDSC`)                                                                                                                | None.                                                               |

Read by hand for jiro, QueryPDF, PALO-LLM-Playground, vue3-migration-extension, quorum, tinypivot,
MyMICDS-v2, LobeChat and dimi-online-notification-backend.
