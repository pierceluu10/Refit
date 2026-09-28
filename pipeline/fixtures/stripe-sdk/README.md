# Real Stripe SDK contract fixture

This fixture executes the actual npm `stripe` SDK against a local HTTP server. The integration test installs exact versions **10.17.0** and **19.1.0** into separate disposable repositories. It does not use a Stripe account or make requests to Stripe's service.

`repository/billing.js` contains the original charge-history read and imports the named client from `repository/client.js`. This exercises static cross-file client tracing. `contract.mjs` serves a minimal simulated API on a random loopback port. Its `before` response includes `PaymentIntent.charges`; its `after` response omits that field and exposes charge history through the Charges list endpoint.

Run from the Refit checkout:

```sh
REFIT_STRIPE_SDK=1 npm test
```

The test requires registry access or a suitable npm cache. Install scripts and npm audit are disabled. It verifies:

1. The original code returns both charge IDs against the simulated old API.
2. The same original code throws against the simulated new API.
3. Refit scans that installed repository and proposes one migration.
4. The generated diff applies cleanly.
5. The patched code returns both charge IDs against the new API using exactly a PaymentIntent retrieval followed by `GET /v1/charges?payment_intent=pi_refit_contract`.

The installed SDK's version is checked, and the tracked fixture is left unchanged. Temporary installations and the local HTTP server are cleaned up.

This verifies SDK request serialization and the narrow migration behavior, not the full Stripe API contract. The API responses and application code remain synthetic. Pagination, large histories, expansion, Connect accounts, real credentials, SDK type migrations and production behavior still need application-specific review. The fixture deliberately uses loopback HTTP and a dummy test-key string; neither setting belongs in a production client.
