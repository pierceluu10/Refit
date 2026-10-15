# Hosted onboarding (design proposal)

Status: **proposal, not implemented.** The decisions at the end need the owner's choice before any code is written.

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

## Decisions needed

- **Hosting platform:** for example Fly.io Machines (Firecracker), AWS (ECS plus Firecracker or Fargate), or GCP Cloud Run with gVisor. This decides the isolation model and cost.
- **Data store:** managed PostgreSQL plus S3-compatible storage. Confirm the provider and region, which affects data residency.
- **AI provider and billing:** a platform-paid model with per-tenant caps, or customer-supplied keys.
- **Scope of the first hosted release:** scanning and review evidence only, or validation and draft PRs from day one.
- **Repository code retention:** this proposal keeps none after a job, and evidence keeps only diffs and logs.

Until these are decided, the supported path stays the local agent and the App-managed local service.
