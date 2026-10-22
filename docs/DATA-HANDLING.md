# Data handling

How the hosted Refit service handles a customer's repositories. Each statement describes the code on `main` and the deployment recorded in [hosted onboarding](HOSTED-ONBOARDING.md#deploy-on-flyio), A feature marked **off by default** does nothing unless the operator turns it on. What is stored and for how long is in [installing Refit Agent](INSTALL.md#what-refit-stores-and-for-how-long).

## Where data lives

- **Worker:** one Fly.io Machine, app `refit-hosted`, in Fly's `iad` region (Ashburn, Virginia, United States), with a 20 GB volume mounted at `/data` (`fly.toml`). Managed checkouts, run evidence, the AI spend file and the Docker daemon's data are on that volume.
- **Database:** Supabase PostgreSQL in AWS `us-east-1` (Northern Virginia, United States). The worker connects over TLS (`sslmode=require`) as a dedicated role that owns only the `refit_*` tables. The tables have row-level security on and no policies, so Supabase's Data API exposes none of them.
- **Logs.** Refit adds no object storage, analytics or log shipping. Fly keeps the worker's standard output (`fly logs`): progress messages that name repositories, job outcomes and errors, with known secrets redacted. Backups are whatever Fly and Supabase keep for the volume and database; Refit has not reviewed them.

The hosted service runs for the accounts its operator allows (`REFIT_HOSTED_ACCOUNTS`). Every allowed account's jobs run on the same machine and in the same database, which is not a boundary between customers. With `--job-machines` (**off by default**) each job runs on its own Fly Machine in a separate app that holds no secrets.

## Subprocessors

| Service | What it receives | When |
|---|---|---|
| Fly.io | Everything the worker holds: checkouts, evidence, logs, secrets | Always |
| Supabase (on AWS) | The database records in [what Refit stores](INSTALL.md#what-refit-stores-and-for-how-long), including inventories as file paths, line numbers and match counts; no source lines or file contents | Always |
| OpenAI | The excerpts described [below](#ai-usage) | Only when AI patches are on and a supported migration needs one |
| npm registry (`registry.npmjs.org`) | Requests for the exact package versions in your committed lockfile, from the worker's address | Only when `.refit.json` asks Refit to prepare dependencies |
| Slack | The worker's notices and failed jobs: repository names, job outcomes and error text, with known secrets redacted | **Off by default**; only when the operator sets `REFIT_SLACK_WEBHOOK_URL` |

GitHub is where the data comes from and where draft pull requests go; it is not a processor Refit adds. The Docker images that run checks are pulled by the operator ahead of time; jobs run with `--pull never` and download no images.

## AI usage

- **When:** only for a repository whose configuration is approved, only when the worker runs with `--ai-patch`, and only for findings Refit has already confirmed in the code. The deployed worker has AI patches on (`REFIT_HOSTED_FLAGS` in `fly.toml`). Repository approval does not ask about AI separately; it is a worker setting.
- **Whose key:** the operator's own OpenAI API key (`OPENAI_API_KEY`), with a spending cap per installation (`REFIT_AI_BUDGET_USD`). A request whose maximum cost would exceed what is left is not sent (`pipeline/ai-budget.ts`).
- **What is sent:** the confirmed findings, the files that contain them, a bounded amount of nearby context from the repository, and any saved provider documentation. When a patch fails its checks and repair attempts are on (the deployed worker allows two), the next request also carries the failed patch and the check's output, truncated. Each request is at most 64 KiB (`pipeline/ai-patches.ts`, `pipeline/openai.ts`). Requests use the Responses API with `store: false`. Nothing else in the repository is sent. The worker's own tokens and keys are never part of the evidence, but the files are sent as they are: a secret committed in an affected file would be sent too.
- **Training:** OpenAI's [your data](https://developers.openai.com/api/docs/guides/your-data) page states that data sent to the API is not used to train or improve OpenAI models unless the organization opts in, and that abuse-monitoring logs are kept for up to 30 days (read 2026-10-22). Refit cannot check the operator's OpenAI data-sharing setting; the operator is responsible for leaving it off.
- **Review:** an AI patch goes through the same checks as any other change and, if drafts are on, becomes a draft pull request for a person to review. Refit never merges.

## What stays inside the sandbox

Refit's own scanner reads the checkout on the worker and parses files; it never executes them. Anything that runs repository code runs in a Docker container (`pipeline/docker-sandbox.ts`):

- Checks run with `--network none`, so code under test cannot send anything anywhere. Dependency preparation is the only step with network access, and it installs only lockfile entries with integrity hashes from the public registry, with install scripts disabled.
- The container gets the repository's files read-only, a temporary workspace, a non-root user, no Linux capabilities and limits on memory, CPU and processes. Its only environment variable is `CI=true`: GitHub tokens, the OpenAI key, the database URL and other secrets never enter it.
- What comes out is check output and exit codes, kept as evidence on the worker's volume; with AI repair attempts on, a failed check's output also goes to OpenAI as described above. The patch itself is applied outside the container and, if drafts are on, pushed to your repository as a draft branch.

All jobs share the worker's Docker daemon inside one Fly Machine (a Firecracker VM separate from other Fly apps). That is not a boundary between allowed accounts unless `--job-machines` is on.

## Deletion

Uninstalling deletes the installation's inventories at once. With `--purge-uninstalled` (**off by default**), the worker deletes an uninstalled installation's repository rows, job records and checkouts seven days later. Otherwise, on request, the operator deletes a customer's rows from the `refit_*` tables and their directories under `/data/state/targets/` by hand.
