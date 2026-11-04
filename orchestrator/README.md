# orchestrator

Refit's end-to-end loop. For each repo it runs inventory → watch → match → harness → PR → record,
and every change ends as an attempted task or a recorded verdict.

| File           | What it does                                                                        |
| -------------- | ----------------------------------------------------------------------------------- |
| `index.ts`     | `runRepoJob`, the app's entry point, and `createRunRepoJob` for explicit deps       |
| `loop.ts`      | `runOrg` and `runRepo`: watching, matching in batches, attempts, PRs, records       |
| `deps.ts`      | `createDeps`, the one place that picks real or stub parts and gives each its budget |
| `budget.ts`    | The run budget: one cap, shared through holds                                       |
| `match.ts`     | The match agent: changes and a usage map in, ranked tasks and verdicts out          |
| `agent-sdk.ts` | A second match transport, on the Claude Agent SDK, that can read the code           |
| `queue.ts`     | An in-process queue with concurrency and retries, behind a replaceable interface    |
| `stubs.ts`     | Offline stand-ins, and the stub for `anyProviderWatcher` until providers/ has it    |
| `cli.ts`       | `refit run --repo <path> [--repo <path> ...] [--dry-run] [--out <file>]`            |

## For the app: `runRepoJob`

```ts
import { runRepoJob } from '../orchestrator/index.ts';

const records = await runRepoJob({ repo: 'owner/name', dir: checkout, openPullRequest });
```

- `dir` is a fresh checkout. The orchestrator only reads it; repo code runs only in the harness sandbox.
- `openPullRequest(task, record, dir)` is called once for each task that ends verified or needs-review
  with a diff, unless `dryRun` is set. A PR that fails to open turns that record into `failed`.
- It returns every record: one per provider change the repo faced. A job that ends with errors and
  no records (the inventory and every watcher failed) throws with the errors instead of returning `[]`.
- Every job in one process shares **one** run budget, `REFIT_AI_BUDGET_USD`, and one queue, so jobs
  started together can never each spend the cap. Pass your own deps and cap to `createRunRepoJob`
  for a budget per org or per install.
- With `ANTHROPIC_API_KEY` set, it needs `REFIT_AI_BUDGET_USD` and refuses to start without it.
  Without the key, offline stubs stand in for every AI part.

## The run budget

The cap is shared through holds. A part holds its share before it runs and settles to what it spent
when it ends, so parts that run at once never spend the same remainder, and spend plus holds never
passes the cap. A part that cannot get its minimum waits while other holds are open, and is refused
once none could free enough.

| Part                     | Holds                                                            | Notes                                     |
| ------------------------ | ---------------------------------------------------------------- | ----------------------------------------- |
| One provider read        | `WATCH_USD` ($1.50)                                              | Cached per provider per UTC day           |
| One inventory            | inventory's `DEFAULT_RUN_CAP_USD` ($0.60)                        |                                           |
| One match call           | Its worst case                                                   | Up to `MATCH_BATCH` (50) changes per call |
| One task                 | Up to `TASK_USD` ($5), or a quarter of what is free in a big run | Starts only with `MIN_TASK_USD` ($2) free |
| Learning from an attempt | `MEMORY_USD` ($1)                                                | Records with no attempt hold nothing      |

A task's recipes come out of its own hold, from what it has above `MIN_TASK_USD`. A part whose spend
is unknown counts its whole hold as spent: a harness run or an inventory that throws, or a match
call that may have been billed. A harness that throws comes back as a failed record, so the queue
does not retry it and count its share again. A refusal from the run budget is never retried.

## Watching

Every provider folder in `providers/` is read once per org run, as a head start. After a repo's
inventory, every provider in its usage map with no folder gets its own watcher, led by the usage's
`hints` and SDK package names. That watcher is `anyProviderWatcher` from `providers/core/any-watcher.ts`;
until it lands, `stubs.ts` stands in and reports the provider as unwatched in the run's errors.
