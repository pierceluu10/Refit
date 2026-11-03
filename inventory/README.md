# inventory

Refit's codebase-understanding agent (P2). `inventoryRepo(repoDir, repo)` returns `ApiUsage[]`:
every external API the repository talks to, its channel (SDK, HTTP, GraphQL, webhook), the pinned
version and where it lives, and every call site with what it sends and what the code does with the
response.

## How it works

- `scan.ts` runs first, with ordinary code and no AI. It reads the manifests, lockfiles, imports
  and API hosts.
  - For a known SDK (`catalog.ts`) that is imported, made into a client and called, it builds the
    `ApiUsage` itself. That includes a client the repo exports, or makes in its own
    `createClient()`-style factory, and uses in other files. It also does this for a fetch to a
    known API host.
  - Everything it can't settle becomes a lead:
    - dependencies it doesn't know;
    - files that import an SDK where it saw no call;
    - HTTP calls to unknown hosts or runtime URLs;
    - unknown hosts;
    - service-like env names;
    - GraphQL;
    - webhook signals;
    - other languages.
  - The catalog is a shortcut, never a gate: an unknown package or host always goes to the agent.
- The agent then starts with the scan's usages recorded and its leads in the task prompt
  (`scanEvidence`). It settles the leads and hunts for what no scan sees. It always runs, so the
  scan is never the only way usage is found.
- `cache.ts` keeps a finished report by repo, commit and `INVENTORY_VERSION` (prompt plus scan),
  for clean git checkouts only. An unchanged repo then costs $0. The folder is
  `REFIT_INVENTORY_CACHE`, default `$TMPDIR/refit-inventory`, or `cacheDir: false` for none.
- `agent.ts` runs the Claude agent on the Claude Agent SDK (`claude-sonnet-5-5`). The model decides
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

## Run it

```sh
REFIT_AI_BUDGET_USD=1 REFIT_SPEND_LOG=~/.refit/spend.jsonl \
  node inventory/cli.ts <repoDir> <owner/name> --out <dir> --run-cap 0.4
```

Writes `<owner__name>.json` (the report), `.txt` (the human summary) and `.transcript.jsonl`.
Point `--out` outside the repository being read. Unit tests use a scripted fake model and cost $0.

See `EVALUATION.md` for the 10-repo evaluation.
