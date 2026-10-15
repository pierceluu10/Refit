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

## Curated Stripe basil moves

[`examples/stripe-basil-moves.provider.json`](../examples/stripe-basil-moves.provider.json) maps Stripe's invoice and invoice-item SDK methods. It configures the six basil moves that pass these checks against Stripe's published acacia and basil documents:

| Removed | New path |
|---|---|
| `invoice.subscription` | `invoice.parent.subscription_details.subscription` |
| `invoice.quote` | `invoice.parent.quote_details.quote` |
| `invoiceitem.subscription` | `invoiceitem.parent.subscription_details.subscription` |
| `invoiceitem.subscription_item` | `invoiceitem.parent.subscription_details.subscription_item` |
| `line_item.subscription_item` | `line_item.parent.subscription_item_details.subscription_item` |
| `line_item.invoice_item` | `line_item.parent.invoice_item_details.invoice_item` |

Copy it next to your contracts and reference it from `providerConfig`; add your own methods as needed. Line items are traced through `invoice.lines.data`. The other basil invoicing moves are deliberately absent because they change meaning:

- `invoice.subscription_details` and `line_item.proration_details` now refer to different object schemas.
- `invoice.subscription_proration_date` gained a `unix-time` format annotation, and Refit compares formats strictly.
- `line_item.proration` was always present, but its new location can be missing for non-subscription lines.

Those reads still need review or a reviewed AI proposal.

## What Refit verifies

Before scanning, Refit checks the move against your recorded contracts:

- The path resolves in the after contract and did not exist in the before contract.
- Every intermediate segment is a direct or single-member `anyOf` reference to an object component.
- The new value has the same declared shape as the removed one: type, `anyOf` members, references and expansion metadata. Descriptions and nullability are compared separately. One narrowing is accepted: an expandable `string | object` field whose new location holds exactly its ID string. Unexpanded responses always returned that string, and the expansion gate below applies.
- If any intermediate is nullable or not required, the removed field must have been nullable or optional. A required, non-nullable field always had a value, so a path that can be missing is refused.

A move that fails any check stops the run with an error naming the move.

## The proposed edit

Only direct property reads on confirmed, statically traced SDK responses change. The rest of the expression is kept. For Stripe's invoice move:

```diff
-  return invoice.subscription;
+  return (invoice.parent?.subscription_details?.subscription ?? null);
```

Nullability and optionality follow the recorded contract, not observed responses. Optional chaining appears only where the after contract allows a missing parent. For a removed nullable field, `?? null` keeps its `null` result when a parent is absent. A removed optional, non-nullable field read as `undefined` when absent, so its edit uses optional chaining without a fallback. If every intermediate is required and non-nullable, the edit reads the path directly.

Reads that already use the new path are not reported, even where other removals share a segment name. Stripe's basil release also removed top-level `invoice.subscription_details` and `invoiceitem.subscription`.

## Stops for review

- **Expanded fields.** If the moved value can be an expanded object, and any `expand` array names the old field or cannot be read statically, the read is left unchanged. The rescan reports it as unresolved. Expanding the old path would not expand the new one, so the value could silently change from an object to an ID string.
- **Webhook payloads.** Signed-event payloads keep their separate incoming-version review.
- **Declared types.** Values known only from `Stripe.*` type annotations are reported as confirmed but are not moved: such a value may be a webhook payload passed into a helper, on the endpoint's version.
- **Other shapes.** Destructuring, string indexes, writes and mutated responses keep the existing review rules. Responses that are only passed to functions, returned, stored or aliased stay confirmed and are moved.

The edit does not change the SDK version, the client's `apiVersion` pin or webhook endpoint versions. Review the rollout separately. For example, the same Stripe SDK's TypeScript types may not declare `parent` until you upgrade the SDK.

## Verified lab

A local repository used the curated adapter with the actual `stripe` 17.7.0 SDK and Stripe's published `2025-02-24.acacia` and `2025-04-30.basil` OpenAPI documents (`stripe/openapi` tags `v1505` and `v1719`). A loopback simulator served each version's invoice shape. `refit run` prepared npm dependencies with scripts disabled. The original code passed the acacia contract, and the migrated code passed the basil contract in offline Docker. It returned the subscription and subscription-item IDs for subscription invoices and items, and `null` for one-off ones. The original code fails against the basil shape.

The responses were simulated, not live Stripe calls. Contract comparison used direct property removals (`fullDiff: false`). With `--full-diff`, response enum additions no longer block Stripe automation unless the code switches over the field. On these contracts, 336 level-2/3 changes remain, 324 of them required-property removals. The lab's five retrieve calls map to operations with 54 such removals, all inside expanded objects such as `customer`. Under the current policy they still block, so the full-diff run proposes the same patch but stops for review.

The repository's checks only cover the code paths they exercise. Passing them does not prove the new field means the same thing in every case.
