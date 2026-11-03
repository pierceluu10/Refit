# Agent guide

This repository holds Refit: a GitHub App that reads an organization's codebases, understands which external APIs they use, watches those APIs for changes, migrates the affected code, proves the migration works and opens a PR. The old deterministic engine stays in git history; don't port it back. `REFIT-PLAN.md` is the plan.

## AI-first: the rule above all others

An AI agent does the understanding, deciding and editing. Code exists to give it tools, context and a way to check its work.

- Let the model read and reason: reading code, understanding API usage, reading changelogs, deciding whether a change matters, planning and editing.
- Parsers, scanners, validators and codemods are tools the agent may call to go faster or check itself. Never gates.
- Every task ends in a PR or a "not affected" verdict, with an honest note on what's unproven. Never a silent stop.
- Guidance lives in prompts, playbooks and memory, not in `if` statements.
- When the agent is unsure, it tries anyway and says so in the PR.

Reject these in review:

- a hand-written rule that decides whether a repo, file or change is "supported";
- any branch that ends a task without an attempt (`stop`, `refuse`, `skip`, "separate reviewed change");
- a fixed list of patterns as the only way to find API usage;
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
