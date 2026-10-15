# Generated Stripe checks (proposal)

Status: **proposal, not implemented.** It needs an owner decision on the validation sandbox before any code is written.

## Problem

Refit validates a migration by running the repository's own checks before and after the patch. 83 of the 100 repositories in the [Stripe benchmark](STRIPE-BENCHMARK.md) have no real test script, so a correct, confirmed migration still cannot be validated there. Phase 4.2 of the [Stripe plan](STRIPE-PLAN.md) asks for generated checks that run the migrated code paths against Stripe responses for the old and new API versions.

## Research result: stripe-mock serves historical versions

Stripe's [stripe-mock](https://github.com/stripe/stripe-mock) README says it is locked to the latest API version. Its source, however, accepts `-spec` and `-fixtures` flags, and every `stripe/openapi` release publishes both `spec3.json` and `fixtures3.json`. We ran the official `stripe/stripe-mock:latest` image with the files from tags `v1505` (`2025-02-24.acacia`) and `v1719` (`2025-04-30.basil`) and requested `GET /v1/invoices/in_123`:

| Version | `subscription` | `parent` |
|---|---|---|
| acacia | present (`null`) | absent |
| basil | absent | `{ subscription_details: { subscription: "subscription" }, type: "quote_details", … }` |

So stripe-mock can supply version-correct response shapes for both sides of a migration, offline, from Stripe's own published artifacts. Fixture values are placeholders such as `"subscription"`, so they prove shape compatibility, not business data.

## Proposed design

1. **Opt-in.** A workflow sets `generatedChecks: "stripe"`. It applies only when the before and after contracts are pinned `stripe/openapi` releases whose fixtures Refit can pin by hash.
2. **Entry points.** For each confirmed, edited finding, Refit takes the enclosing exported function. It qualifies only if every parameter is untyped or typed `string`, at most three of them. Other shapes are reported as not covered rather than guessed. Each qualifying function is called with deterministic placeholder IDs.
3. **Harness.** A generated ESM script imports each entry point and awaits it, catching nothing. It records whether the call completed and which Stripe paths were requested. The harness is evidence, never committed and never part of the PR diff.
4. **Runs.**
   - Original code against before-version stripe-mock must complete. This is the baseline.
   - Patched code against after-version stripe-mock must complete.
   - Original code against after-version stripe-mock is recorded as the demonstrated break. It is expected to fail, and it is reported but never required.
5. **Sandbox change, the decision needed.** Checks run today with `--network none`. stripe-mock would run in its own container on a per-run `docker network create --internal` network, with no route to the internet. The check container joins only that network. `api.stripe.com` resolves to the mock through `--add-host`, and the mock's self-signed certificate is trusted through `NODE_EXTRA_CA_CERTS`, not by disabling TLS verification. All other limits stay: read-only root, no capabilities, non-root user, 512 MiB workspace, 1 GiB memory. The mock container gets the same restrictions plus read-only mounts of the pinned spec and fixtures.
6. **Evidence and claims.** Reports and PRs say the code ran against generated Stripe fixtures for both versions, and name the covered and uncovered entry points. They must not claim application tests or business correctness.

## Limits

- Only simple exported functions qualify. Route handlers, class methods and functions taking request objects or Stripe objects need application-specific arguments.
- Placeholder fixtures exercise shape changes such as removed and moved fields. They do not exercise value-dependent logic, pagination edge cases, webhooks or errors.
- stripe-mock ignores most request semantics, so request-side migrations are checked for crashes, not correctness.
- It adds a pinned third-party image (`stripe/stripe-mock`) that operators must pull explicitly, like the validation image.

## Decision needed

Approve or reject point 5: an internal-only Docker network, plus a trusted mock certificate inside the check container, for generated-check runs only. Without it, generated checks can only run when the application lets its Stripe client host be configured, which most real code does not.
