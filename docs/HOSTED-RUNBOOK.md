# Hosted worker runbook

How to operate the single-tenant hosted worker (`refit hosted serve`, Fly app `refit-hosted`, one Machine in `iad` with the `refit_data` volume at `/data`, PostgreSQL on Supabase). Setup and the database role are in [Hosted onboarding](HOSTED-ONBOARDING.md#deploy-on-flyio).

Commands marked **live** change the running service or spend money; run them only when you mean to. Everything else only reads. You need membership in the Fly organization that owns `refit-hosted`; run `fly auth login` yourself.

## Quick checks

| Question                     | Command                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| Is it up?                    | `curl https://refit-hosted.fly.dev/health` → `{"status":"listening"}`                                    |
| Machine state and checks     | `fly status -a refit-hosted`                                                                             |
| Can it run a job?            | `fly ssh console -a refit-hosted -C "refit hosted health"`                                               |
| What ran recently?           | `fly ssh console -a refit-hosted -C "refit hosted jobs"`                                                 |
| Only failures since midnight | `fly ssh console -a refit-hosted -C "refit hosted jobs --status failed --since 2026-10-22"`              |
| One target                   | `fly ssh console -a refit-hosted -C "refit hosted jobs --target <id>"`                                   |
| Every target and its state   | `fly ssh console -a refit-hosted -C "refit hosted targets"`                                              |
| One job's receipt            | `fly ssh console -a refit-hosted -C "refit hosted receipt <job>"`                                        |
| Raw registry for one target  | `curl -H "Authorization: Bearer $REFIT_SERVICE_TOKEN" "https://refit-hosted.fly.dev/status?target=<id>"` |

`fly ssh console -C` runs the command on the Machine, where the app's secrets are already environment variables, so no database URL leaves Fly. From your own machine the same `refit hosted` commands work with `REFIT_DATABASE_URL` from the owner's private `~/.refit/hosted/` files; never paste it into a terminal or a file in the repository.

- `refit hosted jobs` lists the newest 50 matching jobs: id, status, the receipt's outcome, attempts (`r` marks an operator retry), creation time, target and repository.
- `refit hosted receipt <job>` prints the stored receipt (status, message, revision, doctor status) and its evidence path. On the Machine it also lists the evidence files under `/data/state/targets/<id>/runs/`.
- `refit hosted targets` prints each target's state, its last job and its last stored receipt.
- `refit hosted health` checks PostgreSQL, that the six `refit_*` tables exist and are writable by this role, the Docker daemon, and every image in `REFIT_HOSTED_IMAGES`. It exits 1 if any check fails. Before versioned migrations there is no schema version to compare, so it checks the tables only.

## Read logs

Each line the worker writes is one JSON object on stderr: `time`, `level` (`info` or `error`), `message`, and whichever of `job`, `target`, `installation` and `delivery` apply. Known secrets (the App key, webhook secret, service token, database URL and its password, OpenAI key, Slack webhook URL) and token-shaped strings are replaced with `[redacted]` before writing. The entrypoint's boot lines use the same shape.

```sh
fly logs -a refit-hosted                       # stream
fly logs -a refit-hosted --no-tail             # recent lines, then exit
fly logs -a refit-hosted --no-tail | grep -o '{.*}' | jq 'select(.level == "error")'
fly logs -a refit-hosted --no-tail | grep -o '{.*}' | jq 'select(.target == "<id>")'
```

`fly logs` keeps only recent lines. The evidence directory of each job is the durable record: `refit hosted receipt <job>` gives its path.

Lines that are not JSON come from other programs: the Docker daemon writes to `/var/log/dockerd.log` on the Machine, and a failed `docker pull` or a missing secret at boot prints the tool's own error before the worker starts.

## What each alert means

### Slack: `🚨 [URGENT] <repository>: hosted job <n> failed (<outcome>: <message>); see refit hosted receipt <n>.`

Sent when `REFIT_SLACK_WEBHOOK_URL` is set and a job ends `failed`, at most once per target per hour (the limit is in memory, so a restart can send one more). A failed job stays cached for its commit: the next scheduled run reuses it, so nothing retries by itself.

1. `refit hosted receipt <n>` and read the message.
2. Fix the cause, then [retry](#retry-a-job).

| Outcome and message                                                              | Meaning and fix                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interrupted`                                                                    | The worker stopped mid-job (deploy, restart, `fly secrets set`, lease renewal failure), before or during the workflow. Retry. `Job exceeded the 3600-second job timeout` means the job ran an hour; check `fly logs` for `CPU throttled:` before retrying it. |
| `error: Worker lease expired repeatedly…`                                        | Three workers in a row died holding this job: usually the Machine ran out of memory or crashed. Check `fly logs` for OOM, then retry.                                                                                                                         |
| `error: PipelineInputError: Repository now belongs to another App installation.` | The repository moved. Check the installation in GitHub before retrying.                                                                                                                                                                                       |
| `error: … Configured repository is unavailable, archived, disabled …`            | The App lost access or the repository was archived. Nothing to retry until access returns.                                                                                                                                                                    |
| `error: Managed Git … failed: …`                                                 | Fetching the repository failed (GitHub outage, revoked access). Retry once GitHub is reachable.                                                                                                                                                               |
| `error: Workflow failed during <stage>. … <ErrorName>: …`                        | The workflow stopped on an error in that stage, for example a dependency timeout or a Docker failure; the receipt ends with the error. The evidence directory keeps what completed.                                                                           |
| any other `error`                                                                | A pipeline failure. The evidence directory holds the details.                                                                                                                                                                                                 |

`needs-review` and `validation-failed` are not failures: the job finished and the receipt says what to review. They never send this notice. The workflow's own notices (draft PR ready, regression, publication failed partway) arrive as in `refit serve`; see [Slack notifications](SLACK.md).

### Fly health check critical, or `/health` does not answer

The worker process is not listening. `fly status` and `fly logs`: a crash loop shows the same error at every boot. The Machine restarts on a non-zero exit, up to 10 times in 5 minutes, then stays stopped. See [restore after a crash](#restore-after-a-crash).

### `refit hosted health` failures

| Check      | Failure means                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres` | The database is unreachable or refused the login. Check Supabase status, then the `REFIT_DATABASE_URL` secret ([rotate](#database-url-refit_database_url) if the password changed).               |
| `schema`   | Tables are missing (the worker never booted against this database, or it connects as the wrong role or schema) or the role cannot write them. The worker creates its tables on boot.              |
| `docker`   | The in-VM Docker daemon is down. Read `/var/log/dockerd.log` over `fly ssh console`; a restart starts it again.                                                                                   |
| `images`   | A validation image named in `REFIT_HOSTED_IMAGES` is missing, so doctor blocks every job that uses it. The entrypoint pulls them at boot; restart the Machine, or `docker pull <image>` over SSH. |

### Error log lines

| `message` starts with                       | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Webhook processing failed:`                | A signed delivery was not stored and GitHub got a 500. Fix the cause (usually the database), then redeliver it from the App's Advanced → Recent Deliveries page.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Lease renewal failed:`                     | The worker could not reach the database while a job ran; the job was stopped and will be `interrupted`.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Receipt not stored:` with a `job`          | This worker lost the job's lease before storing its result: another worker reclaimed the job, or it failed after repeated lease expiry. The line keeps the dropped result; `refit hosted receipt <n>` shows what was stored instead.                                                                                                                                                                                                                                                                                                                                 |
| `Slack notification not sent:`              | The Slack webhook failed or timed out. Jobs are unaffected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `CPU throttled:` with a `job`               | The host took at least a quarter of the machine's CPU time while that job ran (steal, from `/proc/stat`; jobs of 30 s or more). Shared vCPUs fall to their quota once the burst balance is spent, and installs and checks then hit their time limits. `refit hosted receipt <n>` shows the job's `CPU steal`. While full runs are queued, `fly scale vm performance-2x --memory 4096 -a refit-hosted` (**live**; it restarts the machine, so do it when no job runs), retry the jobs that stopped on a time limit, and scale back to the `fly.toml` size afterwards. |
| `error: …` or `interrupted: …` with a `job` | That job failed; its receipt has the same message.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

`Lease lost or job cancelled; stopping.` (info) means the repository or installation was removed, or another worker reclaimed the job. GitHub shows 401 for deliveries signed with an old webhook secret and 409 for a reused delivery id with a different body; neither changes state.

## Deploy

**Live.** Deploy from a clean checkout of the commit being shipped.

1. Run the hosted tests against a local PostgreSQL ([Hosted onboarding](HOSTED-ONBOARDING.md#implemented-single-tenant-hosted-worker)) and `npm test`.
2. [Drain](#drain-the-worker): `refit hosted pause`, then wait until no job is running.
3. `fly deploy -a refit-hosted`. Fly builds the image from `Dockerfile`, replaces the Machine and keeps the volume. The Machine comes back still paused, at the `[[vm]]` size in `fly.toml` (shared-cpu-2x). `--vm-size` does not override that section.
4. Verify: `curl https://refit-hosted.fly.dev/health`, `fly status`, then `fly ssh console -C "refit hosted health"`.
5. `fly scale vm performance-2x --vm-memory 4096 -a refit-hosted` for the first round. That round never reuses a receipt ([Unchanged polls](#unchanged-polls)), and a target whose scan changed runs in full. On a throttled shared vCPU a full run can stop at the 300-second dependency limit: job 1024, after the 2026-10-24 deploy, ran at 55% CPU steal.
6. `fly ssh console -a refit-hosted -C "refit hosted resume"`, then retry any job the deploy interrupted (`refit hosted jobs --status failed`). The worker notices the resume when its loop next wakes, up to one polling interval (300 s) later.
7. When that round ends, pause, wait until no job is running, run `fly scale vm shared-cpu-2x --vm-memory 4096 -a refit-hosted`, and resume.

## Roll back to the previous image

**Live.** No rebuild: Fly keeps each release's image in its registry.

```sh
fly releases -a refit-hosted --image        # find the last good release's image
fly deploy -a refit-hosted --image registry.fly.io/refit-hosted:deployment-<id>
```

Then verify as after a deploy. The worker only adds tables and columns on boot, so an older image runs against a schema a newer one created. A rollback never undoes database rows.

## Unchanged polls

A scheduled poll first reads the base branch head through the GitHub API. If it, the approval fingerprint and the worker build match the target's last finished job, and that job's doctor result was ready and its contracts are committed files, the worker stores the earlier receipt with `unchangedSince: <job>` and logs `<status>: unchanged since job <job> at <revision>; nothing ran.` The job does not count against `REFIT_HOSTED_DAILY_JOBS`. A push to the base branch, a new approval or a deploy (a new `FLY_IMAGE_REF`) makes the next poll run in full; so does a change to `--ai-patch`, `OPENAI_MODEL`, `--repair-attempts` or `--publish-draft`. To rerun a target without any of those, [retry](#retry-a-job) it. Without `FLY_IMAGE_REF` (a local `refit hosted serve`), every poll runs.

## Retry a job

**Live, and may spend.** A failed or interrupted result stays cached for its commit until an operator retries it.

```sh
fly ssh console -a refit-hosted -C "refit hosted retry --target <id>"
```

It queues one fresh attempt, or marks the already-queued job as a retry. It refuses while the target has a running job and for a target that is not enrolled. Approval and access gates still apply. With `--ai-patch` in `REFIT_HOSTED_FLAGS`, a retried job can spend the installation's AI budget, and with `--publish-draft` it can open a draft PR.

## Change the AI cap

Each installation's ledger and the ledger across installations store the limit they were created with. A worker whose `REFIT_AI_BUDGET_USD` or `REFIT_HOSTED_AI_BUDGET_USD` differs from the stored limit refuses every AI request (`AI budget state is invalid or its configured limit changed`), so changing a cap takes three steps, run when no job runs:

```sh
fly ssh console -a refit-hosted -C "refit hosted ai-budget"   # read-only: limit, spend and open reservations per ledger
fly secrets set -a refit-hosted --stage REFIT_AI_BUDGET_USD=10 REFIT_HOSTED_AI_BUDGET_USD=10
fly ssh console -a refit-hosted -C "refit hosted ai-budget --limit 10 --total-limit 10"
fly machine restart -a refit-hosted
```

**Live, and may spend.** `--limit` and `--total-limit` move every recorded installation's ledger and the shared one to the new limit and keep their recorded spend; an earlier worker's file ledger under `REFIT_AI_BUDGET_DIRECTORY` is imported first. They refuse while a job runs. A secret overrides the `fly.toml` value of the same name ([Fly configuration](https://docs.fly.io/reference/configuration)). Between the ledger change and the restart the old worker refuses AI requests, which fails closed. While `REFIT_HOSTED_AI_BUDGET_USD` is unset, the limit across installations follows `REFIT_AI_BUDGET_USD`, so a change to `REFIT_AI_BUDGET_USD` also needs `--total-limit` with the same value. To return to the `fly.toml` value, move both ledgers back (`--limit 2 --total-limit 2`), then `fly secrets unset -a refit-hosted --stage REFIT_AI_BUDGET_USD REFIT_HOSTED_AI_BUDGET_USD` and restart; unsetting only `REFIT_AI_BUDGET_USD` leaves the $10 total secret, and the worker then refuses every AI request.

Open reservations are requests that reserved their maximum cost and never settled, for example because the job failed after the request was sent. They still count against the limit.

## Drain the worker

`refit hosted pause` stops every worker from starting jobs until `refit hosted resume`, across deploys and restarts. Running jobs finish, queued jobs wait, and webhooks are still recorded and queue jobs. The worker logs `Paused since <time>; no job starts until refit hosted resume.` and `/status` shows `paused`.

```sh
fly ssh console -a refit-hosted -C "refit hosted pause"
fly ssh console -a refit-hosted -C "refit hosted jobs --status running"   # repeat until it lists nothing
fly deploy -a refit-hosted                                                # or restart, scale, set secrets
fly ssh console -a refit-hosted -C "refit hosted resume"
```

Without a pause, a stop still lets a short job finish. On the first `SIGINT` or `SIGTERM`, the worker stops claiming and exits once its running job finishes. Fly sends `SIGINT`, waits `kill_timeout` (300 seconds in `fly.toml`, Fly's maximum), then sends `SIGTERM`. The worker treats that second signal as a stop: it aborts the job, stores its receipt (`interrupted`, or `error` when the abort lands inside validation) and exits. Either needs a [retry](#retry-a-job). A scheduled poll on an unchanged target takes about a second, and a job that validates can take most of an hour, so pause before any deploy while a validation runs.

To stop new work and the machine, `fly machine stop -a refit-hosted` (**live**). Webhook deliveries fail while it is stopped; GitHub shows them as failed, and you can redeliver them after `fly machine start`.

## Rotate each secret

Secrets live only in `fly secrets` and the owner's private `~/.refit/hosted/` files. Write each new value to a file there (`chmod 600`) and set it from the file, never from a literal or a placeholder:

```sh
fly secrets set NAME="$(cat ~/.refit/hosted/<file>)" -a refit-hosted          # restarts the Machine
fly secrets set NAME="$(cat ~/.refit/hosted/<file>)" -a refit-hosted --stage  # applies at the next deploy or `fly secrets deploy`
```

Setting a secret restarts the Machine, which interrupts a running job: drain first. `fly secrets list` shows names and digests only; compare digests to confirm a change.

| Secret                                                | Rotate                                                                                                                                                                                                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_APP_PRIVATE_KEY`                              | In the App's settings (owned by `refit-dev`, under its Developer settings), generate a new private key. Set it, confirm a job runs, then delete the old key there. Both keys work until the old one is deleted.                                       |
| `REFIT_WEBHOOK_SECRET`                                | GitHub keeps one secret, so deliveries between the two changes fail with 401. Stage the new value with `--stage`, paste it into the App's Webhook secret, then run `fly secrets deploy` at once. Redeliver any 401 deliveries from Recent Deliveries. |
| `REFIT_SERVICE_TOKEN`                                 | `openssl rand -hex 32` into the file, then set it. It must differ from the webhook secret. Only `/status` callers need the new value.                                                                                                                 |
| `REFIT_DATABASE_URL`                                  | See [below](#database-url-refit_database_url).                                                                                                                                                                                                        |
| `OPENAI_API_KEY`                                      | Create a new key in the OpenAI dashboard, set it, confirm, then revoke the old key. Budget ledgers on the volume are unaffected.                                                                                                                      |
| `REFIT_SLACK_WEBHOOK_URL`                             | Optional; set only to turn failed-job notices on. Create a new incoming webhook for the channel, set it, then remove the old one in Slack.                                                                                                            |
| `GITHUB_APP_ID`, `REFIT_HOSTED_OWNER`, `OPENAI_MODEL` | Not secret. Change them only to move to another App, another owner (an owner decision) or another model.                                                                                                                                              |

### Database URL (`REFIT_DATABASE_URL`)

The worker connects as the `refit_hosted` role. Do not switch it to `postgres` or the service key.

1. Generate a new password locally and compute its SCRAM verifier against a local PostgreSQL, so Supabase only ever receives the verifier (`SET password_encryption = 'scram-sha-256'`, set the password on a throwaway local role, read `rolpassword` from `pg_authid`).
2. In Supabase's SQL editor, `ALTER ROLE refit_hosted PASSWORD '<verifier>'`. The running worker's open connections keep working; new ones fail until the next step.
3. Write the new URL (same form as in [Hosted onboarding](HOSTED-ONBOARDING.md#deploy-on-flyio)) to its file and set the secret. The Machine restarts with it.
4. `fly ssh console -C "refit hosted health"`.

## Restore after a crash

- **Worker crash.** Fly restarts the Machine on a non-zero exit. A job running at the crash keeps its lease until it expires (5 minutes); the restarted worker then reclaims it, up to three attempts in total, after which it fails with `Worker lease expired repeatedly`. A reclaimed job whose evidence was incomplete is stored as `interrupted`. Check `refit hosted jobs --status running` and `--status failed`, and retry what needs it.
- **Crash loop.** After 10 restarts in 5 minutes the Machine stays stopped. Read `fly logs` for the repeated boot error (a bad secret, the database, Docker), fix it, then `fly machine start` (**live**) or [roll back](#roll-back-to-the-previous-image).
- **Database unreachable.** The worker exits when a query fails and Fly restarts it; once PostgreSQL answers again, jobs resume from their leases. If the outage outlasts Fly's restart limit, the Machine stays stopped: `fly machine start` (**live**) once Supabase answers.
- **Lost volume.** The volume holds evidence, managed checkouts, AI budget ledgers and Docker images; the database does not depend on it. Fly snapshots volumes daily (5 days by default): `fly volumes list`, `fly volumes snapshots list <volume>`, then `fly volumes create refit_data --snapshot-id <snapshot> -s 20 --region iad` (**live**). A Machine keeps the volume it was created with, so the restored volume needs a new Machine (`fly machine destroy` the old one, then `fly deploy`); confirm in `fly volumes list` that the restored volume is the attached one before deleting anything else. Without a snapshot, a fresh volume works: the entrypoint pulls images and jobs re-create checkouts, but evidence paths in older receipts no longer exist and cached results are gone, so every target runs again, which can spend AI budget again.
- **Lost database.** Restore from Supabase's backups. Approvals must be stored again with `refit hosted approve` if they are not in the restored data.
