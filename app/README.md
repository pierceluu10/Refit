# app

Refit's GitHub App. It receives webhooks, scans each installed repo, queues a run for each task the
scan finds, opens the resulting draft PRs, reports what humans did with them to memory, and serves
runs to the dashboard. Founder setup, local development and the morning runbook are in
[SETUP.md](SETUP.md).

## What it does

| Webhook                                         | Result                                                     |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `installation.created`                          | Lists every repo via the API, queues `scan` for each       |
| `installation.deleted`                          | Forgets the whole installation                             |
| `installation_repositories.added`               | Queues `scan` for each repo                                |
| `installation_repositories.removed`             | Forgets each repo                                          |
| `push` to the default branch                    | Queues `scan` (a re-scan) with the new sha                 |
| `pull_request.closed` on a `refit/` branch      | Records the human verdict, `merged` or `closed`, in memory |
| `pull_request.synchronize` on a `refit/` branch | Records `edited` when a person pushed their own commit     |

Every request's signature is checked against `GITHUB_WEBHOOK_SECRET` before it is handled. The app
answers `202` as soon as the signature and JSON check out, then does the work, since GitHub gives a
delivery 10 seconds. A failure after that is logged with the delivery id; redeliver it from the App's
**Advanced** page. Each delivery's work is done once: the ids of finished ones are kept in
`.refit/deliveries.json` beside the queue file, across restarts, and GitHub repeats the id on a
redelivery.

A `synchronize` counts as a person's edit when the sender isn't a bot and `before...after` holds a
non-merge commit not authored by a bot (memory/README.md, Verdicts). Refit's own pushes, other bots
and the **Update branch** button send nothing. Each verdict gets its own $1 AI budget.

A weekly schedule queues `scan` for every repo of every installation. The app keeps the last time in
`.refit/schedule.json` beside the queue file. The first start only records the time, so restarting
the app never re-scans everything by itself.

## Jobs

Jobs go to a file-backed queue (`REFIT_QUEUE_FILE`, default `.refit/queue.json`). A job leaves the
file only when it ends, so a restart reruns what it interrupted. `REFIT_QUEUE_CONCURRENCY` jobs run at
once (default 2). A job that throws is retried with backoff, then logged and dropped; a refusal from
the run budget and a cancelled job aren't retried. One scan per repo waits at a time, and one run per
task.

- **`scan`:** a fresh clone into a temp directory (depth 1, the installation token passed through the
  environment, never argv) → `.refit.yml` → the orchestrator's `scanRepo` → the `ScanReport` saved →
  a `run` job queued for each `ExternalTask`. A task that already has a Refit PR isn't queued again;
  its report item shows that PR.
- **`run`:** a fresh clone → `.refit.yml` → the orchestrator's `runRepoJob` for that task, with the PR
  opener below → the report item updated → `app/notify`. `app/lifecycle` is called before each PR
  opens.
- **`forget`:** when repos are removed or the App is uninstalled, their waiting jobs are dropped,
  their running jobs are aborted, their checkouts are deleted and their reports go. A cancelled job
  can't open a PR. An uninstall also erases the org from memory, the audit trail, the orchestrator's
  run log and report copies and the Slack record (`forget.ts`). The schedule holds only a time.

Every clone is deleted when its job ends. The app only reads a checkout; the harness runs repo code
in its Docker sandbox.

`createOpenPullRequest(tokens, installationId)` is the shared `OpenPullRequest`: it applies the
record's diff to a scratch git index (never the checkout's files), and opens a draft PR from
`refit/<task-slug>` with the harness's `prBody`. A task that already has an open PR gets that URL
back. It never touches the default branch and never merges.

Reports live in `.refit/reports/` beside the queue file, one JSON file per repo holding its latest
`ScanReport`.

## Repo settings

An optional `.refit.yml` at the repo's root holds the customer's choices: `paused: true` stops scans
and PRs for that repo, and `ignore` lists dependencies Refit should leave alone, matched against a
change's dependency or provider in any case. The app reads the file and never runs it: it doesn't
follow symlinks, it has a size cap, and what's wrong with a bad file goes in the report's `errors`
without quoting it. A bad file never stops a scan. The format is in [SETUP.md](SETUP.md).

## Runs for the dashboard

`GET /api/runs?repo=owner/name&limit=50` returns `RunView[]`, newest first, as JSON.

- `Authorization: Bearer <REFIT_SERVICE_TOKEN>` sees every run. The dashboard's server sends it; it
  never goes in browser code.
- A GitHub user-to-server token for this App stays scoped to its viewer. The app lists the user's
  installations of this App (`GET /user/installations`, filtered by App id) and the repos they can
  reach in each, and returns only those repos' runs, filtered before the limit. A repo the viewer
  can't reach: `200 []`.
- No token, or one GitHub rejects: `401`. Invalid `repo` or `limit` (a whole number, 1 to 100,
  default 50): `400` with `{ error }`.
- Same-origin only: no CORS headers.

The server also mounts the routes from `app/api/` and `app/audit/`.

## Files

| File            | Purpose                                                                           |
| --------------- | --------------------------------------------------------------------------------- |
| `types.ts`      | Job, verdict and PR types, and `BRANCH_PREFIX` (`refit/`)                         |
| `github.ts`     | App JWT, token cache, repo and installation lists, `compareCommits`               |
| `pr.ts`         | `openPullRequest` (Git Data API, draft PR) and the shared `createOpenPullRequest` |
| `webhooks.ts`   | Signature verification and the handlers above                                     |
| `server.ts`     | `POST /webhooks`, `GET /api/runs`, `GET /healthz`, and the mounted routes         |
| `deliveries.ts` | Which webhook deliveries are finished, so a repeat does nothing                   |
| `progress.ts`   | What's running now, and a report for a scan that failed                           |
| `forget.ts`     | Erases an uninstalled org from every store                                        |
| `api/scans.ts`  | `GET /api/scans`: each installed repo's scan state, for onboarding                |
| `runs.ts`       | `/api/runs` validation, the service token and per-viewer scoping                  |
| `queue.ts`      | File-backed job queue with retries and concurrency                                |
| `jobs.ts`       | The `scan` and `run` jobs: checkout, the loop, cleanup                            |
| `reports.ts`    | The latest `ScanReport` per repo                                                  |
| `schedule.ts`   | The weekly re-scan of every installed repo                                        |
| `settings.ts`   | Reads a repo's optional `.refit.yml`                                              |
| `parts.ts`      | Wires the orchestrator, API, audit, lifecycle and notify modules into the app     |
| `cli.ts`        | `run --repo <path>`: the loop on a local checkout, with real PRs when it can      |
| `git.ts`        | `cloneRepo`, and `filesFromDiff` (a diff to file changes, via a scratch index)    |
| `main.ts`       | Entry point; wires memory's `recordVerdict` with a $1 budget per verdict          |
| `config.ts`     | Reads the env vars listed in SETUP.md                                             |
| `fixtures/`     | Illustrative webhook payloads for the tests                                       |
| `manifest.json` | The App's permissions and events; source of truth for its GitHub settings         |

## Opening a PR from the harness

`openPullRequest` refuses any branch that doesn't start with `refit/` or that equals the base, and
any change with no files. `base` defaults to the repo's default branch.

```ts
import { createInstallationTokens } from '../app/github.ts';
import { openPullRequest } from '../app/pr.ts';

const tokens = createInstallationTokens(appId, privateKey);

const pr = await openPullRequest(tokens, installationId, {
  repo: 'acme/payments',
  branch: 'refit/stripe-node-17',
  title: 'Upgrade stripe-node from 14 to 17',
  body: 'What changed, and the checks that prove it.',
  commitMessage: 'chore: upgrade stripe-node to 17',
  files: [
    { path: 'package.json', content: updatedPackageJson },
    { path: 'src/legacy-charge.ts', delete: true },
  ],
  draft: true,
});
// pr: { url, number, branch, sha }
```

The repo, branch and files above are an illustrative example.

## Tests

From the repo root:

```sh
npx vitest run app
```
