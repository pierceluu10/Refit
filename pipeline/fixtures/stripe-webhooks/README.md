# Simulated Stripe subscription webhooks

This fixture reproduces a documented historical incompatibility using simulated events. Application logic is in `repository`; the signature generator and loopback HTTP harness are in `contract.mjs`. The application never imports Refit.

The original app uses [**stripe-node 17.7.0** with **2025-02-24.acacia**](https://github.com/stripe/stripe-node/blob/v17.7.0/src/apiVersion.ts) and incoming Acacia snapshots. Tests also run **stripe-node 19.1.0** to show that an SDK upgrade does not rewrite incoming payloads. Stripe's [2025-03-31.basil change](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end) moves billing periods onto subscription items. The after event has two items with different periods and no top-level period fields. The original handler throws `MissingSubscriptionPeriodError`.

`before.json` and `after.json` are reviewed OpenAPI projections of that field move, not full vendor specifications. The harness generates bodies and signs exact bytes using the installed SDK. It simulates incoming delivery, including `api_version`, and never contacts Stripe. All keys/secrets are dummy fixture values. The migration is intentionally unapplied.

From the Refit checkout, create a separate temporary copy:

```sh
demo_dir=$(mktemp -d /tmp/refit-webhooks.XXXXXX)
cp -R pipeline/fixtures/stripe-webhooks/repository "$demo_dir/application"
cp pipeline/fixtures/stripe-webhooks/contract.mjs "$demo_dir/contract.mjs"
npm install --prefix "$demo_dir/application" --ignore-scripts --no-audit --no-fund
node "$demo_dir/contract.mjs" "$demo_dir/application" before
node "$demo_dir/contract.mjs" "$demo_dir/application" after
node "$demo_dir/contract.mjs" "$demo_dir/application" regression
```

`before` succeeds. `after` deliberately exits 1 after HTTP 422, demonstrating the incompatibility. `regression` succeeds by asserting that failure, replaying an old event, rejecting wrong/tampered/stale signatures with HTTP 400, ignoring an unrelated event and verifying async construction. It does not fix the application. The gated suite exercises both SDKs locally and 17.7.0 in offline Docker.

See [webhook tracing and automation gates](../../../docs/STRIPE-WEBHOOKS.md).
