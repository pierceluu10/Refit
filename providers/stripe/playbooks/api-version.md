---
provider: stripe
kind: api-version
reviewed: false
drafted: 2026-11-01
sources:
  - https://docs.stripe.com/api/versioning
  - https://docs.stripe.com/upgrades
  - https://docs.stripe.com/changelog
  - https://docs.stripe.com/webhooks/versioning
---

# Stripe API version upgrade

**What changes.** Stripe versions are dates. Since `2024-09-30.acacia` each month brings a non-breaking version, and twice a year a named major release (acacia, basil, clover, dahlia, endive) opens with a version that holds all its breaking changes ([versioning](https://docs.stripe.com/api/versioning)). Every version before acacia could break things ([webhook versioning](https://docs.stripe.com/webhooks/versioning)). So `2025-04-30.basil → 2025-08-27.basil` should be a no-op. `2024-06-20 → 2025-03-31.basil` crosses two major starts.

**Where the version comes from.** There are four places, and a repo can disagree with itself:

1. A `Stripe-Version` header on raw HTTP calls, or a per-request `apiVersion` / `stripe_version` option.
2. The SDK pin. stripe-node v12+, stripe-python v6+, stripe-ruby v9+ and stripe-php v11+ send the version that was current at their release. Go, Java and .NET are always fixed to theirs ([upgrades](https://docs.stripe.com/upgrades)).
3. The account default in Workbench, used by curl, the CLI and old SDKs when nothing else sets a version.
4. Each webhook endpoint's own `api_version` (see the webhook-payload playbook).

**How to spot it.** Grep for `apiVersion:`, `api_version`, `Stripe.api_version`, `stripe_version`, `setApiVersion`, `Stripe-Version`, `stripe.APIVersion`, and the SDK version in `package.json`, `requirements*.txt`, `pyproject.toml`, `Gemfile`, `go.mod` (`stripe-go/vNN`), `pom.xml`/`build.gradle` and `composer.json`. In TypeScript, stripe-node types match its pinned version, so a hard-coded older `apiVersion` string often fails type-checking after an SDK bump.

**What to check.**

- Run `stripe_api_versions` with `version` = the current pin and `target` = the new one. It lists every breaking entry in between, with a link to each, and the SDK majors that pin each version. Add `query` (e.g. "subscription", "checkout") to narrow the list to what the repo uses.
- Run `stripe_check_params` on the main create and update calls, with `apiVersion` set to the target. When online it reads the OpenAPI spec tagged for that version.
- Read the linked changelog pages for response-shape changes. The param check only covers requests.

**Pitfalls.** Bumping the SDK silently changes the version. A test suite that mocks HTTP passes anyway. Response fields move as well as request params: for example, basil moved `current_period_*` from subscriptions to subscription items ([changelog](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end)). Webhook endpoints keep the old shape until you recreate them. `.preview` versions are not GA ([changelog](https://docs.stripe.com/changelog)).
