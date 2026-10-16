# Stripe real-repository benchmark

This records historical scans of **100 real public Stripe integrations** with **real Stripe API changes**: each repository's recorded API version, compared with Stripe's published target OpenAPI specifications. The initial run on October 14, 2026 used Refit `03648a6`, which includes shared SDK client support. No repository code was installed or run in those scans.

The phase-2 figures below precede the webhook integration safeguards. Current automation treats declared Stripe types as review hints, requires separately verified incoming webhook policy, and stops on skipped source files. Response unions are not mapped to their first member. These historical scores are not current migration coverage or proof of runtime compatibility; rerun and independently review labels before quoting them for the integrated release.

## Method

- **Repositories:** GitHub code search for TypeScript/JavaScript files using the `stripe` package (imports, `require`, `new Stripe(…apiVersion…)`, common calls) found 1,556 repositories. We kept those that are not archived or forks, are under 50 MB and were pushed since January 2024. From the 140 most-starred we cloned them shallowly, kept the ones with a `stripe` dependency whose API version maps to a real specification, and took the top 100 that have an upgrade ahead of them (7 to 2,110 stars). Repositories and commits are pinned in [`benchmarks/2026-10-14-stripe-repos.json`](benchmarks/2026-10-14-stripe-repos.json). No repository code was installed or run.
- **Each repository's API version:** taken from its literal `apiVersion: '…'` (68 of the 100), or else from its locked or declared `stripe` package version (32). We read each stripe-node release's `OPENAPI_VERSION` and `apiVersion` to map 175 SDK releases to 31 API versions.
- **Real contracts:** for each API version, `openapi/spec3.json` from the `stripe/openapi` release that version shipped with. We verified that each spec's `info.version` equals the API version, after correcting two releases. The target is the latest, `2026-09-30.endive`. 80 repositories start before `2025-03-31.basil`, Stripe's large breaking release.
- **Stages,** run with `npm run benchmark:stripe` (`pipeline/stripe-benchmark-cli.ts`):
  1. read the repository;
  2. trace Stripe SDK calls;
  3. scan for removed fields with the built-in Stripe adapter;
  4. scan again with a **generated full Stripe adapter**: every stripe-node method the repository calls, mapped to the object it returns, from `x-stripeOperations` in Stripe's SDK spec (`pipeline/stripe-benchmark.ts`);
  5. run production mode (full contract diff);
  6. for confirmed affected code, run an AI patch and Docker validation through `refit run`.

## Results

| Stage | Repositories |
|---|---|
| Selected | 100 |
| Refit reads the repository | 100 |
| Scanner completes without crashing | **97**. Three crashed on a single file: a syntax error, a declaration error and a binary `.ts` file |
| Stripe SDK calls found | 96 |
| At least one call **traced** | **55**. Only 355 of 1,556 likely Stripe calls were traced (23%) |
| A traced call maps to a Stripe object | 54 |
| Breaking-field reads reported, any confidence | 83 (built-in adapter) |
| **Confirmed** affected code, built-in adapter (`paymentIntents` only) | **0** |
| **Confirmed** affected code, generated full adapter | **0** |
| Production mode (full contract diff) completes | **0 of 54**. `oasdiff` exceeded its 30s limit or could not compare the real specs |
| AI proposal attempted | **0**: nothing was confirmed |
| Validated draft PR | **0** |
| Could be validated with the repository's own checks at all | **10**: needs a root npm lockfile, a real `test` script and `stripe` in the root `package.json` |

### The breakage is real

Refit's scanner sees the right fields. The most common removed fields read by these repositories, counted per repository: `line_item.type` (66), `line_item.price` and `invoiceitem.price` (58), `invoice.subscription` (40), `subscription.current_period_end` (30), `invoice.payment_intent` (11).

A plain source check confirms the scale for one field only Stripe uses. **31 of the 80 pre-basil repositories (39%) read `subscription.current_period_end` or `current_period_start`, 97 reads in total.** Stripe removed both from subscriptions in `2025-03-31.basil`. These applications break on upgrade, and 21 of the files involved are webhook handlers.

### Why Refit confirmed nothing

All 6,539 reported reads were `review` confidence:

| Reason recorded by the scanner | Reads |
|---|---|
| "Response or SDK client may be mutated or escape through an alias or call…" | 6,026 |
| "Receiver or property cannot be proven by the supported local analysis" | 513 |

Behind those reasons:
1. **Stripe objects arrive through webhooks.** 74 of 100 repositories call `stripe.webhooks.constructEvent`, then read `event.data.object` (often `as Stripe.Subscription`). Refit doesn't trace event payloads.
2. **Objects are passed around.** A subscription retrieved in one function is read in another, often typed as `Stripe.Subscription`. Refit's tracing stops at the first call or alias, and doesn't use TypeScript's `Stripe.*` type annotations.
3. **Common names cause noise.** Because Stripe removed `line_item.type`, any `.type` read near Stripe code is reported, for example in a UI toast hook.
4. **The built-in Stripe adapter maps only `paymentIntents`.** Custom adapters can't use the reserved `stripe` id. The benchmark's generated adapter uses `stripe-full`, which skips Stripe-specific extras such as the charges rule.

### Other blockers found

- **Production mode can't diff real Stripe specs.** The 30s `oasdiff` limit is exceeded on 8–11 MB specifications, and some pairs fail to compare at all. The default worker mode therefore never reaches the code stage for Stripe.
- **Validation coverage:** 57 repositories use npm, 26 pnpm, 5 yarn and 12 have no lockfile. Only 17 have a real test script.

## Score against the ground truth

[`benchmarks/STRIPE-LABELS.md`](benchmarks/STRIPE-LABELS.md) labels 30 of the repositories: 40 real breaking reads in 11 repositories. Today's Refit, generated full adapter, labelled set:

| | Recall | Precision |
|---|---|---|
| Confirmed findings (what Refit acts on) | **0%** (0/39) | n/a |
| Any finding, including review | 100% (39/39) | **1%** (39/3,048) |

Refit reports every real break but can't separate it from about 3,000 false matches, so it confirms none. Phase 2 of the [plan](STRIPE-PLAN.md) targets confirmed recall ≥ 90% at precision ≥ 98%.

**After phase 2** (`Stripe.*` types, typed arrays and helper returns, narrowed webhook events, inline list items, primitive field values passed along, noise limited to Stripe files), with the existing escape and alias safety rules kept:

| | Recall | Precision |
|---|---|---|
| Confirmed findings, labelled set | **51%** (20/39) | **100%** (20/20) |
| Any finding | 100% (39/39) | 6% (39/619) |
| Confirmed findings, 20 held-out repositories (checked by hand) | n/a | **100%** (8/8) |

Across all 100 repositories: 0 scan crashes (was 3), 25 repositories with confirmed affected code (was 0), and 6,555 → about 1,000 review flags.

The remaining misses are downgraded by deliberate safety rules: a Stripe response passed into another function, returned, or stored with an object-valued field; and repository-wide alias doubt when an alias import may resolve to an unscanned declaration file (2 reads). An experiment that trusted traced Stripe responses despite those escapes reached 95% recall at 100% precision on this set, but it contradicts tested safety requirements, so it is not applied. See the plan's open decisions.

## Reproduce

```sh
npm run benchmark:stripe -- --root <dir with repos/, specs/, selected.json, needed-specs.json> \
  --output <new-dir> --env .env --ai --validate
```

The collection steps (GitHub search, SDK version mapping, spec downloads) are described above. The pinned list is in `docs/benchmarks/`.

## Self-maintaining pipeline: before and after

Measured on October 15, 2026, on the same pinned 100 repositories. "Before" is `main` at `f512ffa` (Refit 0.21). "After" is the self-maintaining pipeline branch (escape changes, Stripe enum gating, field-move rules, `apiVersion` bump). Both runs used `npm run benchmark:stripe -- --env .env --ai --validate` with the generated full Stripe adapter. See the [plan](STRIPE-PLAN.md#self-maintaining-pipeline-october-15-2026) for what changed and the open decisions.

### Detection

| | Before | After |
|---|---|---|
| Labelled set: confirmed recall | 5% (2/39) | **95% (37/39)** |
| Labelled set: confirmed precision, as labelled | 100% (2/2) | 86% (37/43) |
| Labelled set: confirmed precision, six disputed labels corrected | 100% (2/2) | 100% (43/43) |
| Held-out set: confirmed reads (checked by hand) | 1 in 1 repository | **10 in 4 repositories, all real breaks** |
| All 100: confirmed reads | 5 in 4 repositories | **76 in 23 repositories** |
| All 100: review-only reads | 744 | 673 |
| Production mode (full contract diff) completes | 0 of 74 | **74 of 74** |

All six "false positives" read `.subscription` inside an `invoice.payment_succeeded` branch on a payload cast to `Stripe.Checkout.Session`. At runtime it is an Invoice, whose `subscription` field basil removed (plan open decision 1). The two misses are tracing gaps, not escapes: an expanded `latest_invoice.payment_intent`, and `entitled[0] ?? sorted[0]`.

### Confirmed breaks by change (after, all 100)

| Change | Reads | Repositories | Source of the reads |
|---|---|---|---|
| `subscription.current_period_end` | 35 | 22 | 30 SDK responses, 4 typed values, 1 webhook |
| `invoice.subscription` | 14 | 11 | 10 webhook, 4 typed values |
| `invoice.payment_intent` | 14 | 2 | 12 typed values, 2 SDK responses |
| `subscription.current_period_start` | 9 | 7 | 8 SDK responses, 1 typed value |
| `line_item.price` | 3 | 1 | typed values |
| `line_item.type` | 1 | 1 | typed value |

Subscription periods (44 reads):
- **Pierce's price-ID webhook rule handles 0.** No repository configures a price policy, none targets the exact `2025-02-24.acacia → 2025-03-31.basil` incoming pair, and only one confirmed period read is a webhook payload.
- **The new SDK-response rule rewrites all 38 SDK-response reads.** 19 of them sit in repositories whose patch the repository-wide webhook gate blocks, and 2 in a repository with skipped unparseable files.
- The 5 typed reads and the 1 webhook read are left to AI or review.

`invoice.subscription` (14 reads): none is on an SDK response, so a [configured nested move](PROPERTY-MOVES.md) would not edit any of them either. The benchmark's generated adapter configures no moves. (An earlier version of this branch had a built-in `invoice.subscription` rule; it also fired zero times and was dropped in favor of the configured moves.)

### Fixes

| | Before | After |
|---|---|---|
| Affected repositories | 4 | 23 |
| No patch generated | 4 (reason not recorded by the old benchmark) | 16 |
| … blocked by the webhook incoming-version gate | | 9 |
| … blocked by skipped files, unverified alias context or declared-type mutation | | 3 |
| … stopped by the AI budget ledger or sandbox dependency preparation | | 4 |
| Deterministic patches proposed | 0 | **6** (7 before the account-default fix below) |
| AI patches proposed | 0 | 0: the AI budget ledger refused every call (plan open decision 9) |
| Patches that bump the Stripe `apiVersion` in the same patch | 0 | 6 of 6 |
| Repositories with runnable checks, among affected | 0 | 3 (`odota/core`, `alanagoyal/branded`, `pretzelai/stripe-no-webhooks`) |
| Patches passing the repository's own checks | 0 | **0**, see below |
| Repair attempts | 0 | 0 |
| Patches that were wrong | 0 | **1 runtime-wrong** (fixed); **6 fail TypeScript typecheck** until the `stripe` package is upgraded |

Why no patch reached the repositories' own checks:
- `odota/core`: its lockfile has entries without registry integrity, which the sandbox refuses ("links and bundled records require a custom image").
- `alanagoyal/branded`: dependency preparation ran out of space in the sandbox's 512 MB `/workspace` tmpfs (`ENOSPC`).
- `pretzelai/stripe-no-webhooks`: a mutated `Stripe.Invoice` value keeps the declared-type gate on, and the repository's checks use `bun`, which the `node:22-alpine` image lacks.

Every proposed patch was reviewed by hand:
- **`horizon-ui/shadcn-nextjs-boilerplate` was wrong.** Its client passes `apiVersion: null`, so responses follow the account's default version. The moved reads would return `NaN` until the account is upgraded. Field moves now apply only when the same patch bumps a literal `apiVersion`, and this repository now gets no patch.
- **The other six are correct at runtime when a subscription's items share one billing period.** All six are TypeScript projects on stripe-node 12–16. Type-checking the patched code against stripe@12.9.0 and stripe@16.12.0 types fails twice: `apiVersion` is typed as the package's own version literal, and `SubscriptionItem` has no `current_period_end`. They need the `stripe` package upgrade before they build (plan open decision 7).

### Re-run with AI (October 15)

Rebuilt from pinned inputs with `scripts/stripe-benchmark-setup.mjs` (100 repositories, 21 versions, no failures), the scan reproduces **23 affected repositories** with the full adapter. A run with `--ai --validate` on `gpt-5.4-mini`, capped at $5 by a fresh ledger, **spent $0.038**:

| Outcome | Repositories |
|---|---|
| Deterministic patches (subscription-period moves) | 6 |
| AI asked, no edit proposed | 2 |
| AI error (exact-replacement mismatch; ambiguous alias configuration) | 2 |
| Blocked by the repository-wide webhook gate (plan open decision 2) | 10 |
| Blocked by skipped unparseable files | 1 |
| Validation stopped (lockfile integrity, dependency archive size, declared types) | 3 |

In `Kanba-co/kanba`, the model named the documented `invoice.parent.subscription_details` replacement but declined to edit, because the read is not on a traced SDK response.

[Generated checks](GENERATED-CHECKS.md) now find an entry point in 5 of the 6 patched repositories, all the Vercel/Supabase template's `manageSubscriptionStatusChange`, exported through an `export { … }` list. The sixth patch is in a webhook route. None of the five ran: `kpirabaharan/Spotify-Clone`'s Next.js dependencies exceed the 256 MiB archive limit, which the 512 MiB validation workspace imposes. These helpers also query Supabase before calling Stripe, so even with room they would be excluded offline as not runnable in isolation.

### Reproduce

Rebuild the benchmark root from the pinned list and labels: shallow clones at the recorded commits, plus each API version's spec and fixtures, and the latest SDK spec, from `stripe/openapi`.

```sh
node scripts/stripe-benchmark-setup.mjs --root <new-dir>
```

```sh
npm run benchmark:stripe -- --root <dir with repos/, specs/, selected.json, needed-specs.json, split.json> \
  --output <new-dir> --env .env --ai --validate
npm run benchmark:stripe-score -- --results <new-dir>/results.json \
  --labels docs/benchmarks/2026-10-14-stripe-labels.json
```

Each run also writes `summary.md`: totals, then one row per affected repository with its outcome, pull request link and stop reason.

To publish validated fixes as real draft PRs, add `--publish <github-org>` (requires `--validate`). For each repository whose checks passed, Refit forks it into that organization with `GITHUB_TOKEN`, points a `refit-base` branch at the validated commit, and publishes the draft as the GitHub App (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_FILE`). Upstream repositories are never changed. `--publish-unresolved` also publishes drafts that list unresolved findings. Publication uses the saved report; checks are not rerun.

The benchmark attaches the pinned Stripe changelog pages in [`benchmarks/stripe-changelog/`](benchmarks/stripe-changelog/) to AI patches for the changes each repository hits.

## Validation funnel on real repositories (October 15, 2026)

Measured with `npm run benchmark:stripe -- --validate` on `main` after the version-tolerant webhook reads, the SDK package upgrade and generated `stripe-mock` checks, with deterministic fixes only (no AI). The benchmark now validates every affected repository with a root npm lockfile and `stripe` declared, not only those with a test script:
- repositories with a real test script run it;
- TypeScript repositories without tests run a typecheck that reports errors without failing, and the benchmark counts errors the patch introduces;
- the rest run a no-op command.

Generated `stripe-mock` checks run in addition, using pinned `stripe/openapi` fixtures for both API versions.

| Stage | Repositories |
|---|---|
| Affected (confirmed breaks) | 23 |
| Root npm lockfile with `stripe` declared, so checks can be prepared | 18 (3 with tests, 15 TypeScript typecheck) |
| Stopped at scan for review | 5 (4 with no deterministic rule for their reads, AI off; 1 declared-type mutation) |
| **Dependency archive exceeds the 256 MiB validation limit** | **11** |
| Lockfile entries without registry integrity | 1 (`odota/core`) |
| Lockfile out of sync with `package.json` | 1 (`LDAWoo/webprodigies-plura`) |
| Reached the repository's checks | **0** |

The archive limit is what stops validation on real applications. Next.js apps routinely install more than 256 MiB, even though dependency preparation now has a 2 GiB workspace. Validation unpacks the archive into its 512 MiB workspace, so raising the archive limit also means raising the validation workspace and memory. The owner made the 2 GiB profile the default in 0.33.0; see [readiness](READINESS.md). Detection and patch generation are unaffected: production mode completed on 74 of 74 contract pairs.

The end-to-end path does work when dependencies fit. A TypeScript app on stripe 16.12.0, using the real `2024-06-20` and `2026-09-30.endive` Stripe specifications, was patched with the moved read, the `apiVersion` bump and stripe 23.0.0. Both dependency sets were prepared in Docker, and `tsc` passed on the original and the patched code (workflow status `validated`). A gated test reproduces this.
