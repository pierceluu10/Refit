# Rule packs

A rule pack holds one provider's migration rules as data. Each entry names a **family**, the code that edits, and the facts the family needs: which removed field or parameter, where it went, which generated helper reads it, which guards apply, the changelog page and the draft warning. Families know nothing about a provider; entries carry the provider.

Stripe's built-in rules are the first pack: [`data/packs/stripe.json`](../data/packs/stripe.json), loaded and checked by [`pipeline/rule-pack.ts`](../pipeline/rule-pack.ts). Since 2026-10-27 that file holds only read reviews: Stripe's field and request moves are generated rule tables in [`data/rules/stripe/`](../data/rules/stripe/), each rule a pack entry plus its page, quote, oasdiff entry, status and benchmark evidence; only `auto` rules join the pack (`STRIPE_PACK`). See [Generated rules](MINED-RULES.md#generated-rules) and `npm run rules:check`. Moving them there changed no behaviour (see [Behaviour check](#behaviour-check)). Shopify is the second: [`data/packs/shopify.json`](../data/packs/shopify.json) uses none of the edit families and holds only SDK facts and symbol reviews (see [Per-provider cost](#per-provider-cost)).

## Families

| Family           | Code                                                               | What an entry rewrites                                                        | Entry fields beyond rule, source, warning                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `moved-value`    | [`field-move-families.ts`](../pipeline/field-move-families.ts)     | `receiver.property` → `helper(receiver)`; writes and deletes stay for review  | `schemas`, `property`, `helper`, `targets`; optional `droppedFields` (child reads that stay for review), `unlessExpanded` (skip when the code expands the field), `typeofGuard` and `narrowTested` (TypeScript reads that narrow share one local) |
| `moved-id`       | same                                                               | `receiver.property.id` → `helper(receiver)`                                   | `schemas`, `property`, `helper`, `targets`                                                                                                                                                                                                        |
| `period-helper`  | same                                                               | each property's read → its helper, with the item-selection plan               | `schemas`, `helpers` (property → helper), `targets`                                                                                                                                                                                               |
| `request-rename` | [`request-move-families.ts`](../pipeline/request-move-families.ts) | `parameter: value` → `replacement: value` in a direct SDK call body           | `operations`, `parameter`, `replacement`                                                                                                                                                                                                          |
| `request-wrap`   | same                                                               | `parameter: value` → `replacement: { type: discriminator, parameter: value }` | `operations`, `parameter`, `replacement`, `discriminator`                                                                                                                                                                                         |
| `readReviews`    | [`stripe-field-moves.ts`](../pipeline/stripe-field-moves.ts)       | nothing: the removed read stops for review with this reason                   | `schema.property` → reason with its source                                                                                                                                                                                                        |

### SDK facts and symbol reviews

Facts edit nothing: a provider's rules consult them before an edit names an SDK symbol. Each fact names its `package`, an https `source` and the `checkedAt` day someone read it. Both sections are optional, so a `formatVersion` 1 pack without them (Stripe's) loads unchanged.

| Section and family           | Answers                                                                             | Fields                                                                 | Used by                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `sdkFacts`, `member-since`   | the first release whose types define each member of a symbol (`releaseDefines`)     | `symbol`, `since` (member → release)                                   | Shopify: an `ApiVersion.<member>` pin edit needs the locked SDK to define the member |
| `sdkFacts`, `constant-value` | the value a constant has in a release (`constantValue`)                             | `symbol`, `values` ([release, value], ascending), optional `removedIn` | Shopify: what `LATEST_API_VERSION` resolves to                                       |
| `sdkFacts`, `minimum-major`  | the oldest major of a package that serves a supported API version (`minimumMajors`) | `major`                                                                | Shopify: the opt-in SDK upgrade's target majors                                      |
| `symbolReviews`              | why a use of an SDK identifier stops for review in an SDK upgrade                   | identifier → `reason`, `source`                                        | Shopify: `RELEASE_CANDIDATE_API_VERSION`, `getJwt`, `setCrypto`                      |

For `member-since` and `constant-value`, a release that is not `major.minor.patch` answers false or undefined, so an edit stops instead of guessing; a prerelease suffix is ignored, as before.

Every family keeps the gates it had: a field move applies only when every `targets` path exists in the target contract; a request move only when both recorded contracts agree with it (same shape for a rename; a required string moving into a holder whose `type` accepts the discriminator for a wrap). The loader refuses a pack with an unknown family, a repeated rule, a source that is not https, a helper that is not an identifier, an empty target path, a flag set to anything but `true`, a wrap without a discriminator, a read review without its source, an SDK fact without an https source or `checkedAt`, constant values out of release order, or a symbol review without its source.

## What stays Stripe code

Moving the rules to data shows what a provider still costs in code. For Stripe, outside the pack:

- **The helper library** (`subscriptionPeriodHelperModule` in `stripe-subscription-periods.ts`): the runtime bodies the pack's `helper` names call. Each new moved field needs a body here; `rule-pack.test.ts` fails when a pack names a helper without one.
- **Owner-decision rules**: the price policy for subscription periods, `payment_method_types` → `allowed_payment_method_types` (`request-removals.ts`), `invoices.createPreview` (`stripe-invoice-preview.ts`), the currency-code rule and the API version pin. Each has conditions an owner decided and stays code until those conditions fit a family.
- **SDK facts**: webhook payload tracing, `Stripe.*` type evidence, expand paths, open enums, the stripe-node upgrade and the operation map.

## What stays Shopify code

Shopify's only automatic edits are the API-version pin move and the opt-in SDK upgrade. Neither fits an existing family, and neither became a new one:

- **Version-pin move** (`versionFindings` in `shopify-pipeline.ts`): Stripe's pin move (`run.ts`) shares only "replace the literal with the target". What counts as a pin (`ApiVersion` enum members, `apiVersion` strings, `/admin/api/<version>/` URLs, codegen configs that move without a finding, `LATEST_API_VERSION`), which version is served (Shopify answers an unsupported version with the oldest supported one) and the gate (every GraphQL document validates on the target and no selected field changes type) are all provider facts written as logic. A shared family would need a shared pin scanner and gate; forcing one would hide the differences rather than remove code.
- **Contract format**: GraphQL introspection snapshots, document validation and type-change findings (`shopify-schemas.ts`, `checkDocument`). Stripe's contracts are OpenAPI, which the shared pipeline handles.
- **Tracer**: `shopify-analysis.ts` finds Admin GraphQL documents, pins and REST calls.
- **SDK upgrade**: the npm lockfile writer (`shopify-sdk-upgrade.ts`) and the source edits and stops it needs (`shopify-sdk-source.ts`: `LATEST_API_VERSION` → `ApiVersion.<member>`, dropping `future.removeRest: true`, the accepted future flags per package, billing and `apiVersion`-required stops). The flag lists stayed code because they only mean something to that checker.
- **REST deprecations**: report only, from the generated [`data/shopify-rest-deprecations.json`](../data/shopify-rest-deprecations.json) (`npm run shopify-rest:check`), kept out of the pack because a script regenerates it.

## Per-provider cost

Lines are non-blank lines (`grep -cv '^\s*$' <file>`) of non-test files whose name starts with the provider (`pipeline/stripe-*.ts`, `pipeline/shopify-*.ts`), counted on this branch. Provider code inside shared files (Stripe's pin move and SDK checks in `run.ts`, `analyzer.ts`, `request-removals.ts`, `patches.ts`) is not counted, so Stripe's number is low. Tooling is the benchmark and ground-truth CLIs.

|                                          | Stripe                                                                                                       | Shopify                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Pack entries                             | 39: 6 field moves, 2 request moves, 31 read reviews (since 2026-10-27 the 8 moves are generated rule tables) | 9: 6 SDK facts, 3 symbol reviews; 0 edit-family entries                                        |
| Pack lines                               | 138                                                                                                          | 89                                                                                             |
| Provider code, runtime                   | 3,138                                                                                                        | 3,506                                                                                          |
| Provider code, tooling                   | 1,753                                                                                                        | 338                                                                                            |
| Moved from code to pack by the pack work | rules → 39 entries, plus 3 shared families (field moves 362, request moves 139 lines)                        | 47 lines (1.2% of Shopify's code)                                                              |
| New families                             | `moved-value`, `moved-id`, `period-helper`, `request-rename`, `request-wrap`, `readReviews`                  | `member-since`, `constant-value`, `minimum-major`, `symbolReviews` (facts and stops, no edits) |
| Other provider data                      | `data/stripe-openapi-versions.json`                                                                          | `data/shopify-rest-deprecations.json` (1,024) and its generator (235)                          |

Runtime files: Stripe `stripe-expand-paths` 95, `stripe-field-moves` 126, `stripe-invoice-preview` 222, `stripe-open-enums` 356, `stripe-operations` 146, `stripe-package-upgrade` 907, `stripe-subscription-periods` 542, `stripe-type-evidence` 83, `stripe-types` 189, `stripe-webhook-payloads` 472; tooling `stripe-benchmark-cli` 814, `stripe-benchmark-score` 226, `stripe-benchmark` 256, `stripe-ground-truth` 377, `stripe-ground-truth-cli` 80. Shopify `shopify-analysis` 1,182, `shopify-pipeline` 684, `shopify-sdk-upgrade` 718, `shopify-rest-deprecations` 427, `shopify-sdk-source` 255, `shopify-rest-cli` 95, `shopify-schemas` 66, `shopify-snapshot-cli` 40, `shopify-versions` 39; tooling `shopify-benchmark-cli` 338.

What the remaining code is:

| Kind               | Stripe                                                                                           | Shopify                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Helper library     | generated helper bodies (`stripe-subscription-periods`)                                          | none                                                                                           |
| SDK facts as logic | webhook payloads, `Stripe.*` types, expand paths, open enums, operation map, stripe-node upgrade | Admin-call tracer, npm SDK upgrade, SDK source edits                                           |
| Owner decisions    | price policy, `payment_method_types`, `invoices.createPreview`, currency codes, version pin      | REST stays report only (REST-to-GraphQL migration is an owner decision); SDK upgrade is opt-in |
| Contract format    | OpenAPI (shared pipeline)                                                                        | GraphQL introspection, validation, report shaping (`shopify-pipeline`, `shopify-schemas`)      |

The honest reading: the edit families pay off when a provider's breaking changes are field and parameter moves inside one contract format. Shopify's changes are found by validating documents against the target schema, so it has no moved-field entries to write, and its single edit (the pin) is mostly provider logic. Adding Shopify to the pack format moved 1.2% of its code to data; a second provider costs roughly 3,500 lines of runtime code when its contract format and SDK differ, and the families do not change that.

Which provider to give a pack next, by how many of its recorded changes these families and the shared mechanisms already cover, is in [Provider family fit](PROVIDER-FAMILY-FIT.md).

## Adding an entry

For Stripe field and request moves, run `refit rules generate` instead and review its output; hand-written moves are no longer added to the pack (owner decision D5).

1. Read the provider's changelog page and both contracts; record the page as `source`.
2. Pick the family whose rewrite is behaviour-preserving for the change. If none is, add a `readReviews` reason instead; never stretch a family.
3. For a field move, add the helper body if the helper is new, and set `targets` to every path the new location needs.
4. Add a fixture test that runs the rule end to end, as the existing `stripe-*.test.ts` files do, and run `npm test`.

## Behaviour check

The pack replaced hand-written rules without changing their output: the full test suite passes unchanged except for imports, and the no-AI Stripe benchmark on the frozen 100-repository list gave an identical result record for every repository before and after the change (runs and commits in [Benchmarks](BENCHMARKS.md#rule-pack-refactor-october-26)).

The Shopify pack changed no outcome either: the no-AI Shopify benchmark on the frozen 50-repository list gave identical results for every repository before and after (runs in [Benchmarks](BENCHMARKS.md#shopify-rule-pack-october-26)).

One internal label can differ: when one file needs both the coupon-ID and product-features helpers, the generated helper module's edit now carries the product rule instead of the coupon rule. Draft text, warnings and sources are unchanged.
