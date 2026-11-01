# harness

Aptitude's migration agent. `runTask(task, repoDir)` runs a Claude agent on the Claude Agent SDK
(`claude-sonnet-5-5`, escalating to `claude-opus-5-5` when an iteration makes no progress) in a
sandboxed copy of the repo and returns a `RunRecord` plus the PR body.

| File              | What it does                                                                       |
| ----------------- | ---------------------------------------------------------------------------------- |
| `run.ts`          | The loop: sandbox, install, baseline checks, agent, re-check, iterate, outcome     |
| `agent.ts`        | The real session: one SDK `query()` over the harness tools as an in-process MCP    |
| `fake-session.ts` | A scripted fake model that drives the real tools, for tests and smoke runs         |
| `prompt.ts`       | The versioned system prompt (`PROMPT_VERSION`), kickoff and retry messages         |
| `tools.ts`        | The tool registry: files, shell, install, checks, fetch, recipes, ToolPack, finish |
| `checks.ts`       | Package manager and check detection, before/after comparison of failures           |
| `sandbox.ts`      | Docker container, or a local temp copy with install scripts disabled               |
| `ledger.ts`       | The run-level dollar cap every model call is charged to                            |
| `pr.ts`           | The PR body: change, why, proof, unproven, behaviour changes                       |
| `secrets.ts`      | Redaction and a scrubbed env for untrusted code                                    |

The only hard limits, enforced in code: repo code runs only in the sandbox; the
`APTITUDE_AI_BUDGET_USD` cap; no pushing (the sandbox's git has no remotes, the PR is opened by
`app/`); secrets are redacted from tool output, the transcript, the diff and the PR body. Nothing
else refuses or gates the agent: tools only return information, and every run ends as verified,
needs-review or not-affected (`failed` only when the sandbox cannot be created).

Outcome: **verified** when the agent changed code, called `finish`, at least one check ran, no
check has a failure it didn't have before, every provider validator it claims is backed by a
passing ToolPack call the harness recorded (`validators.ts`), and it lists nothing unproven.
Otherwise **needs-review**. The dollar cap can overshoot by up to one model turn, because cost is
known only after a turn ends.

One run by hand (writes `transcript.jsonl`, `diff.patch`, `pr-body.md`, `record.json`):

```sh
APTITUDE_AI_BUDGET_USD=5 node harness/scripts/run-task.ts task.json /path/to/clone ./out
```
