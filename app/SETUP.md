# Setting up the Aptitude GitHub App

We reuse the existing GitHub App **Refit Agent** (App ID `5275879`, owned by the `refit-dev` org, bot
login `refit-agent[bot]`) instead of registering a new one through the manifest flow.
[`manifest.json`](manifest.json) is the source of truth for the settings: if this checklist and the
manifest ever disagree, the manifest wins and this file is out of date.

Only a founder changes these settings. Agents and scripts never do.

Settings page: <https://github.com/organizations/refit-dev/settings/apps/refit-agent> (or the org's
**Settings** → **Developer settings** → **GitHub Apps** → **Edit** next to the App). The URL changes
after the rename below.

## 1. General (basic information)

- [ ] **GitHub App name**: `Aptitude` (34 characters max, unique across GitHub). Renaming changes the
      slug, the settings URL (likely `.../settings/apps/aptitude`) and the bot login (likely
      `aptitude[bot]`). Nothing in our code depends on either: Aptitude PRs are recognised by the
      `aptitude/` branch prefix, not the bot login. GitHub's docs don't say whether the old URL
      redirects.
- [ ] **Homepage URL**: set Aptitude's real homepage. `manifest.json` holds
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

- [ ] Optionally fill **Add a note to users** (for example "Aptitude now opens migration PRs").
- [ ] **Save changes**.

Existing installations keep their old permissions until an owner approves the new ones. GitHub emails
each org owner of every installation to review the request. Until they accept, the new access doesn't
apply there, so Aptitude can't push branches or open PRs on those installations.

## 3. Installation target and private key

- [ ] **Where can this GitHub App be installed?** (on the Advanced page or the General page; label may
      differ): keep the current value. The manifest has `"public": false`, which is "Only on this
      account". If it is currently "Only on this account", the test install below must go to
      `refit-dev` itself or the App must be switched to "Any account" for the test; record which.
- [ ] Private key: if nobody has the `.pem`, sidebar → **Credentials** → **Key pairs** → **New key**
      (older UI: **Private keys** → **Generate a private key**; label may differ). The download is
      the only copy (PKCS#1 PEM). Store it in the password manager and outside the repo, e.g.
      `~/.config/aptitude/aptitude.pem`, and point `GITHUB_APP_PRIVATE_KEY_FILE` at it. `*.pem` is
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

| Variable                      | Value                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `GITHUB_APP_ID`               | `5275879`                                                                                         |
| `GITHUB_APP_PRIVATE_KEY_FILE` | Path to the `.pem`                                                                                |
| `GITHUB_APP_PRIVATE_KEY`      | PEM contents instead of a file, for hosts that only take env vars                                 |
| `GITHUB_WEBHOOK_SECRET`       | The webhook secret from step 1                                                                    |
| `PORT`                        | Default `3000`                                                                                    |
| `HOST`                        | Default `127.0.0.1`                                                                               |
| `SMEE_URL`                    | Dev tunnel only                                                                                   |
| `APTITUDE_QUEUE_FILE`         | Job queue file; default `.aptitude/queue.json` (a persistent path in production)                  |
| `APTITUDE_TRIGGER_DIR`        | Scan state and the trigger record; default `.aptitude/triggers` (a persistent path in production) |
| `APTITUDE_SPEND_LOG`          | Keeps the AI check's spend across restarts; without it each restart starts from $0                |
| `APTITUDE_MEMORY_DIR`         | memory/'s store; absolute path on a persistent volume in production                               |
| `APTITUDE_AI_BUDGET_USD`      | Run cap for the loop; required once `ANTHROPIC_API_KEY` is set                                    |
| `ANTHROPIC_API_KEY`           | Real model runs; without it the loop and memory use offline stubs                                 |

Jobs run the harness in Docker, so the host needs Docker running.

## Local development

Needs Node >= 22.12 (the app runs TypeScript with `--experimental-strip-types`). Run the scripts from
the repo root with `-w @aptitude/app`, or from inside `app/`.

1. Open <https://smee.io/new> and copy the channel URL.
2. Set `SMEE_URL` in `app/.env`, and set the App's **Webhook URL** to the same URL.
3. Terminal 1: `npm run tunnel -w @aptitude/app` (smee-client 5.0.0 via npx, forwarding `SMEE_URL`
   to `http://127.0.0.1:$PORT/webhooks`; it reads `SMEE_URL` and `PORT` from `app/.env`).
4. Terminal 2: `npm run dev -w @aptitude/app` (watch mode). `npm start -w @aptitude/app` runs it
   without watching.
5. `curl http://127.0.0.1:3000/healthz` should answer.
6. Trigger a delivery: on the App's settings, sidebar → **Advanced** → **Recent Deliveries**, click a
   delivery, then **Redeliver**. The server logs the queued job or recorded verdict. A delivery with a
   bad signature is rejected; that usually means the secret in `app/.env` doesn't match the App.

## Test install

Install on a test org first, never a real customer org. Check that:

- [ ] each delivery is answered `202` within a second, before the job runs;
- [ ] installing queues one `understand` job per repo, and each runs (clone, `runRepoJob`, cleanup);
- [ ] a run that opens a PR opens it as a draft from an `aptitude/` branch, never on the default branch;
- [ ] pushing your own commit to an Aptitude PR records `edited`; **Update branch** records nothing;
- [ ] adding and removing repos on the installation queues `understand` and `forget` jobs;
- [ ] a push to the default branch queues an `understand` job with the new sha;
- [ ] merging or closing a PR from an `aptitude/` branch records `merged` or `closed`;
- [ ] uninstalling queues `forget` for every repo.

## What runs

`main.ts` runs the orchestrator's `runRepoJob` for each job and serves memory's `listRunViews`.
Verdicts go to memory's `recordVerdict`.
