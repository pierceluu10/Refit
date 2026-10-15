# Moved response fields

Some API versions move a field rather than delete it. Stripe's [2025-03-31.basil release moved `invoice.subscription`](https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects) under `invoice.parent.subscription_details.subscription`. A provider adapter can map that move explicitly, and Refit proposes the edit deterministically. No AI is used.

## Configure a move

Use a custom adapter, referenced by `providerConfig`, whose ID differs from the reserved built-in `stripe` ID. Add the move to `propertyRenames` with a dot-separated replacement path:

```json
{
  "id": "stripe-basil-moves",
  "packageName": "stripe",
  "defaultImport": true,
  "namedExport": null,
  "operations": [{ "resource": "invoices", "method": "retrieve", "schema": "invoice" }],
  "propertyRenames": [
    {
      "schema": "invoice",
      "removed": "subscription",
      "replacement": "parent.subscription_details.subscription"
    }
  ]
}
```

A path has at most four identifier segments, and `__proto__` is refused. A replacement without a dot keeps the existing [scalar rename](CLI.md) behavior.

## What Refit verifies

Before scanning, Refit checks the move against your recorded contracts:

- The path resolves in the after contract and did not exist in the before contract.
- Every intermediate segment is a direct or single-member `anyOf` reference to an object component.
- The new value has the same declared shape as the removed one: type, `anyOf` members, references and expansion metadata. Descriptions and nullability are compared separately.
- If any intermediate is nullable or not required, the removed field must have been nullable.

A move that fails any check stops the run with an error naming the move.

## The proposed edit

Only direct property reads on confirmed, statically traced SDK responses change. The rest of the expression is kept. For Stripe's invoice move:

```diff
-  return invoice.subscription;
+  return (invoice.parent?.subscription_details?.subscription ?? null);
```

Optional chaining appears only where the after contract allows a missing parent. `?? null` keeps the removed field's `null` result when a parent is absent. If every intermediate is required and non-nullable, the edit reads the path directly without a fallback.

Reads that already use the new path are not reported, even where other removals share a segment name. Stripe's basil release also removed top-level `invoice.subscription_details` and `invoiceitem.subscription`.

## Stops for review

- **Expanded fields.** If the moved value can be an expanded object, and any `expand` array names the old field or cannot be read statically, the read is left unchanged. The rescan reports it as unresolved. Expanding the old path would not expand the new one, so the value could silently change from an object to an ID string.
- **Webhook payloads.** Signed-event payloads keep their separate incoming-version review.
- **Declared types.** Values known only from `Stripe.*` type annotations remain review hints.
- **Other shapes.** Destructuring, string indexes, writes, aliases of object-valued fields and escaped responses keep the existing review rules.

The edit does not change the SDK version, the client's `apiVersion` pin or webhook endpoint versions. Review the rollout separately. For example, the same Stripe SDK's TypeScript types may not declare `parent` until you upgrade the SDK.

## Verified lab

A local repository used the actual `stripe` 17.7.0 SDK and Stripe's published `2025-02-24.acacia` and `2025-04-30.basil` OpenAPI documents (`stripe/openapi` tags `v1505` and `v1719`). A loopback simulator served each version's invoice shape. `refit run` prepared npm dependencies with scripts disabled. The original code passed the acacia contract, and the migrated code passed the basil contract in offline Docker. It returned the subscription ID for a subscription invoice and `null` for a one-off invoice. The original code fails against the basil shape.

The responses were simulated, not live Stripe calls. Contract comparison used direct property removals (`fullDiff: false`). On these real contracts, `--full-diff` reports 1,784 level-2/3 changes in components reachable from `invoices.retrieve`: 1,560 response enum additions and 216 required-property removals. Under the current policy, any unmapped breaking change blocks automation. Treating these differently is an open policy decision, so the full-diff gate is unchanged.

The repository's checks only cover the code paths they exercise. Passing them does not prove the new field means the same thing in every case.
