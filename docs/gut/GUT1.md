# GUT1: the agent fixer

`fixWithAgent` (`pipeline/agent-fix.ts`) is the hand-off every gutted stop calls. It implements the `AgentFixInput` / `AgentFixResult` interface in [GUT-PLAN.md](../GUT-PLAN.md) unchanged, with one optional second argument.

```ts
fixWithAgent(input: AgentFixInput, options?: {
  runner?: AgentRunner; // the Claude Agent SDK unless a test passes a fake
  budget?: AiBudget; // the run ledger; REFIT_AI_BUDGET_USD / REFIT_AI_BUDGET_DIRECTORY when unset
  attemptUsd?: number; // what one attempt reserves and may spend; REFIT_AGENT_ATTEMPT_USD, default 3
}): Promise<AgentFixResult>;
```

## How it runs

- **Attempts.** `attempts` (default 3) run in parallel, each in its own copy of `repoDir` under the system temp directory. The last attempt uses `ANTHROPIC_ESCALATION_MODEL` (default `claude-opus-5-5`) when there is more than one; the others use `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`).
- **Rounds.** `rounds` (default 3) counts the agent's passes in one attempt. After each pass Refit calls `input.check(copy)`; on failure the exact errors (truncated at 20,000 characters) go back as the next message in the same session. A check that throws counts as a failure with its message.
- **Diff.** Each copy is snapshotted in a separate git directory before the agent starts, with `node_modules/` excluded, so the repository's own history, index and uncommitted head-start edits (codemods) stay untouched. `diff` is only the agent's change, as a binary-safe `git diff`.
- **Pick.** `passed`, then `no-change`, then `unproven` with the fewest errors, then `failed`; earlier attempts win ties. Only the winner's changed files are copied back into `repoDir`; its `node_modules` is not.
- **Outcome.** `passed`: the check passed and the agent changed something. `unproven`: a diff with errors left. `no-change`: no diff and the check passes. `failed`: no diff and the check fails, the session died, or the copy could not be made. `errors` is empty for `passed` and `no-change`.
- **Summary.** The agent's last message. The prompt and every feedback message ask it to end with what it changed, what it could not verify, and any behaviour change.

## The agent

- Claude Code through `@anthropic-ai/claude-agent-sdk` (`pipeline/agent-fix-sdk.ts`), one streaming session per attempt.
- **Untrusted repositories configure nothing.** `settingSources: []` (no `CLAUDE.md`, `.claude/` settings, hooks or plugins), `strictMcpConfig` with no MCP servers (no `.mcp.json`), no persisted session.
- **Tools.** Read, Edit, Write, Glob and Grep inside the copy; Bash only for one install or listing command of npm, pnpm, Yarn or Bun, `tsc` through npx, pnpm, Yarn or bunx, and `git diff` or `git status`, with no chaining, redirection, substitution or `--output`; WebFetch only over HTTPS to the provider's docs domain (shopify.dev, developers.facebook.com, docs.stripe.com). Everything else is refused. `toolPolicy` is enforced twice, through `canUseTool` and a PreToolUse hook, so calls Claude Code would approve on its own are checked too.
- **Environment.** The agent process gets the caller's environment minus every variable whose name looks like a credential (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PRIVATE`, `DATABASE_URL`, `CREDENTIAL`), except `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`, which it needs. Install scripts are the caller's business: the sandbox (GUT5) runs them in a container; on a developer machine set `npm_config_ignore_scripts=true`. Without `ANTHROPIC_API_KEY`, Claude Code uses the machine's own Claude login.

## Budget

- Each attempt reserves `attemptUsd` in the run ledger before it starts (`reserveAiAmount`, added to `pipeline/ai-budget.ts`) and settles at the session's reported cost when it ends; the SDK's own stop is set at 85% of the reservation, because it is checked between turns. An attempt the ledger cannot cover never starts and ends `failed` with the ledger's message. There is no per-repository cap.
- The cost is Claude Code's `total_cost_usd`, which prices every model the session used (Haiku included) at Anthropic's list prices, 1-hour cache writes included. Refit's price table has neither Haiku nor 1-hour cache writes, so it does not recompute it.
- A session that dies before reporting a cost keeps its whole reservation and reports it as the attempt's cost, as an unpriced OpenAI request does.
- The file ledger refuses a second writer instead of waiting. `fixWithAgent` serializes its own ledger calls within one process; separate processes sharing one file ledger can still collide, so run repositories in one process (or give each process its own ledger).

## Calling it (GUT2, GUT3)

- `repoDir` must be a directory Refit may change: the winner's files are written into it. A git checkout is not required.
- `change` is quoted provider data; `context` is the old stop's reason and findings with files and lines. Both go into the prompt verbatim.
- `check` must be deterministic and must not modify the directory. It runs once per round per attempt, concurrently across attempts, on the attempt's copy, so it must take the directory as given (no fixed paths).
- With `attempts: 3, rounds: 3` the check runs up to nine times; a slow check (a full type check in the sandbox) dominates wall time.
- The SDK spawns the Claude Code binary from `@anthropic-ai/claude-agent-sdk-<platform>`; the refit-bench image needs `npm ci` without `--omit=optional` (GUT5).

## Real check, 2026-10-31

Two stuck repositories from `subsets/shopify-dev-60.json` (dev set only), cloned at their frozen commits, `npm_config_ignore_scripts=true`, `attempts: 2` (Sonnet 5.5 and Opus 5.5), `rounds: 3`, `attemptUsd: 0.7`, on this machine with Claude Code's own login. The judge was Refit's Shopify benchmark scan (`shopify-benchmark-cli.ts --sdk-upgrade --allow-dirty`), passing when it reports the repository pinned to Admin API 2026-10 with no findings, as the manual run of 2026-10-31 did.

| Repository                     | Before (the old stop)                                                                                                                 | Outcome  | Cost  | Wall time |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----- | --------- |
| hasan-araav/shopify-order-sync | A GraphQL document already fails on 2026-01 (`Order.financialStatus`, `fulfillmentStatus`, `Customer.ordersCount`, `totalSpentV2`, …) | `passed` | $0.96 | 4.7 min   |
| matheuscpatricio/omafit        | A GraphQL document already fails on 2026-01 (billing fragments spread on `AppPlanV2`, `Shop.primaryLocale`)                           | `passed` | $0.92 | 4.8 min   |

- Spend recorded in the run ledger: $1.88. An earlier attempt at this run was stopped by the founder's pause after settling $0.11, with one $1.00 reservation whose real spend is unknown, so the total is at most $2.99.
- What the agents did: moved every pin (`shopify.server`, `.graphqlrc`, `shopify.app*.toml`) to 2026-10; upgraded `@shopify/shopify-app-remix` 3 → 6 and `@shopify/shopify-app-react-router` 1.1 → 4 (both bring `@shopify/shopify-api` 15) with session storage to match, the lockfile updated by npm with scripts off; replaced removed fields (`displayFinancialStatus`, `numberOfOrders`, `amountSpent` behind aliases that keep the old response names; `shopLocales` for `primaryLocale`; billing fragments moved under `plan { pricingDetails }`).
- Both summaries say what they could not verify: no live store, and `tsc` errors left in files that do not touch Shopify (Polaris prop types, an ungenerated Prisma client, Supabase functions). These passes are against the scan only; neither diff has been hand-checked or built in the sandbox, so neither is a validated row.
