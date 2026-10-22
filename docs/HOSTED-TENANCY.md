# Hosted tenancy

Status: **implemented, not deployed.** By default only `REFIT_HOSTED_OWNER`'s installations are allowed, so the deployed behaviour is unchanged until the owner lists another account. This page covers what separates installations in `refit hosted serve` and what does not. For the worker itself, see [hosted onboarding](HOSTED-ONBOARDING.md#implemented-single-tenant-hosted-worker).

## Allowed accounts

`REFIT_HOSTED_ACCOUNTS` lists the GitHub accounts (users or organizations) whose installations may enroll, separated by commas or spaces. Without it, the list is `REFIT_HOSTED_OWNER` alone. When it is set, it replaces the owner default, so the owner must list their own account too. Logins are matched case-insensitively.

- **Allowed account.** Installation webhooks record the installation and its repositories. Repositories with a stored approval enroll, exactly as before.
- **Other accounts.** A signed `installation` or `installation_repositories` delivery from another account gets `202` with `status: "not-allowed"`. Refit records the installation ID, login, state and the repository names and IDs from the payload. It enrolls nothing, queues no job, makes no GitHub API call and clones nothing. A stored approval does not change this.
- **Allowing an account later.** The worker applies the list when it starts. If a restart adds an account, its active installations enroll every recorded repository that has an approval, and their jobs are queued. Nothing has to be redelivered.
- **Removing an account.** If a restart drops an account, its targets are cancelled with "Account is no longer allowed." and their open jobs are cancelled, the same as an uninstall. Recorded rows stay.

Allowing an account never runs anything by itself: every repository still needs a stored `refit hosted approve` receipt. Approval, access confirmation and the fingerprint check are unchanged.

## Guardrails per installation

| Guardrail | Setting | Refusal in `/status` |
| --- | --- | --- |
| Allowed account | `REFIT_HOSTED_ACCOUNTS` | `account-not-allowed` |
| At most one running job per installation | fixed | `installation-job-running` |
| Daily job cap | `REFIT_HOSTED_DAILY_JOBS`, default 1440 (five targets polled every 300 seconds) | `daily-job-cap` |
| Daily inventory cap | `REFIT_HOSTED_DAILY_INVENTORIES`, default 500 | `daily-inventory-cap` |

- A job counts against the cap when a worker first claims it. Reclaiming the same job after an expired lease does not count again. Days run in UTC. A job held back by a cap stays queued and runs after midnight UTC.
- Inventories count through the store's `reserveInventory(installationId)`. It returns `account-not-allowed` for a disallowed, suspended or deleted installation, and `daily-inventory-cap` once the cap is reached. Approval issues ([lane PG2](HOSTED-ONBOARDING-APPROVAL.md)) count each issue inspection through it. The install inventory, planned in lane PG1, is meant to be its other caller.
- Claims are serialized by a PostgreSQL advisory lock, so two workers never start jobs for one installation at the same time. A running job whose lease has expired no longer blocks its installation.
- **Fair claiming.** A worker takes the next job from the installation that was claimed least recently, and job order only breaks ties. One installation with many queued jobs therefore takes turns with the others instead of running all of its jobs first. `pipeline/hosted-tenancy.test.ts` shows this with a noisy installation that has four jobs queued ahead of a quiet one.
- `/status` adds `allowed`, `jobsToday`, `inventoriesToday` and `refusals` to each installation, and `waiting` to each job. `waiting` names the refusal that holds back a queued job, or is `null`.
- `refit hosted accounts` prints the same information per installation. Run it with the worker's `REFIT_HOSTED_ACCOUNTS` (or `REFIT_HOSTED_OWNER`) and cap settings. The allow state it shows is the one the serving worker last applied.

## GitHub rate limits

Every GitHub API request (`pipeline/github.ts`) follows [GitHub's documented handling](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit) of `403` and `429` responses:

1. If `retry-after` is present, it waits that many seconds.
2. Otherwise, if `x-ratelimit-remaining` is `0`, it waits until `x-ratelimit-reset`.
3. Otherwise, a `429`, or a `403` whose message names a secondary rate limit, waits 60 seconds, then 120.

Each wait is at most 120 seconds, with at most two retries. A longer wait, such as an exhausted hourly limit, fails at once with `GitHubRateLimitError`, which names the seconds GitHub asked for. A `403` without rate-limit signs, such as a missing permission, is not retried. The tests use a fake GitHub that returns these headers; no live rate limit was observed. Waits do not observe job cancellation, so a cancelled job may wait out the current limit, at most 120 seconds per request.

## AI budget per installation

With `--ai-patch`, each installation's ledger is one row in `refit_ai_ledgers`, keyed by installation ID and capped at `REFIT_AI_BUDGET_USD`. Reservations take a row lock, so concurrent requests cannot overspend one ledger. One installation's reservations never touch another's. Earlier workers kept a file per installation (`installation-<id>/budget.json` under `REFIT_AI_BUDGET_DIRECTORY`). On first use, that file is imported, so recorded spend carries over. Local `refit run` keeps its file ledger.

## What is isolated today, and what is not

Today every job runs inside the one worker Fly Machine, in its Docker daemon.

Separated per installation:
- Database rows are keyed by installation. Targets, jobs, usage and AI ledgers belong to one installation.
- Each checkout uses an installation token scoped to exactly that repository with `contents: read`. Publication tokens are scoped the same way.
- The job and inventory caps, one running job at a time, fair claiming and a separate AI ledger all apply per installation.
- Validation containers are offline and non-root. They get no host environment, Git metadata or Docker socket, and have CPU, memory, process and workspace limits (see [architecture](ARCHITECTURE.md)).

Shared by every allowed account:
- The machine, its Docker daemon and the `/data` volume. Managed checkouts and evidence of every target persist there under `/data/state/targets/<id>`.
- The worker process, which holds the App private key, the database URL and the OpenAI key.
- Dependency preparation, which runs with registry network access (lifecycle scripts disabled) on the same daemon.

So one customer's repository code runs in offline containers on the same machine as the owner's repositories and the worker's secrets. A container escape or Docker daemon flaw would expose them. The Fly Machine is a Firecracker VM separate from other Fly apps, but it is not a boundary between Refit's own tenants. This is why `AGENTS.md` keeps hosted mode to the owner's account until per-job isolation exists.

### With per-job machines (planned, lane PG3)

Lane PG3 plans `--job-machines` (off by default). Each job would run on its own short-lived Fly Machine that receives only that job's inputs, approval, allowed images and budget, and no database credentials or App private key. The machine is destroyed when the job ends. That would remove the shared Docker daemon and the shared checkout volume from job execution. The control process would still hold the webhooks, the database and the App key. None of this is merged or verified in this lane; see PG3's `docs/HOSTED-ISOLATION.md`.

The AI ledger is now in PostgreSQL. A job machine without database credentials therefore cannot reserve budget itself; reservations would have to go through the control process.

## Needs owner decision

- **Add the first customer account.** Set `REFIT_HOSTED_ACCOUNTS=<owner>,<customer>` with `fly secrets set` and restart the worker. Until per-job machines exist, this puts the customer's code on the shared machine described above. Options:
  - (a) wait for PG3's job machines;
  - (b) accept the shared machine for one trusted pilot, with `--ai-patch` and `--publish-draft` decided separately.
- **Cap defaults.** This lane chose 1440 jobs and 500 inventories per installation per UTC day. Neither is measured against real customer traffic.
