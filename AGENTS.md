# Agent guide

This repository holds Refit: a GitHub App that reads an organization's codebases, understands which external APIs they use, watches those APIs for changes, migrates the affected code, proves the migration works and opens a PR. It was briefly renamed Aptitude on 2026-11-01 and went back to Refit on 2026-11-05. The old deterministic engine stays in git history. Its data may be reused, but not its design. `REFIT-PLAN.md` is the plan.

## The rule above all others

Plain code decides what to look at. AI fixes anything new, and proven fixes become plain code. Plain code never decides that something can't be fixed.

An AI agent does the understanding and editing of anything new. Code finds the work, compares it against what's known, checks the result, and runs fixes that have been proven.

- Let the model read and reason: reading changelogs once per source, settling matches plain code finds unclear, planning and editing fixes.
- Parsers, scanners and comparisons may decide whether a repo needs work. A repo with no match has no task and stops at about $0. Validators and rescans prove the result. Once something matches, a fix is always attempted.
- Every task ends in a PR, a "not affected" verdict, or "couldn't fix" with a short report, with an honest note on what's unproven. Never a silent stop.
- Guidance lives in prompts, playbooks and memory. Fixes proven by merged PRs may live as plain code. If one fails on a repo, AI takes over, so a proven fix can never block an attempt.
- When the agent is unsure, it tries anyway and says so in the PR.

Reject these in review:

- a hand-written rule that decides whether a repo, file or change can be fixed or is "supported";
- any branch that ends a matched task without an attempt (`stop`, `refuse`, `skip`, "separate reviewed change");
- a fixed list as the only way to find API usage. The unlisted-provider queue and the AI sweep keep the list from being the only way to find things, and neither may be removed;
- treating an unlisted provider as "nothing to do";
- AI calls shaped as "answer yes or no, decline if unsure";
- "cautious" defaults that make the agent do less.

The only hard limits, enforced in code:

1. Untrusted repo code runs only in the sandbox.
2. A run-level dollar cap.
3. PRs only. Never push to the default branch, never merge.
4. Never print or commit secrets.

## Where things live

| Folder          | What lives there                                                             |
| --------------- | ---------------------------------------------------------------------------- |
| `orchestrator/` | The end-to-end loop, the match agent, the CLI and the queue                  |
| `harness/`      | The migration agent: system prompt, tools, sandbox, budget ledger, PR writer |
| `memory/`       | Run records, recipe extraction, retrieval, skill promotion, self-eval        |
| `app/`          | The GitHub App: install webhooks, org and repo sync, PR opener, verdicts     |
| `inventory/`    | The codebase-understanding agent that produces `ApiUsage[]`                  |
| `providers/`    | Per provider: changelog-reading watcher, knowledge, tool pack, playbooks     |
| `evals/`        | Repo sets, the benchmark runner, scoring, hand-checks                        |
| `shared/`       | `types.ts`, the contract every folder codes against                          |
| `src/`          | The website and dashboard (`public/` and `index.html` belong with it)        |

`shared/types.ts` is the contract. Change it additively only; agree breaking changes with the founders first. Code against the entry-point types, with a local stub until the real module lands. Each workspace adds its dependencies to its own `package.json`, not the root.

## AI spend

- Every real model run needs a dollar cap in `REFIT_AI_BUDGET_USD`. A run without one refuses to spend.
- The founders approve benchmark budgets. Don't start a real benchmark without that approval and a cap.

## Working rules

- Keep the design system in `DESIGN.md`. Polish, don't redesign, unless asked.
- Never commit environment files. Only `.env.example`, with no secrets, is tracked. The repository is intended to become public.
- Label illustrative examples. Don't invent customers, metrics or passing checks.
- Run typecheck, format check, tests and build before committing. Use conventional commit messages with no co-author trailers.
