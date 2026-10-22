# Repository inventory

When the Refit GitHub App is installed, the hosted worker (`refit hosted serve`) takes a read-only inventory of every repository the installation can read, whether or not anyone approved Refit for it. The inventory records which provider SDKs a repository declares, which API versions and AI models it pins, and which registry deadlines it is exposed to. It is the starting point for monitoring and reports.

An inventory never runs repository code: no dependency install, no Docker, no AI and no request to a provider. It never enrolls a repository either. Scanning and validation still run only for repositories with a stored approval (see [hosted onboarding](HOSTED-ONBOARDING.md)).

## When it runs

- **Install.** An `installation` delivery that lists repositories (such as `created`) or an `installation_repositories` `added` delivery queues an inventory for each repository it names.
- **Backfill.** Each worker pass queues any installed repository of an active installation that has no inventory yet, such as one installed while the worker was down.
- **Operator.** `refit hosted inventory --repository <owner/name>` queues one and prints the stored inventory as JSON. The running worker takes it within its polling interval (`--interval`, 300 seconds by default).

Queued inventories run before the next validation job, one at a time per worker, oldest request first. A request for a repository whose inventory is running is queued again when that run ends.

Only installations of allowed accounts (`REFIT_HOSTED_ACCOUNTS`, by default `REFIT_HOSTED_OWNER` alone; see [hosted tenancy](HOSTED-TENANCY.md)) are inventoried. Other accounts' installations are recorded as not allowed, and nothing is queued or cloned for them; allowing the account later backfills their inventories on the next pass. Each installation takes at most `REFIT_HOSTED_DAILY_INVENTORIES` (default 500) inventories per UTC day, counting every one a worker takes, including those that find the revision unchanged; reclaiming a crashed worker's lease does not count again. Requests over the cap stay queued until the next day, and `/status` lists `daily-inventory-cap` among that installation's refusals.

## How it runs

1. The worker confirms through the GitHub API that the App can read the repository and that it still belongs to the same installation, and reads its default branch and size.
2. It reads the default branch's head commit. If the stored inventory was taken at that commit against the same deadline registry, nothing is fetched or scanned: only `checkedAt` changes.
3. Otherwise it makes a fresh App-managed checkout (`git fetch --depth=1` of that commit, hooks, global configuration and submodules disabled) in a new directory under the worker's state directory, measures it, scans it and deletes it. No repository code is kept after the inventory.

## Limits and stops

An inventory that hits a limit ends with `status: "stopped"`, a named `stop` and a `message`, and stores no findings.

| Stop                   | When                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unavailable`          | GitHub reports the repository archived or disabled, its identity does not match, or it now belongs to another installation.                                                             |
| `empty`                | The default branch has no commit (GitHub answers 409 or 404).                                                                                                                           |
| `repository-too-large` | GitHub's `size` for the repository is over 1,000,000 KB. Checked before fetching; GitHub's size includes history, so this is a coarse cap.                                              |
| `checkout-too-large`   | The checked-out files (outside `.git`) are over 50,000 files or 512 MiB.                                                                                                                |
| `unreadable`           | A scanner refused the files: Refit's scan limits (10,000 source files, 2 MiB per file, 50 MiB total), a malformed manifest or lockfile, or a file importing an SDK that does not parse. |
| `timeout`              | The whole inventory took longer than 300 seconds. The cap is checked between steps, so one long step (a fetch is capped at 60 seconds) can overrun it.                                  |

Other failures (GitHub or Git errors) are recorded in `error` with the previous inventory left in place, and are not retried until the repository is requested again. A worker that crashes mid-inventory leaves its lease to expire (the time cap plus 60 seconds); another worker reclaims it, at most three times.

## What it stores

PostgreSQL table `refit_inventories`, one row per installed repository, created by `pipeline/inventory-store.ts`:

| Column                                                   | Meaning                                                                                                                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `installation_id`, `repository`                          | The installed repository. The row references `refit_installation_repositories` and is deleted with it, so removing the repository or uninstalling the App deletes it. |
| `state`, `requeue`, `requested_at`                       | `queued`, `running` or `idle`, and whether a request arrived while running.                                                                                           |
| `lease_owner`, `lease_expires_at`, `attempts`            | The worker holding a running inventory.                                                                                                                               |
| `checked_at`, `error`                                    | When a worker last looked at the repository, and the last failure (null after a success).                                                                             |
| `base`, `revision`, `registry`                           | The default branch, the commit scanned and a digest of the deadline registry it was matched against.                                                                  |
| `status`, `stop`, `message`, `scanned_at`, `duration_ms` | The stored result: `complete` or `stopped`, and when and how long the scan took.                                                                                      |
| `inventory`                                              | The inventory JSON for a complete scan.                                                                                                                               |

The inventory JSON (`formatVersion: 1`) has these fields:

- `providers`: each catalog provider detected from manifests or raw API hostnames, with `agent` (whether Refit ships a reviewed agent), each declaring manifest's `packages` (`file`, `name`, declared `version`, `locked` version from a supported lockfile or null) and up to five `hostnames` lines.
- `integrations`: the integrations a committed `.refit.json` configures, with their catalog agent and `apiVersion`.
- `apiVersions`: Stripe API versions the code sets on a client or request (`kind`), as a literal `value` or `status: "unknown"` when computed. Requests that inherit their client's version are left out. Other providers' pins appear only through deadlines.
- `deadlines`: the deadline scan from [API deadlines](DEADLINES.md#the-registry): `exposures` (deadlines with live evidence) and `mentions` (named only in tests, comments, catalogs, tokenizers or checks), each with the registry entry, `days` left at scan time, up to 20 evidence lines per use, and exact counts.
- `ignores`: the committed `.refit-deadlines-ignore.json` (see [API deadlines](DEADLINES.md)) as parsed `entries`, so monitoring can honour them without a checkout. An invalid file keeps its `error` and no entries: it accepts nothing.
- `models`: OpenAI and Anthropic text-generation calls traced by Refit's analyzer (the calls model fixes cover: chat completions, responses and messages), with the `model` when it is a string literal in the call (null when computed) and `test` for test and fixture files. Embeddings, image, audio and Gemini calls are not listed, and models set through constants or helpers show as null.

`GET /status` lists every row with a `summary` in place of the full inventory: provider IDs, exposed deadline IDs with their date and live-evidence count, mentioned deadline IDs, Stripe API versions, literal models outside tests and the number of model calls. `refit hosted inventory` prints the full row.

## Not covered yet

- Languages other than JavaScript and TypeScript, and package manifests of other ecosystems.
- Raw HTTP hosts beyond the catalog's provider hostnames.
- Re-inventory on push or on a schedule: a new commit is picked up when the repository is requested again (install delivery or the operator command).
