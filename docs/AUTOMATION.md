# Local API monitoring with Refit 0.10

Configured `requestPropertyRenames` cover top-level JSON body fields on mapped SDK calls after checking that the recorded operation changes only by those names. Direct, quoted and shorthand properties retain their values and other arguments; uncertain requests stop for review, and these explicit rules use no AI generation or repair. See [request migrations](REQUEST-MIGRATIONS.md).

Collections with `formatVersion: 2` support up to eight named integrations in one repository. Manual `run`, `watch` and `doctor` commands require `--integration <id>`; enrollment reviews the whole collection and the App service expands it into independent targets such as `billing.stripe` and `billing.openai`, with separate draft PRs and retries. Existing single profiles keep their current commands. See [multiple integrations](MULTIPLE-INTEGRATIONS.md).

Refit has a local polling worker that captures an OpenAPI source, compares it with a retained baseline, scans a repository, and processes each migration once. It can also monitor up to eight manually configured public changelog or migration-documentation pages for each target. AI generation and GitHub publication are explicit options. Start with a single poll; remove `--once` to keep the worker running while your computer is on.

This is the operator workflow for the installed Refit Agent. A customer installing the GitHub App does not yet start a hosted worker. The frontend is still illustrative.

For several configured repositories and signed installation webhooks, use the [local service](LOCAL-SERVICE.md). It includes startup App access discovery, protected status, persisted delivery deduplication and HTTPS tunnel instructions. The commands below remain useful for a single target or an explicit retry. A root `.refit.json` can keep repository selection outside the file: add `--repository /path/to/repo` to the local watch command. It cannot be combined with `--sync-github`.

Literal SDK version conflicts now stop automation. Set `apiVersionPolicy: "source-verified"` in a reviewed workflow to require static confirmation; runtime declarations stay unverified under the existing operator-pin pilot. The built-in Stripe adapter gained version metadata in 0.10, changing worker identity: preserve previous state and use a fresh directory when upgrading an existing Stripe worker. See [API-version policies](API-VERSIONS.md).

## Prerequisites

- Node.js 22.12+ or a supported newer release and the installed `refit` CLI.
- `oasdiff` on PATH for the shared contract comparison. On macOS: `brew install oasdiff`. The evaluated version was 1.33.0; verify with `oasdiff --version`.
- A clean, committed local repository. Publication requires its HEAD to equal the GitHub base branch.
- A running Docker daemon and a prepared local check image. Dependencies are installed when preparing the image; migration checks run with networking disabled.
- An explicit JSON run configuration. Paths in it are relative to the configuration file. Credentials belong in a separate local `.env`.

From the source checkout, `node bin/refit.mjs` works wherever the examples below use `refit`. See [the CLI guide](CLI.md) and [GitHub App setup](GITHUB-APP.md). Keep state outside the monitored repository.

## Repeat the current Stripe App validation

On Pierce's machine, the installed App and reviewed repository approval are already configured. This uses the approved `.refit.json` from an App-managed checkout:

```sh
cd ~/Repos/Refit
refit serve --env .env \
  --config ~/.refit/evaluations/app-enrollment-2026-10-13/billing-service.json \
  --state ~/.refit/evaluations/stripe-service-0.12-2026-10-14 \
  --port 0 --once
```

The retained 0.12 evaluation found two history reads and passed 14 baseline tests, both 14-test patched contracts and TypeScript in offline Docker. Repeating the command confirms App access, refreshes the base and reuses validated evidence. This uses the historical HTTP simulator through the real Stripe SDK, with no AI request or publication. The runtime-selected SDK version is visibly unverified under the approved operator-pin policy.

Choose a fresh state directory to run checks again. Remove `--once` and use a fixed port for continuous monitoring while your computer is on. Changing AI or publication settings requires separate fresh state; enabling publication can create a new draft, so review the configured target and retained result first. Keep the shared $2 AI ledger for any later model evaluation.

The earlier [App draft PR #3](https://github.com/pierceluu10/refit-billing-demo/pull/3) was created before the configuration merge. The normal local billing checkout still has that older base. A current publication preflight correctly refuses it because GitHub main has advanced. Use the App-managed workflow, or deliberately update your own clean checkout before a new manual publication run. The new version metadata preserves migration PR identity, but does not bypass revision checks or establish that an older PR covers the current base.

The check environment can be reproduced using [the billing evaluation commands](BILLING-EVALUATION.md#reproduce). The pagination harness checks **103 charge attempts**, exceeding Stripe's maximum list page size, and empty history under both simulator modes. The configured source remains a curated historical contract; this pilot does not discover today's Stripe changes.

## Let the App fetch and refresh the repository

You no longer need a local clone or to pull the base branch manually. `--sync-github` uses an App-owned checkout inside the worker state directory and refreshes its base before every poll. The target is explicit and must be accessible to the installed App. State must be outside existing Git working copies.

On Pierce's machine, repeat the verified remote workflow:

```sh
cd ~/Repos/Refit
refit watch --env .env \
  --config examples/billing-demo.github.refit.json \
  --state ~/.refit/evaluations/stripe-managed-checkout-0.10-2026-10-14 \
  --sync-github --github pierceluu10/refit-billing-demo --base main --github-app \
  --once --publish-draft
```

This example omits `repository` and uses Refit's curated historical Stripe contract fixtures. It refreshes the base and checks whether a matching current migration already exists. After the base advances, Refit validates again and moves its own draft onto the new base rather than opening another; see [one draft per target version](PULL-REQUESTS.md#one-draft-per-target-version). Remove `--once` for continuous polling. Before returning a cached result, the worker refreshes App authorization and reads the current remote base. A changed base becomes a new repository revision for scanning.

To run and inspect a fresh migration without publishing, choose a new state directory and omit `--publish-draft`. The live evaluation already did this at `~/.refit/evaluations/stripe-managed-validation-2026-10-12`, passing both billing contracts, TypeScript, 103-attempt pagination and empty history in offline Docker. It generated the supported deterministic history patch without calling OpenAI. The original billing checkout stayed clean and unmigrated.

For AI, add the same `REFIT_AI_BUDGET_USD=2` and `REFIT_AI_BUDGET_DIRECTORY` environment values used above, followed by `--ai-patch --repair-attempts 2`. Scanning and the existing-PR preflight still run first; a reused job does not regenerate merely because AI was enabled. For a review-required or failed job, use `--retry --once` after addressing its cause. Switching publication mode requires a fresh state directory.

For another repository, supply your API baseline/current source, provider mapping where needed, local check image, and meaningful commands in a run configuration. `repository` can be omitted for App-managed mode; `--sync-github`, `--github owner/repo`, `--base branch`, and `--github-app` remain explicit command-line choices. This is still one configured repository/source per worker, not automatic enrollment of every installation.

Checkout credentials are short-lived, repository-scoped Contents **read** tokens. They are used only for GitHub reads and Git fetch; they never appear in Git URLs, command arguments, saved configuration, or the validation container. Publication obtains a separate scoped write token. Git subprocesses ignore inherited global/system configuration and credential helpers; hooks and submodule recursion are disabled. No package installation, application script, or repository hook runs during checkout.

The managed directory stores ownership, configuration hash and pinned revision evidence. Modified tracked files, untracked or ignored files, changed Git configuration, and unexpected HEAD changes stop syncing rather than being overwritten. Prepared checkouts and clean completed updates can reconcile after interruption; ambiguous or dirty partial updates require inspection. Never edit the managed checkout: change the upstream repository or your normal working copy instead. The worker fetches commits at their full SHA and checks the GitHub base again before publication. Refit moves only a draft branch that holds just its own single commit, and leaves a branch with anyone else's commits as it is; it never merges.

## Demonstrate a change arriving while the worker runs

To see a new AI proposal independently of the already-open PR, create a disposable source file and a fresh local-only worker state. This remains within the same shared spending ledger:

```sh
cp ~/Repos/refit-billing-demo/docs/contracts/before.json \
  /tmp/refit-demo-current.json

REFIT_AI_BUDGET_USD=2 \
REFIT_AI_BUDGET_DIRECTORY=~/.refit/evaluations/2026-10-12 \
refit watch --env .env \
  --config examples/billing-demo.refit.json \
  --source-file /tmp/refit-demo-current.json \
  --state ~/.refit/evaluations/stripe-arrival-demo \
  --interval 30 --ai-patch --repair-attempts 2
```

In a second terminal:

```sh
cp ~/Repos/refit-billing-demo/docs/contracts/after.json \
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

### A live Stripe change caught by the worker (October 21)

The worker caught a real Stripe change from the live specification and published the fix as Refit Agent: [refit-dev/Clario-ai#1](https://github.com/refit-dev/Clario-ai/pull/1).

- **Change.** `--latest-stripe` fetched Stripe's newest specification commit, [`bcfd59f`](https://github.com/stripe/openapi/commit/bcfd59f49dcac84a84d63d304c62793dff6e5916) (`2026-09-30.endive`, published 2026-09-29). Endive removed the `payment_method_types` request field from Checkout Sessions, PaymentIntents and SetupIntents.
- **Repository.** `refit-dev/Clario-ai`, a fork of the MIT-licensed `MuhammadTanveerAbbas/Clario-ai` at `a97c0de`; upstream was not touched. It pins `2026-02-25.clover` in two clients, and its Checkout Session creation sends `payment_method_types: ["card"]`. The baseline is the clover specification at `stripe/openapi` tag `v2186`.
- **Fix.** The deterministic [card rule](STRIPE-PAYMENT-METHOD-TYPES.md) renamed the field to `allowed_payment_method_types`, moved both pins to `2026-09-30.endive` and upgraded stripe-node 20.4.1 to 23.0.0: 4 files, 11 lines. It was reviewed by hand ([`fix-reviews.json`](benchmarks/fix-reviews.json)), and the lockfile's integrity hash matches npm's.
- **Checks.** `pnpm test && pnpm run typecheck` passed before and after the patch, in offline Docker with dependencies prepared from the pnpm lockfile. No AI request was made; the shared $2 ledger stayed at $0.0036.

From Refit `5fdff08` (0.39.0):

```sh
REFIT_AI_BUDGET_USD=2 \
REFIT_AI_BUDGET_DIRECTORY=~/.refit/evaluations/2026-10-12 \
refit watch --env .env \
  --config ~/.refit/evaluations/live-endive-clario-2026-10-21/inputs/clario.refit.json \
  --state ~/.refit/evaluations/live-endive-clario-2026-10-21/state \
  --sync-github --github refit-dev/Clario-ai --base main --github-app \
  --latest-stripe --prepare-dependencies --once --publish-draft
```

Evidence is in `~/.refit/evaluations/live-endive-clario-2026-10-21/state/runs/79e2486b446cd471fafadfac64b25a1f14ea6db0127159bcd294e30e7ef8f4fa-1`. Repeating the command reuses the job and the open draft.

What this does not show:

- **The change arrived before the worker started.** Stripe published endive on September 29. The worker compared a pinned clover baseline with that day's latest specification; it did not watch the change arrive.
- **Full contract comparison was off** (`fullDiff: false`), as in the benchmark and the Stripe lab. With the worker's default full diff, the same run stops on 9 unmapped breaking changes to `POST /v1/checkout/sessions`, such as the `ui_mode` values dahlia renamed. The call does not send `ui_mode`, but no rule covers those changes, so the gate correctly stops. That run's evidence is in `state-full-diff/` beside `state/`. How Stripe's full diff should gate is still an open owner decision.
- **Checks are narrow.** The repository's 24 tests cover its AI fallback, not Stripe. Only `tsc` against stripe-node 23's types checks the changed call. No Stripe request was made, so Checkout behavior and whether the account keeps cards enabled are unverified; the draft asks the reviewer to confirm the second.
- **One repository.** The first candidate, `Shefaul-22/AgriFlow` (pinned to `2026-04-22.dahlia`), produced the same fix but was refused before validation: its committed source exceeds the 50 MiB archive limit.

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

The worker enables `oasdiff` by default. The full changelog records breaking and non-breaking contract changes. Optional documentation sources are captured independently as visible text, with navigation and hidden page content excluded where HTML provides a main/article region. RSS 2.0 and Atom sources are reduced to entry titles, dates, links and summaries; custom XML entities and feeds over 250 entries are rejected. The first capture becomes a baseline. Later page/feed edits save hash-verified snapshots, a unified text diff and JSON evidence under `state/observations/documentation/`. A docs-only change is reported for review and does not start AI, patch generation, Docker checks or PR publication. When an OpenAPI migration runs in the same poll, the documentation diff stays in the watcher observation and is not copied into the GitHub PR. If that migration uses `--ai-patch`, the saved HTML, Markdown or plain-text snapshot is attached to the model evidence; feed entries are omitted from that request. See [vendor notes](VENDOR_NOTES.md). Sources must be public HTTPS pages or feeds returning HTML, Markdown, plain text, RSS 2.0 or Atom; Refit does not discover sources, authenticate to providers or infer which page is authoritative.

Automatic code handling is narrower than contract detection. Direct removed response fields must map to a supported SDK response and confirmed code usage. A response-removal changelog entry is considered covered only when its status, operation, path, and direct component-schema reference identify the same removed property. A custom adapter can optionally map an SDK method to a unique baseline OpenAPI `operationId`; `--full-diff` then joins unresolved breaking changes by the mapped path and HTTP method and reports the affected SDK call sites. It also reports endpoint removals announced through deprecation. No generic endpoint, parameter, or response migration rule exists, so these impacts stop AI generation, validation and publication for review. Other unmapped breaking changes also stop the automatic path.

Other providers reuse this worker, ingestion, differ, analyzer, budget, sandbox, and publisher. They still need verified SDK mappings, migration semantics, an explicit API-version pin matching the before contract, and application checks. Installing an App on an arbitrary repository does not supply that knowledge. `fullDiff: false` deliberately falls back to the narrower direct-property report; it does not imply full contract coverage.

## AI efficiency and spending

Scanning, comparing specifications, and looking up an existing App PR make no AI requests. A failing baseline also stops before paid generation. Patch context contains confirmed findings, their relevant changes and affected files, plus at most 12 resolved import modules as read-only context. The model cannot edit the rest of the repository or change check commands.

Before generation, Refit counts input tokens and reserves the maximum configured response cost in a shared local ledger. Generation is capped at 32,768 input tokens and 25,000 output tokens, reasoning included, as OpenAI advises for reasoning models; the 64 KiB evidence limit binds first. A generation request waits up to three minutes. It records actual input, output, cached input, reasoning, and cost metadata. Reasoning tokens are part of output billing, not charged twice by the ledger. Repairs are explicit and limited to two; failed network requests are not silently regenerated. An answer Refit rejects as edits (wrong schema, scope, unmatched or uncovered text, overlap, a syntax error) gets one corrected request carrying the reason, and both requests count against the ledger; a guard or policy stop never does. Two failed checks stop for review without a repair request, because every passing repair would need a decision the model may not make: an object-literal property the upgraded types reject and the original code compiled with (Checkout's `subscription_data.trial_from_plan` under stripe-node 12), and a read of a subscription's `current_period_start` or `current_period_end`, which Stripe moved onto subscription items, where choosing an item is the reviewed `stripeSubscriptionPeriods` rule.

The CLI defaults to a $1 ledger at `~/.refit/ai-budget`. Set `REFIT_AI_BUDGET_USD` and `REFIT_AI_BUDGET_DIRECTORY` to choose the shared allowance. All worker instances that should share a limit must use the same directory. A different limit is rejected for an existing ledger; the CLI does not reset spending. This controls Refit's recorded/reserved generation allowance, not your entire OpenAI account's billing.

Built-in prices cover `gpt-5.6-luna` and `gpt-5.4-mini`, including dated snapshots of each. A response from a differently priced model leaves its reservation charged. Other model IDs require all four explicit per-million-token prices in `.env.example`. Use the model's [official pricing](https://developers.openai.com/api/docs/pricing). An interrupted or unaccounted generation retains its reservation: inspect the ledger and provider usage before changing state, because a missing response does not prove no charge.

The October 12 live generation used `gpt-5.4-mini-2026-03-17`: 2,133 input tokens, 438 output tokens, no cached tokens, **$0.00357075** recorded generation cost. It passed both 14-test simulator contracts, TypeScript, 103-attempt pagination, and empty history on its first proposal. Repeating the worker and checking for the existing PR made no further generation requests. These are measured outcomes for this billing evaluation, not a general model success rate.

## State, recovery, and errors

State retains captured snapshots, observations, job receipts, and per-attempt evidence. Job identity includes the committed revision, scanned repository content, adapter, configured application API version, and breaking changes. Source-only documentation edits do not create repeated AI jobs. Completed jobs are reused across restarts.

Failed, interrupted, and review-required jobs are not automatically regenerated. After resolving the cause, use the same command with `--retry --once`; a fresh evidence directory records the new attempt. Retry is refused for continuous mode to prevent repeated paid attempts. Successful jobs stay deduplicated. App service profiles support the equivalent `serve --retry-target <id> --once` action with the same service state and runtime settings; only selected targets are polled. Stop a running service first. See [service retries](LOCAL-SERVICE.md#retry-a-failed-target-once). Enabling publication or changing baseline/source/checks requires a fresh state directory because it changes the worker configuration identity.

Locks prevent concurrent writers. A lock can be recovered only when its host matches this machine and its recorded process is verified dead. Unknown, malformed, active, or foreign ownership requires inspection. An interrupted job is reconciled against a valid final evidence manifest; otherwise it becomes `interrupted` and requires explicit retry. This avoids automatically repeating an uncertain publication.

Continuous polling retries temporary HTTP 408/429/500/502/503/504 and recognized network outages on the configured interval, stopping after three consecutive failures. Authentication failures, malformed contracts, invalid state, and configuration errors stop immediately. No AI job starts for a failed source capture. Ctrl+C prevents subsequent proposals/publication; bounded in-flight checks finish before cancellation is recorded.

Single-poll exit codes are 0 for validated/published/reused successful jobs, 2 for review or validation failure, and 1 for execution errors. Reused failed receipts retain their failure exit code. Use `--json` for machine output. `refit run` uses readable output in terminals and JSON when redirected; `--human` and `--json` override that choice.

Evidence remains JSON for reproducibility and integrations. PRs show the change, affected files, and validation in prose, with hashes and exact commands collapsed under technical evidence. Verify an evidence directory with `refit verify --directory /absolute/path/to/run`. Integrity verification does not prove migration correctness.

## Remaining product work

The local service now records installations, verifies webhooks and schedules approved App-managed profiles. Checked-in workflows now support explicit local approval through [App onboarding](APP-ONBOARDING.md). Hosted customer authentication, automatic customer enrollment with approved checks, durable hosted jobs, dependency provisioning, tenant-level budgets and stronger isolation remain. API-version applicability now has an explicit conservative gate, but provider-specific proof of the effective version, broader code flows and migration evaluations still need work. The standalone `watch` worker handles one target; `serve` schedules up to 32 approved profiles sequentially.
