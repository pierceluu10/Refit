# Round 3 iterations (L1)

Each row is one practice iteration run from `r3/integration`, scored by
`node evals/runner/cli.ts score3`. Times are EST on 2026-11-03.

| #   | Time | Commit | Eligible | Verified | Score | Cost | Top causes | What changed |
| --- | ---- | ------ | -------- | -------- | ----- | ---- | ---------- | ------------ |

No scored iteration has run yet: this session has no `ANTHROPIC_API_KEY`, so nothing that calls a
model can run (inventory, match, the codegen planner, the harness, the reviewer).

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
