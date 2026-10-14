# Installation-aware local service

`refit serve` keeps explicitly configured GitHub App repositories current, polls their OpenAPI sources, and accepts signed installation webhooks. It uses the same scanner, migration gates, budget ledger, managed checkout, offline checks and draft publisher as `refit watch`.

This is a single-operator local service. Installing the App on a repository records access; running that repository also requires an approved workflow, provider mapping where needed, a baseline and meaningful checks. Refit does not infer check commands from webhook payloads or run arbitrary installed repositories.

Repositories can now own a committed root `.refit.json`, activated through an operator receipt rather than an external workflow copy. `refit enroll` displays its settings and file fingerprint; approval is explicit and held outside Git. Every managed poll checks that fingerprint before execution. See [App onboarding](APP-ONBOARDING.md).

## Run the Stripe pilot

Use Node.js 22.12+, Git, tar, `oasdiff` on PATH and Docker. The billing demo's `refit-billing-check:history` image must already exist; [billing evaluation](BILLING-EVALUATION.md) documents its preparation. The App needs access to `pierceluu10/refit-billing-demo`. Keep App credentials and two **different** random service secrets in the ignored `.env`:

```dotenv
GITHUB_APP_ID=your-app-id
GITHUB_APP_PRIVATE_KEY_FILE=/absolute/path/to/private-key.pem
REFIT_WEBHOOK_SECRET=your-random-webhook-secret
REFIT_SERVICE_TOKEN=your-different-random-control-token
```

Each service secret must contain 32–256 letters, digits, underscores or hyphens. Generate each independently with `openssl rand -hex 32` and paste the values into `.env`; never commit them. The service token protects status. The webhook secret verifies GitHub deliveries. Neither replaces the App's private key or OpenAI key.

From the Refit checkout, run one startup poll:

```sh
cd /Users/pierceluu/Repos/Refit
refit serve --env .env --config examples/local-service.refit.json \
  --state /Users/pierceluu/.refit/evaluations/local-service-app-0.10-2026-10-14 \
  --once --publish-draft
```

The supplied profile replays the historical Stripe `PaymentIntent.charges` removal; it does not announce a new live Stripe change. It authenticates the installed App, fetches the GitHub base into a private managed checkout, then checks for an existing migration. A matching App draft on the current monitored revision is reused, with generation and checks explicitly marked as not rerun. The older PR #3 predates the approved configuration merge and is not proof of coverage for the current base. It never merges that PR or edits your normal checkout.

For continuous monitoring, omit `--once`:

```sh
refit serve --env .env --config examples/local-service.refit.json \
  --state /Users/pierceluu/.refit/evaluations/local-service-app-0.10-2026-10-14 \
  --interval 300 --publish-draft
```

The service binds **127.0.0.1:8787**. It confirms each configured installation through GitHub at startup and on every poll, so already-installed repositories work without an incoming webhook. Configured targets run sequentially; a failed target does not prevent the others from running. An accepted installation change wakes the next poll; revoked access cancels the affected in-flight worker. The GitHub API remains the authority for granting access.

`--ai-patch --repair-attempts 2` opts into bounded AI generation for new supported jobs. Use the shared allowance for this project:

```sh
REFIT_AI_BUDGET_USD=2 \
REFIT_AI_BUDGET_DIRECTORY=/Users/pierceluu/.refit/evaluations/2026-10-12 \
refit serve --env .env --config examples/local-service.refit.json \
  --state /Users/pierceluu/.refit/evaluations/local-service-ai-pilot \
  --ai-patch --repair-attempts 2 --publish-draft
```

Changing generation mode, repair count, publication mode or configuration requires fresh service state. Existing matching App PRs stop before generation even when AI is enabled. Failed/review-required worker receipts remain deduplicated; the service does not automatically regenerate a failed paid proposal. Use a named one-time service retry after addressing the cause; the service preserves prior attempts and does not automatically retry paid failures.

## Retry a failed target once

Stop a running service with Ctrl+C before a manual retry; its process lock protects the same state. Keep the service configuration, state path and AI/repair/publication options identical to the original run, then add the configured target id and `--once`:

```sh
refit serve --env .env --config /absolute/path/to/service.json \
  --state /absolute/path/to/service-state \
  --retry-target billing-demo-stripe --once
```

This polls only the named target. Repeat `--retry-target` to select several distinct ids. Unknown or repeated ids and retries without `--once` fail before creating service state or contacting GitHub. Other targets are not polled and their saved worker jobs are not retried. Installation webhooks still enforce access changes for every configured target. Human output and the exit code describe only the selected targets; JSON retains the full registry and includes `retryTargets` so prior failures on unselected targets remain visible.

The App's access and approved configuration are checked again before retrying. An existing failed, interrupted or review-required job may get one fresh attempt and a new evidence directory; the original attempt remains available. Successful jobs stay cached, even when named for retry. Changing code or the current API contract creates a new normal job under the existing identity rules. A changed approved workflow, baseline or adapter still requires review and a new approval; a retry cannot bypass that gate.

The spending ledger and publication reconciliation remain in effect. Retrying an AI-enabled failure can make another paid request within the same allowance. After inspection, restart your original continuous command without `--retry-target` or `--once`.

## Configure providers and repositories

The checked-in service file is small:

```json
{
  "formatVersion": 1,
  "targets": [
    {
      "id": "billing-demo-stripe",
      "repository": "pierceluu10/refit-billing-demo",
      "base": "main",
      "workflow": "./billing-demo.github.refit.json",
      "documentationSources": [
        {
          "label": "Stripe API changelog",
          "url": "https://docs.stripe.com/changelog.md"
        }
      ]
    }
  ]
}
```

A profile defaults to its workflow's `after` file or `latestStripe` setting. Optional `source` values are `{ "kind": "file", "path": "./current.yaml" }`, `{ "kind": "https", "url": "https://provider.example/openapi.yaml" }`, or `{ "kind": "stripe-latest" }`. Paths resolve relative to the service configuration. Workflow files resolve their own relative paths. Configure a baseline appropriate to the integration; using the latest baseline detects future changes, while the supplied historical one reproduces the demo.

Optional `documentationSources` lists up to eight manually selected public changelog pages or RSS 2.0/Atom feeds per target. Refit captures visible page text or normalized feed entries and saves a unified diff when the source changes. The status endpoint reports `documentation-changed`; the saved evidence path points to the documentation observation directory. These changes are review signals only and do not trigger AI generation or draft PRs. When a profile migration does run with AI patches enabled, the saved HTML, Markdown or plain-text snapshot is attached to that patch request. Feed entries remain review-only. See [vendor notes](VENDOR_NOTES.md).

Multiple providers and repositories share the service, with a limit of 32 explicitly approved profiles. Provider adapters map SDK methods to response schemas; broader OpenAPI changes can be reported without being safely patchable. Every target still needs its own verified migration semantics and checks. See [architecture](ARCHITECTURE.md) for the supported code and contract boundaries.

## Inspect local status

`GET /health` returns only `{"status":"listening"}`; it does not imply healthy jobs. `GET /status` requires `Authorization: Bearer <REFIT_SERVICE_TOKEN>` and returns target access, result, evidence path, installation inventory and delivery receipts. Read the private `registry.json` locally for the same information without putting a token in shell history.

`--json` emits the final registry on stdout; progress stays on stderr. `--once` exits 0 for successful jobs, 2 for review/validation/interruption or unavailable access, and 1 for execution errors. Continuous mode stays alive to process other profiles; inspect status for individual failures. Ctrl+C closes the listener, cancels workers, waits for active handlers and releases the process lock.

State is private and must live outside any Git checkout. `registry.json` holds installation access and delivery hashes; `targets/<id>/` holds each managed checkout, job receipts and evidence. Raw webhook bodies, App tokens and service secrets are not saved there. Delivery receipts survive restart: the same GUID and payload returns `duplicate`; conflicting reuse returns HTTP 409. The registry stops accepting additional receipts at 10,000 deliveries, 1,000 installations or 8 MiB. Archive the complete state after inspection and choose a new directory when those limits are reached; this is not an unlimited hosted queue.

## Receive real GitHub webhooks through HTTPS

Local polling works now. GitHub cannot deliver to `127.0.0.1`; use a temporary HTTPS tunnel when you are ready to test actual deliveries. In another terminal:

```sh
brew install cloudflared
cloudflared tunnel --url http://127.0.0.1:8787
```

Copy the generated `https://…trycloudflare.com` address. Open **GitHub → your organization → Settings → Developer settings → GitHub Apps → Refit Agent → Edit**. For the current organization, the settings page is [Refit Agent](https://github.com/organizations/refit-dev/settings/apps/refit-agent). Set:

1. **Webhook URL:** the tunnel address followed by `/github/webhook`.
2. **Webhook secret:** the exact `REFIT_WEBHOOK_SECRET` value from your local `.env`.
3. Enable **Active** webhooks and keep **SSL verification enabled**.
4. Save the App settings. GitHub Apps receive `installation` and `installation_repositories` lifecycle events automatically; no extra repository permissions are needed for these events.
5. Open **Recent deliveries**, inspect the ping, and confirm HTTP **202**. Redelivering the same accepted delivery should return `duplicate`. Adding/removing repository access should update the inventory and wake/cancel the appropriate configured worker.

An invalid signature returns 401; malformed or foreign-App payloads are rejected. A 202 acknowledges a durable receipt, not a completed migration. Inspect target status and evidence separately. Do not add browser/email authentication in front of the webhook route: GitHub deliveries cannot complete an interactive sign-in.

[Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) are temporary testing endpoints. Their address changes on restart, your computer and both processes must stay running, and they have no uptime guarantee. Update GitHub's webhook URL after every tunnel restart. [GitHub's webhook validation guide](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) explains the raw-byte HMAC signature used by this service.

For an always-on pilot, move the same service to a Linux host with Node, Git, `oasdiff`, Docker and persistent private storage, behind a stable HTTPS endpoint or named tunnel. A serverless webhook handler alone cannot run this Docker worker. Customer hosting still needs tenant authentication, enrollment approval, durable hosted queues, dependency provisioning and stronger isolation. A public tunnel is not that hosted product.
