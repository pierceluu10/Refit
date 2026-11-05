# app

Aptitude's GitHub App. It receives webhooks, keeps a clock of its own, scans each repo when something
changed, runs the orchestrator's `runRepoJob` on what the scan finds, opens the resulting draft PRs, reports what humans did with them to
memory, and serves runs to the dashboard. Founder setup and local development are
in [SETUP.md](SETUP.md).

## What it does

| Webhook                                                     | Result                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| `installation.created`                                      | Lists every repo via the API, queues `understand` for each |
| `installation.deleted`, `installation_repositories.removed` | Queues `forget` for each repo, drops its scan state        |
| `installation_repositories.added`                           | Queues `understand` for each repo                          |
| `push` to the default branch                                | Queues `understand` with the new sha                       |
| `pull_request.closed` on an `aptitude/` branch              | Records the human verdict, `merged` or `closed`, in memory |
| `pull_request.synchronize` on an `aptitude/` branch         | Records `edited` when a person pushed their own commit     |

Every request's signature is checked against `GITHUB_WEBHOOK_SECRET` before it is handled. The app
answers `202` as soon as the signature and JSON check out, then does the work, since GitHub gives a
delivery 10 seconds. A failure after that is logged with the delivery id; redeliver it from the App's
**Advanced** page.

A `synchronize` counts as a person's edit when the sender isn't a bot and `before...after` holds a
non-merge commit not authored by a bot (memory/README.md, Verdicts). Aptitude's own pushes, other bots
and the **Update branch** button send nothing. Each verdict gets its own $1 AI budget.

## Jobs

`understand` jobs go to a file-backed queue (`APTITUDE_QUEUE_FILE`, default `.aptitude/queue.json`)
and run one at a time. A job leaves the file only when it ends, so a restart reruns what it
interrupted. Only one read per repo waits at a time; `forget` drops a repo's waiting reads (memory
has no forget yet).

Every job makes the same decision. It reads the default branch's tree SHA (one API call, no clone)
and compares it, and today's in-force list version, with the repo's last scan:

| What it finds                                           | What it does                                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| No scan yet, a new tree, or a new list version          | Clones (depth 1, the token in the environment, never argv), scans, deletes the checkout |
| Nothing new, last scan clean                            | Skips with no download                                                                  |
| Nothing new, last scan not clean                        | Skips with no download and no fix, and stays reported as not clean                      |
| Nothing new, but the last AI check failed or was capped | Scans again, so the unclear finding gets its check                                      |
| A `manual` rescan                                       | Always scans, and tries a fix again                                                     |

A live finding goes to `runRepoJob` only if no fix has been started for it. A finding is its entry and
its file, so a push that only moves a line doesn't pay for a second fix, a closed PR isn't reopened by
a tick, and a dead thing that comes back after a clean scan gets a new one. A fix that throws hasn't had
its try: the next new tree or list version retries it, and the next tick doesn't. A finding that's
only unclear never reaches a fix. Unlisted providers go to the queue that the list's refresh reads and
stay on the repo's record, so its summary reads `clean-unlisted-waiting`, not `clean`.

The decision goes by the branch as it is now, never by the commit a webhook names, so a redelivered or
late push can't scan twice or move a repo back to an old tree. The tree on record comes from the clone,
so a push landing mid-job isn't marked as scanned. A failure writes no state, so it can't read as clean
and the next trigger tries again.

## Always watching

The clock lives in the server process (`startClock` in `main.ts`): one tick at boot, then one every 24
hours, with nobody starting it. A tick queues a check of every repo of every installation, so a list
gain, a shutdown date arriving and a webhook GitHub never delivered are all caught by the same check. It
only runs while the server does: a host that stops idle machines stops the clock too, and the summary
below is what shows it.

Every trigger appends a line to `log.jsonl` under `APTITUDE_TRIGGER_DIR` (default
`.aptitude/triggers`): what woke the job, what it decided and why, findings, seconds and cost. Each
repo's last scan is in `repos/<owner>/<name>.json`.

From `app/`, where the server's relative paths resolve:

```sh
npm run triggers -- summary [--json]
npm run triggers -- rescan <owner/name>
```

`summary` lists each repo worst first, with the time since its last working check. Failures don't count
as checks. A repo with none in 48 hours is marked `STALE`. `rescan` needs the App's credentials and can
spend; it runs beside the server's queue, not through it.

`app/triggers-month.test.ts` measures a month of ticks over quiet repos. It runs the real code with a
fake network, clone and model, so it measures code paths, not a deployed system.

`createOpenPullRequest(tokens, installationId)` is the shared `OpenPullRequest`: it applies the
record's diff to a scratch git index (never the checkout's files), and opens a draft PR from
`aptitude/<task-slug>` with the harness's `prBody`. A task that already has an open PR gets that URL
back. It never touches the default branch and never merges.

## Runs for the dashboard

`GET /api/runs?repo=owner/name&limit=50` returns `RunView[]`, newest first, as JSON.

- The viewer sends `Authorization: Bearer <token>`, a GitHub user-to-server token for this App. The
  app lists the user's installations of this App (`GET /user/installations`, filtered by App id) and
  the repos they can reach in each, and returns only those repos' runs, filtered before the limit.
- No token, or one GitHub rejects: `401`. Invalid `repo` or `limit` (a whole number, 1 to 100,
  default 50): `400` with `{ error }`. A repo the viewer can't reach: `200 []`.
- Same-origin only: no CORS headers.

## Files

| File              | Purpose                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `types.ts`        | Job, verdict and PR types, and `BRANCH_PREFIX` (`aptitude/`)                                                          |
| `github.ts`       | App JWT, token cache, `headTree`, `listInstallationIds`, `listInstallationRepos`, `listViewerRepos`, `compareCommits` |
| `pr.ts`           | `openPullRequest` (Git Data API, draft PR) and the shared `createOpenPullRequest`                                     |
| `webhooks.ts`     | Signature verification and the handlers above                                                                         |
| `server.ts`       | `POST /webhooks`, `GET /api/runs`, `GET /healthz`                                                                     |
| `runs.ts`         | `/api/runs` validation and per-viewer scoping                                                                         |
| `queue.ts`        | File-backed job queue                                                                                                 |
| `jobs.ts`         | One job: the tree check, then skip, or checkout, scan, any fix, and cleanup                                           |
| `triggers.ts`     | The skip rule, per-repo state, the trigger record and its summary, the clock                                          |
| `triggers-cli.ts` | `summary` and `rescan`                                                                                                |
| `runner.ts`       | The real job runner, shared by the server and `rescan`                                                                |
| `git.ts`          | `cloneRepo`, `treeOfCheckout`, and `filesFromDiff` (a diff to file changes, via a scratch index)                      |
| `main.ts`         | Entry point; wires memory's `recordVerdict` with a $1 budget per verdict                                              |
| `config.ts`       | Reads the env vars listed in SETUP.md                                                                                 |
| `fixtures/`       | Illustrative webhook payloads for the tests                                                                           |
| `manifest.json`   | The App's permissions and events; source of truth for its GitHub settings                                             |

## Opening a PR from the harness

`openPullRequest` refuses any branch that doesn't start with `aptitude/` or that equals the base, and
any change with no files. `base` defaults to the repo's default branch.

```ts
import { createInstallationTokens } from '../app/github.ts';
import { openPullRequest } from '../app/pr.ts';

const tokens = createInstallationTokens(appId, privateKey);

const pr = await openPullRequest(tokens, installationId, {
  repo: 'acme/payments',
  branch: 'aptitude/stripe-node-17',
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
