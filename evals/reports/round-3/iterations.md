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
