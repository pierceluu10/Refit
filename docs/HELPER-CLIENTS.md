# SDK clients passed into helpers

Refit traces SDK arguments into named function declarations and identifier-bound arrow/function expressions. Identity comes from an actual imported SDK constructor or an already traced client, never a parameter's type annotation alone.

```ts
const stripe = new Stripe(key, { apiVersion: '2022-08-01' });

async function readHistory(sdk: Stripe, id: string) {
  const intent = await sdk.paymentIntents.retrieve(id);
  if (!intent.charges) { throw new MissingHistory('Missing history'); }
  return intent.charges.data;
}

export const chargeHistory = (id: string) => readHistory(stripe, id);
```

Private helpers qualify for existing migration rules when their direct callers are known, the SDK argument has one stable origin, and neither the function nor client escapes or mutates. Supported aliases and helper chains retain that provenance. Constructor versions and request overrides still pass through the existing [API-version gate](API-VERSIONS.md).

The narrow guarded Stripe history shape above retains retrieval and replaces the field guard/read with the same client's paginated Charges iterator. Other response renames, request-field rules and endpoint replacements retain their own contract requirements. Tracing a helper does not create a new migration rule.

Exported helpers, function aliases/callbacks, unknown or missing arguments, multiple client origins, defaults, optional/rest parameters, spread/optional calls, recursion and detected mutations require review. Their affected findings stop the entire automated run before AI, checks or publication, including runs containing unrelated confirmed findings. Reports identify both the call and parameter location. Destructured parameters are traced only as [injected clients](#injected-clients), for review; arbitrary methods, dynamic factories and cross-language flows remain outside this helper support.

## Injected clients

Applications often hand the client in rather than import it: a default parameter, a destructured `{ stripe }` argument, a factory passed as a default, or a constructor parameter (see [class clients](CLASS-CLIENTS.md#injected-constructor-clients)). Refit traces such a parameter when every call outside test files fills it with a traced client, or leaves it to a default that is one (`pipeline/injected-clients.ts`):

```js
export function createClient(key, Constructor = Stripe) {
  return new Constructor(key, { apiVersion: '2025-02-24.acacia' });
}

export async function refund({ stripe, orderId }) {
  return stripe.refunds.create({ payment_intent: orderId });
}

await refund({ stripe: createClient(process.env.STRIPE_SECRET_KEY), orderId });
```

- **Only calls outside tests count.** Test files, by the same paths that never count as production requests, may pass fakes. There must be at least one other call.
- **Every reference must be a direct call.** That means a call (or `new`) of the function by name or through a namespace import, or a type, import or export. A callback, `.call`/`.apply`, a spread argument or a subclass leaves its parameters untraced. So do a default export and an exported Next.js route handler name (`GET`, `POST`, …), because a framework calls them.
- **Destructured properties are followed one level, through an object literal argument.** The property can be written out (`{ stripe: make() }`), shorthand (`{ stripe }`) or left to its default. A spread or computed property, or an argument that is not an object literal, leaves the parameter untraced. That includes a spread placed after the client, because it may replace it.
- **A function passed as a default is called wherever its parameter is,** as long as every call leaves that parameter out. Examples are `{ createStripe = createClient }` and `Constructor = Stripe`.
- **A `const` that picks between a parameter and a client is the client.** For example, `const stripe = injected || createClient(key)` where every call leaves `injected` out.
- **Libraries are left out.** An exported function or class of a package whose `package.json` declares the SDK as a peer dependency is a library's API. Other applications call it with their own clients, so its parameters stay untraced.

Being traced tells reach which operations the calls request. It never makes them safe to migrate: findings through injected clients, and through a constructor that is itself a parameter, stay for review, and that constructor's pins count as untraced.

Actual Stripe SDK HTTP and TypeScript checks cover the historical history migration, version headers, pagination and empty lists in offline Docker. Actual OpenAI SDK HTTP checks cover a configured, **invented** response rename. Neither is evidence of a live vendor change or deployment. See the independent [Paykit evaluation](PAYKIT-EVALUATION.md) for a real repository's remaining boundaries.
