# Stripe webhook historical field scan

The 15 Stripe entries in [the pinned SDK repository list](2026-10-14-sdk-repos.json) were read at their recorded commits. HEAD and clean Git state were verified before each scan. No application dependencies or code were installed or executed. The same source inputs were analyzed with baseline Refit `5c3f0cf` and webhook implementation `40b06da`.

Two reviewed historical projections were used: the [Acacia-to-Basil subscription period move](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end), and that move plus the documented [Invoice.subscription replacement](https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects). These are small contract projections, not downloaded full vendor specifications. A finding would not independently establish incoming version applicability.

| Measurement | Before | After |
|---|---:|---:|
| Pinned repositories | 15 | 15 |
| Scanner refusals | 1 | 1 |
| Confirmed reads for either projection | 0 | 0 |
| Webhook-provenance findings for subscription periods | 0 | 0 |
| Webhook-provenance findings with Invoice.subscription included | 0 | 0 |

`grepsoft/thelibrary` was refused because `auth.ts` contains a parse error. The other 14 were scanned without executing them. This sample did not demonstrate detection of a real affected webhook period read. Existing request-response/helper flows, unsupported configuration and cross-function payload handling remain gaps; zero findings does not prove the applications are compatible.

An initial incomplete Invoice projection produced three review matches in Checkout Session branches. That exposed a same-name filtering flaw: Checkout Session's `subscription` is not Invoice's removed field. Known event-schema mappings now discard those matches even when the supplied projection omits Checkout Session's component. Regression tests preserve this distinction and keep genuinely unresolved schemas under review.

Retained scripts, inputs and per-repository results are at `/Users/pierceluu/.refit/evaluations/stripe-webhooks-2026-10-14/benchmark`. `final-results.json` and `final-invoice-results.json` are the final comparisons. Earlier exploratory results remain for debugging and must not be used as affected-usage metrics.

These results are separate from the 45-repository SDK call benchmark and the 100-repository Stripe migration benchmark. The signed real-SDK fixture proves bounded tracing and historical failure behavior; it does not establish ground-truth recall, precision or migrations across these public repositories.
