# PayPal: progress after the second pass (2026-10-22)

This is the evidence for the PayPal lane's second pass over `refit paypal`: what was read before and not now, the extended benchmark, and precision and recall before and after. The percentages at the end are for [PROVIDER-GOALS.md](PROVIDER-GOALS.md), which this lane does not edit.

## What changed in the scan

`pipeline/paypal-calls.ts` reads three things the first pass listed as "not read", plus three smaller forms found on the way. Every one has tests on snippets taken from the benchmark repositories (`pipeline/paypal-calls.test.ts`, 31 tests).

| Read now                                                                                                                                                                                                                                                                                                                                               | Examples from the set                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| **Bases from the environment or an object.** `process.env.X \|\| 'https://api-m…'` and `??`, constants and variables that are never reassigned, members of a constant object of hosts (`HOSTS.live`, `HOSTS[mode]`), and string methods that keep the host (`.replace(/\/+$/, '')`). The report adds a note when the environment can replace the host. | `mastodon-paywall`, `ai-saas`                                        |
| **Bases returned by a function.** A function or arrow in the same file, or exported from another file (also through an `@/` or `~/` alias of `src`, `app` or the root; tsconfig is not read), and a method of the same class (`this.getBase(step)`).                                                                                                   | `githubanalyzer`, `paypal-listen`, `loopi`                           |
| **axios instances with a PayPal `baseURL`.** `axios.create({ baseURL })` held in a variable or class property, then `instance.post('/v2/…')`. The `baseURL` is not also reported as a bare URL once a request was traced from it.                                                                                                                      | covered by tests; no instance in the labelled set had a literal base |
| **Controllers passed between files.** An exported constant, an exported function that returns a controller or an object of controllers (`getPaypal().orders`), a default export, `module.exports`, and `x ??= new Controller()`. The file that calls it need not import the SDK.                                                                       | `nextjs-payments` (7 calls)                                          |
| A path piece written as `encodeURIComponent(id)` is named `id`, not `encodeURIComponent(id)`, so it no longer looks like a path chosen at runtime.                                                                                                                                                                                                     | `mastodon-paywall`                                                   |

Still not read: a base held in a function parameter or a config object another file builds (`${cfg.apiBase}`, `baseUrl` passed to a helper), a controller reached through dependency injection or a wrapper class with its own method names, axios `defaults.baseURL`, and anything built with `eval`-like indirection. The old-SDK to new-SDK replacement stays review only.

## Benchmark

[`2026-10-21-paypal-repos.json`](benchmarks/2026-10-21-paypal-repos.json) now lists **42** repositories: the 22 libraries and plugins found by npm search on 2026-10-21, plus 20 found on 2026-10-22 by `scripts/paypal-extend.mjs`. That script uses GitHub code search (a root `package.json` naming either server SDK, and source files naming `api-m.paypal.com` or `api-m.sandbox.paypal.com`) and keeps a repository that is not a fork or archived, was pushed since 2024-10-21, is under 60 MB, and still declares an SDK or names a PayPal host at HEAD. Queries, counts and rejections are in the file under `extensions`. The 20 additions are mostly applications and servers, which the first 22 were not.

**Labels.** [`2026-10-22-paypal-labels.json`](benchmarks/2026-10-22-paypal-labels.json) holds hand labels for those 20, committed (`1569c35`) before Refit ran on any of them. `scripts/paypal-label-candidates.mjs` (a plain text search) listed lines that might send a request; the labeller read the code around each and kept every request that really goes to a PayPal REST API from live source: 56 requests in 15 repositories, none in the other 5. The scorer is `scripts/paypal-score.mjs` (tested in `pipeline/paypal-score.test.ts`): a report matches a label in the same file within 4 lines, one to one.

**Measured on the 20 labelled repositories** (a report is a live request in the scan; a bare URL with no traced call counts as a report):

|                                                              | Reported | Matched | Precision | Recall          |
| ------------------------------------------------------------ | -------- | ------- | --------- | --------------- |
| Before, Refit at `1569c35` (the code of `main` at `7b2c86a`) | 21       | 20      | 0.95      | 0.36 (20 of 56) |
| After, Refit at `662bc90`                                    | 43       | 42      | 0.98      | 0.75 (42 of 56) |

Results files: [before](benchmarks/2026-10-22-paypal-results-before.json), [after](benchmarks/2026-10-22-paypal-results.json); both from `scripts/paypal-benchmark.mjs`. Neither file records the Refit commit or a dirty flag (the script records both from now on), so the commits in the table and a clean worktree are stated, not backed by the files.

The one report that is not a request is `cboard-api` `config/env/development.js:60`, a base URL constant in a config file. The 14 remaining misses, by cause: 5 in `freesocks-control-plane` and 1 in `loopi` (the host is a function parameter or a config field), 4 in `cboard-api` (the base comes from a config module read through `process.env` conditions), 2 in `teq-agave-paypal` (the controller is injected by a dependency container), and 2 in `react-native-paypal-web-payments`, which the repository reader refuses because it is over the scan limits.

**Honesty.** The labels commit (`1569c35`), the before scan, the fix commit (`662bc90`) and the after scan fall within seven minutes, so the history cannot show that the labels were written before the fixes were developed or before any earlier, uncommitted scan. The labels were made before the run and the fixes were written after seeing the first run's misses, so the "after" recall measures those fixes on the data that motivated them, not on new repositories. After the after run, `returnedBy` was changed to read a function's one non-null return at any depth (an early `return null` guard no longer hides the base, and two different returns give none); that change was not remeasured. Precision was checked only through the labels: a report no label matches is listed above and read, not assumed wrong. The 22 older repositories were not re-labelled; across the 17 of them that were scanned, the scan reports 92 live requests instead of 90, and both additions (`aboalynx/payment`: the OAuth token request and the webhook signature check) are real requests.

Across all 42 repositories (36 scanned, 6 over the repository reader's limits): live requests 111 → 135, with a known path 111 → 134, matched to a published operation 97 → 114. By kind: server SDK 82 → 89, raw URL 24 → 41, old SDK 5 → 5. The text cross-check for SDK call lines is unchanged at 125 and counts only files that name an SDK package or controller class, so it cannot see the 7 `nextjs-payments` calls it now traces from files that import a getter; the "traced 87 → 89" it reports understates the change.

## Deadlines

`developer.paypal.com` answered on 2026-10-22 (it did not on 2026-10-21). Pages read: [Deprecated resources](https://developer.paypal.com/api/rest/deprecated-resources) (last updated June 29, 2026), [Payments API v1 → v2 upgrade guide](https://developer.paypal.com/api/rest/integration/payments-api/v1-v2-migration) (last updated August 14, 2026), [Navigating PayPal server-side SDKs](https://developer.paypal.com/community/blog/navigating-paypal-server-sdks/) (January 29, 2024) and the Braintree [overview](https://developer.paypal.com/braintree/docs/start/overview) and [server SDK deprecation policy](https://developer.paypal.com/braintree/docs/reference/general/server-sdk-deprecation-policy).

None gives a date on which a PayPal REST API or the Node server SDKs stop working: the Payments v1 API "is deprecated and will be removed" with no date, the deprecated resources are listed without dates, and the January 2024 post says access to the deprecated server SDK repositories on GitHub is restricted on and after April 29 (a change to repository access, not an end of support). **No deadline entry was added**, and `npm run deadlines:check` is unchanged.

## Request map

`data/paypal-requests.json` was regenerated with `scripts/paypal-requests.mjs` from the registry tarballs of `@paypal/checkout-server-sdk` 1.0.3 and all 13 `@paypal/paypal-server-sdk` releases and a fresh clone of `paypal/paypal-rest-api-specifications`, still at `90e8041`. The only difference from the committed file is `checkedAt` (2026-10-22), so the map reproduces.

## Braintree

The Braintree pages read name no PayPal REST host (`api-m.paypal.com` and the others), so Braintree-via-PayPal detection is not added here. Recorded for FG10 (Braintree is in its list A): the same overview page says the Drop-in SDK is deprecated from October 1, 2026 with processing supported until October 1, 2027, and the server SDK deprecation policy gives a rolling support window per SDK version.

## Progress for PROVIDER-GOALS.md

The checklist keeps its ten items at 10% each, and partial items still count as not done. Nothing moved to done:

| #   | Item                                    | Now                                                                                                                         |
| --- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 3   | Deadline entries                        | No: pages read, no dated end of support                                                                                     |
| 6   | Frozen benchmark set                    | Partial: 42 of 50 repositories (was 22)                                                                                     |
| 7   | Hand-labelled live requests             | Partial: 56 requests in 20 repositories labelled before the run, but the first 22 repositories are not labelled             |
| 8   | At least 90% of likely SDK calls traced | No: cross-check 89 of 125 (71%) on 36 scanned repositories; the cross-check misses calls in files that only import a getter |

**Done: 10%** (unchanged). The next steps, in order: label the first 22 repositories so item 7 covers the whole set; read a base through a helper's parameters and a config module (the largest remaining miss); then the new-SDK adapter, which is an owner decision.
