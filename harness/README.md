# harness

Aptitude's fix agent. `runTask(task, repoDir)` runs a Claude agent on the Claude Agent SDK
(`claude-sonnet-5-5`, escalating to `claude-opus-5-5` only after a failed check that didn't improve;
never just to get the report, since Opus re-reads the whole session uncached) in a sandboxed copy of
the repo and returns a `RunRecord` plus the PR body.

A repo session is one task with `findings` and `entries` (`findings.ts`): every finding from the scan
goes to one session, at most $1, with the fix rules in the system prompt and the list in the kickoff
message, so sessions with the same tools share a cached prefix. Proven fixes run first with no model
(`proven.ts`). Then the same scan reruns on the working copy, what it still finds goes back to the
session, and plain code picks the label:

| Label        | Outcome        | Means                                                                                                                        | Action                |
| ------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Fixed        | `verified`     | Rescan clean, checks no worse, and a passing check touches the change                                                        | PR                    |
| Needs a look | `needs-review` | Partly clean, no passing check touches the change, listed work left undone, or the provider's validator still rejects a name | Draft PR that says so |
| Couldn't fix | `failed`       | New failures, or every use still there, or no change                                                                         | No PR, short report   |

A clean rescan shows the dead thing is gone, not that a live call works. `smoke.ts` adds an optional
one-line live call per provider on a sample of fixes, on the host. With no provider key it logs that,
and nothing is called proven live without a real answer.

| File                | What it does                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `run.ts`            | The loop: sandbox, install, baseline checks, agent, re-check, iterate, outcome                                                |
| `agent.ts`          | The real session: one SDK `query()` over the harness tools as an in-process MCP                                               |
| `fake-session.ts`   | A scripted fake model that drives the real tools, for tests and smoke runs                                                    |
| `prompt.ts`         | The versioned system prompt (`PROMPT_VERSION`), kickoff and retry messages                                                    |
| `tools.ts`          | The tool registry: files, shell, install, checks, diff, fetch, recipes, ToolPack, finish                                      |
| `findings.ts`       | A repo session's task, its list, and the label from the rescan and checks                                                     |
| `proven.ts`         | Runs plain-code proven fixes before any session                                                                               |
| `smoke.ts`          | The optional live smoke call                                                                                                  |
| `install-layers.ts` | Reuses `node_modules` across sandboxes, keyed on every file that can steer an install                                         |
| `checks.ts`         | Package manager, its release and check detection, before/after comparison of failures                                         |
| `sandbox.ts`        | Docker container (the Python image for a Python repo without package.json), or a local temp copy; install scripts off in both |
| `ledger.ts`         | The run-level dollar cap every model call is charged to, as the call streams                                                  |
| `pr.ts`             | The PR body: change, why, proof, unproven, behaviour changes                                                                  |
| `secrets.ts`        | Redaction and a scrubbed env for untrusted code                                                                               |

The only hard limits, enforced in code: repo code runs only in the sandbox; the
`APTITUDE_AI_BUDGET_USD` cap; no pushing (the sandbox's git has no remotes, the PR is opened by
`app/`); secrets are redacted from tool output, the transcript, the diff and the PR body. Nothing
else refuses or gates the agent: tools only return information, and every run ends as verified,
needs-review or not-affected (`failed` only when the sandbox cannot be created).

Installs run the repo's own package manager release, so a lockfile the harness or the agent
rewrites keeps its format and the PR's lockfile diff holds only real dependency changes: the
`packageManager` field first, else the release the lockfile's format implies (npm 6 for a v1
`package-lock.json`, npm 8 for v2, pnpm and yarn by their lockfile versions). npm runs through
`npx -y npm@<release>`, pnpm and yarn through corepack; the Docker image has no pnpm of its own. The
kickoff message names the release and the command for dependency changes, and the `diff` tool shows
the agent its change per file before it finishes. On commitgpt's openai v3 → v4 bump the lockfile
diff went from 683 lines (the image's npm 10.9) to 643 (npm 8, no new `license` lines).

The loop has no fixed iteration cap. It ends when the checks pass and the rescan is clean, when the
agent finishes with an explanation of what still fails after hearing about it once, or when the
dollar cap is reached. Checks the detection misses can be
registered by the agent with `run_checks` `add`. They run on an untouched copy for the baseline and
count toward proof.

For a task with no list (`harness/evaluation/`, the changelog path), the outcome is **verified** when the agent changed code, called `finish`, at least one check ran, no
check has a failure it didn't have before, every provider validator it claims is backed by a
passing ToolPack call the harness recorded (`validators.ts`), and its own test of the change passes.
What the agent lists as unproven goes to the PR for the reviewer and does not change the outcome.
A check that newly fails after the change runs once more, and its failure counts only if it repeats.
Limits no run can get past, such as the sandbox having no credentials for live API calls, are stated
in every PR by the sandbox note rather than listed.
Otherwise **needs-review**. A query stops the moment its metered spend reaches its grant, so it
overshoots by at most the model call in flight; the Agent SDK's own `maxBudgetUsd`, which it checks
only between turns, stays as a second guard. `TURN_RESERVE_USD` is held back for that call.

Spend is charged live: the session meters each model call from its stream events (input and cache
tokens when the call starts, output when it ends) and charges the ledger at once; the SDK's total at
the end of each query adds only what the stream did not show. Pass `chargeRun(usd, label)` in
`HarnessDeps` and every ledger charge reaches the run budget as it happens, so a run that throws has
already reported what it spent. `record.costUsd` is the same money: count one or the other, not both.

Real-repo tasks for hand-checking live in `evaluation/`; `scripts/run-evaluation.ts` runs them under
one batch cap. One run by hand (writes `transcript.jsonl`, `diff.patch`, `pr-body.md`, `record.json`):

```sh
APTITUDE_AI_BUDGET_USD=5 node harness/scripts/run-task.ts task.json /path/to/clone ./out
```
