# Paykit compatibility checkpoint

Refit 0.20 was evaluated read-only against [`getpaykit/paykit` at `c7572ff`](https://github.com/getpaykit/paykit/tree/c7572ff7e0116428a43a2f98ad25dc2c26c8927e). It is a useful independent Stripe integration, but it is not currently a verified end-to-end migration target.

## What was checked

The public repository was cloned at a pinned commit with Git hooks disabled. Refit read 388 source files and ran its existing SDK-call coverage analyzer. Dependencies were not installed, application code and tests were not executed, no specifications were changed, and no model, Stripe-server or upstream GitHub write request was made. The target working tree remained clean.

The retained checkout and machine results are at `/Users/pierceluu/.refit/evaluations/paykit-2026-10-14`. The GitHub source commit is authoritative; no branch or PR was created in Paykit.

## Measured result

| Measurement | Result |
|---|---|
| Source files read | 388 |
| Likely Stripe SDK call candidates | 53 |
| Calls traced by the current scanner | 0 |
| Misses classified as parameter receivers | 41 |
| Other misses | 9 direct-client, 2 object-property, 1 mutable-binding |

Candidates and miss classes are heuristics, not ground-truth recall or precision. Zero traced calls is a scanner-visibility gap; it does not establish that the integration is unaffected or broken. This was a call-tracing benchmark, not an API-contract comparison or migration evaluation.

## Why this is a useful next case

[`createStripeAdapter`](https://github.com/getpaykit/paykit/blob/c7572ff7e0116428a43a2f98ad25dc2c26c8927e/packages/paykit/src/stripe/stripe-provider.ts#L1110) constructs the real client and passes it into the exported, two-argument `createStripeProvider`. Most API calls occur through that parameter or other helper parameters. Current tracing does not establish that provenance across this boundary. Merely trusting the `StripeSdk` annotation would bypass the existing safety boundary; imported type hints must remain review evidence.

The monorepo uses pnpm 12.4.2, workspace/catalog dependencies and a pnpm lockfile. Its Paykit package declares `stripe: ^19.1.0`; the inspected lockfile records 19.3.1. Refit's automatic lock resolution and restricted dependency preparation currently support npm, so they report the pnpm-resolved SDK version as unknown. This target would need reviewed dependency provisioning before isolated application checks could run.

Its source default API version is `2025-10-29.clover`, with runtime user overrides. That is a source declaration, not proof of the effective deployed version. The period helpers already read subscription-item periods and retain a legacy subscription-level fallback. The historical Acacia/Basil field move therefore must not be treated as a ready-made bug or automatically replaced with the demo's price-ID policy. Application meaning and the selected baseline still need review.

## Next verification

### Helper tracing checkpoint (0.21)

Reading the same unchanged commit with helper tracing recognizes **41 of the same 53 likely SDK call candidates**, up from zero. All 41 parameter-receiver misses are now traced. The analyzer records 45 SDK calls overall; four are outside the heuristic's likely-candidate set. All 45 carry helper review evidence because exported/escaped factory flows do not establish a closed caller set. This improves visibility, **not automatic migration eligibility**. The other twelve likely candidates remain unresolved.

The result is retained separately as `coverage-after-helpers.json` beside the original baseline. No dependencies or Paykit application code were executed. See [helper boundaries](HELPER-CLIENTS.md).

Establish real client provenance through supported helper/factory flows, preserving uncertainty for unknown callers and mutations. Separately add or supply locked pnpm preparation, identify an applicable real API change, and run meaningful application checks in isolation. A future GitHub App publication test should use an authorized repository or a user-owned fork with the App installed. Nothing in this read-only result establishes permission to publish to the upstream project.
