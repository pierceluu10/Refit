# orchestrator

Refit's end-to-end loop. For each repo it runs inventory → watch → match → "what's behind" report →
harness → PR → record, for API changes and for every other external change (runtimes, frameworks,
libraries, advisories, AI models, images, CI, Kubernetes, serverless, platforms and rules). Every
change ends as an attempted task or a recorded verdict.

| File                | What it does                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `index.ts`          | `runRepoJob` and `scanRepo`, the app's entry points; `createRunRepoJob`, `createScanRepo` |
| `loop.ts`           | `runOrg`, `runRepo` and `scanTarget`: watching, matching, attempts, PRs, records, audits  |
| `scan.ts`           | The external half: dependencies, their watchers, rules, the report rows                   |
| `external-match.ts` | The match agent for external changes, its hints, ranking and task shaping                 |
| `match.ts`          | The match agent for API changes                                                           |
| `deps.ts`           | `createDeps`, the one place that picks real or stub parts and gives each its budget       |
| `budget.ts`         | The run budget: one cap, shared through holds                                             |
| `agent-sdk.ts`      | A second match transport, on the Claude Agent SDK, that can read the code                 |
| `queue.ts`          | An in-process queue with concurrency and retries, behind a replaceable interface          |
| `stubs.ts`          | Offline stand-ins for the API path                                                        |
| `stubs-external.ts` | Offline stand-ins for the external path, and `asMigrationTask`                            |
| `cli.ts`            | `refit scan` and `refit run`                                                              |
| `fixtures/`         | Illustrative changes and usages, and `samples/`: stand-ins for the three demo repos       |

## CLI

```sh
node orchestrator/cli.ts scan --repo <path> [--repo <path> ...] [--out report.json]
node orchestrator/cli.ts run --repo <path> [--repo <path> ...] [--dry-run] [--out runs.jsonl]
```

`scan` prints the "what's behind" table (deadline, severity, dependency, version → target, status,
change), then each not-affected verdict with its reason, then anything that could not be read. It
never opens a PR. `run` does the same and attempts every task; `--dry-run` stops before PRs.

## For the app: `runRepoJob` and `scanRepo`

```ts
import { runRepoJob, scanRepo } from '../orchestrator/index.ts';

const records = await runRepoJob({ repo: 'owner/name', dir: checkout, openPullRequest });
const { report, tasks } = await scanRepo('owner/name', checkout);
```

- `dir` is a fresh checkout. The orchestrator only reads it; repo code runs only in the harness sandbox.
- `scanRepo` returns the `ScanReport` and every task, API ones included (`change.dependencyKind`
  `'api'`), most urgent first. Report rows carry two extra fields: `taskId`, and `reason`, the
  match agent's words for why a row is open, merged into another task, or not affected.
- `openPullRequest(task, record, dir)` is called once for each task that ends verified or
  needs-review with a diff, unless `dryRun` is set. For an external task the `task` is in the API
  shape (`asMigrationTask`): its `change.kind` is `'other'` when the kind is new in the MVP, and its
  notes and `dependencies` field carry the external change and every place it is declared.
- After a run, the repo's report is saved with each row's PR (`status: 'pr-open'`) under
  `$TMPDIR/refit-reports/`.
- Every job in one process shares **one** run budget, `REFIT_AI_BUDGET_USD`, and one queue.
- With `ANTHROPIC_API_KEY` set, it needs `REFIT_AI_BUDGET_USD` and refuses to start without it.
  Without the key, offline stubs stand in for every AI part.

## The external path

1. **Inventory.** P2's `runDependencyInventory` with P5's surfaces on the same ledger, once per scan.
   The API path and the external path share its result. What it could not read reaches the report's
   errors. Without a key, a manifest reader in `stubs-external.ts` stands in and says so in each
   dependency's notes.
2. **Watch.** F1's `watchDependency` for every dependency, once per org run; it hands platforms and
   infrastructure to F3. An API or SDK the usage map names is read on the API path instead, so no
   changelog is paid for twice. O5's `watchRegulations` runs once per run and `obligationsToChanges`
   per repo, and the obligations are stored for the Platforms and rules view. Rules come first, then
   surfaces, so a small cap does not lose them to the libraries.
3. **Match.** `external-match.ts`: one agent call per repo reads every change against every
   dependency and call site. Name and version overlap, the companions a runtime moves with, and days
   to the deadline go in as hints. Every change comes back as a task or a not-affected reason; one
   with no verdict is still attempted.
4. **Shape.** One task per change per repo. Changes that move the same dependency to the same target
   (Node 18's end of life and the node:18 image's) become one task, and the second row points at it.
   A runtime task lists the base image, version files and CI lines that move with it.
5. **Rank.** Deadline first, then severity (security first), then the agent's impact.
6. **Attempt.** O2's `runExternalTask` on its own hold of the run budget, charging it as it spends.
7. **Audit.** O5's `recordAudit` at detected, matched, not-affected and pr-opened. A failing audit
   store shows up in the errors and never stops the run.

## The run budget

The cap is shared through holds. A part holds its share before it runs and settles to what it spent
when it ends, so parts that run at once never spend the same remainder, and spend plus holds never
passes the cap. A part that cannot get its minimum waits while other holds are open, and is refused
once none could free enough. Prices come from `shared/models.ts`, so no model is priced as another.
`refit scan` logs what each part spent.

| Part                     | Holds                                                            | Notes                                         |
| ------------------------ | ---------------------------------------------------------------- | --------------------------------------------- |
| One read                 | Up to `WATCH_USD` ($1.50), plus $0.20 kept for a match call      | Cached per UTC day with what it couldn't read |
| One inventory            | Up to $2.20, or half of a small run                              | P2 and P5 on one ledger                       |
| One match call           | Its worst case, or room for 6,000 output tokens near the cap     | API: up to `MATCH_BATCH` (50) changes         |
| One task                 | Up to `TASK_USD` ($5), or a quarter of what is free in a big run | Starts only with `MIN_TASK_USD` ($2) free     |
| Learning from an attempt | `MEMORY_USD` ($1)                                                | Records with no attempt hold nothing          |

Each part gets the hold as its own ledger's cap, so no budget is counted twice.

## Watching API providers

Every provider folder in `providers/` is read once per org run, as a head start. After a repo's
inventory, every provider in its usage map with no folder gets its own watcher, led by the usage's
`hints` and SDK package names. That watcher is `anyProviderWatcher` from `providers/core/any-watcher.ts`.

## Real match run

```sh
REFIT_AI_BUDGET_USD=3 ANTHROPIC_API_KEY=... node orchestrator/match-real.ts --external
```

Runs the external match agent on the three sample repos against every fixture change.
