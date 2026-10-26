# Rule packs

A rule pack holds one provider's migration rules as data. Each entry names a **family**, the code that edits, and the facts the family needs: which removed field or parameter, where it went, which generated helper reads it, which guards apply, the changelog page and the draft warning. Families know nothing about a provider; entries carry the provider.

Stripe's built-in rules are the first pack: [`data/packs/stripe.json`](../data/packs/stripe.json), loaded and checked by [`pipeline/rule-pack.ts`](../pipeline/rule-pack.ts). Moving them there changed no behaviour (see [Behaviour check](#behaviour-check)).

## Families

| Family | Code | What an entry rewrites | Entry fields beyond rule, source, warning |
|---|---|---|---|
| `moved-value` | [`field-move-families.ts`](../pipeline/field-move-families.ts) | `receiver.property` → `helper(receiver)` | `schemas`, `property`, `helper`, `targets`; optional `droppedFields` (child reads that stay for review), `readsOnly` (writes stay), `unlessExpanded` (skip when the code expands the field), `typeofGuard` and `narrowTested` (TypeScript reads that narrow share one local) |
| `moved-id` | same | `receiver.property.id` → `helper(receiver)` | `schemas`, `property`, `helper`, `targets` |
| `period-helper` | same | each property's read → its helper, with the item-selection plan | `schemas`, `helpers` (property → helper), `targets` |
| `request-rename` | [`request-move-families.ts`](../pipeline/request-move-families.ts) | `parameter: value` → `replacement: value` in a direct SDK call body | `operations`, `parameter`, `replacement` |
| `request-wrap` | same | `parameter: value` → `replacement: { type: discriminator, parameter: value }` | `operations`, `parameter`, `replacement`, `discriminator` |
| `readReviews` | [`stripe-field-moves.ts`](../pipeline/stripe-field-moves.ts) | nothing: the removed read stops for review with this reason | `schema.property` → reason with its source |

Every family keeps the gates it had: a field move applies only when every `targets` path exists in the target contract; a request move only when both recorded contracts agree with it (same shape for a rename; a required string moving into a holder whose `type` accepts the discriminator for a wrap). The loader refuses a pack with an unknown family, a repeated rule, a source that is not https, a helper that is not an identifier, an empty target path, a flag set to anything but `true`, a wrap without a discriminator, or a read review without its source.

## What stays Stripe code

Moving the rules to data shows what a provider still costs in code. For Stripe, outside the pack:

- **The helper library** (`subscriptionPeriodHelperModule` in `stripe-subscription-periods.ts`): the runtime bodies the pack's `helper` names call. Each new moved field needs a body here; `rule-pack.test.ts` fails when a pack names a helper without one.
- **Owner-decision rules**: the price policy for subscription periods, `payment_method_types` → `allowed_payment_method_types` (`request-removals.ts`), `invoices.createPreview` (`stripe-invoice-preview.ts`), the currency-code rule and the API version pin. Each has conditions an owner decided and stays code until those conditions fit a family.
- **SDK facts**: webhook payload tracing, `Stripe.*` type evidence, expand paths, open enums, the stripe-node upgrade and the operation map.

## Adding an entry

1. Read the provider's changelog page and both contracts; record the page as `source`.
2. Pick the family whose rewrite is behaviour-preserving for the change. If none is, add a `readReviews` reason instead; never stretch a family.
3. For a field move, add the helper body if the helper is new, and set `targets` to every path the new location needs.
4. Add a fixture test that runs the rule end to end, as the existing `stripe-*.test.ts` files do, and run `npm test`.

## Behaviour check

The pack replaced hand-written rules without changing their output: the full test suite passes unchanged except for imports, and the no-AI Stripe benchmark on the frozen 100-repository list gave the same outcome for every repository before and after the change (runs and commits in [Benchmarks](BENCHMARKS.md#rule-pack-refactor)).

One internal label can differ: when one file needs both the coupon-ID and product-features helpers, the generated helper module's edit now carries the product rule instead of the coupon rule. Draft text, warnings and sources are unchanged.
