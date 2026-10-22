# Repository report

`refit report` prints one report of what a repository depends on and what is coming: its provider integrations, the registry deadlines its live code is exposed to, its AI model calls, provider hosts Refit does not track, and the next step. It is built only from Refit's existing scanners, the same ones the hosted [inventory](INVENTORY.md) uses, so it reads files only: nothing runs, installs, or contacts a provider.

```bash
refit report --repository . --format markdown
```

| Option                       | Effect                                                                    |
| ---------------------------- | ------------------------------------------------------------------------- |
| `--repository <root>`        | The repository to report on; the current directory by default.            |
| `--format markdown` / `json` | Markdown (default) fits a GitHub issue; JSON is the versioned form below. |
| `--registry <path>`          | Another deadline registry file instead of the bundled one.                |

The repository is named by its folder, and the commit is the checkout's `HEAD` when it is a Git repository.

## What it shows

- **Integrations.** Each provider Refit detects from package manifests, lockfiles and API hostnames: the package and the manifest that declares it, the declared range, the locked version when a lockfile has it, and the API versions the code pins (Stripe). For each provider, what Refit can do:

  | Refit                       | When                                                                                                                                                                            |
  | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Migrates breaking changes   | A reviewed agent covers the provider (`migrate`). The report says whether `.refit.json` configures it; otherwise the agent is available once added and the repository approved. |
  | Proposes model replacements | No agent, but Refit traces the provider's model calls (`model-fixes`): Anthropic. See `refit deadlines --propose-model-fixes`.                                                  |
  | Reports only                | Neither (`report-only`), such as Gemini, Meta Graph API, Twilio, SendGrid, Resend and PayPal.                                                                                   |

- **Deadlines.** Each [registry](DEADLINES.md) deadline the live code depends on, soonest first: date, days left counted from today, summary, replacement, source page, and the evidence lines (file, line and text). A deadline accepted by an active entry in the committed `.refit-deadlines-ignore.json` is marked as accepted; an expired entry or an invalid file accepts nothing. Deadlines named only in tests, comments, catalogs or tokenizers are listed by ID on one line.
- **AI model calls.** OpenAI and Anthropic text-generation calls grouped by model, with each call's file, line and SDK method. A model the code computes (a variable or an environment value) is grouped as "Computed model". Calls in tests are marked.
- **Hosts Refit does not track.** Hostnames of providers that have neither an agent nor registry deadlines, with where they appear.
- **Next step.** The first that applies:
  1. A model or API version past its date or within 30 days, soonest first; otherwise the soonest live deadline, including an SDK's end of support, which does not stop its requests. Within 30 days it says "Move off"; further out, "Plan to move off". It names the provider's replacement, points to `refit deadlines --propose-model-fixes` for OpenAI and Anthropic models, and counts the other deadlines that are past due or within 30 days. Accepted deadlines are skipped.
  2. A provider with an available agent that `.refit.json` does not configure: add it with `refit agents --add <id>` and approve the repository.
  3. Configured integrations: nothing to do now.
  4. Providers Refit only reports on: nothing to do now; Refit keeps watching them for deadlines.
  5. Nothing found.

## Markdown limits

The markdown is at most 60,000 characters, under GitHub's 65,536-character limit for an issue body. Each section lists at most 50 entries (providers, deadlines, model groups, untracked providers, mentioned deadline IDs), each deadline at most 5 evidence lines, each model at most 10 calls and each provider at most 10 package files, with a "…and N more" line for the rest. Evidence lines are cut at 160 characters. If the result is still longer, it is cut at the last whole line before the budget and ends with a note to run `refit report --format json`. Code is shown exactly: a code span uses a longer fence when the code contains backticks. The JSON form keeps everything the scanners list.

## JSON format, version 1

`formatVersion` is `1`. A field may be added within a version; removing, renaming or changing the meaning of a field increases `formatVersion`.

| Field                       | Type                                                       | Meaning                                                                                                   |
| --------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `formatVersion`             | `1`                                                        | This schema.                                                                                              |
| `repository`                | string                                                     | Folder name locally; `owner/name` in the hosted issue.                                                    |
| `revision`                  | string or null                                             | The scanned commit, or null outside Git.                                                                  |
| `date`                      | `YYYY-MM-DD`                                               | The UTC day days left are counted from.                                                                   |
| `integrations[]`            | object                                                     | One per detected provider, in catalog order.                                                              |
| `.provider`, `.name`        | string                                                     | Catalog ID (`stripe`, `openai`, …) and display name.                                                      |
| `.packages[]`               | `{ file, name, declared, locked }`                         | Each manifest dependency; `locked` is null without a lockfile entry. Empty when only hostnames were seen. |
| `.configured`               | boolean                                                    | Whether a `.refit.json` integration covers the provider.                                                  |
| `.integration`              | string or null                                             | That integration's name, when it has one.                                                                 |
| `.capability`               | `migrate`, `model-fixes` or `report-only`                  | What Refit can do, as above.                                                                              |
| `.apiVersions[]`            | `{ file, line, value }`                                    | API versions pinned in code; `value` is null when computed.                                               |
| `deadlines[]`               | object                                                     | Live exposures, soonest first.                                                                            |
| `.id`, `.provider`, `.kind` | string                                                     | Registry ID, provider and `api-version`, `model` or `sdk`.                                                |
| `.versions`                 | string[]                                                   | The versions, models or packages the evidence matched.                                                    |
| `.date`, `.days`            | string, integer                                            | Deadline date; whole days left, negative once passed.                                                     |
| `.summary`, `.replacement`  | string, string or null                                     | From the registry. A replacement is an identifier for models and SDKs and prose for API versions.         |
| `.source`                   | string or null                                             | The provider page the registry entry came from.                                                           |
| `.evidence[]`, `.more`      | `{ file, line, text }`, integer                            | Live evidence lines, and live matches past the scanner's listing limit.                                   |
| `.ignored`                  | boolean                                                    | Accepted by an active ignore entry.                                                                       |
| `mentions`                  | string[]                                                   | Registry IDs named only outside live code, sorted.                                                        |
| `models[]`                  | `{ model, provider, calls: [{ file, line, call, test }] }` | Model calls grouped by model; `model` is null when computed. Named models first, sorted.                  |
| `untracked[]`               | `{ provider, name, hosts: [{ hostname, file, line }] }`    | Hosts of providers with no agent and no registry deadlines.                                               |
| `next`                      | string                                                     | The next step, as in the markdown.                                                                        |

## The hosted report issue

With `REFIT_HOSTED_REPORTS=1` (off by default), the hosted worker (`refit hosted serve`) keeps one GitHub issue per inventoried repository, titled "Refit report: what this repository depends on", whose body is this markdown for the repository's stored inventory, starting with the marker `<!-- refit-report -->`. Like monitoring, it covers every repository installed by an allowed account, approved or not, and never changes code or enrolls a repository.

- **When it is written.** After each pass's inventories, the worker builds the report from each stored inventory, without a checkout. It writes only when the report's digest differs from the one it last wrote. The digest leaves out the date and the next step and counts days left only through the alert stage they fall in (more than 90, 90, 30 and 7 days, and passed), so the issue changes when the code, the inventory or the registry changes or a deadline crosses one of those days, not every day. Its days left are as of the "Counted on" date it shows.
- **Re-scans.** It takes new inventories on the same triggers as [monitoring](MONITORING.md): a default-branch push, a registry change or 24 hours, at most once per 10 minutes.
- **One issue.** The first write looks for an issue the App opened before whose body starts with the marker (`creator=<app>[bot]`, newest 100), so a lost record or a reinstall reuses it; otherwise it opens one. Later writes update the stored issue and add a comment naming the commit, so watchers are notified. A closed issue stays closed.
- **Exactly once per change.** The worker takes the write in PostgreSQL before contacting GitHub: the row moves to the new digest only if it differs from the stored one, so concurrent workers and restarts write each change once. A write that fails, or a worker that stops mid-write, is tried again after 24 hours. If GitHub refuses the issue token, nothing is taken and the next pass tries again.
- **Removal and uninstall.** The row goes with the installed repository: removing the repository or uninstalling the App deletes it, and nothing is written afterwards. The issue stays in the repository.

`refit_reports` (created by `pipeline/report-store.ts`) holds `installation_id`, `repository`, `issue`, `digest`, `status` (`sending`, `opened`, `updated` or `failed`), `message` and `updated_at`. `GET /status` adds `reports`: whether they are on, and each repository's issue, status, failure message and last write.

### Needs owner decision

- **Enable reports.** `REFIT_HOSTED_REPORTS=1` on the deployed worker opens an issue in every installed repository of an allowed account, including repositories nobody approved. That is customer-facing and stays off until the owner decides.
- **App permission.** The issue needs the App's **Issues: Read and write** permission, an App settings change that existing installations must accept. Until then each pass logs a failed token and writes nothing.

## Examples

`pipeline/fixtures/report/` holds reports generated from inventories of six public repositories from the frozen benchmark sets, at their pinned commits, scanned on 2026-10-22: a Stripe repository the endive upgrade affects (`JiantaoFu/insightly`), an OpenAI app a day before the 2026-10-23 shutdowns (`rohitg00/manim-video-generator`), an Anthropic app (`yayasoumah/pocket-server`), a Shopify app (`Shopify/example-app--qr-code--remix`), a monorepo (`agentset-ai/agentset`) and a repository where nothing was found (`TechNavii/LLM-Memory-Calculator`). Each `<name>.json` names its source list, repository and commit; `<name>.md` and `<name>.report.json` are the recorded outputs the tests compare against.

[`report-examples/`](report-examples/README.md) holds the reports of ten more frozen repositories, in markdown and JSON, generated by `scripts/report-examples.mjs` from shallow clones at their pinned commits that were deleted after the scan. Its index names the Refit commit and the command.

## Not covered yet

- Languages other than TypeScript and JavaScript, as for the [inventory](INVENTORY.md).
- Labels or assignees on the report issue, and links from it to deadline alert issues.
- Recovering a report issue the App opened that is not among its newest 100 issues in the repository.
