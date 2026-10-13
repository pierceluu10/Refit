# Local API monitoring with Refit 0.4

Refit has a local polling worker that captures an OpenAPI source, compares it with a retained baseline, scans a repository, and processes each migration once. AI generation and GitHub publication are explicit options. Start with a single poll; remove `--once` to keep the worker running while your computer is on.

This is the operator workflow for the installed Refit Agent. A customer installing the GitHub App does not yet start a hosted worker. The frontend is still illustrative.

For several configured repositories and signed installation webhooks, use the [local service](LOCAL-SERVICE.md). It includes startup App access discovery, protected status, persisted delivery deduplication and HTTPS tunnel instructions. The commands below remain useful for a single target or an explicit retry.

## Prerequisites

- Node.js 22.12+ or a supported newer release and the installed `refit` CLI.
- `oasdiff` on PATH for the shared contract comparison. On macOS: `brew install oasdiff`. The evaluated version was 1.33.0; verify with `oasdiff --version`.
- A clean, committed local repository. Publication requires its HEAD to equal the GitHub base branch.
- A running Docker daemon and a prepared local check image. Dependencies are installed when preparing the image; migration checks run with networking disabled.
- An explicit JSON run configuration. Paths in it are relative to the configuration file. Credentials belong in a separate local `.env`.

From the source checkout, `node bin/refit.mjs` works wherever the examples below use `refit`. See [the CLI guide](CLI.md) and [GitHub App setup](GITHUB-APP.md). Keep state outside the monitored repository.

## Repeat the verified Stripe App run

On Pierce's existing machine, the image, adjacent billing repository, App installation, and `.env` are already configured:

```sh
cd /Users/pierceluu/Repos/Refit
REFIT_AI_BUDGET_USD=2 \
REFIT_AI_BUDGET_DIRECTORY=/Users/pierceluu/.refit/evaluations/2026-10-12 \
refit watch --env .env \
  --config examples/billing-demo.refit.json \
  --state /Users/pierceluu/.refit/evaluations/stripe-publisher-worker-2026-10-12 \
  --once --ai-patch --repair-attempts 2 \
  --publish-draft --github pierceluu10/refit-billing-demo --base main --github-app
```

The saved result points to [Refit Agent's draft PR #3](https://github.com/pierceluu10/refit-billing-demo/pull/3). Repeating it returns `Already processed` and the evidence path. A new state directory would check for the existing App-authored migration before spending on AI. Existing-PR results explicitly say that generation and validation were not rerun. The local receipt is a past result; inspect GitHub for current PR status.

Remove `--once` to poll every five minutes, or set `--interval 60`. Press Ctrl+C to stop. Do not clear state or budget files between runs. The configured `after` file is a curated historical Stripe contract: this command tests automation with that supplied change, rather than discovering today's Stripe changes.

The check image can be rebuilt using [the billing evaluation commands](BILLING-EVALUATION.md#reproduce). The current pagination harness creates **103 charge attempts**, exceeding Stripe's maximum list page size, and checks empty history under both simulator modes.

## Let the App fetch and refresh the repository

You no longer need a local clone or to pull the base branch manually. `--sync-github` uses an App-owned checkout inside the worker state directory and refreshes its base before every poll. The target is explicit and must be accessible to the installed App. State must be outside existing Git working copies.

On Pierce's machine, repeat the verified remote workflow:

```sh
cd /Users/pierceluu/Repos/Refit
refit watch --env .env \
  --config examples/billing-demo.github.refit.json \
  --state /Users/pierceluu/.refit/evaluations/stripe-managed-checkout-2026-10-12 \
  --sync-github --github pierceluu10/refit-billing-demo --base main --github-app \
  --once --publish-draft
```

This example omits `repository` and uses Refit's curated historical Stripe contract fixtures. It reuses the verified App draft without new AI or validation. Remove `--once` for continuous polling. Before returning a cached result, the worker refreshes App authorization and reads the current remote base. A changed base becomes a new repository revision for scanning.

To run and inspect a fresh migration without publishing, choose a new state directory and omit `--publish-draft`. The live evaluation already did this at `/Users/pierceluu/.refit/evaluations/stripe-managed-validation-2026-10-12`, passing both billing contracts, TypeScript, 103-attempt pagination and empty history in offline Docker. It generated the supported deterministic history patch without calling OpenAI. The original billing checkout stayed clean and unmigrated.

For AI, add the same `REFIT_AI_BUDGET_USD=2` and `REFIT_AI_BUDGET_DIRECTORY` environment values used above, followed by `--ai-patch --repair-attempts 2`. Scanning and the existing-PR preflight still run first; a reused job does not regenerate merely because AI was enabled. For a review-required or failed job, use `--retry --once` after addressing its cause. Switching publication mode requires a fresh state directory.

For another repository, supply your API baseline/current source, provider mapping where needed, local check image, and meaningful commands in a run configuration. `repository` can be omitted for App-managed mode; `--sync-github`, `--github owner/repo`, `--base branch`, and `--github-app` remain explicit command-line choices. This is still one configured repository/source per worker, not automatic enrollment of every installation.

Checkout credentials are short-lived, repository-scoped Contents **read** tokens. They are used only for GitHub reads and Git fetch; they never appear in Git URLs, command arguments, saved configuration, or the validation container. Publication obtains a separate scoped write token. Git subprocesses ignore inherited global/system configuration and credential helpers; hooks and submodule recursion are disabled. No package installation, application script, or repository hook runs during checkout.

The managed directory stores ownership, configuration hash and pinned revision evidence. Modified tracked files, untracked or ignored files, changed Git configuration, and unexpected HEAD changes stop syncing rather than being overwritten. Prepared checkouts and clean completed updates can reconcile after interruption; ambiguous or dirty partial updates require inspection. Never edit the managed checkout: change the upstream repository or your normal working copy instead. The worker fetches commits at their full SHA and checks the GitHub base again before publication. Existing drafts with stale base history require review; Refit does not force-push or merge them.

## Demonstrate a change arriving while the worker runs

To see a new AI proposal independently of the already-open PR, create a disposable source file and a fresh local-only worker state. This remains within the same shared spending ledger:

```sh
cp /Users/pierceluu/Repos/refit-billing-demo/docs/contracts/before.json \
  /tmp/refit-demo-current.json

REFIT_AI_BUDGET_USD=2 \
REFIT_AI_BUDGET_DIRECTORY=/Users/pierceluu/.refit/evaluations/2026-10-12 \
refit watch --env .env \
  --config examples/billing-demo.refit.json \
  --source-file /tmp/refit-demo-current.json \
  --state /Users/pierceluu/.refit/evaluations/stripe-arrival-demo \
  --interval 30 --ai-patch --repair-attempts 2
```

In a second terminal:

```sh
cp /Users/pierceluu/Repos/refit-billing-demo/docs/contracts/after.json \
  /tmp/refit-demo-next.json
mv /tmp/refit-demo-next.json /tmp/refit-demo-current.json
```

The initial unchanged contract is recorded without an AI request. On the next poll, Refit finds the removed field, tests the original application, requests a bounded migration, and tests the proposal in Docker. A passing run prints a readable summary and evidence path. Further polls reuse that result. This local-only command does not publish a PR; the App command above exercises publication reconciliation. The application checkout remains unmigrated for repeat evaluations.

## Use a real upstream source

For Stripe, capture the baseline corresponding to the integration you intend to compare:

```sh
refit stripe-snapshot --latest --output /absolute/path/stripe-baseline.json
```

Use that pinned snapshot as `before` in your run configuration, then:

```sh
refit watch --config /absolute/path/stripe.refit.json \
  --state /absolute/path/outside-repository/stripe-worker \
  --latest-stripe --once
```

Stripe discovery polls the latest Git commit touching its published specification and downloads at the immutable SHA. Starting at today's baseline detects future changes only. Published contract changes do not establish which API version your account or SDK uses. Refit does not advance the baseline after a PR; choose a new baseline and state directory after reviewing the migration.

For another provider with a public HTTPS OpenAPI document:

```sh
refit source-snapshot --provider example \
  --url https://api.example.com/openapi.yaml \
  --output /absolute/path/provider-baseline.json

refit watch --config /absolute/path/provider.refit.json \
  --state /absolute/path/outside-repository/provider-worker \
  --source-url https://api.example.com/openapi.yaml --once
```

Set `before` in the run configuration to the captured baseline and `apiVersion` to the API version the application actually uses. The snapshot command saves the exact supplied contract and provenance; the worker polls the same URL for later versions. This requires a provider-published public OpenAPI URL and does not discover feeds or documentation pages. The configuration still needs a repository, an image, check commands, and `providerConfig`. The SDK adapter names its package, constructor imports, and resource methods mapped to response schemas. [The OpenAI fixture](../pipeline/fixtures/openai/README.md) demonstrates the shared engine with the actual OpenAI SDK. Its `owned_by` removal and synthetic `owner_name` replacement are simulations, not announced OpenAI changes. The basic adapter remains review-only; a separate explicit mapping demonstrates the generic property-rename rule.

JSON and YAML OpenAPI 3 documents share ingestion and comparison. HTTPS downloads are bounded, refuse redirects and credential-bearing/query URLs, and reuse ETags when available. External OpenAPI references are disabled. Multi-file contracts must be bundled first; ambiguous references or unsupported schemas stop automatic publication.

## Breaking changes and review gates

The worker enables `oasdiff` by default. The full changelog records breaking and non-breaking contract changes. Documentation-only edits are saved as source observations and do not generate a new migration for already-processed code and breaking changes.

Automatic code handling is narrower than contract detection. Direct removed response fields must map to a supported SDK response and confirmed code usage. A response-removal changelog entry is considered covered only when its status, operation, path, and direct component-schema reference identify the same removed property. Type changes, removed endpoints, request changes, composed or inline responses, and other unmapped breaking changes stop the automatic proposal/publication path for review.

Other providers reuse this worker, ingestion, differ, analyzer, budget, sandbox, and publisher. They still need verified SDK mappings, migration semantics, an explicit API-version pin matching the before contract, and application checks. Installing an App on an arbitrary repository does not supply that knowledge. `fullDiff: false` deliberately falls back to the narrower direct-property report; it does not imply full contract coverage.

## AI efficiency and spending

Scanning, comparing specifications, and looking up an existing App PR make no AI requests. A failing baseline also stops before paid generation. Patch context contains confirmed findings, their relevant changes and affected files, plus at most 12 resolved import modules as read-only context. The model cannot edit the rest of the repository or change check commands.

Before generation, Refit counts input tokens and reserves the maximum configured response cost in a shared local ledger. Generation is capped at 16,384 input tokens and 4,096 output tokens. It records actual input, output, cached input, reasoning, and cost metadata. Reasoning tokens are part of output billing, not charged twice by the ledger. Repairs are explicit and limited to two; failed network requests are not silently regenerated.

The CLI defaults to a $1 ledger at `~/.refit/ai-budget`. Set `REFIT_AI_BUDGET_USD` and `REFIT_AI_BUDGET_DIRECTORY` to choose the shared allowance. All worker instances that should share a limit must use the same directory. A different limit is rejected for an existing ledger; the CLI does not reset spending. This controls Refit's recorded/reserved generation allowance, not your entire OpenAI account's billing.

Built-in prices cover `gpt-5.4-mini` and its evaluated snapshot. Other model IDs require all four explicit per-million-token prices in `.env.example`. Use the model's [official pricing](https://developers.openai.com/api/docs/pricing). An interrupted or unaccounted generation retains its reservation: inspect the ledger and provider usage before changing state, because a missing response does not prove no charge.

The October 12 live generation used `gpt-5.4-mini-2026-03-17`: 2,133 input tokens, 438 output tokens, no cached tokens, **$0.00357075** recorded generation cost. It passed both 14-test simulator contracts, TypeScript, 103-attempt pagination, and empty history on its first proposal. Repeating the worker and checking for the existing PR made no further generation requests. These are measured outcomes for this billing evaluation, not a general model success rate.

## State, recovery, and errors

State retains captured snapshots, observations, job receipts, and per-attempt evidence. Job identity includes the committed revision, scanned repository content, adapter, configured application API version, and breaking changes. Source-only documentation edits do not create repeated AI jobs. Completed jobs are reused across restarts.

Failed, interrupted, and review-required jobs are not automatically regenerated. After resolving the cause, use the same command with `--retry --once`; a fresh evidence directory records the new attempt. Retry is refused for continuous mode to prevent repeated paid attempts. Successful jobs stay deduplicated. Enabling publication or changing baseline/source/checks requires a fresh state directory because it changes the worker configuration identity.

Locks prevent concurrent writers. A lock can be recovered only when its host matches this machine and its recorded process is verified dead. Unknown, malformed, active, or foreign ownership requires inspection. An interrupted job is reconciled against a valid final evidence manifest; otherwise it becomes `interrupted` and requires explicit retry. This avoids automatically repeating an uncertain publication.

Continuous polling retries temporary HTTP 408/429/500/502/503/504 and recognized network outages on the configured interval, stopping after three consecutive failures. Authentication failures, malformed contracts, invalid state, and configuration errors stop immediately. No AI job starts for a failed source capture. Ctrl+C prevents subsequent proposals/publication; bounded in-flight checks finish before cancellation is recorded.

Single-poll exit codes are 0 for validated/published/reused successful jobs, 2 for review or validation failure, and 1 for execution errors. Reused failed receipts retain their failure exit code. Use `--json` for machine output. `refit run` uses readable output in terminals and JSON when redirected; `--human` and `--json` override that choice.

Evidence remains JSON for reproducibility and integrations. PRs show the change, affected files, and validation in prose, with hashes and exact commands collapsed under technical evidence. Verify an evidence directory with `refit verify --directory /absolute/path/to/run`. Integrity verification does not prove migration correctness.

## Remaining product work

The local service now records installations, verifies webhooks and schedules approved App-managed profiles. Hosted customer authentication, automatic enrollment with approved checks, durable hosted jobs, dependency provisioning, tenant-level budgets and stronger isolation remain. API-version applicability now has an explicit conservative gate, but provider-specific proof of the effective version, broader code flows and migration evaluations still need work. The standalone `watch` worker handles one target; `serve` schedules up to 32 approved profiles sequentially.
