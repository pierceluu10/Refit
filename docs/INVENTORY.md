# Repository inventory

When the Refit GitHub App is installed, the hosted worker (`refit hosted serve`) takes a read-only inventory of every repository the installation can read, whether or not anyone approved Refit for it. The inventory records every API vendor in the vendor catalog the repository uses (from manifests and lockfiles of every ecosystem, raw API hostnames and vendor environment variable names), how Refit can serve each one, which vendors become watch targets, which API versions and AI models it pins, and which registry deadlines it is exposed to. It is the starting point for monitoring and reports.

An inventory never runs repository code: no dependency install, no Docker, no AI and no request to a provider. It never enrolls a repository either. Scanning and validation still run only for repositories with a stored approval (see [hosted onboarding](HOSTED-ONBOARDING.md)).

## When it runs

- **Install.** An `installation` delivery that lists repositories (such as `created`) or an `installation_repositories` `added` delivery queues an inventory for each repository it names.
- **Backfill.** Each worker pass queues any installed repository of an active installation that has no inventory yet, such as one installed while the worker was down.
- **Operator.** `refit hosted inventory --repository <owner/name>` queues one and prints the stored inventory as JSON. The running worker takes it within its polling interval (`--interval`, 300 seconds by default).

Queued inventories run before the next validation job, one at a time per worker, oldest request first. A request for a repository whose inventory is running is queued again when that run ends.

Only installations of allowed accounts (`REFIT_HOSTED_ACCOUNTS`, by default `REFIT_HOSTED_OWNER` alone; see [hosted tenancy](HOSTED-TENANCY.md)) are inventoried. Other accounts' installations are recorded as not allowed, and nothing is queued or cloned for them; allowing the account later backfills their inventories on the next pass. Each installation takes at most `REFIT_HOSTED_DAILY_INVENTORIES` (default 500) inventories per UTC day, counting every one a worker takes, including those that find the revision unchanged; reclaiming a crashed worker's lease does not count again. Requests over the cap stay queued until the next day, and `/status` lists `daily-inventory-cap` among that installation's refusals.

## How it runs

1. The worker confirms through the GitHub API that the App can read the repository and that it still belongs to the same installation, and reads its default branch and size.
2. It reads the default branch's head commit. If the stored inventory was taken at that commit against the same deadline registry, vendor catalog and inventory format, nothing is fetched or scanned: only `checkedAt` changes.
3. Otherwise it makes a fresh App-managed checkout (`git fetch --depth=1` of that commit, hooks, global configuration and submodules disabled) in a new directory under the worker's state directory, measures it, scans it and deletes it. No repository code is kept after the inventory.

## Limits and stops

An inventory that hits a limit ends with `status: "stopped"`, a named `stop` and a `message`, and stores no new findings: the last complete inventory, if any, stays in place with its `inventory_revision`.

| Stop                   | When                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unavailable`          | GitHub reports the repository archived or disabled, its identity does not match, or it now belongs to another installation.                                                             |
| `empty`                | The default branch has no commit (GitHub answers 409 or 404).                                                                                                                           |
| `repository-too-large` | GitHub's `size` for the repository is over 1,000,000 KB. Checked before fetching; GitHub's size includes history, so this is a coarse cap.                                              |
| `checkout-too-large`   | The checked-out files (outside `.git`) are over 50,000 files or 512 MiB.                                                                                                                |
| `unreadable`           | A scanner refused the files: Refit's scan limits (10,000 source files, 2 MiB per file, 50 MiB total), a malformed manifest or lockfile, or a file importing an SDK that does not parse. |
| `timeout`              | The whole inventory took longer than 300 seconds. The cap is checked between steps, so one long step (a fetch is capped at 60 seconds) can overrun it.                                  |

Other failures (GitHub or Git errors) are recorded in `error` with the previous inventory left in place, and are not retried until the repository is requested again. With `refit hosted serve --job-processes`, each inventory runs in its own forked `refit hosted inventory` process, so a scan that holds the CPU (the TypeScript analysis of a repository with thousands of files can take minutes in one step) no longer blocks the worker. If the process has not reported 10 seconds after the 300-second cap, the worker sends it SIGTERM and, 10 seconds later, SIGKILL, and records `JobProcessError: Inventory took longer than 300 seconds and did not stop by itself; its process was stopped.` in `error`, so it waits for the next request like any other failure. Without `--job-processes` the inventory runs inside the worker as before, and a step that holds the CPU overruns the cap. A worker that crashes mid-inventory leaves its lease to expire (the time cap plus 60 seconds); another worker reclaims it, at most three times.

## What it stores

PostgreSQL table `refit_inventories`, one row per installed repository, created by hosted migration 5 (`pipeline/hosted-migrations.ts`). It holds file paths, line numbers, identifiers and counts, never a line of source:

| Column                                                   | Meaning                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `installation_id`, `repository`                          | The installed repository. The row references `refit_installation_repositories`: it is renamed with it when the repository or account is renamed (migration 7) and deleted with it when the repository is removed; uninstalling the App deletes the installation's rows at once. |
| `state`, `requeue`, `requested_at`                       | `queued`, `running` or `idle`, and whether a request arrived while running.                                                                                                                                                                                                     |
| `lease_owner`, `lease_expires_at`, `attempts`            | The worker holding a running inventory.                                                                                                                                                                                                                                         |
| `checked_at`, `error`                                    | When a worker last looked at the repository, and the last failure (null after a success).                                                                                                                                                                                       |
| `base`, `revision`, `registry`                           | The default branch, the commit scanned and a digest of what it was matched against: the deadline registry, the vendor catalog and the inventory format.                                                                                                                         |
| `status`, `stop`, `message`, `scanned_at`, `duration_ms` | The stored result: `complete` or `stopped`, and when and how long the scan took.                                                                                                                                                                                                |
| `inventory`, `inventory_revision`                        | The inventory JSON of the last complete scan and the commit it was taken at; a later stop leaves both in place.                                                                                                                                                                 |

The inventory JSON (`formatVersion: 2`; version 1 had no `status`, `watch`, `references` or `vendorScan`) has these fields:

- `providers`: each catalog vendor detected (see [Vendor detection](#vendor-detection)), with `agent` (whether Refit ships a reviewed agent), its label in `status`, its `watch` target or the reason it is unwatched, each declaring manifest's `packages` (`file`, `name`, declared `version`, `locked` version from a supported lockfile or null, and `ecosystem` outside npm), up to five `hostnames` lines in JavaScript and TypeScript, and up to five `references` (`file`, `line`, `kind`: `env` or `hostname`, and the `name`) in other source and configuration files.
- `vendorScan`: how many files the environment-name and hostname scan read, and whether it stopped at its limits (20,000 files, 1 MiB per file, 64 MiB in all), which leaves later files unread.
- `integrations`: the integrations a committed `.refit.json` configures, with their catalog agent and `apiVersion`.
- `apiVersions`: Stripe API versions the code sets on a client or request (`kind`), as a literal `value` or `status: "unknown"` when computed. Requests that inherit their client's version are left out. Other providers' pins appear only through deadlines.
- `deadlines`: the deadline scan from [API deadlines](DEADLINES.md#the-registry): `exposures` (deadlines with live evidence) and `mentions` (named only in tests, comments, catalogs, tokenizers or checks), each with the registry entry, `days` left at scan time, up to 20 evidence locations per use (`file`, `line`, `kind`, `use` and the matched version; the source line itself is dropped), and exact counts.
- `ignores`: the committed `.refit-deadlines-ignore.json` (see [API deadlines](DEADLINES.md)) as parsed `entries`, so monitoring can honour them without a checkout. An invalid file keeps its `error` and no entries: it accepts nothing.
- `models`: OpenAI and Anthropic text-generation calls traced by Refit's analyzer (the calls model fixes cover: chat completions, responses and messages), with the `model` when it is a string literal in the call (null when computed) and `test` for test and fixture files. Embeddings, image, audio and Gemini calls are not listed, and models set through constants or helpers show as null.

`GET /status` lists every row with a `summary` in place of the full inventory: provider IDs, `vendors` (each with its label and whether it is watched; null for a version 1 inventory until it is scanned again), exposed deadline IDs with their date and live-evidence count, mentioned deadline IDs, Stripe API versions, literal models outside tests and the number of model calls. `/status?target=<id>` lists only that target's repository. `refit hosted inventory` prints the full row. Without `target`, `/status` also lists `watch`: whether captures are on and every watch target with its sources, last capture and the repositories whose latest inventory detected the vendor.

## Vendor detection

Detection is generic code over catalog data: the reviewed provider agents in `pipeline/agent-catalog.ts` and the vendors in `data/vendor-catalog.json`, where every package list, hostname, environment variable name, OpenAPI document and changelog page carries the page it was read from and the day it was checked (`node scripts/vendor-catalog-check.mjs` reads every source again). It reads, without running anything:

- **npm, pnpm and yarn** `package.json` declarations, with the locked version from `package-lock.json`, `pnpm-lock.yaml` or `yarn.lock` (a workspace package's own lockfile when the root's does not cover it).
- **Other ecosystems' manifests and lockfiles:** Python (`requirements*.txt`, `pyproject.toml`, `Pipfile`, `Pipfile.lock`, `poetry.lock`, `uv.lock`), Go (`go.mod`, `go.sum`), Ruby (`Gemfile`, `gems.rb`, `*.gemspec`, `Gemfile.lock`), and PHP, Java and .NET manifests (`pipeline/package-manifests.ts`).
- **Raw API hostnames:** in JavaScript and TypeScript through the existing hostname and request scans, and in source and configuration files of other languages and env templates. A hostname counts only standing alone: `api.example.com` is not found in `api.example.com.evil.net`.
- **Vendor environment variable names:** such as `OPENAI_API_KEY` or `TWILIO_AUTH_TOKEN`, in any source or configuration file and in env templates (`.env.example` and the like). A name must stand alone (`AZURE_OPENAI_API_KEY` is not `OPENAI_API_KEY`), and the catalog refuses names made only of generic parts such as `API_KEY`.

Tests (by each runner's naming), lockfiles, installed packages, build output, minified files and prose (Markdown) are skipped: a vendor named in a README or a test mock is not one the code uses.

Each detected vendor gets one label (`status`):

| Label              | `status`          | When                                                                                                                                                |
| ------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| configured         | `configured`      | A committed `.refit.json` integration already uses this vendor's agent.                                                                             |
| agent available    | `agent-available` | Refit ships a reviewed agent and an npm manifest declares the SDK, so `refit agents --add <id>` can add it.                                         |
| report only        | `report-only`     | Refit ships an agent, but the evidence is outside npm manifests (another ecosystem, environment names, hostnames outside JS/TS) and is never added. |
| detected, no agent | `no-agent`        | Refit has no reviewed agent for the vendor yet.                                                                                                     |

A vendor whose catalog entry names an OpenAPI document or changelog pages is `watched`; the others are `unwatched` with the reason. Every complete inventory registers a row in `refit_watch_targets` (hosted migration 12) for each watched vendor: the provider and its public sources, never anything about the repository. With `REFIT_HOSTED_WATCH=1` (off by default) the worker captures one due target per pass, at most once a day per target, with the same capture `refit watch` uses, and keeps each source's content hash, the time a hash last changed and whether a source failed. Registering or capturing a target never enrolls, approves or edits a repository: enrollment still needs the approval in [hosted onboarding](HOSTED-ONBOARDING.md).

### Detection precision and recall

Measured on 2026-10-27 with `node scripts/vendor-detection-benchmark.mjs` over 26 real public repositories ([list](benchmarks/2026-10-27-vendor-detection-repos.json), [labels](benchmarks/2026-10-27-vendor-detection-labels.json), [results](benchmarks/2026-10-27-vendor-detection-results.json)), each cloned at its labelled commit, scanned and deleted. The unit is one (repository, vendor) pair; pairs the labellers marked uncertain count neither way.

**The labels are AI-assisted, not hand labels.** Two fresh-context labelling agents read every repository blind to Refit's code, catalog and output, and nobody second-labelled them. Batch a (13 repositories) was read only after the catalog was written and is the held-out score; batch b's vendor summary was seen while the catalog was drafted.

| Set                | Repositories | True positives | False positives | Missed (in catalog) | Labelled outside the catalog | Precision | Recall, catalog vendors | Recall, all vendors |
| ------------------ | -----------: | -------------: | --------------: | ------------------: | ---------------------------: | --------: | ----------------------: | ------------------: |
| Held out (batch a) |           13 |             52 |               3 |                  13 |                           35 |     0.945 |                   0.800 |               0.520 |
| Batch b            |           13 |             25 |               2 |                   1 |                            8 |     0.926 |                   0.962 |               0.735 |
| All                |           26 |             77 |               5 |                  14 |                           43 |     0.939 |                   0.846 |               0.575 |

- **False positives (5).** Three are `next-auth`, a library Refit has an agent for but not a hosted vendor under the labels' unit; one is a Slack token name in a built-in tool configuration, and one is `graph.facebook.com` in an OAuth route the labellers did not count.
- **Misses in the catalog (14).** Vendors reached through another vendor's client or a generic one: Azure OpenAI through the `openai` package (2), `@aws-sdk/*` packages the AWS entry does not list (3), the Vercel AI SDK's `@ai-sdk/openai` and `@ai-sdk/google` (2), Cloudflare R2 and Turnstile (2), and one each for Discord and Slack webhooks, a Facebook GraphQL scraper, GitHub Models and Hugging Face dataset hosts. The catalog was not tuned on these misses, so the held-out score stays held out.
- **Outside the catalog (43).** Vendors the labellers found that the catalog does not list yet; they count against "recall, all vendors" only.
- The hostname and environment-name fixes in this branch (longer domains, generic names) changed no score.

### Demo on GitHub Actions

DEMO_PLACEHOLDER

## Sample: 28 frozen list entries, 25 repositories

`scripts/inventory-sample.mjs` runs the same `inventoryDirectory` the worker uses (measure, then scan) on a local shallow clone at each repository's recorded commit, then deletes the clone. It has no GitHub App, so the steps before the checkout (access, size and head checks) are not part of it. The run on 2026-10-22 took the first 10 repositories of the OpenAI application, Anthropic application and Stripe frozen lists at Refit commit `863cb34` ([results](benchmarks/2026-10-22-inventory-sample-results.json)). It ran on a laptop shared with other benchmark lanes, so the times are indicative only, and each time includes measuring the checkout twice (once for the report). Two of the Anthropic list's first 10 were removed on 2026-10-22 with the 12 repositories in that list that are copies of leaked proprietary Claude Code source, and every number below was recomputed on the remaining 28 entries.

| List (first 10)                | Completed | Scan median | Scan max | Repositories with a live deadline exposure | Traced model calls (repositories) |
| ------------------------------ | --------- | ----------- | -------- | ------------------------------------------ | --------------------------------- |
| OpenAI applications (10-21)    | 10        | 5.5 s       | 80.6 s   | 4                                          | 52 (9)                            |
| Anthropic applications (10-21) | 8         | 8.1 s       | 91.7 s   | 6                                          | 17 (5)                            |
| Stripe (10-14)                 | 10        | 1.5 s       | 6.3 s    | 4                                          | 6 (1)                             |

- Three repositories appear in both AI application lists at the same commit, so the 28 entries are 25 distinct repositories; the bullets below count each once. All completed; none hit a cap or stop. Across the 25 the median scan took 3.5 s; the slowest (9,138 files, 143 MiB checked out) took 92 s, under a third of the 300-second cap. It was also the largest checkout, against the 512 MiB cap.
- Providers: every Stripe repository was detected as Stripe, five also as OpenAI. All 15 distinct application repositories were detected as OpenAI, and 13 as Anthropic too; Gemini appeared in 9 and Meta Graph in 2. Only Stripe pins were found in code: `2022-11-15` (2), `2023-10-16` (2) and `2026-01-28.clover` (1).
- Deadlines: 13 repositories had live exposures, most often `openai-2026-10-23-gpt-3-5-turbo` (5) and `openai-2026-10-23-gpt-4` (4), then `anthropic-2026-04-20-claude-3-haiku`, `anthropic-2026-06-15-claude-sonnet-4` and `openai-2027-02-26-whisper-1` (3 each). Five more had only mentions (tests, comments, catalogs).
- Models: 12 repositories had traced text-generation calls (63 calls), but only 3 pass the model as a string literal in the call; 9 compute it (a variable, an environment fallback or a helper), so their calls show `model: null`. The deadline scan still catches literal model names elsewhere in those repositories.

## Not covered yet

- Code analysis (traced SDK calls, API versions, models) outside JavaScript and TypeScript; other languages are detected from manifests, hostnames and environment names only.
- Vendors outside the catalog, and raw HTTP hosts beyond the catalog's hostnames and `data/api-hosts.json`.
- Vendors used only through a generic client (for example the Azure OpenAI client of the `openai` package, or `@aws-sdk/*` packages the AWS entry does not list); see the misses above.
- Re-inventory on push or on a schedule: a new commit is picked up when the repository is requested again (install delivery or the operator command).
- Scanner changes outside the catalog and format: an inventory taken by an older Refit is kept until the revision, the registry, the vendor catalog or the inventory format changes.
