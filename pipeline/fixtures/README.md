# Historical replay fixture

The two OpenAPI files are **hand-authored minimal fixtures**, not downloaded Stripe snapshots. They reproduce the `PaymentIntent.charges` removal documented in Stripe's [2022-11-15 changelog](https://docs.stripe.com/changelog/2022-11-15/removes-charges-attribute-paymentintent). They intentionally omit unrelated fields and the full expandable `latest_charge` schema.

`repository/` is an input for static analysis, never installed or executed. Its Stripe package version is a declared range, not a resolved version. No API key is needed.

The fixture reads charge history. Replacing that list with `latest_charge` changes its meaning; this must be reviewed, not mechanically renamed. Real callers may need to list charges or expand/retrieve the latest one depending on their intent.

Run `npm run stripe:replay` from the project root. To analyze another repository and actual saved OpenAPI 3 JSON snapshots, use `npm run stripe:scan -- --repository /path/to/repo --before /path/to/before.json --after /path/to/after.json`.

The separate [`stripe-sdk/` fixture](stripe-sdk/README.md) installs and executes two real Stripe SDK versions against a simulated local HTTP API. It verifies the proposed migration at the request boundary; it does not change the static replay fixture above.
