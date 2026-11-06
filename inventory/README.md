# inventory

Refit's codebase-understanding agent (P2). `inventoryRepo(repoDir, repo)` returns `ApiUsage[]`:
every external API the repository talks to, its channel (SDK, HTTP, GraphQL, webhook), the pinned
version and where it lives, and every call site with what it sends and what the code does with the
response.

## How it works

- `agent.ts` runs a Claude agent on the Claude Agent SDK (`claude-sonnet-5-5`). The model decides
  what to read, follows clients and wrappers across files, and decides when it is done. On large
  repositories it maps the repo and dispatches `area-reader` subagents (`claude-haiku-5-5`) in
  parallel, then reviews and merges what they recorded.
- `prompt.ts` holds all the guidance: what counts as an external API, how to hunt for usage no
  scanner knows, how to record. Versioned with `PROMPT_VERSION`.
- `tools.ts` is the whole tool surface: read-only file tools confined to `repoDir`
  (`repo-files.ts`), the fast scanners (`scanners.ts`), and `record_usage`. No shell, no writes, no
  network. Scanners return raw signals; known-SDK lists are hints only.
- `collector.ts` checks every recorded file and line against the file and returns the line text, so
  the agent corrects wrong lines itself.
- `hints.ts` checks the `hints` the agent records with each usage (`ProviderHints`: `packages`,
  `hosts`, `docsUrls`). These tell the watchers where to look for a provider's changes, including
  providers with no folder in `providers/`. Only the shape is checked (bare hostnames, absolute
  http(s) URLs without credentials, package names without spaces); malformed values come back to
  the agent with a reason, and accepted ones are normalised, de-duplicated and merged across calls.
  `package_links` gives the agent an installed package's homepage, repository and issue links
  (`node_modules/*/package.json`, `.venv`/`venv` METADATA); a fresh checkout usually has neither.
  Which hints to record is the agent's call, guided by `prompt.ts`. Hints are unmeasured on real
  repositories: the `EVALUATION.md` runs predate them.
- `budget.ts` is the hard dollar cap. Runs fail closed without `REFIT_AI_BUDGET_USD`, and every
  run's cost is appended to `REFIT_SPEND_LOG` as a JSON line.

Watchers should read `usage.hints` as leads, not facts: `packages` to look up registry releases,
`hosts` to match a provider's API surface, `docsUrls` (often a source repository) to read docs,
changelogs and GitHub releases. Any field can be missing.

## Every dependency

`inventoryDependencies(repoDir, repo)` returns `DependencyUsage[]`: language runtimes, frameworks,
libraries, AI models, APIs and SDKs, container images and CI versions, each with every place its
version is declared. `runDependencyInventory` is the same run with the whole report.

- **One run, both answers.** The report holds `dependencies` and `usages` (the same `ApiUsage[]` as
  `inventoryRepo`), so a caller that needs both should call `runDependencyInventory` once rather
  than pay for two agents. It also holds `errors`, for `ScanReport.errors`.
- **The agent decides.** `scanners-platform.ts`, `scanners-libraries.ts` and `scanners-models.ts`
  give it leads and `prompt.ts` holds the guidance. It records with `record_dependencies`;
  `dependency-collector.ts` checks each location against the file and keeps that line's real text.
- **Entries.** One per kind, name, ecosystem, version and package, so places that disagree on a
  version stay separate, and each monorepo package that declares its own version has its own entry.
- **Two fields beyond the contract.** `DependencyFinding` is a `DependencyUsage` plus `hints`
  (`ProviderHints`, for F1's watchers) and `package` (the monorepo directory). `shared/types.ts` is
  outside this folder, so they aren't on `DependencyUsage` yet; adding them there is additive.
- **APIs and SDKs.** `dependency-merge.ts` folds the API inventory in: an SDK's call sites and hints
  join its package's entry, and a pinned version or raw HTTP use adds an `api` entry.
- **Surfaces.** P5's `inventorySurfaces` results are added from `surfaces/index.ts`. If that module
  is missing or fails, the inventory is kept and `errors` says so.
- **Secrets.** The report is passed through `redactSecrets`, and a committed env file only ever
  contributes its key names.

`evaluation/scanner-gap.ts` measures what the agent found that no scanner pointed at. It plays no
part in a run.

## Run it

```sh
REFIT_AI_BUDGET_USD=1 REFIT_SPEND_LOG=~/.refit/spend.jsonl \
  node inventory/cli.ts <repoDir> <owner/name> --out <dir> --run-cap 0.4
```

Writes `<owner__name>.json` (the report), `.txt` (the human summary) and `.transcript.jsonl`.
Add `--dependencies` for the dependency inventory, which also writes `.scanner-gap.json`.
Point `--out` outside the repository being read. Unit tests use a scripted fake model and cost $0.

See `EVALUATION.md` for the 10-repo evaluation.
