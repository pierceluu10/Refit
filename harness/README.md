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
| `sandbox.ts`      | Docker container, or a local temp copy; install scripts off in both                |
| `ledger.ts`       | The run-level dollar cap every model call is charged to, as the call streams       |
| `pr.ts`           | The PR body: change, why, proof, unproven, behaviour changes                       |
| `secrets.ts`      | Redaction and a scrubbed env for untrusted code                                    |

The only hard limits, enforced in code: repo code runs only in the sandbox; the
`APTITUDE_AI_BUDGET_USD` cap; no pushing (the sandbox's git has no remotes, the PR is opened by
`app/`); secrets are redacted from tool output, the transcript, the diff and the PR body. Nothing
else refuses or gates the agent: tools only return information, and every run ends as verified,
needs-review or not-affected (`failed` only when the sandbox cannot be created).

The loop has no fixed iteration cap. It ends when the checks pass, when the agent finishes with an
explanation of what still fails, or when the dollar cap is reached. Checks the detection misses can be
registered by the agent with `run_checks` `add`. They run on an untouched copy for the baseline and
count toward proof.

Outcome: **verified** when the agent changed code, called `finish`, at least one check ran, no
check has a failure it didn't have before, every provider validator it claims is backed by a
passing ToolPack call the harness recorded (`validators.ts`), and it lists nothing unproven.
Otherwise **needs-review**. The dollar cap can overshoot by up to one model turn, because the Agent
SDK checks its query budget only between turns; `TURN_RESERVE_USD` is held back for that.

Spend is charged live: the session meters each model call from its stream events (input and cache
tokens when the call starts, output when it ends) and charges the ledger at once; the SDK's total at
the end of each query adds only what the stream did not show. Pass `chargeRun(usd, label)` in
`HarnessDeps` and every ledger charge reaches the run budget as it happens, so a run that throws has
already reported what it spent. `record.costUsd` is the same money: count one or the other, not both.

One run by hand (writes `transcript.jsonl`, `diff.patch`, `pr-body.md`, `record.json`):

```sh
APTITUDE_AI_BUDGET_USD=5 node harness/scripts/run-task.ts task.json /path/to/clone ./out
```
