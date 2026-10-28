# Structurally equivalent contract changes

Owner decision D4 (Pierce, 2026-10-27): an oasdiff change whose old and new schema accept the same values is not breaking. The check is generic for any OpenAPI provider (`pipeline/schema-equivalence.ts`). It resolves each side's `$ref`s in its own contract, ignores `title`, `description`, `example`, `examples` and `externalDocs`, compares `anyOf`, `oneOf`, `allOf`, `enum`, `required` and `type` as unordered lists, and compares every other keyword exactly. A comparison that walks more than 200,000 nodes counts as different. A matching change is listed with `reach: compatible` and `equivalence` naming its class, so it no longer blocks; it still appears in the draft with its reason.

## Classes

| `equivalence`       | oasdiff ids                                                                                                 | What matches                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `renamed-subschema` | `request-property-any-of-added/removed`, `request-property-one-of-added/removed`, and the `response-` forms | The subschema at the path oasdiff names accepts the same values in both contracts; only its title (or component name) changed. |
| `format-annotation` | `request-property-type-changed`, `request-parameter-type-changed`, `response-property-type-changed`         | Only `format` changed, and the format is one listed below, on the type it annotates.                                           |

Formats treated as annotations:

- `currency` on a string: the field already required "Three-letter ISO currency code, in lowercase" before the format was added (https://docs.stripe.com/currencies). A traced call that visibly sends a value Stripe rejects (an uppercase or non-three-letter literal) is still `reached`, or `handled` where the currency rule lowercases it.
- `unix-time` on an integer: every integer the field accepted is still an integer number of seconds.

Any other format change is compared like any other keyword and keeps its oasdiff level.

## Evidence

Checked against the pinned contracts in `data/stripe-openapi-versions.json`, 2023-10-16 (the most common `before` on `subsets/l2-push-249.json`, 73 rows) and 2026-09-30.endive (every row's `after`):

- `POST /v1/customers` `address`: oasdiff reports "removed `subschema #1: optional_fields_address` from the `address` request property `anyOf` list". Both contracts hold the same object (`city`, `country`, `line1`, `line2`, `postal_code`, `state`, each a string of at most 5000) next to `enum: [""]`; only the title changed to `optional_fields_customer_address` and the description gained a link. 90 such entries appear in the l2 baseline run 40448715209.
- `POST /v1/prices` `currency`: `{"type": "string"}` became `{"type": "string", "format": "currency"}` with the same description. 167 top-level and 112 nested `price_data/currency` entries appear in the same run.

Benchmark before/after numbers are in `docs/BENCHMARKS.md`.

## Reach through the response path

Founder decision (Otabek, 2026-10-28): a response change that oasdiff names by a path (`error/payment_intent/amount`, `line_items/data/items/description`) reaches code only if the code reads every named property on that path, not just the last one (`pipeline/operation-reach.ts`, `responsePropertyOwner` and `annotateReach`). Each property on the path that a named component owns must be read somewhere outside test files, traced or by the same name on an untraced value; if one is never read, the change is `unused` with the reason "No code reads `<schema>.<property>`, the only way to `<owner>.<property>` in this response." Two links are skipped because stripe-node reads them for the code: the top level of an error body (the SDK throws its `error` object) and a list page's root array (auto-pagination iterates `data`). Inline objects own no component and are not checked.

This is a reach rule, not an equivalence: the changes it clears are real. In the 2023-10-16 to 2026-09-30.endive contracts:

- `payment_intent` no longer lists `amount` and `currency` as required (first in 2025-06-30.basil, tag v1819, together with `capture_method`, `confirmation_method` and `payment_method_types`). Stripe documents no case where a PaymentIntent omits them: no changelog entry (https://docs.stripe.com/changelog/basil, read 2026-10-28), the API reference does not mark them optional (https://docs.stripe.com/api/payment_intents/object, read 2026-10-28), and stripe-node still types them as required. Inside every operation's `default` (error) response it appears as `error/payment_intent/amount`; code that never reads a caught error's `payment_intent` cannot reach it. Direct reads of a PaymentIntent's `amount` still block.
- Checkout line item `description` became optional in 2024-09-30.acacia (https://docs.stripe.com/changelog/acacia/2024-09-30/description-optional-checkout-session-line-item, read 2026-10-28) and nullable in 2024-12-18.acacia. A Checkout Session returns `line_items` only when expanded (https://docs.stripe.com/expand, read 2026-10-28), and code reaches them only by reading `line_items`; sending `line_items` in a request is not a read.

What still blocks: a read of the link on any untraced value (`error.raw.payment_intent`, `session.line_items` on an untraced session), with a read of the changed property by the same name; a traced read of the changed property through every link; and every change whose path has no named owner.
