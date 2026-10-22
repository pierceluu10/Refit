# Upstream replay results

This replays six real breaking changes against 18 public repositories whose maintainers fixed them by hand. For each repository, Refit ran on the commit just before the maintainers' fix, and its result is compared with that fix. The question is whether Refit would have caught the break, how much earlier, and whether its patch matches what the maintainers did.

- **Changes:** Stripe `2025-03-31.basil` (subscription periods), Stripe `2026-09-30.endive` (`payment_method_types`), the Anthropic `claude-sonnet-4-20250514` retirement, the OpenAI `gpt-4-turbo-preview` shutdown and Shopify Admin API `2025-01`. The sixth, Meta Graph API v20.0, is a deadline-only provider: Refit reports it but has no patch.
- **Refit:** commit [`984668b`](https://github.com/pierceluu10/Refit/commit/984668b3c8e9d2224dff21acbaaa1670d6b8f6c9), clean, run on 2026-10-22. The harness records of the 8 Stripe and Shopify runs are in the results file. The model retirement and Meta Graph rows have no harness record: their commit and clean tree are unrecorded, so those rows rest on this statement alone.
- **Data:** the cases, with each search query and the day it ran, are in [`benchmarks/2026-10-22-upstream-replay-cases.json`](benchmarks/2026-10-22-upstream-replay-cases.json). The results are in [`benchmarks/2026-10-22-upstream-replay-results.json`](benchmarks/2026-10-22-upstream-replay-results.json), checked by `node scripts/benchmark-results.mjs --committed`. The runs crashed before writing their summaries, so the results file was assembled by hand from the rows each run did write.
- **Safety:** each repository was read at its pinned commit. Its own checks ran only inside Refit's offline Docker sandbox, one repository per Docker lock hold. No vendor API or model was called, and nothing was published.

## Summary

- **Refit flagged the break in 15 of the 18 repositories** at the commit before the fix. The other 3 are Python, which Refit does not read.
- **It wrote a patch for 7 of them:** 4 complete and 3 partial. In the other 8 it stopped at a flag, mostly because a Stripe client's API version could not be proven (see [Misses and stops](#misses-and-stops)).
- **Validation in offline Docker:**
  - 3 patches passed the repository's own checks.
  - PDFNinja's patch failed typecheck. Refit caught that itself, so nothing would have been published.
  - 4 more got no verdict: trondbot's build already failed before the patch, mikki-mase.com and rcweb were over the archive limits, and PawRecords has no checks.
- **Lead time:** for the 13 repositories with a dated signal, Refit could have flagged the break 0 to 159 days before the maintainers fixed it (median 16).
  - The 4 Anthropic repositories sent a retired model for 65 to 92 days before their fix. Refit's first default alert would have come 92 to 136 days before the fix.
- **Against the maintainers' fixes:**
  - Refit was more complete in 2 Stripe repositories. It migrated an `invoice.subscription` read the maintainers missed, and in PDFNinja it read the period end where the maintainers stored the period start.
  - It was less complete in saas-scaffolding, where it kept the old version pin and left one read for review.

## Replay table

Days earlier run from the earliest signal to the UTC date of the maintainers' fix. "Broken" is how many days the code sent a retired model before that fix. Every commit is a pinned link. The patch counts are sites patched out of sites found.

| Change | Repository | Before | Fix | Code added | Refit | Earliest signal | Days earlier | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Stripe basil | [SergeySharipov/ai-companion-saas](https://github.com/SergeySharipov/ai-companion-saas) | [`5972f03`](https://github.com/SergeySharipov/ai-companion-saas/commit/5972f03c013e65173c9de5ee98900ead13a78ffe) | [`7001a74`](https://github.com/SergeySharipov/ai-companion-saas/commit/7001a74e7b0983d6d8de9048edba644467fa25e1) 2025-04-15 | [`c935505`](https://github.com/SergeySharipov/ai-companion-saas/commit/c9355058c14353fad43c2620e933750e0510481c) | Patch (3 of 3 confirmed) | 2025-03-31 | 15 | passed |
| Stripe basil | [anand-mukul/PDFNinja](https://github.com/anand-mukul/PDFNinja) | [`c13e13e`](https://github.com/anand-mukul/PDFNinja/commit/c13e13ee34de4858a089ad4953be1fc77a0dbd83) | [`e48393b`](https://github.com/anand-mukul/PDFNinja/commit/e48393bfb88c59d8c9dcc336d02991f61de67641) 2025-08-15 | [`c34ea45`](https://github.com/anand-mukul/PDFNinja/commit/c34ea45fc655a537570c6522af7274691b95ca48) | Patch (3 of 3 confirmed, 4 review) | 2025-03-31 | 137 | failed |
| Stripe basil | [trentas/saas-scaffolding](https://github.com/trentas/saas-scaffolding) | [`4f3e953`](https://github.com/trentas/saas-scaffolding/commit/4f3e953480d1ff2038cdb87846a78b591be1d76a) | [`b104c9e`](https://github.com/trentas/saas-scaffolding/commit/b104c9e44e5605e72f7386e55023bd3642270662) 2026-03-31 | [`8186919`](https://github.com/trentas/saas-scaffolding/commit/8186919d812476edfbdcc559ed37e09ddf0edfdd) | Partial patch (5 of 5 confirmed, 2 review) | 2025-10-23 | 159 | passed |
| Stripe endive | [deniaiapp/deni-ai](https://github.com/deniaiapp/deni-ai) | [`81c6dbd`](https://github.com/deniaiapp/deni-ai/commit/81c6dbdc2abc5087bf097a8c97c4a1e5cea557e6) | [`5345d69`](https://github.com/deniaiapp/deni-ai/commit/5345d696ba93e0c5b532f7b39befc2c88e968082) 2026-10-03 | [`274384d`](https://github.com/deniaiapp/deni-ai/commit/274384d1090830a3e3fb7c66c4d2ca91ebd3d821) | Flagged | 2026-09-30 | 3 | not-run |
| Stripe endive | [Singuralitylabs/sinlab-study](https://github.com/Singuralitylabs/sinlab-study) | [`5030fe2`](https://github.com/Singuralitylabs/sinlab-study/commit/5030fe28255888b3a18ba01d129bd405571d721d) | [`e9da9d2`](https://github.com/Singuralitylabs/sinlab-study/commit/e9da9d221968f38f611e41260423a25476816ea7) 2026-10-12 | [`2539c86`](https://github.com/Singuralitylabs/sinlab-study/commit/2539c86c5908f989f12d6df48556bb2f7f7aa66a) | Flagged | 2026-09-30 | 12 | not-run |
| Stripe endive | [caballerorandy6/rcweb](https://github.com/caballerorandy6/rcweb) | [`1738856`](https://github.com/caballerorandy6/rcweb/commit/1738856a2427f6efc2167222436f890bf8346091) | [`bb10bea`](https://github.com/caballerorandy6/rcweb/commit/bb10bea17ab807d87c8fa75decfe9e28d631776b) 2026-10-16 | [`674adfd`](https://github.com/caballerorandy6/rcweb/commit/674adfdfc04862b84cfa951d8194581d0e83cbed) | Flagged | 2026-09-30 | 16 | error |
| Stripe endive | [Lala-Arham/Last-Bite-App](https://github.com/Lala-Arham/Last-Bite-App) | [`429e7f7`](https://github.com/Lala-Arham/Last-Bite-App/commit/429e7f7f465c8db2da91c58dfccb668a7cc084cd) | [`35da25f`](https://github.com/Lala-Arham/Last-Bite-App/commit/35da25fda54057f8c31c374043a4c42271065f88) 2026-10-04 | [`5b642ef`](https://github.com/Lala-Arham/Last-Bite-App/commit/5b642ef6ee543c1550f0076ce3a37a7aa7ef5841) | Flagged | 2026-10-01 | 3 | not-run |
| Anthropic Sonnet 4 | [remypol/mikki-mase.com](https://github.com/remypol/mikki-mase.com) | [`39ed41a`](https://github.com/remypol/mikki-mase.com/commit/39ed41a71d54ea768222ba4be2fdc3685d8e19ee) | [`2cdfdc8`](https://github.com/remypol/mikki-mase.com/commit/2cdfdc82029aa3fcf5cc4c7422a6c29d66bbb56c) 2026-08-19 | [`e16a072`](https://github.com/remypol/mikki-mase.com/commit/e16a072a517d5656331f80b78fa2162bbee1a0c1) | Patch (1 of 1) | 2026-04-14 | 127 (broken 65) | refused |
| Anthropic Sonnet 4 | [ParisB81/MealPlan](https://github.com/ParisB81/MealPlan) | [`6fb8fe3`](https://github.com/ParisB81/MealPlan/commit/6fb8fe3af12cf307b173f8ea40f5ff32d044f5ad) | [`fed1f21`](https://github.com/ParisB81/MealPlan/commit/fed1f2129471ad9467c467d30dd4717fa132cfd3) 2026-08-28 | [`7dad34f`](https://github.com/ParisB81/MealPlan/commit/7dad34f2a968ea894f6203e505164f9dba837011) | Flagged | 2026-04-14 | 136 (broken 74) | not-run |
| Anthropic Sonnet 4 | [kataragon1/PawRecords](https://github.com/kataragon1/PawRecords) | [`8511da2`](https://github.com/kataragon1/PawRecords/commit/8511da2852a0abbd376b6707cbfdfdf93e996afe) | [`57eeeaa`](https://github.com/kataragon1/PawRecords/commit/57eeeaae927da7c4d8b247e9155c7d4c2bce1484) 2026-09-15 | [`c1ab64c`](https://github.com/kataragon1/PawRecords/commit/c1ab64cf98d4b6e542a62511a6b6abc49aaf0b49) | Partial patch (4 of 6) | 2026-05-14 | 124 (broken 92) | no-checks |
| Anthropic Sonnet 4 | [grenager/trondbot](https://github.com/grenager/trondbot) | [`eb3bc81`](https://github.com/grenager/trondbot/commit/eb3bc81682a7ffd3267bda5ed88e0f61024ea8ae) | [`ab591ca`](https://github.com/grenager/trondbot/commit/ab591ca0a706295f8ef9ae9b59155244af7ee061) 2026-08-30 | [`0b19c6c`](https://github.com/grenager/trondbot/commit/0b19c6c233aa68175199a80f714dedbbe2baa47b) | Partial patch (3 of 4) | 2026-05-30 | 92 (broken 76) | failed |
| OpenAI GPT-4 Turbo preview | [dacostatricia99-ctrl/Mood-Pass](https://github.com/dacostatricia99-ctrl/Mood-Pass) | [`e19b672`](https://github.com/dacostatricia99-ctrl/Mood-Pass/commit/e19b672329aab99816ff78b713fb552ebb26d4f5) | [`bc2bce2`](https://github.com/dacostatricia99-ctrl/Mood-Pass/commit/bc2bce211f5ce2b6547f2fc27d59714d99c8d661) 2026-06-10 | [`3d0f346`](https://github.com/dacostatricia99-ctrl/Mood-Pass/commit/3d0f3460546ab5bbf1b910354fb7bb99805dd83c) | Patch (1 of 1) | 2026-06-10 | 0 | passed |
| OpenAI GPT-4 Turbo preview | [letoya-ui/ravlo-platform](https://github.com/letoya-ui/ravlo-platform) | [`b374b0c`](https://github.com/letoya-ui/ravlo-platform/commit/b374b0c9bec4b119d7937ef04b01c5c3f9ca6f90) | [`818abc9`](https://github.com/letoya-ui/ravlo-platform/commit/818abc9a9fef96a496c93101aa6b74be225ccfd0) 2026-04-30 | — | Missed | — | — | not-run |
| OpenAI GPT-4 Turbo preview | [victorsole/brubru](https://github.com/victorsole/brubru) | [`545d534`](https://github.com/victorsole/brubru/commit/545d5343a0bb5154a7ddc199fbdc008b63f77182) | [`62585a6`](https://github.com/victorsole/brubru/commit/62585a675e3a42da6d3f70ff5856988fe9319192) 2026-04-20 | — | Missed | — | — | not-run |
| Shopify 2025-01 | [balvant0707/Fomoify-Test](https://github.com/balvant0707/Fomoify-Test) | [`c8379eb`](https://github.com/balvant0707/Fomoify-Test/commit/c8379eb2b97797b008bde27289d6798be18e1c6c) | [`bf35d6b`](https://github.com/balvant0707/Fomoify-Test/commit/bf35d6be7ab360c2db98ee786320face9e425db8) 2026-03-01 | [`f06b4a1`](https://github.com/balvant0707/Fomoify-Test/commit/f06b4a1b871526c56470950b7c1ac54b15a4cffa) | Flagged | — | — | not-run |
| Shopify 2025-01 | [futureaidigital/bal-ring-builder](https://github.com/futureaidigital/bal-ring-builder) | [`647909b`](https://github.com/futureaidigital/bal-ring-builder/commit/647909b4809d2edfbddcf3f3602a349e8dda0f49) | [`27a9cdf`](https://github.com/futureaidigital/bal-ring-builder/commit/27a9cdf8c96c9b26b38c52e13c5e2ca7182a76ff) 2026-06-02 | [`d299f82`](https://github.com/futureaidigital/bal-ring-builder/commit/d299f82b618a36f7d9a7b6604fefb45dee16b124) | Flagged | — | — | not-run |
| Meta v20.0 | [k9tsune/tokyo-cafe-finder](https://github.com/k9tsune/tokyo-cafe-finder) | [`d6bea9f`](https://github.com/k9tsune/tokyo-cafe-finder/commit/d6bea9fb5c69a16416071a95f32886cf50caf805) | [`0d80307`](https://github.com/k9tsune/tokyo-cafe-finder/commit/0d80307b0482b1a412855df2bf48b5d00d86afc8) 2026-08-08 | [`08cfa0d`](https://github.com/k9tsune/tokyo-cafe-finder/commit/08cfa0d4a648ef3f6d309f5aae223f638641f7e2) | Flagged | 2026-08-04 | 4 | not-run |
| Meta v20.0 | [lhotea/TriAgent](https://github.com/lhotea/TriAgent) | [`2de91c3`](https://github.com/lhotea/TriAgent/commit/2de91c3101f1bc4699b905bacff4542e0494076d) | [`d9b7a4c`](https://github.com/lhotea/TriAgent/commit/d9b7a4c2c939105efff5bafed617eb29b4b05999) 2026-08-05 | — | Missed | — | — | not-run |

## Misses and stops

**Python (3 misses).** ravlo-platform and brubru set `gpt-4-turbo-preview` in Python, and TriAgent builds its Graph API URL in Python. Refit reads JavaScript and TypeScript only. brubru's one Refit exposure is an unrelated `'gpt-4'` default in a frontend component.

**Stripe endive (4 flags, no patch).** All four maintainers made the same one-word fix: `payment_method_types: ['card']` became `allowed_payment_method_types: ['card']`. Refit has that rule, but it keeps the edit only when every client that may send it reaches the new version. Three things stopped it:

- **A client built with no options is an unknown pin.** `new Stripe(key)`, with no second argument, is reported as `unknown`, not `absent`, so the rule does not apply. This is in deni-ai (`src/lib/stripe.ts:7`), sinlab-study (`stripe-server.ts:118`) and Last-Bite-App's webhook verifier (`stripe.ts:191`). In deni-ai and sinlab-study the findings also drop to review confidence.
- **An options spread is an unknown pin.** Last-Bite-App's main client spreads `...api` (a test host) into its options. In a scratch copy, the patch was proposed only after both this and the webhook constructor were changed.
- **Lockfiles and per-request pins.**
  - The stripe-node upgrade fails on deni-ai's `pnpm-lock.yaml` ("not a single document in pnpm formatting"), although it already locks stripe 23.0.0. deni-ai's 6 requests pinned to `2026-03-25.dahlia` also conflict with the application pin.
  - The upgrade does not support sinlab-study's `bun.lock`.
  - rcweb's 3 sites were confirmed, but validation stopped before a patch: "Dependency archive exceeds 1024 MiB". `REFIT_VALIDATION_WORKSPACE=4g` was not tried.

**Anthropic.**
- **MealPlan:** all 4 sites stopped on "The client sets a custom base URL". That is a false positive: the match is the frontend's `API_BASE_URL` setting, not the Anthropic client.
- **PawRecords:** 2 of 6 sites were left. `chat.js:299` sits in a module that is also loaded dynamically, and `files.js:1119` is in a repository with no `@anthropic-ai/sdk` import.
- **trondbot:** the chat route stopped because its `MODEL` constant is used twice. trondbot's validation never ran on the patch: `npm run build` failed at the before commit inside the sandbox, and the validation output does not say why.

**Shopify 2025-01 (2 flags, no dated alert).**
- Refit's registry has no entry for `2025-01` (it starts at `2025-04`), so there is no deadline and no lead time.
- The scans flag the `ApiVersion.January25` pins and Fomoify's REST URLs on `/admin/api/2025-01/` for review. They stop because each app builds a GraphQL document at runtime and pins two versions.
- Fomoify's only dated exposure is its `2025-07` URL (due 2026-07-16).

**PDFNinja's failed validation.** Refit moved the pin to `2025-03-31.basil` but skipped the stripe-node upgrade: "stripe 18.0.0 needs dependency changes (qs, @types/node)". The old SDK's types reject the new version: `TS2322 Type '"2025-03-31.basil"' is not assignable to type '"2023-08-16"'`. Validation reported a regression, so the run stopped before publication.

## Refit's patches against the maintainers' fixes

Both sides were read in full, ignoring whitespace. The maintainers' commits often changed much more, such as other dependency upgrades or a reformat. Only their changes to the affected code are compared here.

- **ai-companion-saas.**
  - Both moved the pin from `2024-04-10` to `2025-03-31.basil`, moved stripe-node from 15.7.0 to 18.0.0, and fixed the two `current_period_end` reads. The maintainers read `items.data[0]` directly; Refit reads through a generated helper that works under either version.
  - Refit also migrated `session.subscription` in the `invoice.payment_succeeded` branch. That event's object is an Invoice, and basil moved the field to `parent.subscription_details.subscription`. The maintainers' code still reads it at their latest commit [`b680ee2`](https://github.com/SergeySharipov/ai-companion-saas/commit/b680ee296e699edda4db4325e42fbeb1fbf97cc3) (2026-02-18).
- **PDFNinja.**
  - The maintainers replaced both period-end reads with `items.data[0]?.current_period_start`, so the period start is stored as `stripeCurrentPeriodEnd`. They also left the invoice read, and both are unchanged at [`d83bd78`](https://github.com/anand-mukul/PDFNinja/commit/d83bd78476e1094060ff63c3000cc224e40cb3f0) (2025-12-30).
  - Refit's reads were right, but its patch failed typecheck without the SDK upgrade, as above. The maintainers moved to stripe ^18.4.0 and `2025-07-30.basil`.
  - Refit's 4 review findings are `.price` reads on the app's own `PLANS` config. Refit correctly left them alone.
- **saas-scaffolding.**
  - Refit's 5 edits match 5 of the maintainers' 6.
  - The maintainers also migrated `lib/stripe.ts:86`, which Refit left for review because the subscription is returned to the caller.
  - Refit kept `apiVersion: '2023-10-16'` and stripe-node 14, because it could not resolve the constructor's pin. The workflow summary still says it updates the pin, which it did not. The maintainers moved to `2026-03-25.dahlia` and Stripe 21.
  - Refit's patch passed the repository's tests.
- **mikki-mase.com, Mood-Pass.** These are the same sites. Refit picks the registry replacement (`claude-sonnet-5-5`, `gpt-5`), where the maintainers picked `claude-sonnet-5` and `gpt-4o`. Mood-Pass's build passed with Refit's patch. mikki-mase.com was refused because its committed source is over 50 MiB.
- **PawRecords, trondbot.** Refit's 4 and 3 edits match 4 of the maintainers' 6 and 3 of their 4. Refit's PawRecords patch prints whole-file hunks but changes exactly 4 lines.

## Alert lead time for a deadline-only provider

Meta Graph API v20.0 has no Refit agent, so Refit reports the deadline and does not patch it.

- **tokyo-cafe-finder.** The v20.0 oEmbed URL was added in [`08cfa0d`](https://github.com/k9tsune/tokyo-cafe-finder/commit/08cfa0d4a648ef3f6d309f5aae223f638641f7e2) on 2026-08-04.
  - `refit deadlines` at the before commit reports `scripts/fetch-instagram.mjs:40`, due 2026-09-24.
  - 2026-08-04 is already within 90 days of that date, so Refit's first default alert would have opened the day the code landed. That is 4 days before the maintainers' fix on 2026-08-08.
  - The maintainers moved to v25.0 because v20.0 "returns 403 for every call". That was 47 days before the registry's date. Why v20.0 failed early is not verified.
- **TriAgent** has the same change in Python, which Refit misses.

## Method

1. **Find the changes and the repositories.** Each change has a published source and date in the cases file. The repositories come from GitHub commit search or from mining the frozen Stripe lists. The query and the day it ran are recorded for each change.
   - A repository is kept only when its maintainers' commit fixes this change by hand. The "before" commit is that fix's parent.
   - No repository was found for the 2022 removal of `PaymentIntent.charges`; the reason is in the cases file.
2. **Earliest signal.** This is the first day Refit could have flagged the break:
   - For a contract change: the later of the version's publication and the day the affected code was added.
   - For a deadline: the latest of the announcement, 90 days before the deadline (Refit's first default alert, `pipeline/deadline-alerts.ts`), and the day the code was added.
   - "Code added" is the first commit before the fix that adds the affected string (`git log -S`) to a file Refit reads. PawRecords kept its model in `index.html` until [`c1ab64c`](https://github.com/kataragon1/PawRecords/commit/c1ab64cf98d4b6e542a62511a6b6abc49aaf0b49) moved it into JavaScript modules, so its signal starts there.
3. **Stripe.** The repositories are in [`2026-10-22-replay-stripe-basil-repos.json`](benchmarks/2026-10-22-replay-stripe-basil-repos.json) and [`2026-10-22-replay-stripe-endive-repos.json`](benchmarks/2026-10-22-replay-stripe-endive-repos.json), with the Stripe OpenAPI tags they use.
   - Roots were built with `scripts/stripe-benchmark-setup.mjs --list`.
   - `pipeline/stripe-benchmark-cli.ts` scanned each root, then ran `--validate --offset <n> --limit 1` with `REFIT_DOCKER_IMAGE=node:22-alpine`.
4. **Shopify.** `pipeline/shopify-benchmark-cli.ts` ran on [`2026-10-22-replay-shopify-repos.json`](benchmarks/2026-10-22-replay-shopify-repos.json).
5. **Models and Meta.** `refit deadlines --json` and `refit deadlines --propose-model-fixes --json` ran at each before commit. `pipeline/ai-model-validation-cli.ts` then ran the repository's `npm test` or `npm run build` before and after the patch in the same image.

## Limits

- **Today's Refit and registry.** Old code was replayed with the Refit and deadline registry of 2026-10-22, not what existed at the time. The lead times assume the registry entry existed by the earliest signal.
- **Shopify contracts are approximate.** Shopify no longer serves `2025-01`, so the scans used the `2026-01` to `2026-10` schemas. Those were fetched on 2026-10-22, and their hashes differ from the ones pinned in the frozen Shopify list.
- **Endive's before version.** All four endive repositories were scanned with `2026-08-26.dahlia` as the before version. deni-ai's default client already ran stripe-node 23.0.0, which sends `2026-09-30.endive`.
- **Some changes are missing from the comparison.** The maintainers' commits sometimes fixed other things. Only their edits to the affected code are compared.
- **Missing run summaries.** The harness's final results check failed after the rows were written, because a property was set to `undefined` (fixed in `05bb604`, #182). The rows in each run are complete, but the runs have no `summary.md`.
- **This is a search sample, not a rate.** These are repositories whose maintainers fixed the break by hand, in a commit someone could find. Repositories that broke silently, or were fixed without a recognisable commit, are not here.
