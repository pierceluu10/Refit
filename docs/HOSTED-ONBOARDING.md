# Hosted onboarding (design proposal)

Status: **owner decisions recorded 2026-10-21; single-tenant worker implemented, not yet deployed.** `refit hosted` runs the hosted worker on PostgreSQL (see [what is implemented](#implemented-single-tenant-hosted-worker) and [deployment](#deploy-on-flyio)). Nothing is hosted for other customers.

## Goal

A customer installs the Refit GitHub App on selected repositories, reviews and approves a committed `.refit.json`, and later receives human-reviewed draft PRs from Refit Agent, without running a local worker. Everything Refit does locally today stays the source of truth: the scanner, contract comparison, migration rules, AI budget, isolated validation, evidence and publication. Hosting changes where the work runs and who may trigger it, not what it is allowed to do. See [architecture](ARCHITECTURE.md#hosted-product-target).

## What already exists

- **Verified webhook intake** (`refit serve`): raw-byte HMAC, deduplicated delivery receipts, installation inventory, access removal that cancels workers. See [local service](LOCAL-SERVICE.md).
- **Explicit approval** (`refit enroll`): a fingerprint-bound receipt over the committed workflow, baseline and adapter. Changed inputs stop for review. See [App onboarding](APP-ONBOARDING.md).
- **Scoped tokens**: separate installation tokens for checkout and publication, never persisted in URLs or configuration.
- **Durable local jobs**: receipts, locks, no automatic paid retries, and explicit retry after failure.
- **Evidence**: hashed manifests, PR bodies that state what was and was not proven, and no auto-merge.

## Proposed hosted shape

1. **Installation ownership.** A GitHub OAuth sign-in proves that the user administers the installation's account. Only those users can approve repositories. Approvals are stored server-side with the same fingerprint the local receipt uses, plus who approved and when.
2. **Enrollment flow.** For each selected repository, the site runs `doctor` against the committed `.refit.json`, without executing application code. It shows the readiness report and the exact fingerprint, then records approval. Nothing runs for repositories that are installed but not approved.
3. **Durable jobs.** PostgreSQL holds installations, approvals, provider baselines, jobs, leases and receipts. Workers take jobs with time-limited leases. The existing job identity (revision, contracts, configuration, breaking changes) keeps deduplication. Failed jobs stay failed until a user retries them, as they do locally.
4. **Workers.** Stateless containers run the shared core with the same restrictions as today: network only for dependency preparation, and none for checks. Each job gets a fresh VM or microVM (for example Firecracker or gVisor), not a shared Docker host. Local Docker isolation is not a multi-tenant boundary.
5. **Budgets.** Each installation gets its own AI ledger with an explicit monthly cap. AI stays opt-in per repository in the approved configuration. The platform key is never exposed to repository code.
6. **Evidence storage.** Object storage holds manifests, patches, logs and dependency archives, encrypted per tenant with retention limits. The dashboard reads from it. Repository source is not retained after a job.
7. **Audit.** Approvals, retries, AI spend, publications and access changes are append-only records that customers can see.

## Milestones

1. Multi-tenant data model and OAuth installation ownership, with no execution.
2. Hosted enrollment: doctor, review and approval in the browser, reusing the local fingerprint.
3. Single-tenant hosted worker for the owner's own installation, with leases and retries, scanning and validation only.
4. Isolation upgrade to per-job microVMs, then a pilot for a second tenant with draft PRs.
5. Per-tenant AI budgets and the audit log, then early access.

## Implemented: single-tenant hosted worker

`refit hosted serve` replaces the tunnel and the static service file with PostgreSQL state. It reuses the local service's webhook verification, the `refit enroll` fingerprint, `pollServiceTarget` and `watchOnce`; there is no second orchestration path.

1. **Approval.** `refit hosted approve --approval <receipt.json> --approved-by <login>` stores a receipt made by `refit enroll`. Until OAuth ownership exists (milestone 1), only someone with database access can approve.
2. **Enrollment.** A signed `installation` or `installation_repositories` webhook records the installation and its repositories. Each installed repository with a stored approval becomes a target (one per approved integration), and one job is queued. Installed repositories without an approval are recorded and never run. Approving an already installed repository enrolls it immediately.
3. **Jobs and leases.** Workers claim jobs with `FOR UPDATE SKIP LOCKED` and a time-limited lease that they renew while running. An expired lease is reclaimed by another worker, up to three attempts, after which the job is marked failed. At most one job per target is open at a time, and enrolled targets are queued again after the polling interval.
4. **Pipeline.** Each job confirms repository access through the GitHub API, verifies the approved inputs on a fresh App-managed checkout, runs `refit doctor`, then scans and validates with the approved checks in offline Docker. Blocked doctor checks stop the job before scanning. The job receipt (status, evidence path, revision, doctor status) is stored in PostgreSQL.
5. **Cancellation.** Removing a repository, or deleting or suspending the installation, cancels its targets and open jobs in the same transaction that records the delivery. Running jobs in the same process are aborted immediately; jobs in other processes stop at their next lease renewal. A cancelled job keeps whatever evidence it produced. Re-adding the repository enrolls it again.

6. **AI and draft PRs.** `--ai-patch` uses the owner's `OPENAI_API_KEY` with a separate ledger per installation (`installation-<id>` under `REFIT_AI_BUDGET_DIRECTORY`), each capped at `REFIT_AI_BUDGET_USD`. `--publish-draft` opens draft PRs as Refit Agent through the existing publication path. Both stay explicit flags.
7. **Single owner.** `REFIT_HOSTED_OWNER` names the only GitHub account whose installations are recorded or enrolled. Other accounts' deliveries are acknowledged and ignored. This holds until jobs run in per-job microVMs.

Not yet included: OAuth installation ownership and a browser approval flow, object storage for evidence (it stays on the Fly volume under `/data/state`), per-job microVMs and the audit log. Validation uses the Docker daemon inside the worker's Fly Machine. That machine is a Firecracker VM separate from other apps, but all jobs share it, which is why hosting stays single-owner.

The end-to-end test in `pipeline/hosted-service.test.ts` runs when `REFIT_POSTGRES_URL`, `REFIT_DOCKER_IMAGE` and `REFIT_OASDIFF` are set. For example, with a disposable database:

```sh
docker run -d --name refit-hosted-pg -e POSTGRES_USER=refit -e POSTGRES_PASSWORD=refit-local-test -e POSTGRES_DB=refit -p 127.0.0.1:55432:5432 postgres:17-alpine
REFIT_POSTGRES_URL=postgres://refit:refit-local-test@127.0.0.1:55432/refit REFIT_DOCKER_IMAGE=node:22-alpine REFIT_OASDIFF=1 npx vitest run pipeline/hosted-service.test.ts
```

## Deploy on Fly.io

`Dockerfile`, `fly.toml` and `scripts/hosted-entrypoint.sh` build the worker from the release tarball. The image adds oasdiff 1.33.0, git and a Docker daemon that keeps its data on the `/data` volume. The machine never idle-stops, because leases renew between webhooks.

1. Use the `refit-hosted` Supabase project (us-east-1, next to Fly's `iad`). The worker applies its [schema migrations](HOSTED-DATA.md#schema-migrations) on boot, with row-level security and no policies, so Supabase's Data API exposes nothing. It connects as a dedicated `refit_hosted` login role that owns the Refit tables, not as `postgres`: create the role with a generated password (send Supabase only its SCRAM verifier), `GRANT refit_hosted TO postgres`, grant it `USAGE, CREATE` on `public` and make it the owner of the `refit_*` tables. The URL is `postgresql://refit_hosted.<project-ref>:<password>@aws-0-us-east-1.pooler.supabase.com:5432/postgres?uselibpqcompat=true&sslmode=require` (session pooler, IPv4). Without `uselibpqcompat=true`, node-postgres treats `require` as full verification, which Supabase's pooler certificate chain fails.
2. Install `flyctl`, run `fly auth login`, then `fly launch --no-deploy --copy-config` and `fly volumes create refit_data --size 20 --region iad`.
3. Set secrets with `fly secrets set`: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (the PEM contents), `REFIT_WEBHOOK_SECRET`, `REFIT_SERVICE_TOKEN`, `REFIT_DATABASE_URL`, `REFIT_HOSTED_OWNER`, `OPENAI_API_KEY`, `OPENAI_MODEL`. `REFIT_HOSTED_IMAGES` in `fly.toml` lists the validation images that approved repositories name; the entrypoint pulls them on boot, because validation runs with `--pull never`.
4. `fly deploy`, then open the App's settings (Refit Agent is owned by the `refit-dev` organization, so they are under its Developer settings, not a repository's Webhooks page). Under Webhook, tick Active, set the URL to `https://<app>.fly.dev/github/webhook` and paste `REFIT_WEBHOOK_SECRET`. Stop any local `refit serve` that used the old URL.
5. Store approvals with `REFIT_DATABASE_URL=... refit hosted approve --approval <receipt.json> --approved-by <login>`, then install the App on those repositories. Choosing "All repositories" again on an existing installation sends no event; uninstall and reinstall, or remove and re-add the repository, to deliver one.

### Operate the deployed worker

- `GET /health` is public. `GET /status` with `Authorization: Bearer $REFIT_SERVICE_TOKEN` lists installations, targets and jobs with their receipts.
- `fly logs -a refit-hosted` shows each job's progress lines, prefixed with the target id. `fly ssh console -a refit-hosted` reaches the volume; evidence lives under `/data/state/targets/<id>/runs/`.
- A failed job stays cached for its commit, so the next scheduled run reuses it instead of paying again. After fixing the cause, `REFIT_DATABASE_URL=... refit hosted retry --target <id>` queues one fresh attempt (or marks the already-queued job); successful jobs remain cached, and approval and access gates still apply. A running job must finish first.
- The worker keeps running through PostgreSQL outages and deletes an uninstalled installation's targets, jobs and evidence after a 7-day grace period. `REFIT_DATABASE_URL=... refit hosted migrate --dry-run` lists pending schema migrations. Tables, retention, migrations and backups are in [Hosted data](HOSTED-DATA.md).
- Before changing hosted code, run the hosted tests against a local PostgreSQL: `REFIT_POSTGRES_URL=postgres://… REFIT_DOCKER_IMAGE=node:22-alpine REFIT_OASDIFF=1 REFIT_POSTGRES_OUTAGE_IMAGE=postgres:17-alpine npx vitest run pipeline/hosted-*.test.ts`. Deploy with `fly deploy` from a clean checkout of the branch being shipped.

## Owner decisions (2026-10-21)

- **Hosting platform:** Fly.io Machines.
- **Data store:** Supabase PostgreSQL in us-east-1 (project `refit-hosted`, created 2026-10-22). Evidence stays on the Fly volume until object storage is added.
- **AI provider and billing:** the owner's own API key, with a capped ledger per installation.
- **Scope of the first hosted release:** validation and draft PRs from day one, limited to the owner's own account until per-job microVMs exist.
- **Repository code retention:** still open. Managed checkouts currently persist on the volume between jobs to support deduplication.

## Decisions originally requested

- **Hosting platform:** for example Fly.io Machines (Firecracker), AWS (ECS plus Firecracker or Fargate), or GCP Cloud Run with gVisor. This decides the isolation model and cost.
- **Data store:** managed PostgreSQL plus S3-compatible storage. Confirm the provider and region, which affects data residency.
- **AI provider and billing:** a platform-paid model with per-tenant caps, or customer-supplied keys.
- **Scope of the first hosted release:** scanning and review evidence only, or validation and draft PRs from day one.
- **Repository code retention:** this proposal keeps none after a job, and evidence keeps only diffs and logs.

Until these are decided, the supported path stays the local agent and the App-managed local service.
