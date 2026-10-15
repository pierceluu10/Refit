# SDK clients stored on class fields

Refit 0.19 traces supported TypeScript and JavaScript SDK clients stored on instance fields. The same provider adapter and migration gates used for module-level clients apply. It does not infer a client from a field name or type annotation alone.

## Supported origins

A direct field initializer or a single direct constructor assignment must establish a known SDK origin:

```ts
import Stripe from 'stripe';

export class Billing {
  #stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2022-08-01',
  });

  async history(id: string) {
    const intent = await this.#stripe.paymentIntents.retrieve(id);
    return intent.charges.data;
  }
}
```

The API version and legacy field in this illustration belong to the historical PaymentIntent migration; current SDK typings may differ. Use the SDK and version actually installed by the application. Refit does not upgrade either automatically.

Supported forms include ordinary fields, TypeScript private fields, JavaScript `#private` fields, constructor assignments, immutable known shared-client initializers and immutable local aliases. Supported ESM/CommonJS imports and repository source aliases retain their existing rules. Instance methods and arrow methods preserve lexical `this`; an ordinary nested function does not.

Constructor API-version declarations enter the existing source-verification gate. A class declaration, `readonly` modifier or annotation is not independent proof that a field is initialized correctly or stays unchanged.

## Review boundaries

Conditional/lazy initialization, replacement or resource mutation, aliases that mutate or escape, early receiver use, instance escapes, borrowed methods, constructor replacement returns, inheritance and decorators prevent stable client provenance. Known outside-instance writes, computed writes and `Object.defineProperty` also prevent confirmation. Injected clients, getters and static fields do not gain a supported origin merely from their types.

When an affected response has a known class-client origin but uncertain stability, the finding includes `classClient.stability: "review"`. This stops migration, AI requests, migration validation and publication for the run, including runs that also contain confirmed findings. An unmapped method's return type cannot override that review evidence.

Some unsupported patterns remain invisible to static tracing. No finding is not proof that the integration is unaffected. The scanner cannot establish receiver behavior in unseen runtime code.

## History migration

The existing guarded PaymentIntent history rule also supports a narrow async class method or arrow method: retrieve the PaymentIntent, reject absent `charges` with the original error, then return `charges.data`. Its atomic patch retains retrieval and iterates all pages from the same field's `charges.list({ payment_intent })`. Empty history stays empty. It adds no client import and leaves SDK/API-version configuration unchanged.

Other function shapes retain the existing review boundaries. This is not an automatic refactor of arbitrary billing services. The added Charges requests, pagination, errors and application meaning still need review.

## Verification

Unit cases cover stable and unstable origins, shared-client mutations, lexical receivers, declared versions and mixed safe/review findings. Offline Docker workflows use actual Stripe 10.17.0/19.1.0 SDKs against simulated HTTP contracts, including TypeScript compilation, multi-page history, empty history and exact version headers. A real OpenAI 7.32.0 SDK case exercises an invented response-field rename; it is not an announced provider change or a live model request.

To run these cases with Docker and an existing `node:22-alpine` image:

```sh
REFIT_STRIPE_SDK=1 REFIT_OPENAI_SDK=1 REFIT_NPM_PREPARE=1 \
REFIT_DOCKER_IMAGE=node:22-alpine \
  npm test -- pipeline/class-clients.test.ts pipeline/class-client-sdk.test.ts --maxWorkers=1
```

Public repository call-tracing measurements are separate from migration correctness. See the [coverage report](SDK-COVERAGE.md).
