# inventory/surfaces

Finds the parts of a codebase that platforms and rules apply to (P5 in `MVP-PLAN.md`).

```ts
import { inventorySurfaces } from './inventory/surfaces/index.ts';
const surfaces = await inventorySurfaces(repoDir, 'owner/name'); // DependencyUsage[]
```

Each result is a `DependencyUsage` with `kind` one of `platform`, `infrastructure`, `security-standard` or `regulated-surface`, every file and line it was found in (`declaredIn`, each line checked against the file and quoted in `text`), a `version` when something is versioned (`targetSdk`, `apiVersion`, a Lambda runtime, `manifest_version`), and `notes` saying why it matters. P2's `inventoryDependencies` merges these; O5 matches them against obligations; F3 watches the platforms.

## How it works

A Claude agent on the Agent SDK reads the repository with read-only tools and records what it finds. The agent decides what to read and what counts; the code only wires tools, budget and output.

| File           | What it does                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `agent.ts`     | The run: options, the budget check, spend recording, the report. Three specialist readers it can dispatch in parallel.     |
| `prompt.ts`    | All guidance: what counts as a surface, how to find and record it, each specialist's area.                                 |
| `tools.ts`     | `list_files`, `read_file`, `grep`, `find_surface_leads`, `record_surface`, `list_recorded_surfaces`, `remove_surface`.     |
| `scanners.ts`  | `find_surface_leads`: fast, noisy pointers by area (mobile and extension manifests, Kubernetes, serverless, TLS, auth, …). |
| `collector.ts` | Checks every location against the file, merges repeat reports. Never judges what is a surface.                             |
| `fixtures.ts`  | Illustrative reconstructions of the three sample repos (see below).                                                        |
| `cli.ts`       | One real run on a local checkout.                                                                                          |

The scanners are pointers, never gates: the agent is told they miss things and reads past them. There is no rule that decides a repo or file is unsupported. A run that crashes keeps what it recorded and reports the reason in `errors`; the entry point throws only when a failed run found nothing, so the caller can say why instead of showing an empty repo.

Hard limits: no shell, write or network tool; every path is confined to the repository (`../repo-files.ts`); every run needs `REFIT_AI_BUDGET_USD` or an explicit `BudgetLedger`, and a run gets at most $1 by default.

## Real run

```sh
REFIT_AI_BUDGET_USD=1 node inventory/surfaces/cli.ts ../demo-node-api refit-dev/demo-node-api --out inventory-out
```

## Fixtures

`fixtures.ts` holds reconstructions of `refit-dev/demo-node-api`, `demo-python-app` and `demo-next-web` written from `MVP-PLAN.md` section 5. The real repos are private and were not reachable when these were written. Tests find line numbers by text, so swapping in the real files only needs the expected surfaces updated.
