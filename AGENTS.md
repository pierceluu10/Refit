# Contributing

Refit is a GitHub App that keeps an organization's code up to date with the external APIs and dependencies it uses: it finds the affected code, migrates it, proves the change in a sandbox and opens a PR. See [README.md](README.md) for the overview.

## Where things live

| Folder          | What lives there                                                                        |
| --------------- | --------------------------------------------------------------------------------------- |
| `app/`          | The GitHub App: install webhooks, org and repo sync, job queue, PR opener, verdicts     |
| `orchestrator/` | The end-to-end loop, the match agent, the scan report and the `refit` CLI               |
| `inventory/`    | The codebase-understanding agent that produces `ApiUsage[]` and `DependencyUsage[]`     |
| `providers/`    | Watchers, knowledge, tool packs and playbooks per provider, plus upgrades and platforms |
| `harness/`      | The migration agent: system prompt, tools, Docker sandbox, checks, PR writer            |
| `memory/`       | Run records, recipe extraction, per-organization retrieval, skill promotion             |
| `compliance/`   | The rules agent and the audit trail                                                     |
| `evals/`        | Repo sets, the eval runner, scoring and the PR reviewer                                 |
| `shared/`       | `types.ts`, the contract every package codes against                                    |
| `src/`          | The dashboard (`public/` and `index.html` belong with it)                               |

`shared/types.ts` is the contract; change it additively. Each workspace adds its dependencies to its own `package.json`.

## Rules enforced in code

1. Repo code runs only in the sandbox.
2. Every run that calls a model has a dollar cap.
3. PRs only: never push to a default branch, never merge.
4. Never print or commit secrets. Only `.env.example` is tracked.

## Before committing

Run `npm run typecheck`, `npm run format:check`, `npm test` and `npm run build`. Use Conventional Commits.
