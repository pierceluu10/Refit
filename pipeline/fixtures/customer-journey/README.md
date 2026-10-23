# Customer journey fixture

The repository a customer installs Refit on in [the acceptance test](../../../docs/ACCEPTANCE.md). It is the Stripe half of the [multiple-integrations fixture](../multiple-integrations/README.md): `src/history.ts` reads `PaymentIntent.charges`, and the contracts are the same small projections of the historical `PaymentIntent.charges` removal (Stripe's [2022-11-15 changelog](https://docs.stripe.com/changelog/2022-11-15/removes-charges-attribute-paymentintent)). They are not complete Stripe specifications.

`simulator/stripe-sdk` is a **simulated** stand-in for the `stripe` package, not Stripe's SDK. It implements only `paymentIntents.retrieve` and `charges.list` with stripe-node's request shapes and sends requests only to the loopback server in `simulator/check.mjs`. Because of it, validation needs no `npm install` and runs fully offline. The check links it as `node_modules/stripe` for the run and removes the link afterwards, refusing an existing `node_modules`.

```sh
node --experimental-strip-types simulator/check.mjs before
node --experimental-strip-types simulator/check.mjs after
```

The original code passes `before` and fails `after`, where a PaymentIntent no longer embeds its charges. Refit's deterministic patch reads them from `charges.list({ payment_intent })` and passes both. The test writes `.refit.json` itself, so the approved image follows `REFIT_DOCKER_IMAGE`.
