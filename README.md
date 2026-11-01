<p align="center">
  <img src="public/refit-agent-avatar.png" alt="Aptitude logo" width="96" height="96" />
</p>
<h1 align="center">Aptitude</h1>
<p align="center"><strong>Turn upstream API changes into reviewed code updates.</strong></p>

Aptitude is a GitHub App for an organization. Once installed, it reads each codebase the way a new engineer would, understands which external APIs it uses, where and how, then watches those APIs for changes, migrates the affected code, proves the migration works and opens a PR. It learns from every outcome. Aptitude was previously called Refit.

## How it works

1. **Install.** An org admin installs the GitHub App on all or selected repos.
2. **Understand.** An agent reads each repo and writes an API usage map: provider, SDK or raw HTTP/GraphQL/webhooks, pinned version, every call site and what it sends. It re-reads on every push.
3. **Watch.** Agents read each provider's changelogs, specs, SDK releases and deprecation notices, and record each change with a source quote.
4. **Match.** An agent decides which changes touch which call sites, and why, and ranks the resulting tasks by deadline and impact.
5. **Migrate.** The harness agent edits a sandboxed copy of the repo.
6. **Prove.** It runs the type check, build and tests before and after, counting only new failures, and calls provider validators. The outcome is verified or needs-review.
7. **Ship.** A PR on a branch saying what changed, why, the proof, what's unproven and any behaviour change.
8. **Learn.** Every run and the human verdict on its PR is recorded; successful runs become recipes future runs retrieve.

## AI-first

The agent does the understanding, deciding and editing. Code gives it tools, context and checks. Parsers, scanners and validators are tools, never gates. Every task ends in a PR or a "not affected" verdict with an honest note on what's unproven, never a silent stop. The only hard limits in code: untrusted repo code runs only in the sandbox, a run-level dollar cap, PRs only (never push to the default branch or merge), and never print or commit secrets. See [AGENTS.md](AGENTS.md).

## Workspaces

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
| `src/`          | The website and dashboard                                                    |

## Run the website

Requires Node.js 22.12+ or a supported newer release.

```sh
npm ci
npm run dev
```

## Run the loop locally

```sh
APTITUDE_AI_BUDGET_USD=2 ANTHROPIC_API_KEY=... npx aptitude run --repo ../some-repo --dry-run
```

Or directly: `node orchestrator/cli.ts run --repo <path> [--dry-run] [--out <file>]`. `--dry-run` stops before opening the PR. `APTITUDE_AI_BUDGET_USD` caps the run's AI spend; a run without it refuses to spend. Without `ANTHROPIC_API_KEY`, the CLI uses an offline stub matcher.

Current status: inventory, watch, migrate, PR and memory are stubs in this branch until their branches merge.

## Checks

`npm run typecheck`, `npm run format:check`, `npm test` and `npm run build` are the checks CI runs.
