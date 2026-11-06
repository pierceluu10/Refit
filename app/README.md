# app

Refit's GitHub App. It receives webhooks, runs the whole loop on each repo through the
orchestrator's `runRepoJob`, opens the resulting draft PRs, reports what humans did with them to
memory, and serves runs to the dashboard. Founder setup and local development are
in [SETUP.md](SETUP.md).

## What it does

| Webhook                                                     | Result                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| `installation.created`                                      | Lists every repo via the API, queues `understand` for each |
| `installation.deleted`, `installation_repositories.removed` | Queues `forget` for each repo                              |
| `installation_repositories.added`                           | Queues `understand` for each repo                          |
| `push` to the default branch                                | Queues `understand` (a re-read) with the new sha           |
| `pull_request.closed` on an `refit/` branch                 | Records the human verdict, `merged` or `closed`, in memory |
| `pull_request.synchronize` on an `refit/` branch            | Records `edited` when a person pushed their own commit     |

Every request's signature is checked against `GITHUB_WEBHOOK_SECRET` before it is handled. The app
answers `202` as soon as the signature and JSON check out, then does the work, since GitHub gives a
delivery 10 seconds. A failure after that is logged with the delivery id; redeliver it from the App's
**Advanced** page.

A `synchronize` counts as a person's edit when the sender isn't a bot and `before...after` holds a
non-merge commit not authored by a bot (memory/README.md, Verdicts). Refit's own pushes, other bots
and the **Update branch** button send nothing. Each verdict gets its own $1 AI budget.

## Jobs

`understand` jobs go to a file-backed queue (`REFIT_QUEUE_FILE`, default `.refit/queue.json`)
and run one at a time. A job leaves the file only when it ends, so a restart reruns what it
interrupted. Only one read per repo waits at a time; `forget` drops a repo's waiting reads (memory
has no forget yet).

Each job clones the repo (depth 1, the installation token passed through the environment, never
argv) into a fresh temp dir, calls `runRepoJob({ repo, dir, openPullRequest })` and deletes the
checkout. The app only reads the checkout; the harness runs repo code in its Docker sandbox. A job
whose `runRepoJob` throws (errors and no records) is logged as failed.

`createOpenPullRequest(tokens, installationId)` is the shared `OpenPullRequest`: it applies the
record's diff to a scratch git index (never the checkout's files), and opens a draft PR from
`refit/<task-slug>` with the harness's `prBody`. A task that already has an open PR gets that URL
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

| File            | Purpose                                                                            |
| --------------- | ---------------------------------------------------------------------------------- |
| `types.ts`      | Job, verdict and PR types, and `BRANCH_PREFIX` (`refit/`)                          |
| `github.ts`     | App JWT, token cache, `listInstallationRepos`, `listViewerRepos`, `compareCommits` |
| `pr.ts`         | `openPullRequest` (Git Data API, draft PR) and the shared `createOpenPullRequest`  |
| `webhooks.ts`   | Signature verification and the handlers above                                      |
| `server.ts`     | `POST /webhooks`, `GET /api/runs`, `GET /healthz`                                  |
| `runs.ts`       | `/api/runs` validation and per-viewer scoping                                      |
| `queue.ts`      | File-backed job queue                                                              |
| `jobs.ts`       | One job: checkout, `runRepoJob`, cleanup                                           |
| `git.ts`        | `cloneRepo`, and `filesFromDiff` (a diff to file changes, via a scratch index)     |
| `main.ts`       | Entry point; wires memory's `recordVerdict` with a $1 budget per verdict           |
| `config.ts`     | Reads the env vars listed in SETUP.md                                              |
| `fixtures/`     | Illustrative webhook payloads for the tests                                        |
| `manifest.json` | The App's permissions and events; source of truth for its GitHub settings          |

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
