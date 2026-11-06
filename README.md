<p align="center">
  <img src="public/refit-agent-avatar.png" alt="Refit logo" width="96" height="96" />
</p>
<h1 align="center">Refit</h1>
<p align="center"><strong>Software that never falls behind.</strong></p>

Refit is a GitHub App for an organization. Code goes stale because things outside the team's control keep changing: language runtimes reach end of life, frameworks and libraries ship breaking majors, security advisories land, AI models are retired, third-party APIs change, base images and CI actions are deprecated, Kubernetes, serverless and cloud platforms move on, and rules and regulations take effect. Refit reads each codebase, finds what it depends on, watches all of those sources, and when something changes it finds the affected code, fixes it in a sandbox, proves the fix and opens a draft PR. It learns from every outcome.

## How it works

1. **Install.** An org admin installs the GitHub App on all or selected repos.
2. **Scan.** An agent reads each repo and writes an inventory of every dependency and API it uses: runtimes, frameworks, libraries, AI models, third-party APIs, container images, CI, platforms, and the surfaces a rule may touch. It re-reads on every push.
3. **Watch.** Watchers read changelogs, release notes, end-of-life calendars, advisories and deprecation notices for every change source, and record each change with a source link and quote.
4. **Match.** An agent decides which changes touch which dependencies and call sites, and why. Changes that don't apply become "not affected" items with a reason.
5. **Report.** A "what's behind" report lists every finding by deadline, then severity, then impact.
6. **Migrate and prove.** The harness agent edits a sandboxed copy of the repo. It runs the type check, build and tests before and after, counting only new failures, and calls validators. The outcome is verified or needs-review.
7. **Ship.** A draft PR on a branch says what changed, why, the proof, what's unproven and any behaviour change.
8. **Learn.** Memory records every run and the human verdict on its PR. Successful runs become recipes later runs retrieve.
9. **Audit.** Every step is written to an audit trail with its evidence.

Rules and regulations are handled with care. Refit never claims code is "compliant" and never gives legal advice. A rule PR is always needs-review and lists what a person must confirm.

## AI-first

The agent does the understanding, deciding and editing. Code gives it tools, context and checks. Parsers, scanners and validators are tools, never gates. Every task ends in a PR or a "not affected" verdict with an honest note on what's unproven, never a silent stop. See [AGENTS.md](AGENTS.md).

The only hard limits, enforced in code:

1. Untrusted repo code runs only in the sandbox.
2. A run-level dollar cap.
3. PRs only. Never push to the default branch, never merge.
4. Never print or commit secrets.

## Workspaces

| Folder          | What lives there                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `orchestrator/` | The end-to-end loop, the match agent, the scan report, the CLI and the queue                        |
| `harness/`      | The migration agent: prompt, tools, sandbox, budget ledger, PR writer, and proof (`harness/proof/`) |
| `memory/`       | Run records, recipe extraction, retrieval, skill promotion, self-eval                               |
| `app/`          | The GitHub App: install webhooks, org and repo sync, PR opener, verdicts                            |
| `inventory/`    | The codebase-understanding agent: `ApiUsage[]`, `DependencyUsage[]` and surfaces                    |
| `providers/`    | Watchers for every change source, knowledge, tool packs and playbooks                               |
| `compliance/`   | The rules and regulations agent and the audit trail                                                 |
| `evals/`        | Repo sets, the benchmark runner, scoring, hand-checks                                               |
| `shared/`       | `types.ts`, the contract every folder codes against, and `models.ts`, the model layer               |
| `src/`          | The website and dashboard                                                                           |

The plan is in [MVP-PLAN.md](MVP-PLAN.md), building on [REFIT-PLAN.md](REFIT-PLAN.md).

## Quick start

Requires Node.js 22.12+ or a supported newer release.

```sh
npm ci
```

Scan one or more local repos and see what's behind:

```sh
node orchestrator/cli.ts scan --repo <path> [--repo <path> ...] [--out report.json]
```

This prints a "what's behind" table (deadline, severity, dependency, version → target, change, status) and writes the `ScanReport` JSON.

Run the whole loop, including upgrade tasks:

```sh
node orchestrator/cli.ts run --repo <path> [--dry-run] [--out runs.jsonl]
```

`--dry-run` stops before opening PRs.

Without `ANTHROPIC_API_KEY`, the CLI runs offline: fixture stubs stand in for every AI part, and the output says so. With the key, `REFIT_AI_BUDGET_USD` is required, and the run refuses to start without it. Every part the orchestrator runs draws on that one cap.

To try it offline on the illustrative sample repos:

````sh
node orchestrator/cli.ts scan --repo orchestrator/fixtures/samples/demo-node-api
``` For example (illustrative values):

```sh
REFIT_AI_BUDGET_USD=2 ANTHROPIC_API_KEY=... node orchestrator/cli.ts run --repo ../some-repo --dry-run
````

Copy [.env.example](.env.example) for the full list of variables. Never commit a filled-in env file.

## Run the website

```sh
npm ci
npm run dev
```

## Checks

CI runs these, and so should you before committing:

```sh
npm run typecheck
npm run format:check
npm test
npm run build
```

## License

MIT. See [LICENSE](LICENSE).
