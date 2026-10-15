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

Exported helpers, function aliases/callbacks, unknown or missing arguments, multiple client origins, defaults, optional/rest parameters, spread/optional calls, recursion and detected mutations require review. Their affected findings stop the entire automated run before AI, checks or publication, including runs containing unrelated confirmed findings. Reports identify both the call and parameter location. Destructured parameters, arbitrary methods, dynamic factories and cross-language flows remain outside this helper support.

Actual Stripe SDK HTTP and TypeScript checks cover the historical history migration, version headers, pagination and empty lists in offline Docker. Actual OpenAI SDK HTTP checks cover a configured, **invented** response rename. Neither is evidence of a live vendor change or deployment. See the independent [Paykit evaluation](PAYKIT-EVALUATION.md) for a real repository's remaining boundaries.
