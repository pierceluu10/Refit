# Setting up the Refit GitHub App

We reuse the existing GitHub App **Refit Agent** (App ID `5275879`, owned by the `refit-dev` org, bot
login `refit-agent[bot]`) instead of registering a new one through the manifest flow.
[`manifest.json`](manifest.json) is the source of truth for the settings: if this checklist and the
manifest ever disagree, the manifest wins and this file is out of date.

Only a founder changes these settings. Agents and scripts never do.

Settings page: <https://github.com/organizations/refit-dev/settings/apps/refit-agent> (or the org's
**Settings** → **Developer settings** → **GitHub Apps** → **Edit** next to the App). The URL changes
after the rename below.

## Morning runbook: refit-dev

Runs the whole loop on the test org `refit-dev`: the App **Refit Agent** (ID `5275879`) on
`refit-dev/demo-node-api`, `demo-python-app` and `demo-next-web`. Never add other repos to this
install. Run everything from the repo root.

### Before you start

- [ ] Docker is running (`docker info`). The harness runs repo code only in its sandbox.
- [ ] A founder has granted **Workflows: Read and write** (section 2) and approved it on the
      `refit-dev` install. Without it, GitHub refuses commits that touch `.github/workflows/`: a PR
      opens without those files and lists them in its body, and a change that is only workflow files fails.
- [ ] `ln -s "$HOME/.config/refit/app.env" app/.env`, if the link isn't there. That file holds the
      App's credentials and `REFIT_SERVICE_TOKEN`.
- [ ] `ANTHROPIC_API_KEY` and `REFIT_AI_BUDGET_USD` are exported in terminal 2's shell, or set in
      `app/.env`. A real run refuses to spend without a cap. All jobs in one app process share that
      cap, so restarting the app starts a new one.

### Run it

1. Terminal 1: `npm run tunnel -w @refit/app`.
2. Terminal 2: `npm run dev -w @refit/app`.
3. `curl http://127.0.0.1:3000/healthz` answers `200`.
4. Start the first scan, one of:
   - Not installed yet: the App's settings → **Install App** → `refit-dev` → **Only select
     repositories**, pick the three demo repos, **Install**.
   - Already installed: the App's settings → **Advanced** → **Recent Deliveries**, open an
     `installation` delivery with action `created`, **Redeliver**.
   - Already installed, one repo: push a commit to that repo's default branch.
5. Terminal 2 logs `queued scan <repo>` for each repo. When a scan finds work it logs
   `queued run <repo>` per task.
6. Each scan writes a report to `.refit/reports/` beside the queue file (`app/.refit/reports/` when
   the app runs from `app/`), one JSON file per repo.
7. Watch the PRs appear, as drafts on `refit/` branches:

   ```sh
   gh pr list --repo refit-dev/demo-node-api --state open --draft
   ```

   Repeat for `refit-dev/demo-python-app` and `refit-dev/demo-next-web`.

8. Read every run. Load the token into the shell without printing it:

   ```sh
   set -a; . app/.env; set +a
   curl -H "Authorization: Bearer $REFIT_SERVICE_TOKEN" http://127.0.0.1:3000/api/runs
   ```

9. Merge or close one PR. Terminal 2 logs `verdict merged <pr url>` or `verdict closed <pr url>`.

### Stopping and scheduling

- Stop one repo for good: remove it from the install, or uninstall. Its waiting jobs go, its running
  jobs stop and its checkouts are deleted.
- Pause one repo and keep the install: commit a `.refit.yml` with `paused: true`.
- Weekly re-scan: the app keeps the last time in `.refit/schedule.json`. The first start only records
  the time; every installed repo is re-scanned a week after it.

### Repo settings: `.refit.yml`

Optional, at the repo's root. These are the customer's choices.

```yaml
paused: true # stop scans and PRs for this repo
ignore: # dependencies Refit should leave alone
  - stripe
  - node
```

`ignore` matches a change's dependency or provider, in any case. A file Refit can't read never stops
a scan: what's wrong is listed in the report's `errors` and the valid parts still apply.

### The CLI

```sh
npm run refit -w @refit/app -- run --repo <path> [--dry-run]
```

It opens real draft PRs when the App's credentials are present and the checkout's `origin` is on
GitHub. Otherwise it prints stub links and touches nothing on GitHub. `--dry-run` stops before PRs.

### If something goes wrong

- **Deliveries answer `401` (bad signature):** `GITHUB_WEBHOOK_SECRET` in `app/.env` doesn't match the
  App's webhook secret.
- **A run refuses to spend (no cap):** set `REFIT_AI_BUDGET_USD`, then restart the app.
- **The sandbox fails (Docker off):** start Docker, then redeliver the delivery.
- **The queue is stuck or corrupt:** the app refuses to start on a corrupt queue file rather than drop
  its jobs. Stop the app, delete `.refit/queue.json` (this drops the waiting jobs) and start again.

## 1. General (basic information)

- [ ] **GitHub App name**: `Refit` (34 characters max, unique across GitHub). Renaming changes the
      slug, the settings URL (likely `.../settings/apps/refit`) and the bot login (likely
      `refit[bot]`). Nothing in our code depends on either: Refit PRs are recognised by the
      `refit/` branch prefix, not the bot login. GitHub's docs don't say whether the old URL
      redirects.
- [ ] **Homepage URL**: set Refit's real homepage. `manifest.json` holds
      `https://github.com/pierceluu10/Refit` as a placeholder; update it there too.
- [ ] Logo: under **Display information**, click **Upload a logo**, crop if needed, then **Set new
      avatar**. GitHub wants a PNG, JPG or GIF under 1 MB; 200 × 200 px renders best, square with the
      mark centred and a transparent background. Then set **Badge background color** (it only appears
      after the upload).
- [ ] Webhook **Active**: checked.
- [ ] **Webhook URL**: the smee channel URL for development (see below); the real host's
      `https://<host>/webhooks` once deployed.
- [ ] **Webhook secret**: generate with `openssl rand -hex 32`. Store it in the password manager and
      as `GITHUB_WEBHOOK_SECRET` in `app/.env`. Never commit it or paste it anywhere else. If the
      field already has a secret nobody has a copy of, replace it.
- [ ] **SSL verification**: enabled.
- [ ] **Save changes**.

## 2. Permissions & events

Sidebar → **Permissions & events**. Under **Repository permissions**, set each dropdown (GitHub offers
"Read-only", "Read and write" or "No access"; GitHub has no write-only, and write includes read):

| Permission    | Access                                        |
| ------------- | --------------------------------------------- |
| Contents      | Read and write                                |
| Pull requests | Read and write                                |
| Checks        | Read and write                                |
| Workflows     | Read and write                                |
| Metadata      | Read-only (mandatory; it can't be turned off) |

Set every other repository permission to No access, unless it is already set and something still
uses it. Leave **Organization permissions** and **Account permissions** at No access.

Under **Subscribe to events**, check:

- [ ] **Push** (needs Contents)
- [ ] **Pull request** (needs Pull requests)

`installation` and `installation_repositories` are not in that list and not in the manifest's
`default_events`: GitHub's docs say every GitHub App receives both by default and can't subscribe to
them manually. Our install, uninstall and repos-added/removed handlers rely on that.

`pull_request` already covers `synchronize`, which the `edited` verdict uses. No new permission is
needed: cloning and `compare` use Contents (read), and `/user/installations` needs none.

- [ ] Optionally fill **Add a note to users** (for example "Refit now opens migration PRs").
- [ ] **Save changes**.

Existing installations keep their old permissions until an owner approves the new ones. GitHub emails
each org owner of every installation to review the request. Until they accept, the new access doesn't
apply there, so Refit can't push branches or open PRs on those installations.

## 3. Installation target and private key

- [ ] **Where can this GitHub App be installed?** (on the Advanced page or the General page; label may
      differ): keep the current value. The manifest has `"public": false`, which is "Only on this
      account". If it is currently "Only on this account", the test install below must go to
      `refit-dev` itself or the App must be switched to "Any account" for the test; record which.
- [ ] Private key: if nobody has the `.pem`, sidebar → **Credentials** → **Key pairs** → **New key**
      (older UI: **Private keys** → **Generate a private key**; label may differ). The download is
      the only copy (PKCS#1 PEM). Store it in the password manager and outside the repo, e.g.
      `~/.config/refit/refit.pem`, and point `GITHUB_APP_PRIVATE_KEY_FILE` at it. `*.pem` is
      gitignored, but don't rely on that. Delete old keys nobody holds.

## 4. User sign-in for the dashboard

`GET /api/runs` scopes runs by a GitHub user-to-server token for this App, so the dashboard needs a
"Sign in with GitHub" flow (not built yet; the site shows labelled example runs until then). On the
**General** page:

- [ ] **Callback URL**: the dashboard's OAuth callback once it exists.
- [ ] **Expire user authorization tokens**: keep checked.
- [ ] **Request user authorization (OAuth) during installation**: optional; it signs the installer in
      straight away.
- [ ] Note the **Client ID** and generate a **Client secret** for the site's sign-in (password
      manager only).

## Environment

Put these in `app/.env` (gitignored; `npm run dev` loads it). Never commit or print them.

| Variable                      | Value                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `GITHUB_APP_ID`               | `5275879`                                                                     |
| `GITHUB_APP_PRIVATE_KEY_FILE` | Path to the `.pem`                                                            |
| `GITHUB_APP_PRIVATE_KEY`      | PEM contents instead of a file, for hosts that only take env vars             |
| `GITHUB_WEBHOOK_SECRET`       | The webhook secret from step 1                                                |
| `PORT`                        | Default `3000`                                                                |
| `HOST`                        | Default `127.0.0.1`                                                           |
| `SMEE_URL`                    | Dev tunnel only                                                               |
| `REFIT_QUEUE_FILE`            | Job queue file; default `.refit/queue.json` (a persistent path in production) |
| `REFIT_QUEUE_CONCURRENCY`     | Jobs that run at once; default `2`                                            |
| `REFIT_SERVICE_TOKEN`         | The dashboard's token: reads every run on `GET /api/runs`; server side only   |
| `REFIT_SLACK_WEBHOOK_URL`     | Optional; `app/notify` posts to it                                            |
| `REFIT_MEMORY_DIR`            | memory/'s store; absolute path on a persistent volume in production           |
| `REFIT_AI_BUDGET_USD`         | Run cap for the loop; required once `ANTHROPIC_API_KEY` is set                |
| `ANTHROPIC_API_KEY`           | Real model runs; without it the loop and memory use offline stubs             |

Jobs run the harness in Docker, so the host needs Docker running.

## Local development

Needs Node >= 22.12 (the app runs TypeScript with `--experimental-strip-types`). Run the scripts from
the repo root with `-w @refit/app`, or from inside `app/`.

1. Open <https://smee.io/new> and copy the channel URL.
2. Set `SMEE_URL` in `app/.env`, and set the App's **Webhook URL** to the same URL.
3. Terminal 1: `npm run tunnel -w @refit/app` (smee-client 5.0.0 via npx, forwarding `SMEE_URL`
   to `http://127.0.0.1:$PORT/webhooks`; it reads `SMEE_URL` and `PORT` from `app/.env`).
4. Terminal 2: `npm run dev -w @refit/app` (watch mode). `npm start -w @refit/app` runs it
   without watching.
5. `curl http://127.0.0.1:3000/healthz` should answer.
6. Trigger a delivery: on the App's settings, sidebar → **Advanced** → **Recent Deliveries**, click a
   delivery, then **Redeliver**. The server logs the queued job or recorded verdict. A delivery with a
   bad signature is rejected; that usually means the secret in `app/.env` doesn't match the App.

## Test install

Install on a test org first, never a real customer org. Check that:

- [ ] each delivery is answered `202` within a second, before the job runs;
- [ ] installing queues one `scan` job per repo, and each runs (fresh clone, `scanRepo`, report saved,
      checkout deleted);
- [ ] each task a scan finds queues a `run` job, and each runs on its own fresh clone;
- [ ] a run that opens a PR opens it as a draft from a `refit/` branch, never on the default branch;
- [ ] pushing your own commit to a Refit PR records `edited`; **Update branch** records nothing;
- [ ] adding repos queues `scan` jobs; removing them drops their waiting jobs, stops their running
      jobs and deletes their checkouts;
- [ ] a push to the default branch queues a `scan` job with the new sha;
- [ ] merging or closing a PR from a `refit/` branch records `merged` or `closed`;
- [ ] uninstalling stops every job of that installation;
- [ ] a `.refit.yml` with `paused: true` stops new scans and PRs for that repo, and `ignore` leaves
      out those dependencies.

## What runs

`main.ts` wires the queue to two jobs: `scan` (the orchestrator's `scanRepo`) and `run` (the
orchestrator's `runRepoJob` with the App's PR opener). It serves memory's `listRunViews`, sends
verdicts to memory's `recordVerdict` (with the PR's final diff for a merge or an edit), and re-scans
every installed repo weekly. `parts.ts` wires in the other folders' modules.
