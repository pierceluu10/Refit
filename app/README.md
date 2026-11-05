# app

Aptitude's GitHub App. It receives webhooks, keeps a clock of its own, scans each repo when something
changed, runs the orchestrator's `runRepoJob` on what the scan finds, opens the resulting draft PRs, reports what humans did with them to
memory, and serves runs to the dashboard. Founder setup and local development are
in [SETUP.md](SETUP.md).

## What it does

| Webhook                                              | Result                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `installation.created`                               | Records shared learning as no, lists every repo via the API, queues `understand` for each       |
| `installation.deleted`                               | Drops the shared learning answer, queues `forget` for each repo, drops its scan state and facts |
| `installation_repositories.removed`                  | Queues `forget` for each repo, drops its scan state and facts                                   |
| `installation_repositories.added`                    | Queues `understand` for each repo                                                               |
| `push` to the default branch                         | Queues `understand` with the new sha, and records any `Revert "..."` commit                     |
| `pull_request.closed` on an `aptitude/` branch       | Records the human verdict, `merged` or `closed`, in memory, then the evidence                   |
| `pull_request.synchronize` on an `aptitude/` branch  | Records `edited` when a person pushed their own commit, in both                                 |
| `pull_request.closed` and merged on any other branch | Records a revert if it's GitHub's revert PR form, onto the default branch                       |

Every request's signature is checked against `GITHUB_WEBHOOK_SECRET` before it is handled. The app
answers `202` as soon as the signature and JSON check out, then does the work, since GitHub gives a
delivery 10 seconds. A failure after that is logged with the delivery id; redeliver it from the App's
**Advanced** page.

A `synchronize` counts as a person's edit when the sender isn't a bot and `before...after` holds a
non-merge commit not authored by a bot (memory/README.md, Verdicts). Aptitude's own pushes, other bots
and the **Update branch** button send nothing. Each verdict holds up to $1 of the run's AI budget, and spends nothing without one.

## Evidence for memory

Memory learns from what really happened to a fix. The app sends it `FixEvidence`, the shape in
`memory/types.ts` on `rebuild/otabek`, copied by shape into `types.ts`. `runner.ts` holds the only two
lines to swap, `sendEvidence` and `sendHabits`, which only log until that code lands. Either way the
app's own fact files hold what it has seen.

| Field      | Where it comes from                                                                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edited`   | A non-merge commit on the PR not authored by a bot, or a change in what was merged even when no commit looks like a person's (an amend keeps the bot as author). Only ever `true`.                   |
| `merged`   | `merged_at`, and `humanDiff`: what people changed between our commit and the PR's final head, in the files where the change itself differs from ours. Secrets redacted, then capped at 60,000 chars. |
| `closed`   | `closed_at`, and `comment`: the closing person's latest comment, else the latest from any person. Bots and empty reviews never count. Secrets redacted, then capped at 2,000 chars.                  |
| `reverted` | `via: 'revert'`: GitHub's revert PR, or a commit naming our PR or commit. `via: 'rescan'`: a later scan finds live a list entry this fix removed. The earliest wins.                                 |

**Why not diff against the merge commit?** A squash's tree also holds everything main gained since we
branched, and GitHub's compare only offers `BASE...HEAD` (`BASE..HEAD` answers 404), which diffs from
the merge base. So `humanDiff` compares our commit with the PR's final head, the tree that was merged.
Update branch can still bring main's edits into our files, so a file only counts when the lines its
change adds and removes differ from ours. If the branch was rewritten, our commit is no longer an
ancestor, and the diff says it shows the whole merged change for those files.

**Order.** Each webhook only adds facts to a per-repo file, `<APTITUDE_APP_DIR>/fixes/<owner>/<repo>.json`,
and the evidence is worked out from all of them. A redelivered or out-of-order event ends in the same
state, and a revert that arrives before its merge waits there. Each send carries the whole evidence so
far, so `recordEvidence` must be safe to call twice.

**Which entries a fix fixed.** `createOpenPullRequest` keeps the commit and `task.entries`, minus any the
harness's last rescan still found live, since finding those later isn't a return. `task.entries` comes
from `harness/findings.ts` on `rebuild/otabek`, so until that lands no fix names entries and a rescan
can't report a return. A fix merged into another branch isn't watched, since the default branch never had it. A job that scans
hands its findings to evidence when the repo has a merged fix that named entries, with no second scan.
It dates them from before the clone, so a merge during the clone never counts against itself. A job
that skips has downloaded nothing, so there is nothing to look at; the tree hasn't changed since the
last scan, and a revert's push or merge event still reports it.

**Repo habits.** After each event the app sends `RepoHabitEvidence` for the customer's own store, never
shared: `rejections` (how many of our PRs were closed unmerged, and the latest 5 reasons) and `edits`
(how many were edited, and the files people changed on 2 or more merged PRs).

## Shared learning consent

Whether a customer agrees to shared learning is the app's own setting, per installation, in
`<APTITUDE_APP_DIR>/installations/<id>.json`. It isn't a GitHub App setting.

- An install records no. A redelivered install keeps the answer, and an uninstall drops it.
- No record, a value that isn't `true`, or any read error all mean no.
- It's read fresh for every send and passed to the sink as `consented`. A customer's own store gets the
  evidence either way. Revoking stops sharing from the next event, but can't recall what already left.
- There's no customer-facing toggle yet. Once a customer has told us, a founder sets it:

```sh
node --experimental-strip-types app/consent-cli.ts <installationId> yes
```

It refuses an id with no install on record, so a typo can't wait as a yes for that id's install.

## Jobs

`understand` jobs go to a file-backed queue (`APTITUDE_QUEUE_FILE`, default `.aptitude/queue.json`)
and run one at a time. A job leaves the file only when it ends, so a restart reruns what it
interrupted. Only one read per repo waits at a time; `forget` drops a repo's waiting reads (memory
has no forget yet).

Every job makes the same decision. It reads the default branch's tree SHA (one API call, no clone)
and compares it, today's in-force list version and the scanner's version with the repo's last scan:

| What it finds                                           | What it does                                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| No scan yet, a new tree, list version or scanner        | Clones (depth 1, the token in the environment, never argv), scans, deletes the checkout |
| Nothing new, last scan clean                            | Skips with no download                                                                  |
| Nothing new, last scan not clean                        | Skips with no download and no fix, and stays reported as not clean                      |
| Nothing new, but the last AI check failed or was capped | Scans again, so the unclear finding gets its check                                      |
| Nothing new, but the last fix didn't get its try        | Scans again, and tries the fix again                                                    |
| A `manual` rescan                                       | Always scans, and tries a fix again                                                     |

A live finding goes to `runRepoJob` only if no fix has had its try on it: a PR, or a verdict on every
change. A finding is its entry and its file, so a push that only moves a line doesn't pay for a second
fix, a closed PR isn't reopened by a tick, and a dead thing that comes back after a clean scan gets a new
one. A fix that throws, returns nothing or never got to run hasn't had its try, so the next tick scans
again and retries it (`why: fix-retry`), as often as ticks come, under the run's cap. A finding that's
only unclear never reaches a fix. Unlisted providers go to the queue that the list's refresh reads and
stay on the repo's record, so its summary reads `clean-unlisted-waiting`, not `clean`.

The decision goes by the branch as it is now, never by the commit a webhook names, so a redelivered or
late push can't scan twice or move a repo back to an old tree. The tree on record comes from the clone,
so a push landing mid-job isn't marked as scanned. A failure writes no state, so it can't read as clean
and the next trigger tries again.

The scanner's version is `SCANNER_VERSION`, a hash of the non-test source in `inventory/` and
`dead-apis/` taken at load, so nobody has to remember to bump it. Any edit there re-reads every repo once
(`why: scanner-change`) after a deploy. That costs a clone per repo, one AI check where a repo has unclear
findings, and a fix only for a live finding that hasn't had one. A finding on the first scan by a new
scanner isn't reported to evidence, since it can't be told from one the old scanner couldn't see.

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

| File              | Purpose                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `types.ts`        | Job, verdict and PR types, and `BRANCH_PREFIX` (`aptitude/`)                                                       |
| `github.ts`       | App JWT, token cache, `headTree`, repo and installation lists, `compareCommits`, and reading what happened to a PR |
| `pr.ts`           | `openPullRequest` (Git Data API, draft PR) and the shared `createOpenPullRequest`                                  |
| `webhooks.ts`     | Signature verification and the handlers above                                                                      |
| `evidence.ts`     | Turns webhooks and rescans into facts, and sends the evidence and repo habits                                      |
| `fix-facts.ts`    | The per-repo facts, how they merge in any order, and the evidence worked out from them                             |
| `consent.ts`      | The per-installation shared learning setting; `consent-cli.ts` changes it                                          |
| `json-file.ts`    | Reads a JSON file, and writes one atomically                                                                       |
| `server.ts`       | `POST /webhooks`, `GET /api/runs`, `GET /healthz`                                                                  |
| `runs.ts`         | `/api/runs` validation and per-viewer scoping                                                                      |
| `queue.ts`        | File-backed job queue                                                                                              |
| `jobs.ts`         | One job: the tree check, then skip, or checkout, scan, any fix, and cleanup                                        |
| `triggers.ts`     | The skip rule, per-repo state, the trigger record and its summary, the clock                                       |
| `triggers-cli.ts` | `summary` and `rescan`                                                                                             |
| `runner.ts`       | The real job runner, evidence and verdicts, on the process's one run budget                                        |
| `redact.ts`       | `messageOf`: an error's text with secrets taken out, for every log line and record                                 |
| `git.ts`          | `cloneRepo`, `treeOfCheckout`, and `filesFromDiff` (a diff to file changes, via a scratch index)                   |
| `main.ts`         | Entry point; wires the webhook server, the queue and the daily clock                                               |
| `config.ts`       | Reads the env vars listed in SETUP.md                                                                              |
| `fixtures/`       | Illustrative webhook payloads for the tests                                                                        |
| `manifest.json`   | The App's permissions and events; source of truth for its GitHub settings                                          |

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
