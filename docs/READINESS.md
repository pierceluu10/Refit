# Refit implementation checkpoints

## October 28 checkpoint: untraced reads on a receiver typed as another object (unreleased, after 0.39.0)

An untraced read of a removed field name also stops counting where, behind a passing type check, TypeScript's checker shows its receiver is not the Stripe object of the changed schema (`receiver-type` in `localReceiverReads`): an ORM row, an application type, a Stripe error class (`error.type`), with every value that reaches it followed through callers, callbacks, annotated `const`s and returns. Validation unpacks the candidate's prepared `node_modules` beside its sources for the proof, so stripe-node's installed types decide. `any`, unresolved types, casts, unions with the schema's Stripe type, unmapped Stripe interfaces and other Stripe packages' types keep stopping. A `default` response's `error/` field that became optional is `handled`. Tests: `pipeline/stripe-receiver-types.test.ts`, `pipeline/dependency-types.test.ts`, `pipeline/openapi-diff.test.ts`. Benchmarks: pending.

## October 28 checkpoint: untraced reads Refit proves are not Stripe objects (unreleased, after 0.39.0)

Founder decision (Otabek, 2026-10-28), widening D2b: an untraced read of a removed field name stops counting, with or without AI, where `localReceiverReads` (`pipeline/stripe-type-evidence.ts`) proves its receiver is a type the repository declares (behind a passing type check), an object literal the repository writes (a `const` config or an element of a `const` list nothing writes into), or a `const` asserted to a type Payload generated from the repository's schema. The draft lists each cleared read with its proof under "Untraced Reads Cleared". Reads through exported or Stripe-fed helpers, annotated `const`s over other values, unions with Stripe types, `any`, webhook handlers and `data.object` keep stopping, as do JavaScript ORM rows and Convex's generated `.d.ts` types. Tests: `pipeline/stripe-local-receivers.test.ts`, `pipeline/review.test.ts`. Benchmarks: pending.

## October 27 checkpoint: install-time vendor detection (unreleased, after 0.39.0)

The hosted inventory now detects every API vendor in the vendor catalog a repository uses: npm, pnpm and yarn manifests and lockfiles, Python, Go, Ruby, PHP, Java and .NET manifests, raw API hostnames in any language and vendor environment variable names (including env templates). `data/vendor-catalog.json` adds 32 vendors without an agent, and env names, OpenAPI documents and changelog pages for the existing agents, each fact with the page it was read from (D5: generic code over sourced data). Each vendor is labelled `configured`, `agent-available`, `report-only` or `no-agent`; vendors with an OpenAPI document or changelog pages become watch targets (`refit_watch_targets`, hosted migration 12), captured once a day with `REFIT_HOSTED_WATCH=1`, and never enroll or edit a repository. Inventory format 2; the stored digest now covers the catalog and format, so a catalog change re-scans. On 26 real repositories with AI-assisted labels: precision 0.939 (0.945 held out), recall 0.846 on catalog vendors (0.800 held out) and 0.575 on all labelled vendors ([details](INVENTORY.md#detection-precision-and-recall)). Tests: `pipeline/vendor-detection.test.ts`, `pipeline/vendor-watch.test.ts`, `pipeline/inventory-store.test.ts` (PostgreSQL). End-to-end demo: blocked. `install-demo.yml` on refit-bench (#8) is ready, but on 2026-10-28 the App's delivery log held 0 installation deliveries (its one installation is older than GitHub's retention window), and the existing installation and App settings were left alone. It runs after a new install event with one `gh workflow run install-demo.yml` ([how](INVENTORY.md#demo-on-github-actions)).

## October 27 checkpoint: API versions untraced only where the client escapes (unreleased, after 0.39.0)

`declaredApiVersions` now starts from `versionUnsafe` (`pipeline/analyzer.ts`): only clients passed to opaque helpers, unsafe class bindings, untraced webhook events and aliases in ambiguous files make a pin `api-version-untraced`, and an exported helper's typed client parameter is followed (`pipeline/helper-clients.ts`, `pipeline/source-imports.ts`). On refit-bench without AI, rows with an untraced version on l2-push-249 fall from 19 to 16; validated stays at 80 and 9 ([benchmarks](BENCHMARKS.md#api-versions-untraced-only-where-the-client-escapes-october-27)). Test: `pipeline/declared-api-versions.test.ts`.

## October 27 checkpoint: structurally equivalent schema changes are compatible (unreleased, after 0.39.0)

Owner decision D4: `pipeline/schema-equivalence.ts` marks an oasdiff change compatible when the schemas on both sides have the same structure, such as a renamed subschema with the same shape or a format-only annotation, for any OpenAPI provider ([schema equivalence](SCHEMA-EQUIVALENCE.md)). On refit-bench without AI, l2-push-249 goes from 80 to 84 validated and heldout-30 from 9 to 10; rows with a contract-change stop on l2-push-249 fall from 97 to 86 ([benchmarks](BENCHMARKS.md#structurally-equivalent-schema-changes-october-27)). Tests: `pipeline/schema-equivalence.test.ts`.

## October 27 checkpoint: AI patches on stops under D2, D2a and D2b (unreleased, after 0.39.0)

The coverage AI attempt now publishes as a validated draft only through `aiValidationGate` (`pipeline/validation.ts`): the target stripe-node installed, `typeOraclePasses`, the repository's own tests passing offline or, for type-visible changes only (removed or renamed field, changed type, removed enum value), a passing type check over the files it covered (`typeCheckCoverage` in `pipeline/check-selection.ts`), and a diff limited to traced sites. A type-check-only pass is labelled "validated by type check, no tests" in the draft. An AI "no change needed" answer clears untraced reads only where the type oracle passed and `localReceiverReads` shows the receiver is the application's own object. On refit-bench with AI, l2-push-249 goes from 80 to 84 validated and heldout-30 from 9 to 10, all through D2b with the rules' patch, each reviewed ([benchmarks](BENCHMARKS.md#ai-patches-on-stops-under-d2-d2a-and-d2b-october-27)). Tests: `pipeline/ai-traced-sites.test.ts`, `pipeline/stripe-local-receivers.test.ts`, `pipeline/workflow-waivers.test.ts`.

## October 27 checkpoint: validated means the draft is not [Needs review] (unreleased, after 0.39.0)

A run without publication whose draft title is `[Needs review]` (kept untyped request properties, a grade-D patch, advisory JavaScript type errors) now ends `needs-review` with "Baseline and patched checks passed, but the draft is [Needs review]", not `validated` (`pipeline/workflow.ts`). On refit-bench heldout-30 goes from 10 to 9 validated with and without AI (KPZ231/what-now-chaos, grade D) and l2-push-249 stays at 80 ([benchmarks](BENCHMARKS.md#validated-means-the-draft-is-not-needs-review-october-27)). Test: `pipeline/workflow-waivers.test.ts`.

## October 27 checkpoint: type oracle on the target stripe-node (unreleased, after 0.39.0)

When the final patch upgrades stripe-node with prepared dependencies of its own and the check compares type errors, validation type-checks the original code once more with the target stripe-node installed (`runTypeOracle` in `pipeline/validation.ts`, recorded as `validation.typeOracle`). Errors on a traced call's property, on the operation's own stripe-node request type, or TS2339/TS2551 on the Stripe type of a changed response object move that change from `unknown` to `reached`; zero errors never moves a change toward `unused`, `compatible` or `handled`. `typeOraclePasses` is the type condition of the AI patch gate. On refit-bench it changed no outcome: 80 of l2-push-249 and 10 of heldout-30 validate with and without AI, before and after ([benchmarks](BENCHMARKS.md#type-oracle-october-27)). Tests: `pipeline/stripe-type-oracle.test.ts`.

## October 26 checkpoint: AI classification of Stripe release changes (unreleased, after 0.39.0)

`refit classify-release` sends each saved changelog page of a Stripe release to OpenAI through the shared client and spending ledger and scores the strict-JSON answer (category, handling, rule-pack family, identifiers) against the hand catalog, never sending its handling. With `--statements none` the model lists the changes itself, as it must for an uncatalogued release, and they are matched to the catalog's statements by shared content words; `--statements catalog` sends the catalog's statements as an upper bound. It is review only: nothing it predicts edits code or feeds a pack. Pages only (refit-bench run 40285557374, `gpt-6.1-sol`, $0.70), 70 of 125 catalog statements got the catalog's handling (95 with statements given), and by hand review the same 8 statements got a rule or AI edit where the catalog stops or has no signal in both modes, so every `rule` and `ai` prediction needs human review ([Release classification](RELEASE-CLASSIFICATION.md)). Tests: `pipeline/release-classification.test.ts`, which replays both runs' recorded outputs to their committed scores.

## October 25 checkpoint: Bun lockfiles, CI-chosen lockfiles and pnpm patches (unreleased, after 0.39.0)

Preparation now builds the refusals O2 classified as buildable and #289 left:

- **Bun text lockfiles.** A root project's `bun.lock` is translated into the npm lockfile of the same tree and installed with the verified `npm ci`; Bun never runs, and the draft says so. A tree npm cannot describe stops, such as a peer Bun nests inside the package that needs it.
- **Conflicting lockfiles.** With a `packageManager` pin and committed GitHub workflows that install only with that manager, Refit installs that manager's lockfile.
- **pnpm patches.** `patchedDependencies` are applied when every patch file is committed and matches the SHA-256 `pnpm-lock.yaml` records; `overrides` must equal the lockfile's.
- **Peer-only npm drift.** An `npm ci` that reports the lockfile out of sync is retried once with `--legacy-peer-deps`, as `ERESOLVE` is (an extension of the 2026-10-20 decision, announced on the board); anything beyond peers still stops.

On `subsets/l2-prep-remaining.json` (before 40159661032, after 40164744067):

- guillermolg00/nextjs-stripe-store and Ardione321/prep-ai now prepare from `bun.lock` and pass their type checks, with findings left.
- Alex-Unnippillil/share-house-portal prepares with pnpm, as its CI installs, and passes its tests.
- devczero/saas-pdf-analysis-dev validates.
- muhallimir/ampertalent prepares, but its baseline needs a Prisma generate step.
- inventashif/hackerai's patches pass and it stops at a workspace bin.

Tests: `pipeline/bun-lock.test.ts`, `pipeline/dependency-inputs.test.ts`, `pipeline/pnpm-inputs.test.ts`, `pipeline/npm-dependencies.test.ts` and `pipeline/review.test.ts`; the Docker suites passed on refit-bench (`gated.yml` run 40161788197).

## October 25 checkpoint: built-in Stripe adapter generated from Stripe's SDK spec (unreleased, after 0.39.0)

`refit run`, `refit watch` and the hosted worker no longer guess stripe-node method names from URL shapes or keep a hand-written alias table (`subscriptions.del` → `cancel`). The built-in adapter maps the methods an application calls through `operations` in `pipeline/stripe-sdk-metadata.json`. That list is generated by `scripts/stripe-sdk-metadata.mjs` from the `x-stripeOperations` declarations in Stripe's `spec3.sdk.json`. It is the union of all 31 pinned `stripe/openapi` tags (2022-08-01 to 2026-09-30.endive), so an application on an older API version keeps the methods that version had. Production and the benchmark now share one mapper. As in the benchmark, a list or search method maps to the object its page holds, and a union response such as `customers.retrieve` maps to each referenced object. Each mapping still needs the application's own contract to return that schema. Regenerating the file from the same 31 specs gives byte-identical output. Tests: `pipeline/stripe-operations.test.ts` and `pipeline/stripe-benchmark.test.ts`. A test fails if a frozen benchmark list pins an API version the file was not generated from.

## October 25 checkpoint: Stripe list and search results traced to their objects (unreleased, after 0.39.0)

An adapter operation may now say `"list": true`, with `schema` naming the object a list or search page holds ([pagination](https://docs.stripe.com/api/pagination), [search](https://docs.stripe.com/api/pagination/search), [auto-pagination](https://docs.stripe.com/api/pagination/auto)). The analyzer then traces `page.data[N]`, `const { data } = await ...list()`, `page.data.map`/`find`/`forEach` callbacks, `for (const x of page.data)`, `for await (const x of stripe.r.list())`, `autoPagingEach(cb)` and `await ...autoPagingToArray()` to that object, so the existing rules migrate removed-field reads on them (for example `getSubscriptionPeriodEnd` on `subscriptions.list` results). The list object itself, an un-awaited page, a plain `for` loop over the call, a page that is written to and expand paths on lists are not traced; those reads keep their review findings. The Stripe benchmark marks every list and search method whose 200 response is a `list` or `search_result` of one component. The built-in hosted adapter still maps `paymentIntents` only, so this applies to configured and benchmark adapters. Tests: `pipeline/stripe-list-traces.test.ts` (fixtures from `shagunmistry/FlowCraft` at `ae2e307` and `iggy-tech/product-hunt-clone-final` at `85b3a0f`, plus the untraced cases above) and `pipeline/stripe-benchmark.test.ts`. Rescanned locally at their commits, 14 push-279 repositories that call list methods got 17 new read edits across 7 repositories, each reviewed and correct; refit-bench run 40175558373 on push-279 validated three more repositories than main, with no new regression ([benchmarks](BENCHMARKS.md#stripe-list-and-search-traces-october-25)). A rule that picks a subscription item copies the selection the same function makes on another subscription, as it already did for retrieved ones.

## October 25 checkpoint: compressed scan, report and observation evidence (unreleased, after 0.39.0)

Each hosted target kept three copies of the full Stripe contract diff: the run's `scan.json` and `report.json` and the poll's `observations/<hash>.json`, about 90–125 MB each, because the 64,779 oasdiff changes from 2024-06-20 to 2026-09-30.endive (each with the repository's reach) are 97% of the JSON. About 205 targets filled the 40 GB volume and every job failed with `ENOSPC`. `refit run`, `refit watch` and the hosted worker now write those three files gzip-compressed as `scan.json.gz`, `report.json.gz` and `<hash>.json.gz`; their decompressed text is byte for byte what Refit wrote before. The manifest lists the compressed bytes, so `refit verify` and the interrupted-job check work unchanged. Every reader accepts both forms: the CLI result summary, the Stripe and Shopify benchmarks, the benchmark scorer, the AI patch eval and `scripts/stripe-benchmark-compare.mjs`, which now hashes the decompressed `scan.json` so runs from before and after compare equal. Receipt reuse, retries, watch carry-over and publication never read these files. An uncompressed observation is removed on its source's next full poll; old run directories are kept. On `Shivamrai15/lms` the three files went from 279 MB to 6.8 MB (`report.json` measured on another repository with the same version pair; see [Capacity](CAPACITY.md#what-one-worker-does)). `refit validate --bundle` still writes an uncompressed `report.json`, and each run still keeps uncompressed `before.json` and `after.json` (about 16 MB for Stripe). Tests: `pipeline/state-files.test.ts`, `pipeline/workflow.test.ts`, `pipeline/watch.test.ts` and `pipeline/stripe-benchmark-compare-details.test.ts`. Not deployed or measured on the Fly volume.

## October 25 checkpoint: capped dependency cache on the hosted volume (unreleased, after 0.39.0)

Prepared dependency bundles were never evicted, and `fly.toml` left `REFIT_DEPENDENCY_CACHE_DIRECTORY` unset, so on the Fly worker they went to the 8 GB root disk: about 55 bundles from about 70 jobs used 7.6 GB in 50 minutes, and 50 jobs then failed with `ENOSPC` during validation. Now each new bundle is followed by least-recently-used eviction until the cache fits `REFIT_DEPENDENCY_CACHE_GIB` (whole GiB, 1–1024, default 8; a bad value stops preparation before it installs). A reuse counts as use. Eviction takes each bundle's existing preparation lock and skips one another process holds; validation now copies the archive while it holds that lock, so a bundle is never removed mid-copy. A bundle is unpublished with one rename before it is deleted, so an interrupted eviction leaves no partial bundle, and the next preparation reinstalls it. `fly.toml` sets `REFIT_DEPENDENCY_CACHE_DIRECTORY=/data/dependencies` on the volume (40 GB as reported, not checked) and an 8 GiB cap, which peaks near 16 GiB with four jobs writing bundles. Tests: `pipeline/npm-dependencies.test.ts` (with the simulated Docker client) evicts in least-recently-used order, keeps a bundle locked by another live process, races reuse against eviction (every copy complete, no partial bundle), evicts after a real preparation under a 1 GiB cap and refuses bad values such as `0x10` and `1e1`. Not deployed or exercised on the Fly worker. Validation still copies archives into temporary directories on the root disk for the length of each job.

## October 25 checkpoint: lazy Proxy and let-holder Stripe clients (unreleased, after 0.39.0)

The Stripe tracer now follows lazy `Proxy` exports that name the client in a `const`, bind methods to that same client or pass it as its own `Reflect.get` receiver, a Proxy over a holder filled in its trap, and a `let` holder used as the client itself (`let stripe = null; if (key) stripe = new Stripe(key, …); stripe.customers.create(…)`, or `let stripe; try { stripe = getStripe(); } catch {}`). A holder counts only when every assignment is a client or nothing, all in its own file, and every read keeps the client inside it (a member read, a return, a write or a set-or-not test); a copied, passed, stored or exported holder stays untraced. An exported holder, or one written from another file, no longer backs a lazy factory either. Model fixes keep none of these shapes: their OpenAI and Anthropic requests stay listed but not edited, as before (pinned in `pipeline/model-retirements.test.ts`). See [client modules](CLIENT-MODULES.md).

On 19 Push 279 repositories (`subsets/l3-proxy-a.json` and `-b.json`; base runs 40147835670 and 40153378737, head runs 40150652070 and 40153941488), traced calls went from 464 to 710 of 842 likely calls, in hackerai-tech/hackerai (57 to 185), inventashif/hackerai (41 to 114), profullstack/vibe-stack (15 to 45), createdbymax/Loopletter (6 to 17) and IramMcFly/kitchen-soft-platform (2 to 6). No outcome changed. One diff changed: vibe-stack now also moves the pin of its module-holder client to endive (reviewed in `fix-reviews.json`). Docker-gated tests were not run.

## October 25 checkpoint: hosted inventories in their own processes (unreleased, after 0.39.0)

With `--job-processes`, `refit hosted serve` now runs each inventory in a forked `refit hosted inventory` process, with the same entry, 1536 MiB heap, stripped worker secrets and IPC protocol as job processes; the process reads the App credentials from its environment and gets the claim, the loaded registry and the time over IPC. Before, the inventory ran inside the worker: on the Fly worker the TypeScript analysis of `refit-dev/simplerdevelopment` (about 4,400 `.ts`/`.tsx` files) held the event loop for minutes in `getSymbolAtLocation`, so the 300-second cap never fired, `/health` failed, no job was claimed for over 20 minutes, SIGTERM was ignored, and after a restart the worker reclaimed the same inventory and hung again. Now a process that has not reported 10 seconds after the cap gets SIGTERM, then SIGKILL 10 seconds later, within the inventory's 360-second lease, and the inventory is recorded with an `error` naming the timeout. A failed inventory goes idle and runs again only on a push (at most once per 10 minutes), the daily re-scan, an operator request or a new installation, within the daily inventory cap; registry changes skip it. Without `--job-processes` nothing changed. Tests: `pipeline/hosted-runner.test.ts` forks a test inventory process (a result round-trips, a busy loop is killed at the cap, an error and a worker stop) and the real CLI, and `pipeline/hosted-job-limits.test.ts` shows `/health` answering within a second while an inventory process busy-loops, the timeout recorded, and the next job claimed and stored. Not exercised on the Fly worker or against `refit-dev/simplerdevelopment`; the analyzer itself is unchanged, so that repository's inventory now times out rather than completing.

## October 25 checkpoint: dependency preparation for Push 279 (unreleased, after 0.39.0)

Preparation changes from #289, measured on refit-bench against the Laptop 2 base run 40144503063 (main `c65f169`, 249 repositories, default `2g` profile). In the after-run 40149872255 (`c65f169` plus #289), 12 repositories change stage, all of them preparation refusals before, and every repository that prepared before still prepares:

- **glibc-only packages on musl images.** An npm lockfile that records no `libc` makes `npm ci` on `node:22-alpine` install the glibc builds of native packages (`@next/swc`, `@swc/core`, `sharp`) beside the musl ones, about 250 MiB that cannot load there. After the verified, script-free install, Refit removes each installed package whose own `package.json` excludes musl and that declares no `bin`. The lockfile is unchanged, and every draft states how many packages it removed (`installation.prunedGlibcPackages`, beside `legacyPeerDeps`). The recipe version is now 6, so cached bundles rebuild.
  On `subsets/o2-preparation.json` (26 size refusals, default profile), before 40148428223 (main `c65f169` plus the subset lists) and after 40148454891: 8 of the 15 dependency-archive refusals now prepare, each after removing 2 to 8 such packages (archives of 795 to 988 MiB). Two validate, two pass their checks with findings left, two fail at baseline and two regress, the same outcomes the 4 GiB run 40142158182 gives them without removing anything. The other seven are pnpm trees, which pnpm already filters, or npm trees still over 1 GiB; the 4 GiB default (#303) takes them.
- **Committed source.** The `4g` profile, the default under owner decision 3 (#303), archives up to 256 MiB of committed source; `2g` and smaller keep 50 MiB. The refusal names what to stop committing. With `--validation-workspace 4g` (run 40149726203), Shefaul-22/AgriFlow (73 MiB) now validates and CRONANANI/EzanaFinance3 (54 MiB) passes its checks with findings left; the 4 GiB run 40142158182 refused both at 50 MiB. Traviseric/arxmint and Eziox-Development/eziox-web now stop at lockfile integrity and lockfile drift, refusals O2 classified as correct and out of scope.
- **Gitlinks.** A gitlink that `.gitmodules` does not declare has no URL, so every clone sees an empty directory there; validation now reads it the same way. A declared submodule still refuses. Rerun 40151563784 on the four gitlink refusals (default profile): kaorii-ako/Shiori-v1 and RescuePC/Donation-Link now validate, on generated checks only because neither has tests or a type check; bichsonnhat/cognito reaches preparation and runs out of the 2 GiB workspace (Yarn 1); eka0789/evofuture stops at lockfile drift, the refusal O2 classified as correct.
- **pnpm settings.** The refusal names each unsupported setting and the file that sets it.

What still refuses, and why, is in [Preparation failures](PREPARATION-FAILURES.md#lockfile-drift-push-279): lockfile drift other than a range the locked version still satisfies (no repository of the set has only that drift, so it is not built), peers missing from a lockfile written with `--legacy-peer-deps` when no committed install asks for it, and Yarn 1 trees on the `2g` profile. Tests: `pipeline/npm-dependencies.test.ts`, `pipeline/validation-source-limit.test.ts`, `pipeline/committed-repository.test.ts`, `pipeline/review.test.ts` and `pipeline/pnpm-inputs.test.ts`; the Docker suites passed on refit-bench (`gated.yml` run 40148010031).

## October 25 checkpoint: hosted worker reconciles installed repositories (unreleased, after 0.39.0)

`refit hosted serve` now lists each active, allowed installation's repositories from `GET /installation/repositories` on start and once per `--interval`, records the ones no webhook recorded and enrolls the approved ones; `refit hosted reconcile` runs it once. The `refit-dev` installation (all repositories) had recorded 135 of 293, so 121 approved forks could not enroll. It only adds: removal stays webhook-only, and not-allowed installations are never listed. Tests: `pipeline/hosted-reconcile.test.ts`; its paging and per-installation failure case runs by default with a simulated GitHub, and its PostgreSQL cases (`REFIT_POSTGRES_URL`) were not run before this checkpoint. Not verified against the live GitHub API or the hosted worker on Fly.

## October 24 checkpoint: draft text matches the patch (unreleased, after 0.39.0)

When one file calls the generated Stripe helpers, Refit writes the ones it uses into that file after its imports instead of adding `stripeSubscriptionPeriod.ts` and an import; two or more calling files, or a file that declares a name the helpers use, still share one module. Either way only the helpers the patch calls are written, inserted lines keep the file's line endings, and nothing goes above a shebang, byte order mark or leading file pragma such as `@ts-nocheck`. In refit-bench run 40151479708, `alanagoyal/branded` regressed only because a test loads `lib/billing-state.ts` with a fixed set of allowed imports and rejected the new one; 105 of its 106 tests passed. Its patch was not regenerated and rerun with this change. When both sides of a compared type check exit non-zero, Stripe and model-fix drafts now say it "reported N existing type errors on the original code, counted by file, code and message, and no error with a new file, code and message on the migrated code" rather than "passed", counting errors as the gate compares them. Stripe drafts also ask the reviewer to confirm each kept non-card payment method is enabled ([dynamic payment methods](https://docs.stripe.com/payments/payment-methods/dynamic-payment-methods), read 2026-10-25), and collapse the breaking contract changes that do not hold the patch back under a count of each reason: no traced code reaches them, a kept rule edit handles them, or traced code uses them in a way the change does not break. See [Stripe subscription periods](STRIPE-SUBSCRIPTION-PERIODS.md#every-period-read-the-generated-helper).

## October 24 checkpoint: AI completes coverage stops as [Needs review] drafts (unreleased, after 0.39.0)

With AI on (`--ai-patch`, the hosted worker's `--ai-patch` and the benchmark's `--ai`), decisions 1 and 8 now let AI build on the rules' patch where a coverage stop left work: removed request parameters with no reviewed replacement, calls traced to breaking changes no rule migrates, and confirmed or untraced findings the rules leave unresolved. After the rules' patch passes its checks, the model gets the rules' code with its lines frozen and only those sites, and its proposal runs through the usual guards, checks and repair attempts. A passing AI patch ships as `[Needs review]` with the lines it wrote and what it resolved; a failing one is never published, and the rules' draft ships with the attempt and its cost recorded. Safety stops (API-version evidence, webhook payload version policy, class and helper clients, declared or type-only evidence, contract reviews, skipped files, tests) still keep AI out. With AI off, output is unchanged: the AI-off workflow artifacts for eight fixture shapes match the base commit apart from timing. Tests: `pipeline/validation-coverage.test.ts` (fixtures shaped like dev-30 repositories, fake Docker, OpenAI stubbed). Not covered: rows whose rules write no patch or whose checks cannot run (AI is not asked), and calls traced to breaking changes stay counted as unresolved after AI edits them, because no rescan shows them resolved.

## October 24 checkpoint: stops become [Needs review] drafts by default (unreleased, after 0.39.0)

Owner decision 1 (Pierce, 2026-10-24, #300) is the default for `refit run`, `refit serve`, `refit hosted serve`, `refit enroll`, `refit doctor` and the Stripe benchmark. Wherever Refit used to stop, it writes its best patch and opens a `[Needs review]` draft whose body starts with **Why this needs review**: each reason, the `file:line` it applies to and what to check ([CLI guide](CLI.md)). A finding that needs review is never edited. A patch that moved the API version and failed its checks is validated again without the move; if that passes it is published as `[Needs review]` with the pins it left listed, and otherwise a run the scan alone would have stopped ends at that stop, as before decision 1, without publishing.

- **Reasons:** findings left unedited (webhook payload reads, removed request parameters, class and helper clients, declared or type-only evidence, contract reviews, skipped files), an application API version that does not match the before contract, breaking contract changes no rule migrates (unknown reach included), a `node -e 0` check, an AI patch with the lines the AI wrote (decision 8), and on the hosted worker the `refit doctor` review checks.
- **Untested patches:** when dependency preparation fails because of the repository's inputs or its install (also when the upgraded stripe-node lockfile cannot be installed after the original checks passed, or the repository has no root lockfile), or the checks fail or time out on the original code, the patch is published untested and the draft says why. Refit's own errors during preparation (a state lock, the dependency cache, Docker or a setting) still fail the job so it is retried, and the draft never quotes an absolute path.
- **Model fixes:** `refit serve --model-fixes` titles a draft whose only check is `node -e 0` `[Needs review]` and gives the same reason as a Stripe draft.
- **Enrollment:** a repository that commits no `.refit.json` gets a generated configuration even without a root lockfile or checks, with submodules (checked without them, and each draft names them), with several API versions (it starts from the oldest), or with a version it cannot read or whose default it does not know. Then it assumes the versions it can read, else the locked stripe-node default of the project that installs those clients, else the oldest contract, 2022-08-01. The review lists every reason and the assumed version.
- **API versions:** the patch moves every traced pin older than the target to it with the same rules, and the draft lists each pin with the version it sent. It never edits a version Refit cannot trace, and lists it. For clients without `apiVersion` on a stripe-node whose default Refit does not know, it adds no pin; the draft says the account default decided the version before the stripe-node upgrade and the target decides it after. A run whose only finding is a removed request parameter gets the target pin and the upgrade, with the parameter left in place and named. The card-only rename, the mined request moves and `createPreview` keep stopping when a pin cannot be traced. Tested on synthetic contracts and on the saved Stripe contracts for enrollment; no draft was published. Follow-up: when the version is assumed, compare every contract from the assumed floor to the target and union the findings, so no version Refit has a contract for can hide one.
- **Still stops:** a patch whose checks ran on it and did not pass (a regression, an error, or a generated check that fails on the original code), a run with no patch, `source-verified`-refused API-version declarations, and setup problems. Every blocked doctor check is classified as setup, workflow or review, and an unknown one throws. Enrollment still refuses a version with no contract, files that do not parse, and stripe declared only in a workspace package, in a project the root lockfile does not install, or without a root package.json.

`--publish-validated-only` restores validated-only publication and cannot be combined with `--publish-unresolved`; under it a passing AI patch is not published, because an AI patch is never a validated draft (decision 8). Job machines (`--job-machines`) run without decision 1. Not verified: live draft publication, the hosted worker on Fly and AI patches.

## October 24 checkpoint: lowercase Stripe currency codes (unreleased, after 0.39.0)

With `--full-diff`, a request `currency` that endive gives the `currency` format no longer stops a call that writes an uppercase literal in its own request: the deterministic rule `stripe-lowercase-currency-code` lowercases it (`'USD'` to `'usd'`, quotes kept), citing [docs.stripe.com/currencies](https://docs.stripe.com/currencies), and the reach gate reports the change `handled`. Constants, literals outside the call, computed values and test files are not edited and still stop. In refit-bench run 40146076045, 17 repositories stopped only on this; rescanned at their commits, all 17 get a proposed patch. Their checks were not run. See [Stripe currency codes](STRIPE-CURRENCY-CODES.md).

## October 24 checkpoint: hosted jobs in their own processes (unreleased, after 0.39.0)

`refit hosted serve --job-processes <n>` (off by default) runs each job in a forked `refit hosted job` process, up to `n` at once. Before, every job ran inside the worker process, and a scan of a large repository held its event loop for minutes on the Fly worker: `/health` missed Fly's 5-second check, webhooks timed out and lease renewals waited. The worker keeps claims, leases, receipt reuse, CPU-steal measurement and receipts; a stop sends the job process SIGTERM, then SIGKILL after 30 seconds, and a process that exits without reporting fails its job. `REFIT_HOSTED_INSTALLATION_JOBS` (default 1) lets several jobs of one installation run at once, counted across workers under the existing claim lock. Allowed accounts are unchanged. Tests: `pipeline/hosted-runner.test.ts` forks a test job process and the real CLI, `pipeline/hosted-job-limits.test.ts` shows `/health` answering within a second while a job process busy-loops and drain waiting for every job, and `pipeline/hosted-tenancy.test.ts` (PostgreSQL) races four claims against a limit of two. Not exercised on the Fly worker, and parallel jobs' memory and CPU were not measured. Two jobs preparing the same dependency bundle at once do not wait for each other: the second fails on the cache lock.

## October 24 checkpoint: hosted validation on Linux (unreleased, after 0.39.0)

The first hosted fork test ran the full path on the Fly worker: installation, stored approval, offline Docker validation and draft publication ([results](BENCHMARKS.md#hosted-fork-test-october-24)). It found two Linux-only failures that local runs could not, because Docker Desktop on macOS ignores folder modes: the unprivileged sandbox user could not read candidate or generated folders made by `mkdtemp` (#242), or `stripe-mock` contracts mounted from private run artifacts (#243). Both are fixed; generated checks now mount read-only copies, and run artifacts stay private. Fly shared CPUs throttle under back-to-back jobs until checks pass the check limit, so sustained hosted use needs a performance machine. Not exercised on the hosted worker: AI repair, approval issues, and more than one installation.

## October 23 checkpoint: hosted AI cap across installations (unreleased, after 0.39.0)

With `--ai-patch`, `refit hosted serve` now caps AI spend across every installation, not only per installation. Each request reserves against its installation's ledger and against one total ledger (`refit_ai_total_ledger`, hosted migration 10), and is sent only when both have room. The total cap is `REFIT_HOSTED_AI_BUDGET_USD`; unset, it equals `REFIT_AI_BUDGET_USD`, so allowing more accounts does not multiply exposure until the operator raises it. Local `refit run` is unchanged. Tests: `pipeline/ai-budget.test.ts` (file ledgers) and `pipeline/hosted-tenancy.test.ts` (PostgreSQL, gated by `REFIT_POSTGRES_URL`). Not exercised against the live hosted worker or OpenAI.

## October 22 checkpoint: no silent model exposures (unreleased, after 0.39.0)

`refit deadlines --propose-model-fixes` now gives every live OpenAI and Anthropic model match an outcome:

- **Unresolved.** A live model ID that no traced request sends is listed under `unresolved` (`--json`) or "Not sent by a traced request", with its replacement and where it is written. These are never edited.
- **Header-detected requests.** A `fetch` to a non-official URL that sets `anthropic-version` inline and sends `model` and `messages` is traced as an Anthropic request and always stops for review.
- **Unreadable configurations.** Calls found only by trusting an SDK import under a `tsconfig.json` or `jsconfig.json` Refit cannot read (for example one extending a generated `.svelte-kit/tsconfig.json`) stop for review.
- **`paths` fallback.** A bare import matching a `paths` entry is the installed package when no mapped target or `baseUrl` lookup is a scanned source, as TypeScript resolves it. This applies to every provider's analysis, Stripe included.
- **Catalogs.** A model's per-platform ID record (with a Bedrock or Vertex AI form) and members of a `new Set([...])` or keys of a `new Map([...])` are catalog.

On the application sets, read only against `main` at `fb0143a`, exposed repositories with no outcome went from 6 to 0 for Anthropic (38 applications, after we removed 12 copies of leaked proprietary source) and 12 to 0 for OpenAI; replacements stayed at 2 repositories per set and no repository lost one ([benchmarks](BENCHMARKS.md#model-fixes-on-the-application-sets-october-21)). Tests: `pipeline/model-retirements.test.ts`, `pipeline/deadlines.test.ts` and `pipeline/ai-model-benchmark-summary.test.ts`.

## October 22 checkpoint: sourced parameter table, off by default (unreleased, after 0.39.0)

The model-replacement rule can continue past a sampling or length stop where an official page read by a person proves the replacement accepts that parameter with that literal value. It is off by default (owner decision, 2026-10-22): only `refit deadlines --propose-model-fixes --parameters data/model-parameters.json` uses the table; `refit serve --model-fixes` and the default command keep the heuristic stops.

- **Table.** `data/model-parameters.json` holds sourced entries, each with an official `source`, a `checkedAt` date and, for defaults, a `defaultSource`. `npm run model-parameters:check` rejects the whole file on any error, and a table that fails to load stops model fixes.
- **What continues.** Only a literal `temperature: 1` on a `claude-sonnet-5-5` replacement. Each parameter is verified separately.
- **What keeps stopping.** On replacements with a table entry, every parameter the table does not prove, renamed parameters (never rewritten), non-literal values and computed property names. Replacements without an entry keep the earlier heuristic: Claude 4.7-and-later replacements (such as Opus 4.8) stop on `temperature`, `top_p` and `top_k`, earlier ones such as `claude-haiku-4-5-20251001` continue, and every OpenAI replacement stops on its sensitive parameters.

Evidence is fixture tests and the pages read; no live provider was called. Fix rates are measured separately, on the application benchmark sets.

## October 21 checkpoint: single-tenant hosted enrollment (unreleased, after 0.39.0)

`refit hosted serve` is milestone 3 of the [hosted onboarding proposal](HOSTED-ONBOARDING.md#implemented-single-tenant-hosted-worker). A signed App installation webhook enrolls each installed repository that has a stored `refit enroll` approval. PostgreSQL then holds the installation, the target, a leased job and its receipt. The worker reuses the service's existing core: access confirmation, an App-managed checkout, the approval fingerprint check, `refit doctor`, then scanning and validation with the approved checks. Removing the repository, or deleting or suspending the installation, cancels its targets and stops running jobs. `refit hosted approve` stores an approval.

What was verified: an end-to-end test against PostgreSQL 17 sends a signed installation delivery for one approved and one unapproved repository. Only the approved repository was enrolled. Doctor reported `ready-for-validation`, the deterministic migration passed baseline and patched checks in offline Docker (`node:22-alpine`), and the stored receipt was `validated` with integrity-verified evidence. A duplicate delivery was ignored and a conflicting one rejected (409). Uninstalling cancelled the target, and no further job was queued or claimed. A second test covers lease expiry and reclaim by another worker, a stale worker's renewal and finish being refused, cancellation of a running job that keeps its evidence, and re-enrollment.

Boundaries: GitHub's API and the git remote were simulated in these tests. No real GitHub delivery, deployment, AI request or publication was used. Owner decisions (2026-10-21): Fly.io Machines, Supabase Postgres in the US, the owner's own AI key with a ledger per installation, and draft PRs from day one. Hosted mode enrolls only `REFIT_HOSTED_OWNER`'s installations, because jobs share the worker's Fly Machine and its in-VM Docker daemon. The image was built and booted locally against PostgreSQL (in-VM `dockerd`, health, status, schema migration).

Live check (2026-10-22): the worker runs on Fly (`refit-hosted`, `iad`) against Supabase through a dedicated `refit_hosted` role that owns the Refit tables. Installing the real Refit Agent App on all of the owner's repositories delivered `installation created` (202). The worker recorded 26 repositories and enrolled only the approved `refit-billing-demo`. Job 3 ran doctor (`ready-for-validation`), found 2 confirmed Stripe usages, passed baseline checks, then requested an AI patch and one repair; both regressed, so the stored receipt is `validation-failed` and nothing was published. Uninstalling delivered `installation deleted` (202), the target became `cancelled` and no job was queued afterwards. The first run failed because the entrypoint's `umask 077` made sandbox inputs unreadable (fixed); its cached failure had to be moved aside on the volume. `refit hosted retry --target <id>` now queues one fresh attempt instead, matching `refit serve --retry-target`; a store test covers queueing, marking an already-queued job, refusing a running or unenrolled target, and handing the flag to the claiming worker.

## October 21 checkpoint: OpenAI and Anthropic benchmarks re-measured (unreleased, after 0.39.0)

Both frozen AI SDK sets and the 34-application deadline set were run again, from a worktree pinned at main `72386c2`. That is after #137 (class properties reported, not edited), #138 (shared analyzer program) and #143 (catalog precision and build output). Scans ran three or four at a time with nothing else running. Four repositories that hit the 2-minute cap only under that load were re-run alone with the same cap. An earlier run on a tree that still edited class properties gave the same counts. The one difference: a policy-synth stop now names the class property `llmModel` instead of the sampling parameters.

- **OpenAI** (100 repositories):
  - 45 exposed (47 before), with 1 proposal and 1 stop;
  - 14 not fully scanned (16 before);
  - the one proposal is still correct on hand review and still over the 50 MiB validation archive limit.
- **Anthropic** (50): 16 exposed (17 before), with 1 proposal (6 sites, validated again: `vitest` passed before and after) and 2 stops; 15 not fully scanned (17 before).
- **Deadline set** (34 applications):
  - 22 exposed, with 2 proposals (6 sites, correct on hand review) and 4 stops;
  - neither proposal validated: one needs a custom image, and the other's build fails offline before the change;
  - 7 of the 19 labelled live lines reach an edit or a stop.
- **Why fixes did not move.** Live lines fell from 1,170 to 630, but almost all of the removed lines sat in repositories that also send a model some other way. Of 43 untraced OpenAI exposures:
  - 10 are non-text models only, which the rule never replaces;
  - 7 are timeouts;
  - 26 pass the model through a library's wrappers.

  The frozen sets are libraries from npm search. An application set needs GitHub code search.

Validation used `node:22-alpine` with the build environment's proxy CA added, for the benchmark only. Results: `docs/benchmarks/2026-10-21-{openai,anthropic,model-replacement}-results.json`, each with the run's validation and hand review. The checklist is in [Provider goals](PROVIDER-GOALS.md#openai-and-anthropic-progress-checklist-2026-10-21): 70% for both providers, unchanged.

## October 21 checkpoint: new model-fix stops, prose and traced indirect sources (unreleased, after 0.39.0)

This change only adds stops: `refit deadlines --propose-model-fixes` and `refit serve --model-fixes` edit nothing they did not edit before. See [Deadlines](DEADLINES.md#propose-model-replacements).

- **Prose.** A model ID quoted inside a longer plain string with spaces (a description, an error message, embedded markdown) is a `comment`, not live (D-20, approved by the owner on 2026-10-21). Template pieces with substitutions, `+` operands, JSX text, JSON-shaped strings and text that sets a model key, flag or env name right before the ID stay live.
- **Non-text calls.** Every traced OpenAI or Anthropic call outside text generation, and raw requests to the non-text endpoints and Anthropic `/v1/complete`, stop with a named reason and are never edited. In `refit serve --model-fixes` a repository whose only retiring uses are such calls ends as `needs-review` instead of `no-change`.
- **New stops.** These stop with a named reason:
  - a custom endpoint anywhere in the repository (`baseURL`, `OPENAI_BASE_URL`, `withOptions(`, `AzureOpenAI`, in source or `.env*`, JSON or YAML);
  - a module loaded by `import()`, `require()`, a glob, `export *` or an opaque namespace;
  - class inheritance the tracer cannot resolve;
  - an enum, class or object read as a whole or written to;
  - a trace cut by the depth limit (10) or the work budget (2,000 steps).
- **Indirect sources, reported.** The rule now traces class fields, `const` object members, computed initializers, returned literals, destructuring defaults, options-object parameters and axios request configs. A model reached only through one of them stops and names its source. Editing them (D-06 to D-08) comes with a separate change carrying the owner decision. Shared sources (D-09) stay stops, counted per member for objects and enums.
- **Counts.** Every exposure and mention carries exact `nonLiveCounts` by use. The AI benchmark summary gains `nonLive`, `nonLiveTotal`, `mentionedOnly` and `exposedErrored`, and errored repositories are no longer counted in `exposedSilent`.

Tests: `pipeline/model-retirements.test.ts` runs the resolver cases with indirect edits enabled and pins the default, in which indirect sites stop. `pipeline/deadlines.test.ts` covers the prose rule; `pipeline/ai-model-benchmark-summary.test.ts` covers the summary keys. Evidence is fixture tests only; no live provider was contacted.

## October 21 checkpoint: computed request keys stop model fixes (unreleased, after 0.39.0)

A traced request with a computed property name, such as `['temperature']: 0.5` or `[KEY]: 5`, now stops for review instead of being edited. The sampling-parameter check reads only plain names, so a computed one could hide a parameter the replacement rejects. This change only adds a stop. Tests: `pipeline/model-retirements.test.ts` covers string, template and variable keys for OpenAI and Anthropic, beside a plain request that is still edited.

## October 21 checkpoint: class property models reported for review (unreleased, after 0.39.0)

`refit deadlines --propose-model-fixes` and `refit serve --model-fixes` now trace a request's `model: this.model` to where the class sets it:

- the field initializer;
- a constructor parameter default;
- each assignment, including JavaScript's `this.model = options.model || 'gpt-4'`.

Each such site is listed as a stop with its location and replacement, and is never edited. Editing class properties would widen which uses are replaced, so it waits on an owner decision (#120).

Tests: `pipeline/model-retirements.test.ts` covers class fields, constructor parameter properties, JavaScript constructor assignments and a property read twice. All are stops, with no patch.

## October 21 checkpoint: dynamically imported Stripe client factories (unreleased, after 0.39.0)

A client factory loaded with `await import()` is now followed the way a static import is: `const { getStripe } = await import('./stripe')`, a renamed entry, and `(await import('./stripe')).getStripe()`. The analyzer's type checker runs without lib types, so it could not type a dynamic import; the binding is now made from syntax, like `const { x } = require(...)`. Only `const` destructuring links, only to a stable ESM export (a function, class or top-level `const`), and the factory itself must still pass every existing factory rule. A `let` binding stays untraced; a test pins it.

On the 10 active-team repositories with the most calls that traced nothing on October 16, traced calls went from 247 to 280 of 355, read from source with no Docker ([benchmarks](BENCHMARKS.md#lazy-stripe-clients-on-the-active-teams-set-october-21)). Most of the gap the October 16 run reported had already closed with factory tracing on October 17; this measures what was left. No migration was run or validated for this change.

## October 21 checkpoint: model catalog precision and build output (unreleased, after 0.39.0)

- **Catalogs.** For OpenAI, Anthropic and Gemini, the deadline scan now lists more catalog shapes as non-live:
  - model-keyed entries behind `satisfies` or `as`;
  - model records: an `id` or `name` beside a metadata field such as `contextWindow`, `max_output_tokens`, `pricing` or `owned_by`;
  - genkit-style `versions: [...]` lists;
  - constant-case objects naming three or more models.

  A request's `model` never counts as a record name, and mixed-case settings objects stay live.

- **Measured.** Read-only scans of the 184 checkouts behind the frozen sets (100 OpenAI, 50 Anthropic and the 34-repository deadline set):
  - OpenAI and Anthropic live lines fell from 1,170 to 630.
  - Repositories with a live line fell from 87 to 84.
  - Every dropped line was read by hand: model records and cards, generated model tables, `versions` lists, enum-like objects and one minified bundle.
  - All 19 hand-labelled live model lines in the deadline set stay live. The 4 labelled options still counted as live are alias-map values, which stay live on purpose.
- **Build output.** The model replacement rule never proposes an edit in build output committed with the sources: `out/`, `ts-out/`, `*.min.js`, `*.bundle.js`, or JavaScript whose TypeScript source sits beside it or in a sibling `src/`. This narrows where edits land; it does not widen which uses are replaced.

Tests: `pipeline/deadlines.test.ts` adds the new catalog shapes, and the live lookalikes they must not catch. `pipeline/model-retirements.test.ts` adds compiled copies beside their sources.

## October 21 checkpoint: Gemini detection, report only (unreleased, after 0.39.0)

Gemini is in the agent catalog with `adapter: null`: packages `@google/genai` and `@google/generative-ai`, hostname `generativelanguage.googleapis.com`, which is the default host in the published code of both SDKs. Every fact recorded in [Provider goals](PROVIDER-GOALS.md#gemini) was read on 2026-10-21 from an official source: the two SDK READMEs on GitHub, the npm registry and the published package code. Google's model and deprecation pages on ai.google.dev were refused by this environment's network policy, so **no Gemini model retirement date is in the registry**, and there is no `refit deadlines --sync gemini`: a parser could not be written against a page nobody could read.

- **Registry.** It accepts the `gemini` provider and a new `sdk` kind, whose `versions` are npm package names and whose date is an end of support. One entry: `@google/generative-ai`, support ended 2025-11-30 per its repository README, replacement `@google/genai`. The README in the package's last npm release gave 2025-08-31; the summary records both, and that Google does not say requests through it stop working. `npm run deadlines:check` passes.
- **Matching.** A declared `sdk` package is live evidence at its manifest line, read only when some source file names the package; manifests in test or example paths are `test`. Gemini model IDs get the OpenAI and Anthropic use classes, and `models/<id>` matches `<id>`, as both SDKs treat them as the same model. Gemini-shaped IDs count toward a model list only when classifying a Gemini match, so OpenAI and Anthropic classification is unchanged.
- **Report only.** `refit deadlines --propose-model-fixes` and `refit serve --model-fixes` never edit Gemini code, even when an entry names a replacement; a test pins this. Widening replacements to Gemini, and the old-to-new SDK swap, are owner decisions.
- **Benchmark.** 50 repositories frozen from npm search, almost all libraries. All 6 that declare the old package are flagged, with 8 manifest lines correct on hand review. A census against every `gemini-*` string found live Gemini IDs in 39 repositories; in a 72-match sample, 50 of the 67 model IDs are real live pins (75%). See [Benchmarks](BENCHMARKS.md#gemini-october-21).
- **Found, not changed.** A model in a template string inside a test file counts as live for every provider, because only plain string tokens get the test class. Fixing it would lower OpenAI and Anthropic live counts, which `--fail-within` and alerts rest on, so it is left for a decision.

What changes for users: `refit deadlines --fail-within` now exits 2 for a repository that declares and imports `@google/generative-ai`, and with `--deadline-alerts` an enrolled repository like that gets an issue. Nothing edits code. No Google API was called and no credential was used. Gemini is at 20% on its [progress checklist](PROVIDER-GOALS.md#gemini-progress-checklist-2026-10-21).

## October 21 checkpoint: faster model replacement analysis and steadier tests (unreleased, after 0.39.0)

- **Shared program.** Analyses of the same repository snapshot now share one TypeScript program and type checker. That covers the OpenAI, openai v3, `openai-edge` and Anthropic tracers of `refit deadlines --propose-model-fixes` and `refit serve --model-fixes`. On `earendil-works/pi` (1,677 source files), a proposal took 176 s before and 121 s after, measured back to back under the same concurrent load. Results are unchanged; a test compares shared and separate reads.
- **Pruning measured, not adopted.** Analyzing only the files that reach an SDK import or name a traced call kept 1,408 of pi's 1,677 files and gave identical calls, but saved only 15–20%.
- **Tests.** The `pipeline` test project now defaults to a 30 s timeout. Many of its tests start the CLI as a subprocess or run the compiler, and on a loaded machine more than ten of them exceeded vitest's 5 s default. With the new default the whole suite passes with no `--testTimeout` flag, under the same load.

## October 21 checkpoint: review-only PayPal request detection (unreleased, after 0.39.0)

`refit paypal` lists the PayPal REST requests a repository makes. It reads three shapes: `@paypal/checkout-server-sdk` request classes sent with `client.execute`, `@paypal/paypal-server-sdk` controller calls, and raw `fetch` and `axios` calls to `api-m.paypal.com`, `api-m.sandbox.paypal.com`, `api.paypal.com` and `api.sandbox.paypal.com`. For each it gives `file:line`, method and path, and the matching operation in PayPal's published OpenAPI documents. It also gives the newest server SDK method that makes the same request, and notes requests, hosts and SDK methods the documents or the declared release do not have. It is review only: nothing is edited, installed, run or sent to PayPal, and it proposes no SDK replacement. The catalog entry stays at `adapter: null`, and no gate, default or stop changed. See [PayPal](PAYPAL.md).

- **Request map.** `data/paypal-requests.json` is generated by `scripts/paypal-requests.mjs` from never-installed npm tarballs and a pinned checkout of `paypal/paypal-rest-api-specifications` (`90e8041`, 2026-04-07). It holds 15 old-SDK request classes from 1.0.3, every controller method of the 13 server SDK releases 0.5.1 to 2.5.0, and the operations of 13 published documents.
- **Facts checked 2026-10-21** from the npm registry, both packages' sources and READMEs, the new SDK's GitHub repository and the published documents. The old SDK is deprecated on npm in favour of the new one. The new SDK renamed every controller method in 0.7.0. The old SDK calls `api.` hosts where the new SDK and the documents use `api-m.`. Two requests the new SDK makes are not in the documents (`POST /v1/oauth2/token`, `GET /v1/billing/subscriptions`), and one old-SDK request is in neither (`OrdersValidateRequest`).
- **Not verified.** `developer.paypal.com` is blocked by this environment's network policy. So the deprecation date, any end-of-support or API retirement date, the versioning policy and the release notes stay unverified, and **no deadline entry was added**. `npm run deadlines:check` still passes.
- **Benchmark.** `scripts/paypal-select.mjs` froze 22 repositories from npm search (GitHub code search is unavailable); no more qualified. The set is libraries and plugins, not applications. From a pinned worktree at `1ec93a8`, 17 were scanned and 5 exceeded scan limits. The scan reported 90 live requests: 82 new-SDK and 8 raw. All 90 are correct on hand review, and 83 match a published operation. A text heuristic found 92 real SDK call lines in scanned repositories, and 82 were traced (89%). The 10 misses come from a controller returned by another file's getter. Every old-SDK request in the set is in over-limit repositories. A separate scan of their PayPal package directories traced all 15 call lines, 12 of them old-SDK requests ([benchmarks](BENCHMARKS.md#paypal-requests-october-21)).
- **Not read.** PayPal bases from environment variables or object literals, axios instances with a PayPal `baseURL`, and controllers passed between files.

Tests: `pipeline/paypal-calls.test.ts` (20) covers each old-SDK binding form, `execute` tracing through variables and assignments, unknown request classes, controllers in variables, class properties, constructor assignments, namespaces and `require`. It also covers release checks against a locked, exact or ranged version, the 0.x-to-0.7 rename note, raw calls through conditional and imported bases, helpers, reassigned URLs, unlisted hosts, and the published-document gap list. The full suite, typecheck, format check and build passed. No vendor API was called and no model was used.

## October 20 checkpoint: frozen OpenAI and Anthropic benchmarks (unreleased, after 0.39.0)

`scripts/ai-sdk-select.mjs` froze 100 OpenAI and 50 Anthropic repositories: packages whose latest npm manifest declares the SDK in `dependencies`, with a GitHub repository, published since 2024-01, ranked by downloads. GitHub code search was unavailable, so this replaces the Shopify method's search step, and the sets are mostly libraries, not applications. `scripts/ai-model-benchmark.mjs` ran the deadline scan and, where a live exposure exists, the model replacement rule, capped at 2 minutes per command, from a pinned worktree at `f62bad2`. `pipeline/ai-model-validation-cli.ts` validated each proposal the way `refit serve --model-fixes` does. The Docker image was `node:22-alpine` plus this environment's proxy CA, for dependency installs only.

- OpenAI: 47 of 100 repositories have a live exposure. 1 got a proposal, which is correct on hand review but too large to validate (over the 50 MiB archive limit). 1 more stopped for review, and 16 could not be scanned.
- Anthropic: 17 of 50 have a live exposure. 1 got a proposal (6 sites), correct per the registry and validated with its `vitest` suite. 2 more stopped for review, and 17 could not be scanned. The validated script also sets extended thinking `budget_tokens`; whether `claude-sonnet-5-5` accepts it is unverified.
- Also in this change: a swap to a pre-Claude-4.7 replacement keeps `temperature`, `top_p` and `top_k`, since Anthropic rejects them only on 4.7 and later. The rule skips analysis a repository cannot need.

Most untraced exposures are catalog entries the scanner counts as live, or library defaults in class fields. On the progress checklist in [Provider goals](PROVIDER-GOALS.md#openai-and-anthropic-progress-checklist-2026-10-21) both providers were at 70%. The fix rate is far below the 70% target, and it needs an application set to be measured fairly.

## October 20 checkpoint: reviewed Meta Graph API change list (unreleased)

`data/meta-graph-changes.json` now holds the Meta Graph API changelogs for v14.0 to v26.0, each read in full from developers.facebook.com on 2026-10-20 and marked `reviewed`, with 281 changes from the Graph API and Marketing API sections. Every change cites its page. The Instagram sections were checked against the Instagram Platform changelog's version-gated entries; they match except that from v14.0 the IG Media `video_title` field errors, which is recorded from that changelog. v13.0 stays `unread`: it matters only to pins older than any benchmark pin. Each version's note lists what the page holds that is not an entry: permission policy changes, error codes, transport changes, additions, and Certificate Transparency endpoints the page does not name.

`refit meta-graph --propose-version-moves` gained three stricter rules:

- **WhatsApp and Messenger.** Their changelogs are separate and not in the list, so their requests stop. This is decided by edge, such as `messages`, `message_templates` or `conversations`, or by a send parameter such as `messaging_product` or `recipient`.
- **Node-wide changes.** A removal of a whole node type, such as `/{offline-event-set-id}` or the Instagram v1.0 nodes, stops requests to a single opaque node (a placeholder or numeric ID) and never matches a literal path such as `/me`. Before, a single-placeholder path matched every request.
- **Metric names** compare regardless of case, since some pages print them in capitals.

On the 33 Meta repositories of the deadline benchmark at target v25.0, the reviewed list proposes **35 moves in 13 repositories**. Before, there were 0 with every changelog unread; the hypothetical upper bound with empty changelogs is 100. Every moved request was checked by hand against the list: Instagram publishing and field-named reads, field-named ads insights, Page feed posts, Conversions API events and `/me`. 113 pins stop with named reasons:

- 44 have unknown request parts;
- 32 cross a node-wide change;
- 26 are WhatsApp or Messenger;
- 22 hit an edge change;
- 21 hit a field change;
- 17 are test-only;
- 4 are in pins the move cannot edit safely.

One v24.0 entry was first recorded as a removed `/search` endpoint. The page actually describes changed interest search results, so it is recorded as a change to the `type` parameter. The removed-endpoint form had stopped 128 pins through placeholder matching.

The Meta tests passed (59). New tests cover the WhatsApp and Messenger guard by edge and by parameter, node-wide matching on opaque and numeric IDs but not literal paths, case-insensitive metrics, and a committed-list run where a Page photo post moves. The general fixture moved off a WhatsApp send, which the old tests had moved on Graph-only evidence. Deliberately removing the guard, the parameter signal, the node-only matching or the case folding each fails a test. No vendor API was called; only public documentation pages were read. Whether a hand-kept list is enough evidence for automatic edits is still an owner decision, and the moves remain review-only.

## October 20 checkpoint: self-maintaining Anthropic deadlines (unreleased, after 0.39.0)

`refit deadlines --sync anthropic` reads Anthropic's model deprecations page and updates `data/deadlines.json`. It groups the page's tables into one entry per retirement date and replacement. Entries are matched by model, so a moved date updates in place, and unchanged entries keep their aliases and `checkedAt`. Nothing is deleted, an unparseable row fails the sync, and the result must pass the registry check before it is written. On the live page (20 retirements, 2026-10-20) it reports no change: the shipped entries match.

A scheduled workflow, `.github/workflows/deadlines-sync.yml`, runs it daily and opens a pull request when the registry should change, so the registry stays current with a reviewer's merge as the only human step. Matching, CI checks, alerts and model replacements still read only the committed registry. OpenAI's page could not be reached from this environment, so its entries are still maintained by hand.

## October 20 checkpoint: automatic model fixes in enrolled repositories (unreleased, after 0.39.0)

`refit serve --model-fixes` (off by default) now maintains retiring OpenAI and Anthropic models without asking first. After each poll, for every enrolled repository:

1. It applies the model replacement rule to the committed snapshot.
2. It runs the repository's approved checks before and after the change, in the same offline Docker sandbox and limits as contract migrations, through a new `validateSourcePatch`.
3. If both runs pass and `--publish-draft` is set, it opens a draft pull request. The branch, commit and pull request steps moved from `publishDraft` into a shared `publishFiles`, and contract publication behaves exactly as before.

Refit never merges, and a failing check publishes nothing. Uses that stop for review are listed in the pull request, never edited. The service records each repository's outcome under `modelFixes`, keyed by the replacements themselves, so the same fixes are not revalidated or republished on every poll and a closed pull request is not reopened.

Tests:

- Mocked validation and publication test the workflow's decisions and the pull request description.
- A service test checks that the feature is off by default, gets the approved checks, opens a pull request only with `--publish-draft`, and is deduplicated through state.
- A `REFIT_DOCKER_IMAGE`-gated test ran real offline Docker (`node:22-alpine`): a passing check validated the replacement, and a check that depends on the old model failed it.

The team asked for this on 2026-10-20. It changes the open replacement-policy decision, so it needs the owner's sign-off before release; it is not recorded in `AGENTS.md` until then.

## October 20 checkpoint: model replacements across files and raw HTTP (unreleased, after 0.39.0)

The model replacement rule now resolves names with the TypeScript checker over the repository's own sources, so it follows imports. It covers:

- a constant or enum member that holds the model, even in another module, edited where it is declared when this request is its only use;
- a helper function's model parameter, edited at its default and at each caller that passes a literal;
- raw HTTP requests to the official text-generation endpoints (`fetch`, `UrlFetchApp.fetch`, `axios.post`).

A constant used more than once, a helper passed as a value or called with spread arguments, and every earlier stop still stop for review. Each stop now gives `at`, the place the model is written.

On the 15 exposed deadline-benchmark repositories, fixes stayed at 6 sites in 2 repositories, all correct on hand review. Repositories that stop for review with a reason went from 2 to 4, and silent misses from 11 to 9. 3 of the 4 stops are the sampling-parameter rule, so verifying which parameters the replacement models accept is now the main lever. See [the results](benchmarks/2026-10-20-model-replacement-results.json).

## October 20 checkpoint: wider model replacement coverage (unreleased, after 0.39.0)

`refit deadlines --propose-model-fixes` now covers three more shapes found on the deadline benchmark:

- `createChatCompletion` on an openai v3 or `openai-edge` `OpenAIApi` client. The analyzer lists such direct client-method calls separately, and no other analysis reads them.
- A request object held in a `const`.
- A model `const` used by one call. Such a constant is edited where it is declared.

A `const` that is exported or used more than once stops for review, as before. Legacy completions are still never proposed.

On the 15 exposed OpenAI deadline-benchmark repositories, proposals went from 2 sites in 1 repository to 6 sites in 2, all correct on hand review. Stops with a reason went from 1 repository to 2. See [the results](benchmarks/2026-10-20-model-replacement-results.json).

## October 20 checkpoint: `allOf` response schemas and OpenAI `responses.create` (unreleased, after 0.39.0)

Adapter mappings used to require a response schema with directly declared properties, so OpenAI's `Response`, an `allOf` of `ModelResponseProperties`, `ResponseProperties` and its own fields, could not be mapped. When a spec is loaded, a component that is an `allOf` of plain object schemas (references or inline objects, followed recursively) is now merged into one object schema with the union of their properties and required fields. This applies only to the schema map that analysis reads; the document oasdiff compares is unchanged. Parts with `anyOf`, `oneOf`, `not`, a discriminator or a non-object type, and parts that declare the same property differently, are left as they were.

The OpenAI adapter now maps `responses.create` → `Response` (operation ID `createResponse`). In OpenAI's published document (info.version 2.3.0), 22 components merge, including `Response` with 37 properties. Stripe's current `spec3.json` has no component-level `allOf`, so Stripe results do not change. A test runs the shipped adapter on a trimmed contract with that `Response` shape and a simulated removal from `ResponseProperties`, which is reported at the property read.

## October 20 checkpoint: Stripe pipeline hardening (unreleased, after 0.39.0)

Three owner decisions (2026-10-20) are recorded below: untraced reads count as unresolved, npm `ERESOLVE` is retried with `--legacy-peer-deps`, and strict forwarding Proxy exports are traced. No other gate was relaxed. Benchmarks were not rerun; the reasons below come from the October 16 results and from parsing the affected repositories' committed files.

- **Tracked symbolic links are accepted when every one resolves inside the repository**, following links in its target. Absolute, escaping or looping links still refuse validation, and profile inputs must still be regular files. This was the refusal for four fresh Stripe repositories. `git apply` already refuses a patch that writes through a link or over one.
- **Byte order marks.** A `package.json` with a BOM, which npm accepts, refused the whole scan as invalid JSON. A script whose shebang follows a BOM was unparseable, which fails the scan when it imports Stripe. Both are read now; patched manifests keep the BOM. Of the eight repositories stopped by unparseable files, one had this cause; the other seven contain genuinely broken files and still stop for review.
- **Draft PR descriptions say what the code uses.** A card-rule draft (most validated Stripe fixes) said the API "removes fields this code reads", listed "response fields the API usages recorded in the technical evidence" and described the rename as migrated reads. Under `--full-diff` it could also list removals the code never reads. The overview, breaking changes and key changes now name only removed fields the code reads, removed request fields it sends and retired endpoints it calls, with the endpoints' paths.
- **The card rule needs every client on the target version.** With one literal pin and one `apiVersion: process.env.…` client, the patch bumped the literal and renamed `payment_method_types` on both calls, so the dynamic client could send `allowed_payment_method_types` on dahlia. Any declaration Refit cannot resolve (other than an omitted option, which the stripe-node upgrade moves) now drops the rename and keeps the stop. This narrows the owner-approved rule; it widens nothing.
- **More client shapes traced.** Async factories that load the SDK with `await import('stripe')` (destructured `default`, `.default` or the named export) and static class getters with a static holder (`Payments.get()`, written through the class name or `this`) are traced, with their literal `apiVersion`. Exported classes now count as stable module exports. A Proxy export is traced only when its sole trap is a `get` that returns `client[key]` or `Reflect.get(client, key)` for one traced client (owner decision, 2026-10-20). Widened (owner decision, 2026-10-21, #156): `Reflect.get(client, key, receiver)` with the trap's own receiver, one fill statement before the return (`client ??= make()` or `if (!client) client = make()`), and a one-parameter wrapper such as `lazy(() => new Stripe(key))` whose Proxy forwards to a local filled only with the parameter's result. Other traps, method binding, a foreign receiver or any other body stay untraced. NestJS constructor injection stays untraced and goes to review (owner decision, 2026-10-20). Untraced reads of removed field names now count as unresolved (owner decision, 2026-10-20): the draft is titled `[Needs review]`, lists them as left unchanged, and publishes only with `--publish-unresolved`. Before this change they were left behind in a draft that looked complete.
- **Preparation reasons.** Rerunning preparation on the eight October 16 failures: three Yarn 1 roots ran out of the 2 GiB workspace, three npm lockfiles have peer conflicts that `npm ci` rejects (`ERESOLVE`; written with `--legacy-peer-deps`, no `.npmrc` committed), and two are out of sync with `package.json`. Out-of-space failures now name the workspace and the opt-in `REFIT_VALIDATION_WORKSPACE=4g` profile. When `npm ci` fails with `ERESOLVE`, preparation now retries once with `--legacy-peer-deps` on the same committed lockfile (owner decision, 2026-10-20); `environment.json` records `installation.legacyPeerDeps` and the PR says so. Two of the reproduced repositories then prepared (`zero19124/next-ai-platform`, `utsavkrishnatra/pdf_answers`). If the retry also reports `ERESOLVE`, it is classified as a repository-side failure (`peer-dependency-conflict`) with what to fix, so `--publish-unresolved` can publish the untested patch under the #88 waiver like the other lockfile reasons.
- **Docker-gated tests** for the demo, subscription periods, validation, workspaces, endpoint and request migrations were updated to the current patch and PR template; they had fallen behind because the default suite skips them.

The default suite passed **1,472 tests across 96 files** before merging `main` (78 gated tests skipped), plus typecheck, formatting and build; with `REFIT_DOCKER_IMAGE=node:22-alpine REFIT_NPM_PREPARE=1 REFIT_STRIPE_SDK=1`, 1,522 passed and 28 stayed skipped. After merging `main`, the run that also sets `REFIT_OPENAI_SDK=1 REFIT_OASDIFF=1` passed **1,613** with 4 skipped (external billing repository and package-install gates). All simulated; no live provider or model was called.

## October 20 checkpoint: Shopify REST Admin calls reported with method and path (unreleased, after 0.39.0)

Second item of the Shopify goal in [Provider goals](PROVIDER-GOALS.md#shopify): report REST calls exactly, without migrating them.

- **Each REST Admin call at its line.** REST findings and the new `shopify.restCalls` report field give file, line and column, the HTTP method and the path or resource operation wherever the code states them. Sources are `admin.rest.get({ path })` and calls on `shopify.clients.Rest` or `createAdminRestApiClient` client variables (newly reported call by call). Resource classes count too: `Product.all` is GET and `save` is POST or PUT. So do versioned URLs passed to `fetch` (a literal `method` option, GET without one) or to an HTTP verb call, directly or through a `const`. `refit scan` prints them. REST calls still stop for review, and REST-to-GraphQL migration stays an owner decision.
- **Raw GraphQL requests are no longer REST.** URLs to `/admin/api/<version>/graphql.json` matched the REST pattern. They are Admin GraphQL calls whose documents Refit does not read, so they now stop as unread documents at their line. On the frozen sets this moved 9 apps from "REST" to "unread document"; none of them was or became patchable.
- **Benchmark** (scan level; [details](SHOPIFY-BENCHMARK.md#rest-evidence-october-20)): REST calls 32 → 28 (original 50) and 184 → 152 (fresh 200). 114 of the 180 have both a method and a path or resource operation. Apps stopped on REST went from 8 to 6 and from 39 to 32. A second run matched 50/50 and 200/200.

A random sample of 20 reported calls was right on hand review. The default suite ran 1,593 tests across 107 files with 78 environment-gated tests skipped; 1,513 passed, and the two failures are the known subprocess CLI timeouts (`scan-cli`, `service-configuration`) that fail the same way on `main` in this container. Typecheck, formatting and build passed.

## October 20 checkpoint: Shopify documents through callbacks, closures, re-exports and arrays (unreleased, after 0.39.0)

Work toward the Shopify goal in [Provider goals](PROVIDER-GOALS.md#shopify), first item: read more GraphQL documents.

- **Measured first.** Every Admin call with an unread document in the two frozen Shopify sets (250 apps, 90 calls) was classified by the pattern hiding it. Half are templates interpolating runtime values, which must stop. The largest readable group was helpers reached through callbacks, `const` arrows passed on and closure factories (6 apps, 18 calls), then helpers stored in objects, class and object methods, and constant arrays.
- **Function values are followed.** When a document is a parameter of a function, Refit follows that function to every call: named helpers through named, namespace and re-exported imports (`export { a as b } from`, `export *` when exactly one module provides the name), callbacks passed into repository functions, `const` arrows and closures returned by factories. Constant arrays looped with `for … of` and members of constant objects are read element by element. Imported document constants follow re-exports too.
- **No caller is guessed.** A use of a sending function that Refit cannot follow (stored in an object, passed to a package, reassigned, or in a module loaded with `import()`) now stops for review at that line. Before, callers that were not plain calls were silently skipped. Class and object methods still stop at the call that sends the document. Mocks and spies in test files do not stop the run; documents that tests pass are still checked as fixtures.
- **Benchmark** (scan level, no Docker, no AI; [details](SHOPIFY-BENCHMARK.md#callback-closure-and-array-tracing-october-20)): traced documents 336 → 350 (original 50) and 628 → 644 (fresh 200); unread Admin calls 27 → 22 and 63 → 54. Two outcomes changed: `lpc-product-manager` is now fully read and stops on its SDK, and `glimpse-app` sends `Shop.brand`, a Storefront-only field, to the Admin API, now an already-failing query at its line. A second run matched 50/50 and 200/200. `shopify.dev` was blocked here, so the four schemas came from Shopify's `@shopify/dev-mcp` 1.17.0 package; they reproduced the published outcomes at `c262f8f`, apart from differences explained by later Refit fixes.

The default suite ran 1,564 tests across 105 files with 78 environment-gated tests skipped; 1,484 passed. The two failures are the known subprocess CLI tests (`scan-cli`, `service-configuration`) hitting the 5-second timeout in this container; they pass with a 60-second timeout and fail the same way on `main`. Typecheck, formatting and build passed.

## October 20 checkpoint: review-only Meta Graph API version moves (unreleased, after 0.39.0)

Third review-only step toward a Meta agent (shared work item 4 in [Provider goals](PROVIDER-GOALS.md)). Nothing is applied, and the rule is not wired into `refit run`, validation or drafts. Whether a hand-kept change list is enough evidence for an automatic edit is an open owner decision.

- **`refit meta-graph --propose-version-moves --target <version>`** proposes moving each place a Graph API version is written (a pin), as a patch for review, only when all of these hold:
  - every request through the pin is fully known;
  - every changelog crossed is `reviewed`;
  - no reviewed change touches a request's edge, path, fields (a GET with no `fields` counts as using all of them), metrics or parameters;
  - changing the pin changes nothing else: it is a file-local `const` whose every use the scan follows.

  Everything else stops, listing each reason with its location. Business SDK requests and test-only pins always stop. See [version moves](META-GRAPH.md#propose-version-moves-review-only).

- **Measured on the 33 Meta repositories, target v25.0.** With the committed change list, 0 moves: all 148 pins stop on unread changelogs. In a hypothetical run with every changelog marked reviewed and empty, an upper bound and not evidence about Meta, 100 of the 131 live pins would move. Each of those edits changes one line, and only its version text. The 31 live pins that stop there have helper requests or runtime options (31), a `let` (3) or an exported constant (1); some have more than one.
- **Scanner fix.** A property with the same name as a variable, as `url` in `data.url`, is no longer treated as a use of that variable. The request benchmark's results are unchanged.

The default suite ran 1,587 tests across 100 files, with 78 environment-gated tests skipped; 1,497 passed, including 17 new tests. The other 12 are subprocess CLI tests that time out (11) or race on a temporary file (1, `service-configuration`) in this container, as on `main` here. Typecheck, formatting and build passed.

## October 20 checkpoint: Meta Graph API change list format (unreleased, after 0.39.0)

Second review-only step toward a Meta agent (shared work item 5 in [Provider goals](PROVIDER-GOALS.md)).

- **`data/meta-graph-changes.json`** is a hand-kept list of what each Graph API version removes or changes: endpoints, edges, fields, insights metrics and parameters. Every change needs a developers.facebook.com `source`, a `checkedAt` date, and a version whose changelog page is marked `reviewed`. See [the change list](META-GRAPH.md#the-per-version-change-list).
- **`npm run meta-graph:check`** (`refit meta-graph --check-changes`) rejects the whole file on any error: unknown or missing fields, duplicates, bad or future dates, sources outside Meta's documentation, and changes from unread pages. It also lists unread versions and Meta versions in the deadline registry that have no record.
- **No changes are recorded.** developers.facebook.com could not be reached from this environment: the proxy refused every connection. The file holds 14 `unread` version records, v13.0 to v26.0, each saying so. Search results confirmed the page addresses for v17.0, v19.0, v22.0, v26.0 and the versions index, and were not used as evidence of any change. Nothing reads this list yet.

The default suite ran 1,570 tests across 99 files, with 78 environment-gated tests skipped; 1,479 passed, including 11 new tests. The other 13 are the subprocess CLI tests that hit the 5-second test timeout in this container, as on `main` here. Typecheck, formatting and build passed.

## October 20 checkpoint: Meta Graph API request detection (unreleased, after 0.39.0)

First review-only step toward a Meta agent ([Provider goals](PROVIDER-GOALS.md#meta-graph-api), shared work items 4, 5 and 7). Nothing is edited, and the `meta-graph` catalog entry keeps `adapter: null`.

- **`refit meta-graph`** lists the Graph API requests a repository makes, with `file:line`, method, pinned version and where it is written, path and edge, and the literal `fields` and insights `metric` values. It reads raw `graph.facebook.com` URLs passed to `fetch`, `axios` and project helpers, including base constants imported from other files and URLs kept in a `const`, and `facebook-nodejs-business-sdk` resource-class calls. Anything built at runtime is reported as unknown with the reason: spread or mutated options, `FormData`, helper options, runtime versions and edges, reassigned pagination URLs. See [Meta Graph API](META-GRAPH.md).
- **Business SDK edges.** `data/meta-business-sdk-edges.json` maps the 648 generated method names of facebook-nodejs-business-sdk 24.0.1 to their Graph API edges, built by `scripts/meta-business-sdk-edges.mjs` from the SDK's source text. The SDK was downloaded with `npm pack --ignore-scripts`; nothing was installed or run.
- **Measured on the 33 Meta repositories of the deadline benchmark.** 162 requests in live code, all real, and every reported value matched the code on hand review (one line-break bug in a multi-line URL was found while labelling and fixed first). The version was read for 157, the path for 158, the edge for 116 and `fields` for 113. A request was found at 62 of the 63 labelled live Graph pins; the miss is the browser SDK's `FB.init`. Labels are one reviewer's single pass.

Not done here: a per-version change list from Meta's changelog and a version-move proposal. Meta's documentation host could not be reached from this environment, so no change entries were written.

The default suite ran 1,559 tests across 98 files, with 78 environment-gated tests skipped; 1,471 passed, including 28 new tests. The other 10 are subprocess CLI tests (`first-run`, `pipeline`, `scan-cli`, `service-configuration`, `watch`, `workflow`, `workflow-integrations`) that hit the 5-second test timeout in this container; the same tests fail the same way on `main` here, and they pass with `--testTimeout=120000`. Typecheck, formatting and build passed.

## October 20 checkpoint: Anthropic deadlines and review-only model replacements (unreleased, after 0.39.0)

Work toward the OpenAI and Anthropic goals in [Provider goals](PROVIDER-GOALS.md):

- **Anthropic in the deadline registry.** 12 Claude API retirements, 2024-11-06 to 2026-11-30, each with Anthropic's recommended replacement, from the official [model deprecations page](https://platform.claude.com/docs/en/about-claude/model-deprecations), checked 2026-10-20. Claude model IDs get the same live, catalog, test and check classes as OpenAI models, and mixed-provider model lists count as catalogs. Bedrock and Google Cloud IDs never match, because those platforms set their own dates. Only the `claude-sonnet-4-5` alias is listed; aliases of already retired models are on no current Anthropic page. Anthropic has no catalog agent, so its alerts and CLI results say "no agent yet". See [API deadlines](DEADLINES.md).
- **Adapters.** The OpenAI preview adapter now maps `chat.completions.create` and `embeddings.create` besides `models.retrieve`, with the response schemas and operation IDs of OpenAI's published OpenAPI document (info.version 2.3.0), checked by hand; no `adapter-suggest` budget was spent. `responses.create` is not mapped because its `Response` schema is an `allOf`. A new `examples/anthropic.provider.json` traces `messages` calls. It is not in the agent catalog, because Anthropic publishes no contract that `refit run` could compare.
- **Review-only model replacements.** `refit deadlines --propose-model-fixes` proposes the registry replacement where a retiring OpenAI or Anthropic model is a literal `model` in a traced text-generation call, or the `??`/`||` default there, outside tests. When a replacement retires too, it follows the registry. It stops for review on sampling and length parameters (Anthropic returns a 400 for non-default `temperature`, `top_p` and `top_k` on Claude 4.7 and later), spread options, constants and prose replacements. Nothing is applied, validated or published. Whether Refit may apply such a swap through validation and drafts is an open owner decision.
- **Measured on the deadline benchmark.** Of the 34 frozen OpenAI repositories, 15 send a model retiring on 2026-10-23 from live code. The rule proposed 2 replacements in 1 of them, both correct on hand review, and stopped for review in 1 (spread options). The other 13 hold the model in the openai v3 SDK, `openai-edge`, constants, helper parameters, UI state or configuration. That is the next coverage work. Results: [`benchmarks/2026-10-20-model-replacement-results.json`](benchmarks/2026-10-20-model-replacement-results.json). The OpenAI goal's 100-repository and Anthropic's 50-repository frozen sets are not built: selection needs GitHub code search, which this environment could not reach.

The default suite ran 1,452 tests across 97 files, with 78 environment-gated tests skipped; 1,449 passed. Three subprocess CLI tests (`scan-cli`, `service-configuration`, `watch`) hit the 5-second test timeout in this container. They fail the same way, intermittently, on `main` at `672e425`. Typecheck and formatting passed.

## October 16 checkpoint: stripe-node upgrade for pnpm and Yarn 1, and an active-teams set (unreleased, after 0.39.0)

**Validated Stripe fixes went from 53 to 74 on the same 531 repositories** (fresh 35 → 52, original 11 → 13, held-out 7 → 9), with no owner decision changed. Every new fix comes from making an existing deterministic fix installable:

- **stripe-node upgrade for pnpm v9 and Yarn 1 roots.** Before, only a root npm lockfile was upgraded, so a TypeScript patch in a pnpm or Yarn project moved `apiVersion` while the old types rejected it. The pnpm edit goes through the YAML document model and refuses unless the lockfile round-trips byte for byte; on 32 real pnpm repositories `pnpm install --lockfile-only` left 30 results byte-identical, and the other two differ only through drift already in those repositories. Yarn 1 accepts 12 of 13 upgraded lockfiles with `--frozen-lockfile`; the thirteenth was already stale. Records only the old `stripe` reached are pruned. See [the dependency guide](DEPENDENCIES.md#stripe-node-upgrade-in-a-patch).
- **npm lockfiles in their own formatting.** 12 of 398 benchmark lockfiles use tabs, four spaces or CRLF; they are now rewritten the same way instead of skipping the upgrade.
- **Upgrade refusals instead of broken lockfiles.** stripe-node 23 has an optional `@types/node >=20` peer; a project that locks an older `@types/node` (`liamstamper/lamp-bot`) got a lockfile `npm ci` rejected. Such projects now stop with that reason. A reset registry connection is retried twice.
- **Preparation fixes.** An unpinned pnpm root whose `pnpm-workspace.yaml` holds only settings (which pnpm 9 rejects) installs with pnpm 10.34.7 (`MayorEmpror/CARZ`, now validated). A repository whose committed source exceeds the 50 MiB archive limit gets that reason instead of Node's `maxBuffer` error.
- **The benchmark validates Yarn roots** like npm and pnpm ones (`fecd935`); before, every Yarn repository counted as having no checks.
- **An AI patch may not choose a subscription item.** The rules choose one only from evidence (an item the function already reads, a compared price ID or the operator's price policy). A model edit that adds its own `planItem` selector to the period helper now stops for review. 71 of the 74 fixes are deterministic; the three AI repairs were read in full and add no selector.

All 12 remaining regressions are forks of one Supabase subscription template: stripe-node 23 widens enums such as `Price.Type` with `OtherString`, and `libs/supabaseAdmin.ts` assigns them to narrow database types. Validation caught each one; no rule casts them, because a cast would accept values the database rejects. Four Yarn repositories run out of the 2 GiB preparation workspace because Yarn 1 downloads every platform's optional binaries; the existing `REFIT_VALIDATION_WORKSPACE=4g` operator profile is the remedy.

**A frozen [active-teams set](benchmarks/2026-10-16-stripe-active-repos.json) shows what startups would see.** Its 66 repositories each had at least two human commit authors in the 90 days before 2026-10-16, CI and one root lockfile; the list and its [selection script](../scripts/stripe-active-select.mjs) were committed before any run. 46 of 66 pin a 2025–2026 API version (35% in the fresh set). Only 11 are affected, and none was fixed: 6 send `payment_method_types` values outside the card rule, 2 have unparseable files and 3 are refused at preparation. The larger finding is coverage: in 32 of the 66, Refit found 518 likely Stripe calls and traced none, and at least 18 of those create the client in a lazy factory (`getStripe()` assigning a module-level `let`). Factory clients are the main gap between Refit and active codebases.

The default suite passed **1,386 tests across 93 files**, with 78 environment-gated tests skipped, plus typecheck, formatting and build. Benchmarks ran from pinned worktrees at `7238e46` and `fecd935`; see [the benchmark summary](BENCHMARKS.md#stripe-node-upgrade-for-pnpm-and-yarn-and-the-active-teams-set-october-16).

## October 16 checkpoint: fresh Stripe set complete and team PRs merged (unreleased, after 0.39.0)

The 48 fresh Stripe repositories that Docker had not reached were validated at `6d02116`, the same commit as the other 333. All 381 are now measured: validated fixes went from 5 to 35 on the fresh set, and from 10 to 53 across all 531 Stripe repositories. All 43 card-rule fixes were checked against their diffs. See [the policy results](STRIPE-PAYMENT-METHOD-TYPES.md#results-refit-6d02116-october-16).

Otabek's open PRs were merged on the owner's instruction:

- Stripe labels for all 100 benchmark repositories, with per-repository outcome scoring (#78, with #85);
- basil invoicing review reasons and an invoice price ID helper (#79, with #86);
- bounded AI repair rounds driven by remaining type errors (#80);
- unexpanded response changes no longer blocking, signed off by the owner (#84);
- `[Needs review]` drafts for removed parameters and untested patches (#88);
- pnpm release-age settings (#87, which had missed main).

One interaction was fixed while merging: #80's guard against repairs that drop a removed parameter now subtracts the sites the card rule already renamed, so an AI repair of a card-rule patch is not stopped by mistake. A test covers it.

The default suite passed **1,366 tests across 93 files**, with 78 environment-gated tests skipped, plus typecheck and formatting.

## October 16 checkpoint: unexpanded response changes (unreleased, after 0.38.0)

The owner signed off on this gate change on 2026-10-16. The expansion gate from 0.25.0 now covers every response property change whose oasdiff text names a property path: removals, `any-of` additions, became-nullable, became-optional, `maxLength` unset or increased, and type changes. A change inside an expandable field's expanded object stops blocking `--full-diff` unless the repository expands that field. Any non-literal `expand` mention still keeps every such change blocking. Changes on the expandable field itself, direct fields, unrecognized texts and other change kinds still block. The 0.25.0 sign-off covered removals only, so this extension needs owner sign-off before release.

Production-mode scans of 9 benchmark repositories against `2026-09-30.endive`, scan only, with each repository's generated adapter. Counts are blocking level-2/3 changes in the adapter contract / on the called operations:

| Repository                   | Before version | No expansion gate | Removals only (0.25.0) | All response changes |
| ---------------------------- | -------------- | ----------------- | ---------------------- | -------------------- |
| odota/core                   | 2022-11-15     | 2,441 / 1,303     | 1,998 / 1,064          | 161 / 75             |
| Kanba-co/kanba               | 2023-10-16     | 2,084 / 701       | 1,463 / 494            | 104 / 41             |
| different-ai/embedbase       | 2022-11-15     | 2,696 / 836       | 2,207 / 686            | 184 / 62             |
| get-convex/convex-saas       | 2024-06-20     | 3,148 / 1,077     | 2,301 / 788            | 292 / 107            |
| pretzelai/stripe-no-webhooks | 2023-10-16     | 1,928 / 741       | 1,364 / 526            | 269 / 117            |
| dalemoncayo/express-stripe   | 2024-04-10     | 1,994 / 670       | 1,460 / 492            | 59 / 25              |
| csuermann/virtual-smart-home | 2023-08-16     | 886 / 247         | 662 / 183              | 181 / 51             |
| steven-tey/extrapolate       | 2024-04-10     | 2,255 / 782       | 1,660 / 577            | 115 / 50             |
| benlamiro/ShipGenAI          | 2023-10-16     | 1,805 / 607       | 1,259 / 425            | 56 / 24              |

Confirmed removed-field findings are identical in every repository, and every called operation still has an operation impact, so these runs still stop for review. What remains is direct: became-optional fields, `any-of` additions on the expandable fields themselves, error-response (`default`) changes and request-side changes.

## October 16 checkpoint: live-only deadline evidence (unreleased, after 0.38.0)

## October 16 checkpoint: card-only `payment_method_types` replacement (0.39.0)

Owner decision: Stripe endive's removed `payment_method_types` is replaced automatically only when the value is exactly the literal `['card']` on Checkout Session, PaymentIntent or SetupIntent creation. It becomes `allowed_payment_method_types: ['card']`, kept only when the same patch moves the `apiVersion` literal to the target and, for a TypeScript project, upgrades stripe-node. Every other value stops for review, and the parameter is never dropped. The draft PR asks the reviewer to confirm cards stay enabled, because the new field filters the dynamically eligible methods. See [the policy](STRIPE-PAYMENT-METHOD-TYPES.md).

On the Stripe benchmarks, validated fixes rose from 10 to 45:

- original 100: 4 → 11;
- held-out 50: 1 → 7;
- fresh 381: 2 → 27 on the 333 repositories measured before Docker was shut down. The remaining 48 were scanned without Docker: 18 of the 28 affected get a deterministic patch, 14 through the card rule. Those patches are unvalidated.

All 38 new fixes were checked against their diffs, and three were read in full. 9 patches regressed on other stripe-node 23 type errors and were caught by validation. The rerun found that validation's preflight dropped the rename because it requests no patch. Without a patch request, Refit now checks only the pin, and the patch run enforces the upgrade.

The default suite passed **1,339 tests across 87 files**, with 78 environment-gated tests skipped, plus typecheck and formatting.

## October 16 checkpoint: benchmarks on 781 real repositories (0.38.0)

[Benchmarks](BENCHMARKS.md) now consolidates every set. Two new frozen sets were run end to end at pinned commits, with no vendor API calls:

- **381 fresh Stripe repositories**, from 6,363 code-search hits.
  - 171 affected and 5 validated deterministic fixes, all hand-reviewed: 3 correct, 2 correct-partial.
  - 148 stop on endive's removed `payment_method_types`; across all 531 Stripe repositories that is 193 of 234 affected (82%).
  - A rerun at the final commit matched 381 of 381.
- **200 fresh Shopify apps**, from 3,496 hits.
  - 13 patched, 6 validated, and 23 with queries that fail on every version Shopify serves.
  - A repeat matched 200 of 200.

AI spend for every Stripe run in this release was $0.02 on a fresh $5 ledger.

The benchmarks found bugs, each fixed with a test that fails without the fix:

- **Dotted module names.** Imports like `./shopify.server` and `./stripe.server` (the Remix convention) now resolve; `.server` had been taken as a file extension.
- **Shopify documents.** Refit now reads default-exported documents and documents passed as a named helper's parameter, at every call site. On the original 50 apps, traced Admin documents went from 255 to 336 and unreadable ones from 55 to 27, with no outcome changes. Shopify's own `subscriptions-reference-app` is now fully read.
- **Shopify REST.** Three REST forms were missed, so a REST app's version could be moved. Template URLs with a resource path before a substitution, `createAdminRestApiClient`, and REST resource classes (`shopify.rest.Product`) now stop for review. 3 fresh apps had been wrongly patched; none had validated.
- **npm `{ "packages": [...] }` workspaces.** This form, which Shopify's app template uses, is now prepared. npm reads it the same way as an array, and no other object form is accepted. Two apps now validate, one with 63 tests.
- **UTF-16 source files** with a byte-order mark, such as Supabase types written by PowerShell, are decoded for scanning instead of stopping the repository as binary. Refit refuses to edit them.

Benchmark tooling:

- Both setup scripts and `benchmark:shopify` take `--list <frozen.json>`, and `benchmark:stripe` takes `--offset` to split a list across processes. Three processes ran the 381 repositories in 22 minutes.
- Both benchmarks record seconds per repository; the Stripe benchmark also records validation time and AI cost.
- An oasdiff timeout is no longer reused for every repository on the same API version. Under CPU load it had failed 47 production-mode comparisons that take 2–4 seconds normally. The 30-second limit is unchanged.

`refit deadlines` was run, unlabelled, over both fresh sets:

- 62 of 200 Shopify apps have a live exposure, 29 of them to `2025-10`, which is due today.
- 51 of 381 Stripe apps send an OpenAI model retired on 2026-10-23.

A trial that restricted analysis to files import-connected to SDK usage saved under 30% on a 1,605-file app. It was not kept, because every repository-wide safety check would need re-proving.

The default suite passed **1,330 tests across 86 files**, with 78 environment-gated tests skipped, plus typecheck, formatting and build. No safety gate was relaxed.

## October 16 checkpoint: deadline checks in CI (0.38.0)

`refit deadlines --fail-within <days>` turns the deadline report into a CI check. It exits 2 when a live exposure is past due, due today or within the window, 0 when none is, and 1 on any error. The window is 0–3650 whole days. Without the flag the command only reports, as before. Only live evidence counts, so model lists, tests, examples and comments never fail a build. `docs/DEADLINES.md` has a GitHub Actions example that runs on pull requests and weekly.

Known exposures can be accepted in a committed `.refit-deadlines-ignore.json`. Each entry names a registry deadline and must give a reason and an `until` date at most 365 days away; expired entries stop applying and are reported. Optional `paths` scope an entry to repository-relative directories or files, matched by whole path segments. An exposure is accepted only when every live match is covered, and path-scoped entries never accept a deadline with matches past the 20-item listing limit. Any problem rejects the whole file with exit 1: unknown fields, a missing reason, a bad or distant date, `..` or absolute paths, more than 100 entries, over 64 KiB, or a symbolic link or directory. Accepted exposures stay in the output with their reason, and unknown deadline IDs are flagged as likely typos. `--ignore-file` reads another file and errors if it is missing. `refit serve --deadline-alerts` honors a committed, valid ignore file; an invalid one is logged and accepts nothing, so it never silences an alert.

The default suite passed **1,324 tests across 86 files**, with 78 environment-gated tests skipped, plus typecheck, formatting and build. New tests cover:

- ignore validation, reporting every error at once;
- file safety: symbolic links, directories, size and a missing explicit file;
- coverage rules, including a sibling-folder lookalike, capped matches and the inclusive expiry day;
- the window boundaries and argument parsing;
- an end-to-end CLI run checking exit codes 0, 1 and 2 and the JSON `check` field;
- a service run where a committed ignore suppresses an alert and an invalid one does not.

Deliberately broken versions of the boundary, capped-match, expiry and path-segment rules, and removing the service filter, each fail a test. No provider was contacted.

## October 16 checkpoint: live-only deadline evidence (0.38.0)

`refit deadlines` now classifies every match by how the code uses it: live, catalog, test, comment, tokenizer or check. Catalogs are lists of three or more models, type positions, tables keyed or indexed by model, and `<option>` pickers. Tests and examples are recognized by path. Comparisons and `case` labels count as checks. Only live matches make a repository exposed, appear as evidence and open or update an issue alert. The CLI lists the rest, collapsed per use, plus deadlines named only outside live code. `--json` adds `use`, `nonLive`, `nonLiveMore` and a top-level `mentions` array without removing a field. Catalog, test and comparison rules apply to OpenAI only. Meta and Shopify matching is unchanged, except that comments are now listed as non-live instead of dropped. See [API deadlines](DEADLINES.md#live-and-non-live-evidence).

Re-scored on the merged labels, with the same clones and script ([results](DEADLINE-BENCHMARK.md#live-only-evidence-october-16-2026)):

- **OpenAI line precision:** 14% (19/133) → **83% (19/23)**. All lines: 41% → 91%.
- **Repository recall:** stays **28/28**. OpenAI line recall stays 19/19.
- **Repository precision:** 28/31 → **28/28**.
- **The 2026-10-23 OpenAI flag:** 31 → 20 repositories at 75% precision, with all 15 exposed repositories still flagged.

The 4 remaining OpenAI false lines are an alias map in a file nothing imports, which Refit cannot tell from the live copy without tracing imports. No alert, registry or approval gate was relaxed. Labels are still a single pass.

The default suite passed **1,317 tests across 85 files**, with 78 environment-gated tests skipped, plus typecheck, formatting and build. New tests cover each classification, including lookalikes. Lookalikes that stay live include two-model lists, alias maps, settings objects, an `?? 'gpt-4'` fallback, single-member enums, and paths such as `contest/`, `attestation.ts` and `exampleData.ts`. They also cover the separate non-live cap, mention-only deadlines, alerts from live evidence only, and unchanged Meta and Shopify behavior.

## October 16 checkpoint: deadline exposure benchmark (0.38.0)

[The deadline benchmark](DEADLINE-BENCHMARK.md) scanned 100 active public JS/TS repositories from GitHub code search, balanced across OpenAI, Meta Graph API and Shopify, and hand-labelled 32 of them line by line. 28 of the 32 (88%, 95% CI 72–95%) pin a registry version or model in a live call path, 17 already past due. 15 of 34 OpenAI repositories send a model OpenAI shuts down on 2026-10-23. Refit flags every exposed labelled repository (28/28) at 90% repository precision. Line precision is 100% for Meta, 79% for Shopify and 14% for OpenAI, where model lists, tests and examples dominate. Labels are a single pass and have not been second-labelled.

Matcher fixes from the benchmark: versions in comments no longer count, which the guide already promised (the file is parsed and only source tokens match). Tokenizer and prefix-check arguments are not pins. Shopify Admin URLs that end at the version match. No alert or registry gate changed. Known gaps: Shopify version constants and env-var fallbacks, `FB.init({ version })`, Shopify versions before 2025-04, and catalog entries reported like live calls.

The default suite passed **1,312 tests across 85 files** (after merging 0.37.0), with 78 environment-gated tests skipped, plus typecheck, formatting and build.

## October 16 checkpoint: Shopify as the second provider (0.37.0)

Shopify Admin GraphQL is supported end to end with a built-in agent, and every migration is deterministic. `refit shopify-snapshot` saves a supported Admin API version's schema by introspecting Shopify's public documentation proxy, with no store or credentials, and pins it by SHA-256. Shopify runs take two such snapshots. Refit reads documents passed to `admin.graphql`, `createAdminApiClient().request` and `clients.Graphql().query`: literals, scoped and imported constants, constant fragments, ternaries and `#graphql` literals. It reads pins from the `ApiVersion` enum, `apiVersion` strings, `/admin/api/<version>/` URLs and `LATEST_API_VERSION`, which the locked SDK release fixes. Each document is validated against both schemas. Removed fields, arguments, enum values and types, selected fields that change type, already-failing documents, runtime-built documents, REST calls, and conflicting or dynamic pins stop for review at the exact line. Otherwise the rule moves every pin to the target. An enum pin moves only if the locked `@shopify/shopify-api` release defines the target member. `refit agents` now suggests and scaffolds the Shopify agent. See [Shopify](SHOPIFY.md).

**Benchmark** ([details](SHOPIFY-BENCHMARK.md)): 50 public Shopify apps were frozen before any Shopify code existed. Refit found 320 Admin calls and 443 GraphQL documents. Outcomes:

- 1 app patched and validated, 6 already current for their SDK, 2 with no Admin usage, 2 over the scan limit.
- 39 apps stopped for review: 15 need an SDK upgrade to reach a supported version, 7 use REST, 6 build documents at runtime, 6 have dynamic pins, and 5 contain queries that fail on every version Shopify serves.
- 31 apps pin a version Shopify no longer serves.
- A second run on the same commit matched 50 of 50 outcomes.
- The first run exposed three Refit bugs, fixed with tests: `LATEST_API_VERSION` resolution, documents from other Shopify APIs and test fixtures, and nested SDK locks.
- No AI was used ($0).

**Lab:** `~/Repos/refit-shopify-lab` (`@shopify/shopify-api` 14.0.1, `ApiVersion.January25`, simulated responses only) runs from detection and scaffold to a validated draft-PR-ready change: `ApiVersion.October26`, with `tsc` and tests passing on both versions in offline Docker. A `deliverySettings` query (removed in `2026-10`) stops for review at its line. One early lab test run sent two requests to the nonexistent store `lab.myshopify.com` with a fake token, because the SDK captures `fetch` at import. The tests now replace the SDK's fetch and fail on any unexpected request.

The default suite passed **1,311 tests across 85 files**, with 78 environment-gated tests skipped.

## October 16 checkpoint: API deadline tracking (0.36.0)

`refit deadlines` matches the API versions and models a repository pins against a reviewed registry of provider sunset dates, with `file:line` evidence and no code executed. `data/deadlines.json` holds 47 entries, each checked on 2026-10-15 against its provider page: 7 Shopify Admin API versions, 13 Meta Graph API versions and 27 OpenAI shutdowns covering 67 model IDs. `npm run deadlines:check` validates the registry's shape and flags past-due entries and entries without a source. Unsourced entries are never matched or alerted. Matching reads Graph and Shopify URLs, Shopify's `ApiVersion` enum and pinned `apiVersion` strings (only in files that use Shopify), the `facebook-nodejs-business-sdk` version from manifests and lockfiles, exact quoted OpenAI model IDs, and `apiVersion` pins in `.refit.json`.

`refit serve --deadline-alerts` is off by default. With it on, after each poll the service checks every enrolled repository's managed checkout. It opens one GitHub issue per repository and deadline at the first lead time (90, 30 and 7 days by default, set with `--deadline-lead-days`), then updates the issue and comments at each tighter stage and once the date passes. Stages are deduplicated in `registry.json` across restarts. Operator workflow targets are not alerted. Each alert says whether a configured integration's normal migration run will handle the change, gives `refit agents --add` when Refit ships an agent, or says no agent exists yet. Alerts never change code or start a worker. Issue alerts need the App's Issues write permission through a new token scoped to exactly Contents read and Issues write. Granting that permission on the Refit Agent App is an owner decision. Until it is granted, alerts fail and are recorded in status. See [API deadlines](DEADLINES.md).

The default suite passed **1,304 tests across 84 files**, with 78 environment-gated tests skipped, plus typecheck, formatting and build. New tests cover the registry check, UTC day counting, lead-time stages with a fixed clock, matching and lookalikes, `.refit.json` pins, agent status, and issue rendering and syncing. A signed-webhook service run against a mocked GitHub opens exactly one issue, ignores a same-stage poll, updates and comments at the 7-day stage, does not repeat after a restart, and never alerts an operator-workflow target. An invalid registry is logged and skipped without stopping the service. No live GitHub issue was opened and no provider API was called. On real public repositories, `thematters/matters-server` at `12adb2d` showed three Graph API v18.0 calls (retired 2026-01-26). `embedelite/chat` at `6479fbf` showed `gpt-4-turbo-preview`, `dall-e-3` and `gpt-3.5-turbo`, the last 7 days from shutdown. Outside the new files, this adds the issues token to `github-app.ts`, the two flags to `service-cli.ts` and `data/` to the CLI package.

## October 16 checkpoint: held-out reliability on gpt-5.6-luna (0.35.0)

The 50-repository held-out Stripe set ran end to end four times on `gpt-5.6-luna`: twice before fixes, twice after. Totals with the 100-repository set: **$0.059** of a fresh $5 ledger. Before the fixes, 17 repositories were affected and 4 validated, but all 4 AI-validated results across both runs silently replaced `payment_method_types` with `allowed_payment_method_types`, which the endive contract defines differently. One deterministic "validated" result was a latent break that the old SDK types hid. After the fixes:

- **Removed request parameters stop for review** (#62). Refit compares each mapped operation's request body parameters across contracts and stops when a traced call still sends a removed one. `2026-09-30.endive` removed `payment_method_types` from Checkout Sessions, PaymentIntents and SetupIntents; 48 of the 63 affected repositories across both sets send it.
- **apiVersion pins are verified in Vite and Convex projects** (#61): solution `tsconfig.json` references, generated `api.js`/`dataModel.d.ts`, rooted asset imports, and type annotations are no longer treated as client escapes. This closes the gap noted in the previous checkpoint.
- **Outcomes are stable:** 50/50 held-out repositories had the same outcome in two runs on the same commit, against 48/50 before (the two differences were AI repairs of the parameter error).
- **5 validated drafts were published** to `refit-dev` forks as Refit Agent, 1 held-out and 4 from the original set. All five were hand-reviewed `correct`, with the version pin and package upgraded. All five are deterministic and were validated by `tsc`; generated `stripe-mock` checks found no runnable entry points in their Convex handlers.

The AI price table now covers `gpt-5.6-luna` ($0.20/$0.02/$1.20 per million input/cached/output tokens) and dated snapshots. A response from a differently priced model keeps its reservation charged. Benchmarks run from a pinned worktree, and `scripts/stripe-benchmark-compare.mjs` reports per-repository agreement. See [the held-out run](STRIPE-BENCHMARK.md#held-out-run-on-gpt-56-luna-october-16-2026).

Owner decision: the removed `payment_method_types` keeps stopping for review. Checkout's `allowed_payment_method_types` filters dynamically eligible methods rather than listing them, and the intents have no replacement. The 10-draft review target was set aside; the 5 hand-reviewed drafts are the recorded result.

## October 16 checkpoint: callback clients and unpinned pnpm (0.35.0)

Stripe clients created inside a callback passed to another function, such as a Convex `action({ handler })`, now have their literal `apiVersion` verified, so their pins are bumped and the `stripe` package is upgraded. Before, every binding declared inside such a callback counted as exposed. On thumbnail-critique and both vukrosic repositories, fixes that already passed now also move the pin to `2026-09-30.endive` and `stripe` 14 to 23, still with no new type errors and no AI. Roots with a pnpm lockfile v9 and no `packageManager` field are prepared with pnpm 9.15.9 instead of rejected (17 benchmark and 3 held-out repositories). Solution-style `tsconfig.json` files with `references` still leave shared clients unverified (convex-saas).

## October 15 checkpoint: invoice.subscription helper (0.35.0)

Stripe `invoice.subscription` reads are migrated deterministically through `getInvoiceSubscription()` in the generated helper file, which reads either API version; before this, every such read went to AI. Reads stay for review when the code expands `subscription` or the adapter configures its own move. 11 of the 23 affected benchmark repositories read this field. On `vukrosic/setup-nextjs-convex-clerk-typescript-stripe-shadcn-tailwindcss-react`, AI produced a passing fix in 1 of 4 runs; the rule produced a passing deterministic fix with no AI, published as [a draft PR by refit-agent[bot] on a refit-dev fork](https://github.com/refit-dev/setup-nextjs-convex-clerk-typescript-stripe-shadcn-tailwindcss-react/pull/1). That repository has no tests: the evidence is the TypeScript check, with stripe-mock checks not run. See [Stripe subscription periods](STRIPE-SUBSCRIPTION-PERIODS.md#invoice-subscription-reads).

The default suite passed **1,278 tests across 82 files**, with 78 environment-gated tests skipped.

## October 15 checkpoint: provider detection and agent catalog (0.34.0)

`refit agents` detects provider SDKs from committed manifests, npm, pnpm and yarn lock evidence, and raw API hostnames in source, without running code. It suggests only catalog agents with a shipped adapter: Stripe (built-in) and OpenAI (preview example adapter). Anthropic, Shopify, Meta Graph and Twilio are detected but have no agent yet. `--add <id>` writes a reviewable integration scaffold into `.refit.json`, converting single-workflow files and never duplicating an agent already configured under another adapter ID. Nothing is enrolled or activated. `refit serve` handles `pull_request` webhooks for configured repositories: it compares base and head `package.json` through the GitHub API and comments once per agent per pull request when a new SDK has an agent. See [provider agents](PROVIDER-AGENTS.md).

The default suite passed **1,273 tests across 81 files**, with 78 environment-gated tests skipped. New tests cover detection evidence, scaffolds, refusals, CLI writes, suggestion and deduplication logic, webhook parsing, and a signed end-to-end service delivery producing exactly one comment, all against a mocked GitHub API. No live GitHub comment was posted. On the local Stripe lab and the real `Kanba-co/kanba` clone, detection reported Stripe with locked versions 17.7.0 and 14.25.0.

## October 15 checkpoint: default-profile benchmark confirmation (0.33.1)

The benchmark was re-run with validation on v0.33.0 defaults: no `REFIT_VALIDATION_WORKSPACE` override and no AI. It matches the earlier explicit `2g` run:

| Outcome                                                   | Repositories |
| --------------------------------------------------------- | ------------ |
| Affected                                                  | 23           |
| Pass every check (stop only on other unresolved findings) | 3            |
| Fail their own baseline                                   | 8            |
| Exceed the 1 GiB archive                                  | 3            |
| Lockfile integrity or sync problems                       | 2            |
| No deterministic rule (AI off)                            | 1            |
| Declared-type evidence                                    | 1            |

The archive-limit error no longer suggests a larger profile when the default is already the largest. It points to a custom validation image instead.

## October 15 checkpoint: 2 GiB validation by default (0.33.0)

At the owner's decision, offline validation now defaults to the `2g` profile: a 2 GiB workspace, 3 GiB memory and a 1 GiB dependency archive limit. Network stays disabled, along with the read-only root, dropped capabilities, non-root user, 1 CPU, 128 processes and 120-second check limit. `REFIT_VALIDATION_WORKSPACE=1g` or `512m` selects a smaller profile on constrained hosts. Reports record the workspace and memory used. On the Stripe benchmark, this profile brings 11 more of the 23 affected repositories to their checks; 3 pass every check (see 0.32.0).

The default suite passed **1,266 tests across 79 files**, with 78 environment-gated tests skipped, plus build, typecheck and formatting. Sandbox-argument tests now assert the 2 GiB and 3 GiB default and `--network none`. The local Stripe lab validated end to end with no override, recording a `2g` workspace and `3g` memory, and six generated functions passed against both stripe-mock versions.

## October 15 checkpoint: larger validation profiles and compiled TypeScript checks (0.32.0)

Operators can opt into a larger offline validation profile with `REFIT_VALIDATION_WORKSPACE`: `1g` or `2g`. Each raises the workspace, memory and dependency archive limit together, and network stays disabled. The default is unchanged at 512 MiB and 1 GiB, with a 256 MiB archive. Evidence verification now accepts archives up to the largest profile. Its old 256 MiB cap had rejected every archive the larger profile produced.

Benchmark validation without AI, under the `2g` profile, compared with the default:

- 11 more of the 23 affected repositories reach their checks.
- 3 pass every check: `mrwebwork/spotify`, `Shivamrai15/Safari` and `kpirabaharan/Spotify-Clone`. They stop for review only on other unresolved findings.
- 8 fail their own baseline (typecheck) before any patch.
- 3 still exceed even the 1 GiB archive.

Generated checks now transpile TypeScript with the bundled compiler. The real repositories' type-only imports (`import { Price } from '@/types'`) had failed under Node's type stripping. Their `manageSubscriptionStatusChange` helpers now load, and stop at creating a Supabase client without application environment. They are correctly excluded as not runnable in isolation, and no regressions are reported.

After merging the AI-first work, the default suite passed **1,266 tests across 79 files**, with 78 environment-gated tests skipped; three CLI tests that time out under full-suite load pass when run alone. A new test reproduces the type-only import failure and fails without the compiler hook. The local Stripe lab validates end to end with six generated functions.

## October 15 checkpoint: AI handles what rules don't (0.32.0)

With `--ai-patch`, every confirmed finding no deterministic rule covers goes to the AI patcher, including webhook payload reads. Rules apply first; the model receives the rule-patched code and only the findings left, and the final diff contains both. For webhook payloads and `Stripe.*`-typed values, the model is told that payloads can arrive in older or newer API versions and must read the old field through `Reflect.get` when present, otherwise the new location. Webhook reads it rewrites are marked `ai-version-tolerant` and count as migrated. Without AI, unmigrated webhook reads keep the previous gate.

Before this change, an AI-enabled run could still skip the model entirely: a repository with any helper-migrated webhook read was treated as configured, and webhook-only repositories errored with "AI patching requires at least one confirmed finding", losing their rule edits too. Both are fixed.

The AI patch guard now counts only traced reads, and its fallback rule looks only at lines the model wrote; see [AI patch guard](AI-PATCH-GUARD.md#real-repository-adjustments-october-15). The vendor-note instruction now treats a documented new location as the replacement to use.

On the 100-repository Stripe benchmark with `--ai`, proposals only (validation is still blocked by the sandbox archive limit):

|                                                           | Before | After (final run) |
| --------------------------------------------------------- | ------ | ----------------- |
| Repositories where the model was called                   | 2      | 11                |
| Fixed by rules alone                                      | 11     | 10                |
| Fixed with AI edits                                       | 0      | 4                 |
| Model declined (said the evidence was insufficient)       | 1      | 6                 |
| Errors or guard rejections                                | 8      | 1                 |
| Blocked before AI (skipped files, declared-type mutation) | 2      | 2                 |

The model is non-deterministic: across the three runs after the guard fixes it fixed 3 or 4 of the 11, with different repositories each time. Of four AI patches reviewed by hand, three read the subscription correctly for both old and new payloads. One handled only new-version payloads, because the read was a `Stripe.Invoice`-typed helper parameter; the version-tolerant instruction now covers typed values too. The whole investigation spent $0.38 of AI budget.

The default suite passed **1,265 tests**, with 78 environment-gated tests skipped, plus typecheck and formatting. The oasdiff suite passed 10 of 10, and the Stripe SDK/Docker suites passed 45 of 45. The tuning and held-out AI evaluations were not rerun.

## October 15 checkpoint: subscription period helper (0.32.0)

Subscription-period reads no longer fall back to the widest period across items. Every `current_period_start/end` read on SDK responses, signed webhook payloads and `Stripe.Subscription`-typed values calls one generated helper. It returns the old subscription-level field when present, otherwise the period all items share, otherwise the item the application already selects (a `price.id` comparison or `items.data[N]` in the same function or file) or the configured price policy's item. Without either, mixed periods return `undefined`, and the pull request lists those reads with the instruction to set `stripeSubscriptionPeriods`. The guarded price-policy handler keeps precedence. Patches can now create files: the helper is rendered as a new file and included in publication. The gate is unchanged from the previous checkpoint.

The default suite passed **1,263 tests across 79 files** with 78 environment-gated tests skipped, plus typecheck and formatting. Gated separately: the oasdiff suite passed 10 of 10. The Stripe subscription-period, webhook SDK/Docker and package-upgrade suites passed 45 of 45, with actual stripe-node 17.7.0 and 19.1.0, an old-version signed delivery returning 200 after the patch, and a TypeScript project upgraded to stripe 23.0.0 typechecking with the helper. No live Stripe request or model request was used.

## October 15 checkpoint: TypeScript imports in generated checks (0.31.0)

Generated checks now load TypeScript code the way the scanner resolves it. On the host, Refit maps each source file's static and literal dynamic imports to the repository file its own verified resolver chooses: extensionless paths, `index` files and `tsconfig`/`jsconfig` aliases. A Node resolve hook in the offline sandbox reads that map, with no alias parsing inside the container. Otabek's benchmark validation funnel (#33) is merged: 0 of 23 affected repositories reached their own checks, and 11 are blocked by the 256 MiB archive limit.

The default suite passed **1,256 tests across 79 files**, with 78 environment-gated tests skipped, plus build, typecheck and formatting. A new test runs a TypeScript module through an extensionless `@/lib/client` alias and an extensionless relative import against a Stripe-like client. It fails without the hook. In the local lab, a TypeScript function importing the client through an extensionless `@/client` alias ran in Docker against both stripe-mock versions with the actual `stripe` 17.7.0 SDK, alongside the five JavaScript functions; both runs passed.

## October 15 checkpoint: reproducible benchmark and per-function generated checks (0.30.0)

`scripts/stripe-benchmark-setup.mjs` rebuilds the Stripe benchmark root from the pinned list and labels: clones at recorded commits, plus each version's spec and fixtures from `stripe/openapi`. The rebuilt run reproduces 23 affected repositories. An authorized AI run on `gpt-5.4-mini`, hard-capped at $5 by a fresh ledger, spent $0.038. It produced 6 deterministic patches and 2 AI no-edit decisions. 10 repositories stayed blocked by the repository-wide webhook gate. See [the re-run](STRIPE-BENCHMARK.md#re-run-with-ai-october-15).

Generated checks now record a result per function. A function that fails on the original code is excluded as not runnable in isolation; only functions that ran there must run after the migration. Entry points include functions exported through `export { … }` lists. That finds 5 of the 6 patched benchmark repositories' helpers, but none ran: Next.js dependencies exceed the 256 MiB archive limit, and the helpers need Supabase first.

After merging the webhook and package-upgrade work, the default suite passed **1,255 tests across 79 files**, with 78 environment-gated tests skipped, plus build, typecheck and formatting. New tests cover per-function exclusion, regressions, a harness that cannot start, and export-list entry points.

## October 15 checkpoint: version-tolerant webhook periods (0.30.0)

Without a configured price policy, `current_period_start/end` reads on signed webhook payloads and `Stripe.Subscription`-typed values become version-tolerant: the old subscription-level field when present, otherwise the widest item period, and `undefined` when items carry none. Old-version events behave as before, so the endpoint version can change separately. A configured price-ID policy still takes precedence. Webhook reads no rule migrates no longer block patch generation or validation when other confirmed work exists. They stay unresolved, AI never receives them, and publication still refuses them. Doctor passes migrated webhook reads and still blocks activation on unmigrated ones. This needs Pierce's sign-off on the incoming-version design.

The default suite passed **1,238 tests across 78 files**, with 77 environment-gated tests skipped, plus typecheck and formatting. Gated separately: the oasdiff suite passed 10 of 10 (`REFIT_OASDIFF=1`), and the Stripe subscription-period and webhook SDK/Docker suites passed 27 of 27 with actual stripe-node 17.7.0 and 19.1.0. Old-version signed deliveries return 200 after the patch. Upgrading the `stripe` package in patches is not part of this checkpoint, so TypeScript projects on older types still need it. No live Stripe request or model request was used.

## October 15 checkpoint: generated Stripe checks (0.29.0)

Workflows can opt into `generatedChecks`. Refit then calls the exported functions around confirmed findings, with placeholder IDs, against Stripe's official stripe-mock serving the before and after releases' published contracts and fixtures. stripe-mock runs inside the normal validation container on loopback. A Node preload redirects the Stripe SDK's `api.stripe.com` requests to it, so validation stays at `--network none` with no certificate changes. Both runs must complete for validation to pass. Uncovered usages, hashes and the image ID are recorded, and the PR names the functions called and states that placeholder data checks shapes, not behavior. See [generated checks](GENERATED-CHECKS.md).

The default suite passed **1,235 tests across 78 files**, with 77 environment-gated tests skipped, plus build, typecheck and formatting. New tests cover entry-point selection and uncovered counting, TypeScript handling, configuration parsing, and the redirect against a Stripe-like client: test-key substitution, request path, and failure on a thrown error. That test fails without the `secureConnect` handling.

In the local Stripe lab, with the actual `stripe` 17.7.0 SDK and Stripe's acacia and basil specs and fixtures, five exported functions ran against both stripe-mock versions with no uncovered usages. Both runs passed offline. Fixture values are placeholders and differ by version, so the check catches crashes on new shapes, not wrong values. No live Stripe call or AI was used.

## October 15 checkpoint: larger preparation workspace (0.28.0)

At the owner's request, dependency preparation now gets a 2 GiB writable workspace. tmpfs pages count against container memory, and with only 2 GiB of space the installer was killed at the 1 GiB limit (exit 137). So preparation also gets 3 GiB of memory. Validation keeps its 512 MiB workspace and 1 GiB memory, and the 256 MiB dependency archive limit is unchanged because validation unpacks that archive. Evidence records the preparation workspace and memory.

The default suite passed **1,231 tests across 77 files**, with 77 environment-gated tests skipped, plus build, typecheck and formatting. New assertions check that preparation runs with 2 GiB and 3 GiB and validation with 512 MiB and 1 GiB.

Re-testing the large benchmark repositories with a 900-second deadline:

- `backmesh/backmesh` (Yarn 1) now installs completely, then stops because its archive exceeds 256 MiB.
- `alanagoyal/branded` (npm) also passes the space limit and stops at the archive limit.
- `starwidesolutions/b2b-ecommerce-saaskit-` still fills the 2 GiB workspace, because Yarn 1 keeps both its cache and a copied tree.

All three dependency trees exceed what the unchanged 512 MiB validation workspace could unpack, so they still need a custom image. The change helps mid-size projects whose cache and unpacked tree together exceeded 512 MiB while the result fits.

## October 15 checkpoint: Yarn 2+ preparation (0.27.0)

Pinned Yarn 2–4 root projects on the node-modules linker now use automatic preparation. Lock entries must be exact npm resolutions with checksums, or Yarn's built-in `compat` patches, which ship in the verified bundle. Refit installs `@yarnpkg/cli-dist` through npm, checks a Corepack `+sha512` pin against the bundled `yarn.js` (byte-identical to the file Corepack hashes), and configures Yarn only through environment variables. Repository rc files never reach the installer. See [dependency preparation](DEPENDENCIES.md).

The default suite passed **1,229 tests across 77 files**, with 77 environment-gated tests skipped, plus build, typecheck and formatting. Gated Yarn and pnpm preparation suites passed in Docker. The new Yarn 4.9.2 case installed Stripe 17.7.0 with its install-script tripwire untouched, then ran `yarn run` offline.

The benchmark's Yarn 2+ repository, `naveennaidu/OpenformStack`, is refused twice over. It has no exact Yarn pin, and even with one added to a local copy, its `@esbuild/*` platform packages carry no lock checksum. Accepting those would let Yarn install binaries without integrity verification, so they remain on the custom-image path. No dependencies from that repository were installed.

## October 15 checkpoint: Yarn 1 workspaces and installation deadline (0.26.0)

Yarn 1 workspaces now use automatic preparation: up to 64 positive patterns (a list or `{ packages }`), unique names, sibling dependencies on `*` or an exact version, and verified root `node_modules/<name>` links. `nohoist` and workspace CLI bins still need a custom image. Operators can extend the installer deadline with `REFIT_DEPENDENCY_TIMEOUT_SECONDS` (60–1800); other sandbox limits are unchanged. See [dependency preparation](DEPENDENCIES.md).

The default suite passed **1,227 tests across 77 files**, with 76 environment-gated tests skipped, plus build, typecheck and formatting. All five gated Yarn tests passed in Docker. The new workspace case uses a Yarn 1.22.22 lockfile generated for the existing workspace conformance app. It installs Stripe 19.1.0 at the root and 10.17.0 nested in a workspace, links the sibling workspace, leaves both install-script tripwires untouched, and resolves everything offline.

Re-running the two large benchmark repositories with a 900-second deadline showed the earlier failures were not about time. `backmesh/backmesh` and `starwidesolutions/b2b-ecommerce-saaskit-` both stop with `ENOSPC` on the 512 MiB writable install workspace, where Yarn's download cache and the unpacked packages share space. Raising that limit is a sandbox-security decision and remains open, as for `alanagoyal/branded` under npm.

## October 15 checkpoint: Yarn 1 preparation and unexpanded removals (0.25.0)

`prepareDependencies` now supports Yarn 1 root projects. Every `yarn.lock` entry must resolve an exact version to a public registry tarball with strong integrity, and every root range must be locked. The pinned Yarn 1 manager is installed through npm with integrity evidence, and dependencies install with `--frozen-lockfile --ignore-scripts --no-default-rc`. Only `package.json` and `yarn.lock` enter the networked installer, and checks run offline with `yarn` on PATH. Scans and readiness also record SDK versions from Yarn 1 and Yarn 2+ lockfiles. Yarn workspaces and Yarn 2+ installs still need a custom image. See [dependency preparation](DEPENDENCIES.md).

With owner sign-off, `--full-diff` no longer blocks on removed response properties that lie inside an expandable field's expanded object, unless the repository expands that field. Any non-literal mention of `expand` keeps every such removal blocking. In the basil lab this removes 47 of 54 blocking changes on the called operations; direct removals the code never reads still block.

The default suite passed **1,226 tests across 77 files**, with 75 environment-gated tests skipped, plus build, typecheck and formatting. The gated Yarn test installed a generated Yarn 1 lockfile with actual Stripe 17.7.0 in Docker, left its install-script tripwire untouched, ignored a hostile repository `.yarnrc`, ran `yarn` and the SDK offline, and reused its cache. The gated pnpm/npm preparation suites still pass.

On the Stripe benchmark's five yarn repositories, read without running application code: three Yarn 1 lockfiles and one Yarn 2+ lockfile now record Stripe versions; the fifth repository, with both `package-lock.json` and `yarn.lock` stays unknown. Automatic preparation succeeded for `ahmedaliofficial/latest-nestjs-stripe` (514 locked records). `backmesh/backmesh` and `starwidesolutions/b2b-ecommerce-saaskit-` exceeded the 300-second installation limit, and `naveennaidu/OpenformStack` was correctly refused as Yarn 2+. No checks or migrations were run on these repositories.

## October 15 checkpoint: curated Stripe basil moves (0.24.0)

[`examples/stripe-basil-moves.provider.json`](../examples/stripe-basil-moves.provider.json) maps Stripe's invoice and invoice-item SDK methods and six basil moves: `invoice.subscription`, `invoice.quote`, `invoiceitem.subscription`, `invoiceitem.subscription_item`, `line_item.subscription_item` and `line_item.invoice_item`. Each passes the move checks against Stripe's published acacia and basil documents. Two rules make that possible. An optional, non-nullable field moves with optional chaining and no null fallback, keeping `undefined`. An expandable `string | object` field may move to a location that holds exactly its ID string, and the expansion gate still applies. Moves that change object schemas, formats or required presence stay out. See [moved response fields](PROPERTY-MOVES.md).

After merging the self-maintaining Stripe work below, the default suite passed **1,208 tests across 75 files**, with 74 environment-gated tests skipped, plus build, typecheck and formatting. A test checks the shipped adapter against excerpts of the real Stripe schemas and migrates all six moves, including line items read through `invoice.lines.data`.

The local lab at `~/Repos/refit-stripe-lab` used this adapter with the actual `stripe` 17.7.0 SDK. `refit run` migrated eight usages across invoices, quotes, line items and invoice items. The original passed simulated acacia responses and the migration passed simulated basil responses in offline Docker; the original fails against basil. Evidence is at `~/.refit/evaluations/basil-moves-six-2026-10-15`. The responses were simulated, and no AI or live Stripe call was used. Nullability follows the recorded contract, not observed responses.

## October 15 checkpoint: self-maintaining Stripe detection and field moves (0.24.0)

Read confirmation now follows mutations, not escapes. Traced SDK responses, signed webhook payloads and values with a resolved `Stripe.*` type stay confirmed when they are passed to functions, returned, stored or aliased. Property writes, `delete`, `++`/`--`, mutating array methods, `Object.assign`-style statics, methods called on the binding itself, rebinding a client and method replacement through a re-exported module still downgrade a read. Declared Stripe types now confirm and no longer stop automation unless the value is mutated. This supersedes the 0.17.0 statement that declared types are review hints. Repository-wide alias doubt from imports that may resolve to unscanned declaration files no longer downgrades reads. Request renames, endpoint replacements and the price-ID webhook rule keep the earlier escape analysis for their edits. The repository-wide webhook gate is unchanged.

On the requester's explicit instruction, full-diff gating for Stripe adapters no longer treats response enum additions as breaking ([Stripe enum policy](https://docs.stripe.com/api/versioning#enums)), except on fields the code switches over or checks with `never`. Production mode now completes on real Stripe 2022–2024 → `2026-09-30.endive` contract pairs. It still reports 1,300–3,800 other blocking changes per repository, so unattended worker migration is not yet possible for those upgrades. This changes only the enum part of the open owner decision recorded in 0.23.0, and it needs the owner's sign-off. Reachable required-property removals and other response changes still block.

A deterministic rule moves `subscription.current_period_start/end` reads on SDK responses to their items (earliest start, latest end). It runs only when the target contract defines the item periods and the same patch bumps a literal Stripe `apiVersion`. `invoice.subscription` is left to the 0.23.0 configured nested moves. Neither this rule nor configured renames and moves edit webhook payloads or values known only from their `Stripe.*` type, which may arrive on another version. The `stripe` package is not upgraded, so TypeScript projects on older stripe-node types will not typecheck after the patch. AI patches receive only findings no rule covers and can carry pinned vendor notes through `refit run --documentation-snapshot`.

On the 100-repository Stripe benchmark, confirmed recall on the labelled set rose from 5% to 95%. Six deterministic patches were proposed and none reached a repository's own checks. AI generation was refused by the local budget ledger, so no AI patch was measured. See [the benchmark](STRIPE-BENCHMARK.md#self-maintaining-pipeline-before-and-after) and [open decisions](STRIPE-PLAN.md#open-decisions). The default suite passed **1,205 tests across 75 files**, with 74 environment-gated tests skipped, plus typecheck and formatting. Gated separately: the oasdiff suite passed 7 of 7 (`REFIT_OASDIFF=1`), and the Stripe subscription-period and webhook SDK/Docker suites passed 27 of 27. No live Stripe request was used. Benchmark AI requests were attempted with the configured key but refused by the budget ledger before any model call.

## October 15 checkpoint: configured nested field moves (0.23.0)

An adapter's `propertyRenames` entry can now name a dot-separated replacement path of up to four identifiers. Before scanning, Refit checks that the path is new in the after contract, its intermediates are object references, and the value keeps the removed field's declared shape with compatible nullability. Confirmed direct reads on traced SDK responses get optional chaining where the contract allows a missing parent, plus a `?? null` fallback that keeps the removed nullable field's result. Reads already using the new path are not reported, even when other removals share segment names. Expandable values stay unedited when an `expand` array names the old field or cannot be read statically. Webhook payloads, declared-type values and other review shapes are unchanged. See [moved response fields](PROPERTY-MOVES.md).

The default suite passed **1,195 tests across 74 files**, with 73 environment-gated tests skipped, plus build, typecheck and formatting. New cases cover the move edit and its runtime null behavior, required paths, colliding basil removals, expansion gates, contract rejections and parser limits.

A local lab at `~/Repos/refit-stripe-lab` used the actual `stripe` 17.7.0 SDK with Stripe's published `2025-02-24.acacia` and `2025-04-30.basil` OpenAPI documents. `refit run` prepared npm dependencies, migrated three `invoice.subscription` reads to `invoice.parent.subscription_details.subscription`, and passed the original acacia and migrated basil simulated contracts in offline Docker. The original code fails against the basil shape. Evidence is at `~/.refit/evaluations/property-moves-2026-10-15`; the lab stayed clean. The responses were simulated, not live Stripe calls, and no AI was used.

The lab ran with `fullDiff: false`. On the same real contracts, `--full-diff` reports 1,784 level-2/3 changes reachable from `invoices.retrieve`: 1,560 response enum additions and 216 required-property removals. These still block automation under the current policy. How to treat them for Stripe remains an open owner decision, so that gate is unchanged.

## October 15 checkpoint: pinned pnpm preparation (0.22.0)

`prepareDependencies` now accepts pnpm roots and bounded workspaces with an exact `packageManager` pin and a committed lockfile v9, including pnpm 12's separate environment document. Default/named catalogs and explicit `workspace:` links are verified against their recorded resolutions. Only manifest, lock and workspace-configuration bytes enter the networked installer; lifecycle scripts stay disabled and checks run offline from the verified archive. pnpm importers, package records and peer-qualified snapshots also supply recorded SDK versions to scans and readiness. See [pnpm requirements and limits](PNPM-WORKSPACES.md).

The default suite passed **1,187 tests across 73 files**, with 73 environment-gated tests skipped, plus build, typecheck and formatting. The gated pnpm/npm preparation suites passed 46 tests with actual Docker: pnpm 9.15.4, 10.17.1, 11.28.5 and 12.4.2 each installed Stripe 19.1.0 and 10.17.0 through catalogs and links, then passed original/changed simulated Stripe contracts and TypeScript offline with install-script tripwires untouched. The two billing-repository cases that need a separately supplied checkout were skipped. No paid model request or live vendor API call was used.

Paykit's pinned commit now resolves both Stripe declarations to 19.3.1 from lock evidence, but its workspace CLI bin still blocks automatic preparation. No Paykit dependencies were installed and no Paykit migration is implied. See [Paykit](PAYKIT-EVALUATION.md).

## October 14 checkpoint: SDK arguments in helper functions (0.21.0)

Actual SDK arguments trace into supported named declarations and identifier-bound function/arrow expressions. Closed private helpers with one stable client origin reuse existing response, request and endpoint migration rules. Aliases and helper chains share mutation and API-version evidence. Exported/escaped helpers, unknown callers, multiple origins, argument uncertainty and mutations retain review metadata and stop the entire automated run before paid work, checks or publication. Type annotations alone never establish client identity. See [helper-client support](HELPER-CLIENTS.md).

The guarded Stripe history rule now accepts supported helper parameters and preserves retrieval, complete paginated charge history and empty lists. The fully gated suite passed **1,227 tests across 78 files with no skips**, plus build, typecheck and formatting. Actual Stripe 10.17.0 TypeScript helper code compiles and passes version headers, pagination and empty histories in offline Docker. Actual OpenAI 7.32.0 helper HTTP calls pass a configured invented response rename. Request/endpoint cases and mixed confirmed/review cases preserve the shared automation gate. No paid model request or live vendor API call was used.

The independently installed candidate CLI validated a clean helper application at `c927751e2802`, verified both workflow manifests, and reused a repeated worker poll without checks. Retained evidence is at `~/.refit/evaluations/helper-clients-2026-10-14`; the application stays clean and unmigrated. Paykit's same pinned commit improves from **0/53 to 41/53 likely Stripe calls traced**, all new calls review-only. No Paykit dependencies or source code were executed. This is visibility evidence, not migration correctness or general provider support. See [Paykit's remaining gaps](PAYKIT-EVALUATION.md). pnpm preparation is the next requested slice.

## October 14 checkpoint: repository first run (0.20.0)

From a configured repository root, `refit doctor` inspects setup and `refit run` attempts the workflow without repeating configuration, repository and output paths. `--repository` selects another root; explicitly selected `.refit.json` files derive their repository from that directory. External operator profiles still require a repository selection. Manual specification flags do not silently merge a root profile. Collections still require an integration selector. Implicit root profiles cannot redirect the run to another repository, and AI/publication remain explicit opt-ins.

An omitted output creates a UUID-named private directory under the operating system's temporary directory, through the existing outside-repository and exclusive-creation checks. Both terminal and JSON results identify that path. The OS may later remove temporary evidence; explicit `--output` remains available for retention. Missing profiles explain setup rather than inventing contracts, mappings, versions or check commands. See [first-run setup](REPOSITORY-SETUP.md).

The fully gated suite passed **1,193 tests across 77 files with no skips**, plus build, typecheck and formatting. New CLI cases cover no-argument execution, distinct private evidence, an outside caller and explicit profile, integration selection, existing output refusal, missing configuration, repository redirection and an OS temp directory placed inside the application. Existing configuration, migration, App and package tests remain gated.

The separately installed candidate CLI ran literal no-argument `refit run` commands in actual terminal sessions for the class-based Stripe application and an unmodified committed copy of the approved billing demo. Both doctors permitted validation. Both workflows generated the deterministic history patch, passed original/changed HTTP contracts and TypeScript in offline Docker, and left source clean. The copied billing source derives from approved GitHub revision `cfa192fd2bab995da81bf7f95ea97e0b0ea5f676`, retained locally at `ec90200`; the original checkout was not advanced or edited. Evidence copies and the separate unmigrated application are at `~/.refit/evaluations/first-run-2026-10-14`. Both evidence manifests pass integrity verification.

The README remains short at 363 words. Its release badge no longer depends on unauthenticated access to this private GitHub repository. Verified milestones are published as annotated Git tags and early-access GitHub Releases, with installable archives and SHA-256 checksums. These are not npm registry publications or a hosted launch. No paid AI request, live Stripe request or new migration PR was used for this slice. The broader agent goal remains active; an independent pilot repository is the next requested input.

## October 14 checkpoint: class-held clients and readable scans (0.19.0)

Supported instance fields now establish SDK origins through direct initializers or constructor assignments, including TypeScript private fields, JavaScript `#private` fields, immutable known shared clients and lexical arrow methods. Constructor version declarations enter the existing source gate. Mutation, aliases, receiver escapes, early use, conditional initialization, inheritance, decorators and known outside-instance writes prevent confirmation. Affected unstable class responses stop the entire run before AI, migration validation or publication, even alongside a confirmed finding. Unmapped SDK methods cannot gain confirmation from a declared response type. See [class-client boundaries](CLASS-CLIENTS.md).

The guarded PaymentIntent history rule also migrates narrow async class methods and arrow methods. It retains retrieval, uses the same class field's paginated Charges iterator, preserves empty histories and leaves SDK/version settings unchanged. The fully gated suite passed **1,187 tests across 76 files with no skips**, including actual Stripe 10.17.0/19.1.0 class clients, TypeScript compilation, version headers, pagination/empty histories and a generic actual OpenAI 7.32.0 client under an invented field rename in offline Docker. Build, typecheck and formatting passed. No paid model request was used.

The same 45 pinned public repository commits were verified clean and read without installing dependencies or executing applications. Call tracing improves from 110/354 to 249/354; OpenAI 38→172, Anthropic 27→32 and Stripe unchanged at 45/106. One repository accounts for 103 newly traced calls. Zero-traced repositories among the 41 with candidates decrease from 18 to 15. These are structural calls, including review-only clients, not migration correctness, precision/recall or PR acceptance. See [the measured comparison](benchmarks/2026-10-14-class-client-coverage.md).

Retained installed CLI evidence is at `~/.refit/evaluations/class-clients-2026-10-14`. Its separate clean unmigrated application is at `e1984e8`. A worker observed a committed historical contract projection, found two class-held history reads, validated one deterministic patch against both HTTP contracts and TypeScript in offline Docker, then reused its next poll. Evidence integrity passed. This uses simulated Stripe responses and a loopback dummy key, not live Stripe or AI.

A fresh installed App service fetched the approved independent billing demo, validated its existing history migration and reused the next poll. Evidence integrity passed at `~/.refit/evaluations/stripe-service-0.19-2026-10-14`. App access and Git transport were live; billing responses were simulated. Neither application working copy changed, and no new PR was requested.

`scan` and `replay` now share the workflow's readable report rows, default to JSON when redirected and retain complete JSON through `--output`. Their summary explicitly says that checks have not run. The product README is reduced from 5,652 to 328 words, with detailed boundaries in the docs. The installable archive now carries the same short README, MIT license and complete guides. The broader agent goal remains active; easier repository setup is the next selected slice.

## October 14 checkpoint: price-selected subscription webhook migration (0.18.0)

An operator-approved `stripeSubscriptionPeriods` adapter policy selects a price ID and the supported Acacia/Basil incoming versions. A narrow, immutable signed-event handler receives one atomic deterministic patch. The patch checks each signed Event's `api_version`, preserves historical subscription periods and the original missing-period error, and selects new periods from exactly one matching item. Missing/duplicate identities, incomplete lists, malformed periods and other versions fail through that error. No extra API call, SDK upgrade or webhook endpoint change is made. Unsupported source shapes retain the webhook review gate. Direct webhook AI assessment/generation and configured-policy AI repair remain blocked. See [policy setup and boundaries](STRIPE-SUBSCRIPTION-PERIODS.md).

The fully gated suite passed **1,150 tests across 73 files with no skips**. The new cases exercise actual Stripe SDKs 17.7.0 and 19.1.0 through signed loopback HTTP, historical event replay, reordered items, changed period values, 14 invalid policy payloads and signature rejection. A historical TypeScript application compiles before and after the patch. Complete offline Docker workflows cover successful and failed checks, zero AI repairs despite supplied AI flags, worker processing and receipt reuse. Build, typecheck and formatting passed. The original webhook fixture now declares scalar metadata and price identity; its confirmed reads still stop without a configured policy.

Real Stripe `openapi/spec3.json` releases **v1505** and **v1642**, mapped from stripe-node 17.7.0 and 18.0.0 `OPENAPI_VERSION`, were downloaded and verified as **2025-02-24.acacia** and **2025-03-31.basil**. Inline item-list support was added after inspecting those real contracts. Their 51 direct property removals yield four confirmed subscription-period reads in the retained application, one proposed edit and zero remaining detected findings. This does not mean all 51 migrations are supported or that the supplied simulated payloads implement every field in the full vendor schema.

Retained specifications, the separate clean unmigrated application at `dea4b7d368eb`, installed CLI evidence and worker state are under `~/.refit/evaluations/stripe-period-policy-2026-10-14`. The installed workflow validated the patch in offline Docker with AI flags supplied but no model request. Doctor accepted the configured handler for validation. No PR was requested. Human CLI/PR summaries now lead with affected fields while preserving every contract change in machine evidence.

A fresh installed GitHub App service fetched the independently approved billing demo at `cfa192fd2bab`, validated its existing deterministic payment-history migration and reused the next poll. Its state is `~/.refit/evaluations/stripe-service-0.18-2026-10-14`. App authentication and Git transport were live; Stripe events/responses were simulated. Both demo working copies remained unchanged. No paid AI request or new PR was used. Broader source shapes, additional incoming versions and live Stripe delivery verification remain outside this slice; the broader agent goal remains active.

## October 14 checkpoint: integrated Stripe maintenance safeguards (0.17.0)

The snapshot-webhook slice and incoming Stripe maintenance work now share one analyzer. The built-in adapter adds called Stripe methods whose contracts return a single component reference. Union responses stay under review; an operation overflow is refused rather than silently truncated. Explicit `Stripe.*` annotations, assertions, arrays and helper returns provide review hints, not runtime provenance. Signed webhook tracing takes precedence over those hints. Skipped unparseable source files stop automation because their API usage and mutations are unknown. The same provenance guard protects normal scan/workflow, validation, AI assessment/generation and publication paths. Installed packages now include the Stripe metadata needed by type-hint scanning.

The fully gated suite passed **1,126 tests across 72 files with no skips**, alongside build, typecheck and formatting. Historical benchmark tooling and labels from the maintenance branch are preserved. Its earlier scores do not describe this integrated analyzer; declared-type confirmation has deliberately been downgraded. Full-diff coverage now explicitly identifies adapter-selected operations and reachable components, rather than claiming comparison of the entire vendor contract. This integration used no paid AI and created no PR.

Webhook migration remains blocked in this release. The next rule uses the user's selected price-ID policy and must check signed incoming event versions, preserve old-event replay, and reject missing, duplicate or incomplete item lists before automation is enabled.

## October 14 checkpoint: Stripe snapshot webhook detection (0.16.0)

Refit traces supported Stripe signature constructors, event/data/object aliases, static nested destructuring and exact event-type branches into payload field evidence. Curated event mappings establish the source schema; ordinary component/list tracing retains incoming-event provenance through supported nested reads. Missing components do not turn Checkout Session fields into Invoice matches. Mutations, incomplete narrowing and unsupported projections remain under review. Outgoing client versions never establish incoming webhook versions. Affected webhook findings stop deterministic/AI patches, advisory AI assessment, Docker migration validation and PR publication. Doctor requires incoming-version and explicit item-policy review and distinguishes local signature helpers from API operation mappings. CLI summaries show webhook event types, review counts and source files. See [webhook boundaries and replay](STRIPE-WEBHOOKS.md).

The fully gated suite passed **1,111 tests across 68 files with no skips**. Actual Stripe SDKs 17.7.0 and 19.1.0 receive locally signed HTTP events reproducing the documented Acacia-to-Basil subscription period removal. Original events succeed, changed events fail with the application's missing-period error, old events replay successfully, and wrong/tampered/stale signatures are rejected. An unrelated event remains ignored; awaited async verification also works. Locked preparation and offline Docker exercise the same delivery harness. Guards verify zero model/GitHub requests and no migration checks for reviewed webhook findings, including direct advisory/patch/publication entry points. Build, typecheck, formatting and separately installed CLI checks passed.

Retained evidence is at `~/.refit/evaluations/stripe-webhooks-2026-10-14`. The separate application remains clean and unmigrated at `f414bca1f31b`. Its installed CLI run reports four webhook period accesses plus three conservative harness findings, even with AI/assessment/publication flags supplied, and stops at scan with no patch or PR. A fresh local worker observes the simulated contract removal and reuses the review receipt on its next poll. Evidence integrity verification passes. These are reviewed contract projections and simulated incoming events, not live Stripe deliveries. No paid AI request was used.

A fresh installed App service fetched the approved independent billing demo at `cfa192fd2bab995da81bf7f95ea97e0b0ea5f676`. Its deterministic history migration passed 14 baseline tests, both 14-test patched contracts and TypeScript in offline Docker; the next poll reused that result. The separate state is `~/.refit/evaluations/stripe-service-0.16-final-2026-10-14`. App authorization/Git transport were live, Stripe responses were simulated, and publication was not requested. Both original demo working copies remain clean.

The [15-repository historical webhook field scan](benchmarks/2026-10-14-stripe-webhook-coverage.md) found zero traced subscription-period or Invoice.subscription webhook reads, with one parse refusal. It exposed and removed three same-name Checkout Session review matches from an incomplete Invoice projection. This does not establish migration coverage, recall or precision on public repositories. No public application code was executed or installed.

Subscription-item selection and independent incoming-version proof are not implemented as automatic migration policies in this release. The user's explicit-policy requirement is enforced by refusing that automation; no first-item guess is made. Thin events, cross-function payload flows, arbitrary factories and unsupported module/configuration forms remain gaps. The broader agent goal remains active.

## October 14 checkpoint: configured source aliases (0.15.0)

Refit resolves supported `paths` and `baseUrl` from the nearest standard TypeScript/JavaScript configuration, including local inherited inputs, using its installed TypeScript parser. One resolver serves shared ESM/CommonJS clients, supported wrappers, mutation evidence, API-version declarations and imported AI context. The reader captures bounded regular configuration files; their contents enter scan identity while reports expose path/hash/byte evidence. Mapped SDK-package lookalikes are refused. Ambiguous source/output targets, skipped paths and unresolved project configuration stay under review, with an explicit doctor blocker and no paid imported-context request. See [source aliases and runtime boundaries](SOURCE-ALIASES.md).

The fully gated suite passed **1,045 tests across 66 files with no skips**. The new runtime case validates a billing workspace with matching native Node `#billing/*` and TypeScript mappings, actual Stripe SDKs 10.17.0/19.1.0, paginated/empty history, exact API-version headers, linked local source and TypeScript in offline Docker. Controlled generic tests cover a nested OpenAI resource with an invented rename. Mutation, inherited origin, ordered fallbacks, `${configDir}`, local package lookalikes, skipped sources, cycles and unknown project scopes have explicit checks. Build, typecheck, formatting and a separately installed package passed.

A rerun on the same 45 pinned public repository commits reproduced the 0.14 baseline **82/352 traced calls** and measured **108/352 after aliases**. The slice adds 34 Stripe calls across nine repositories while declining eight previously traced calls in two unresolved project-reference configurations. Zero-traced repositories among the 40 with likely calls decreased from 22 to 18. Those repositories were only read, never installed or executed. These numbers measure tracing, not migration success, ground-truth recall/precision or the 100-repository Stripe upgrade benchmark. Class fields, factories, webhook payloads and project references remain substantial gaps. See [the measured comparison](SDK-COVERAGE.md).

Retained installed CLI and worker evidence is at `~/.refit/evaluations/source-aliases-2026-10-14`. The worker observed a committed historical contract removal in an aliased workspace, confirmed two reads, validated a deterministic patch and reused its next poll. The application remained clean and unmigrated. A fresh installed GitHub App service fetched the approved billing demo at `cfa192fd2bab995da81bf7f95ea97e0b0ea5f676`, passed 14 baseline and both 14-test patched contracts plus TypeScript, and reused its second poll. Its separate state is `~/.refit/evaluations/stripe-service-0.15-2026-10-14`. Both evidence bundles passed integrity verification. App authorization/Git transport were live; Stripe responses were simulated. No paid AI request or new PR was used.

The feature was committed and pushed on `codex/configured-source-aliases`, merged into main, and installed globally as 0.15.0 without npm registry publication or co-author trailers. Project references, package/outside extends and bundler-specific resolution remain unsupported. Static alias resolution does not independently prove runtime mapping; application checks must exercise it.

## October 14 checkpoint: npm workspace preparation (0.14.0)

Refit prepares supported npm workspace repositories from committed root/workspace manifests and the root lockfile. Positive relative glob arrays select at most 64 named packages. Importer requirements, names, versions and workspace link targets are checked before installation. The networked Docker input remains manifest-only with lifecycle scripts disabled; actual links and root/nested dependency directories are checked before archiving. Workspace source comes from the separate committed application snapshot during offline validation. Cache identity includes workspace manifest hashes, and recipe 3 separates older environments. The existing prepare/run/watch/doctor/enrollment/service paths reuse this implementation. See [workspace setup and boundaries](NPM-WORKSPACES.md).

The fully gated suite passed **1,000 tests across 64 files with no skips**. A synthetic TypeScript monorepo uses actual Stripe 19.1.0 at the root, 10.17.0 in billing and a linked local ID package. Tests demonstrate the original after-contract history failure, then validate the deterministic patch with multi-page and empty history, exact version headers, both installed versions and TypeScript in offline Docker. They also verify manifest-only workspace staging, lifecycle-script suppression, archive contents, nested dependency roots, exact links, stale graph refusal and workspace-only cache invalidation. The canonical Stripe simulator is shared, not duplicated. Build, typecheck and formatting passed.

Retained CLI evidence at `~/.refit/evaluations/npm-workspaces-2026-10-14` observes a committed simulated historical contract change, finds two history reads, validates the workspace patch, verifies evidence and reuses the next poll. From outside the checkout, the installed 0.14.0 prepare command reports two committed workspace manifests and reuses the verified environment; a fresh installed run passes both before/after contracts and TypeScript. The application stays clean and unmigrated.

A fresh installed GitHub App service also fetched the approved independent billing demo at `cfa192fd2bab995da81bf7f95ea97e0b0ea5f676`. Recipe 3 prepared its ordinary root dependencies, and 14 baseline tests, both 14-test patched contracts and TypeScript passed in offline Docker. Evidence integrity passed. Its state is `~/.refit/evaluations/stripe-service-0.14-2026-10-14`. App access/Git transport were live; billing responses were simulated. This slice used no paid AI calls and created no new PR. Negative patterns, object/nested workspace declarations, workspace bins, non-registry dependency protocols and other package-manager locks remain outside automatic npm preparation.

## October 14 checkpoint: CommonJS and default-exported SDK clients (0.13.0)

Refit traces immutable shared clients through direct relative named/default ESM imports and supported static CommonJS requires/exports. The built-in Stripe adapter recognizes documented callable initialization; other adapters must explicitly enable `constructorCalls`. A shared module graph drives SDK call evidence, mutations, constructor/request API-version checks, imported read-only AI context and the bounded guarded-history import. Dynamic exports, namespace imports, re-exports, mixed local module interop, ambiguous resolution and shadowed/exposed loaders remain review cases. See [client module forms](CLIENT-MODULES.md).

After integrating concurrent AI guards, PR explanations, SDK coverage benchmarking and CI work, the fully gated suite passed **880 tests across 62 files with no skips**. The module slice alone had passed 740 tests across 60 files. Actual Stripe SDKs 10.17.0 and 19.1.0 demonstrate the original guarded-history failure and pass default-export/CommonJS factory migrations in offline Docker with locked npm preparation, multi-page history, empty history and declared version headers. Actual OpenAI SDK 7.32.0 tests cover default/CommonJS clients for a simulated response rename and a nested request-field rename, preserving exact request values, headers and propagated errors. Those OpenAI changes are invented conformance cases, not announced migrations or live model requests. Production build, typecheck and formatting passed.

Retained CLI evidence at `~/.refit/evaluations/commonjs-clients-2026-10-14` records an initially unchanged contract without claiming no impact, observes a committed historical removal, finds two confirmed CommonJS history reads, generates the deterministic patch, validates both Docker contracts, verifies artifact integrity and reuses the next poll. From outside the checkout, the installed 0.13.0 CLI performed a fresh validated run with readable output at `installed-run`. The application stays clean and unmigrated.

A fresh real GitHub App evaluation fetched the approved billing demo at `cfa192fd2bab995da81bf7f95ea97e0b0ea5f676`, passed 14 baseline tests, both 14-test patched contracts and TypeScript in offline Docker, and verified its evidence. Its state is `~/.refit/evaluations/stripe-service-0.13-2026-10-14`; repeating the installed service command confirms access and reuses the successful result without checks. App access and Git transport were live, billing responses were simulated, and no model request, AI spending or new PR was used.

## October 14, 2026: configured request-field migrations

Refit 0.12 adds `requestPropertyRenames` across provider adapters. Rules identify a mapped SDK operation, its body argument index and explicit removed/replacement field names. The shared contract comparator resolves local references and verifies the complete recorded operation after normalizing only those names and required-property entries. Other constraint, response, parameter, server and security changes stop the migration. The AST path preserves body values, shorthand variables and other arguments, while spreads, computed/duplicate properties, aliases, optional calls and unsafe clients remain review-only. The same workflow, readiness, monitoring and publisher gates consume the request evidence. These explicit rules never use AI generation or repair; human review of SDK serialization, type compatibility, API rollout and business meaning remains necessary. See [request migrations](REQUEST-MIGRATIONS.md).

The fully gated suite passed **673 tests across 59 files with no skips**. Tests cover full-contract mismatch, local request references/aliases, multiple field rules, argument positions, source forms, nested resources, imported clients, mutation/escape and duplicate/collision guards. The simulated catalog application demonstrates the original after-contract failure, then passes exact HTTP body values, request IDs, a preserved version header and propagated 503 under a deterministic patch in offline Docker. Mixed direct/dynamic requests stop before validation or model work. Failing patched checks retain evidence without AI repair. Controlled GitHub responses verify readable request PRs and independently refuse unsupported request evidence or unrelated breaking changes.

An actual OpenAI 7.32.0 SDK evaluation simulates an invented **request** `model` → `model_id` rename on `chat.completions.create`. The original request fails against that forced after contract; Refit's patch passes both SDK HTTP contracts, exact body/header assertions and propagated 400 in offline Docker with locked npm preparation. This is not a historical/announced OpenAI migration, live generation or TypeScript SDK type upgrade. Only npm dependency preparation uses registry access; SDK requests reach a loopback simulator with an explicit dummy key. The canonical existing OpenAI client fixture is reused.

Retained CLI evidence at `~/.refit/evaluations/request-fields-2026-10-14` starts with an unchanged source, observes a committed simulated request change, validates the patch under source-verified policy, checks evidence integrity and reuses the next poll. The original app remains clean and unmigrated. A fresh real GitHub App evaluation also fetched the approved billing demo at `cfa192fd2bab995da81bf7f95ea97e0b0ea5f676` and passed 14 baseline tests, both 14-test patched contracts and TypeScript in offline Docker. Its state is `~/.refit/evaluations/stripe-service-0.12-2026-10-14`; App access/Git transport were live, billing responses were simulated, and evidence integrity passed. No model request, AI spending or new PR was used. Production build, typecheck and formatting passed.

The feature was developed and pushed on `codex/request-field-migrations`, then merged to main with conventional commits and no co-author trailers. The 0.12.0 archive was installed globally. From outside the source checkout, its `run` command generated and validated a fresh request-field patch, displayed the readable request mapping, and retained artifacts at `request-fields-2026-10-14/installed-run`. Its real App service confirmed access and reused the successful Stripe receipt without rerunning checks. The package includes the request guide and shared contract/request runtime helpers; no npm registry publication occurred.

## October 14, 2026: multiple APIs per repository

Refit 0.11 supports up to eight named integrations in one checked-in `.refit.json`. Manual `run`, `watch` and `doctor` commands select one with `--integration`; enrollment reviews and approves the entire collection, baselines and adapters together. App service targets expand into independent workers such as `billing.stripe` and `billing.openai`, with scoped input caches, job receipts, evidence and retries. Separate PR identities and branch hashes prevent one named integration from reusing a sibling draft, including profiles for the same provider. Legacy single profiles preserve their existing identity and commands. See [multiple integration configuration and limits](MULTIPLE-INTEGRATIONS.md).

The fully gated suite passed **621 tests across 56 files with no skips**. Native Git and controlled GitHub access tests run actual Stripe 10.17.0 and OpenAI 7.32.0 HTTP clients against a loopback simulator, prepare locked npm dependencies and validate each migration in real offline Docker. Both baseline and patched commands exercise peer integration behavior. Tests also cover named retries without altering sibling failed receipts, group approval changes, malformed sibling sources, conflicting sibling versions, expanded worker limits, App access revocation across the group, separate draft publication/discovery with controlled GitHub responses, and an independently installed package's selector and hidden configuration fixture.

Retained local CLI evidence at `~/.refit/evaluations/multiple-integrations-2026-10-14` starts with unchanged contracts, observes committed simulated changes to both APIs, validates separate patches to `src/history.ts` and `src/model.js`, verifies both evidence bundles and reuses both results on repeat polls. The original application stays clean and unmigrated. Stripe simulates its historical `PaymentIntent.charges` removal; OpenAI's `ChatCompletion.model` → `model_id` rename is invented for conformance testing, not an announced vendor change or live migration. The fixture checks two-charge history, empty history, retrieval failures, completion reads and failed requests. Combined-upgrade correctness still needs review and its own application checks.

A fresh real GitHub App evaluation fetched the approved billing demo at `cfa192fd2bab995da81bf7f95ea97e0b0ea5f676`, passed 14 baseline tests, both 14-test patched contracts and TypeScript in offline Docker, and verified evidence integrity. Its state is `~/.refit/evaluations/stripe-service-0.11-2026-10-14`; repeating that command reuses the successful receipt. App authorization and Git transport were live; billing responses remained simulated. No model request, AI spending or new PR was used. Production build, typecheck and formatting passed.

The feature was developed and pushed on `codex/multiple-api-integrations`, then merged into main with conventional commits and no co-author trailers. The 0.11.0 archive was installed globally. From outside the source checkout, its enrollment command reviewed both integrations, both named watch commands reused their validated receipts, and its real App service confirmed access and reused the billing result without rerunning checks. The package includes the multi-integration guide and the fixture's hidden `.refit.json`; no npm registry publication occurred.

## October 14, 2026: declared SDK API versions

Refit 0.10 records SDK constructor version options and per-request overrides through provider-declared argument indexes and property paths. The built-in Stripe mapping checks both configuration mechanisms. The resolver uses the existing AST program and symbol/import identities, reads supported immutable strings and objects, and preserves unknown evidence for dynamic or unsafe declarations. Known conflicts stop workflows before paid or executable work. The compatibility default remains `operator-pin`; `source-verified` additionally requires matching supported declarations. The policy works in manual CLI commands, checked-in profiles, readiness, enrollment, local workers, App-managed service loading and draft publication. Candidate validation rejects conflicting versions and weakened source proof. See [API-version policies and limits](API-VERSIONS.md).

The fully gated suite passed **593 tests across 55 files with no skips**. Actual Stripe SDKs 10.17.0 and 19.1.0 sent the declared client header and honored a conflicting per-request override over loopback HTTP. A generic mapped SDK migration passed real `oasdiff` and offline Docker under strict policy, including version-header assertions, success, request options and error propagation. Controlled AI proposals that changed or weakened a verified declaration were rejected before patched execution. Tests also cover changed application versions under an unchanged configuration approval, strict CLI overrides, missing adapter metadata and publication gates. PR identity excludes version-only adapter metadata so those additions do not duplicate otherwise identical migrations; application revision and migration mappings still distinguish drafts.

The retained evaluation at `~/.refit/evaluations/declared-api-versions-2026-10-14` starts with an unchanged source, observes a committed simulated endpoint retirement, validates a strict deterministic migration and reuses the result on the next poll. A fresh real GitHub App run fetched the approved billing demo and passed 14 baseline tests, both 14-test patched contracts and TypeScript with verified cached dependencies in offline Docker. The independent billing app's runtime-selected version stays unverified under its approved operator pin; a separate strict scan records unknown applicability. Evidence integrity passed, the original applications remain clean and unmigrated, and no model request or new PR was used. A read-only PR preflight correctly refused the older local billing checkout after GitHub main advanced; the automation guide now uses the current App-managed validation.

Production build, typecheck and formatting passed. The merged 0.10.0 archive was installed globally, including the version guide. From outside the source checkout, its strict enrollment review verified the supported declarations, the local worker reused validated evidence, and the real App service confirmed access and reused its successful result without rerunning checks. The independently installed packaging tests were rerun after adding the guide and passed.

## October 13, 2026: nested SDK resources across providers

Refit 0.9 accepts dot-separated identifier resource paths up to 256 characters in adapter operations and endpoint replacements. A shared AST path resolver handles observed SDK inventory, mapped responses, removed-operation callers, and replacement edit ranges. Imported shared clients, supported wrappers and response aliases retain their existing tracing. Mutating or exposing any nested resource downgrades its client flows; optional invocations and computed resource access remain review-only. Unawaited SDK calls are no longer treated as response objects. Configured endpoint edits can increase or decrease resource depth while preserving arguments.

The fully gated suite passed **544 tests across 53 files with no skips**. Production build, typecheck and formatting passed. Coverage includes nested client mutations and escapes, optional-call aliases, unaffected SDK metadata, invalid resource paths, generic removed-operation review gates, nested response renames, resource-depth replacements, and actual before/after HTTP checks. A nested catalog endpoint replacement passes real `oasdiff` and offline Docker validation with no AI request. The independently installed CLI test remains enabled.

The actual OpenAI Node SDK 7.32.0 also makes a non-streaming `chat.completions.create` request through a shared imported client to the loopback simulator. The test verifies the request body and header, demonstrates failure after a synthetic `ChatCompletion.model` removal, applies the configured `model_id` rename, and verifies the unchanged request with the patched response read. The client rejects non-loopback URLs. This is JavaScript runtime conformance, not a live API migration, real generation request or TypeScript SDK type upgrade; `model_id` is invented for the test. See [OpenAI fixture scope](../pipeline/fixtures/openai/README.md).

A retained local worker evaluation at `~/.refit/evaluations/nested-sdk-2026-10-13` starts with an unchanged contract, records review evidence, observes a committed simulated endpoint retirement, generates `inventory.legacy.items.retrieveLegacy` → `inventory.current.products.get`, passes both isolated HTTP checks in Docker, verifies evidence integrity, and deduplicates the next poll. The original application stays clean and unmigrated. `watch --repository` now permits the same committed `.refit.json` to run manually without adding a repository selector to the approved file; combining this local selector with `--sync-github` is rejected. No AI or GitHub publication was used for this evaluation. A fresh 0.9 Stripe App regression evaluation also confirmed real installation access and fetched the approved billing demo at `cfa192fd2bab995da81bf7f95ea97e0b0ea5f676`. It found two charge-history reads, passed 14 baseline tests, both 14-test patched contracts and TypeScript in offline Docker, and verified the retained evidence. This used the real Stripe SDK with the historical simulator, with no model request or new PR.

The merged 0.9.0 CLI archive was installed globally. From outside the source checkout, its local worker returned `already-processed`, and its real GitHub App service confirmed access and reused the same validated Stripe evidence. Neither repeated checks, requested AI or created a PR. Both original evaluation repositories remained clean and unmigrated.

## October 13, 2026: one-time App service retries

Refit 0.8.1 adds `serve --retry-target <id> --once`. Only explicitly selected service profiles are polled. Failed, interrupted and review-required worker receipts can get one new attempt using the existing configuration identity; old evidence is preserved. Successful jobs remain cached. Unknown/repeated ids or continuous retries are rejected before service state or GitHub requests. Approval, App access, spending limits and publication reconciliation still apply. Human output and the exit code cover selected targets; JSON retains the full registry plus the retry selection. Stop an existing service before running this command against its locked state.

The fully gated suite passed **503 tests across 52 files with no skips**. Production build, typecheck and formatting passed. Tests cover selected and multiple targets, unchanged unrelated failures, invalid CLI selections, approval refusal under retry, actual offline Docker recovery after a controlled availability failure, retained failed evidence and successful-job deduplication.

The live App evaluation at `~/.refit/evaluations/service-target-retries-2026-10-13` used two profiles for the existing approved billing configuration. A deliberately unavailable Docker socket was supplied only to the first evaluation process; the actual daemon was not stopped. App authorization and checkout succeeded, both jobs retained errors, and an ordinary poll reused those failures. With normal Docker access restored, a named billing retry passed the 14 baseline tests, both 14-test patched contracts and TypeScript, saving attempt 2. The unrelated profile's saved error record stayed unchanged; the selected CLI run exited 0. Retrying the successful target reused its output without checks. All three retained attempts passed integrity verification.

App API access and Git transport were real. Stripe responses remained a historical HTTP simulation through the real SDK. No model request, AI spending or new PR was used, and the original billing checkout remained clean and unmigrated. See [service retry commands](LOCAL-SERVICE.md#retry-a-failed-target-once).

## October 13, 2026: approved checked-in App workflows

Refit 0.8 adds `refit enroll` for a committed root `.refit.json`. A read-only review displays the exact workflow settings, baseline and optional provider adapter. Explicit approval requires that review's fingerprint and creates a new owner-only receipt outside Git. The receipt is bound to the GitHub repository/base and input bytes. App service targets selecting it fetch the committed base, verify approval before each poll, and use hash-checked copies of approved inputs through the shared worker. Installation alone still does not activate a repository, request AI or publish.

Application code and current API-source contents can change without reapproval. Changed workflow, baseline or adapter inputs stop for review before source polling, preparation, model requests, checks or publication; other service targets continue. Tests reject escaped paths, dirty state, tracked links, oversized/invalid Git blobs, stale fingerprints, receipt tampering and changed/incomplete cached inputs. Existing operator profiles retain their behavior. These are unsigned local operator receipts, not hosted tenant authorization.

The onboarding suite passed **487 tests across 52 files with no skips**. After integrating the separately merged vendor-note feature, the complete release suite passed **493 tests across 52 files with no skips**. Production build, typecheck and formatting passed. The CLI archive includes both onboarding and vendor-note guides. Controlled GitHub responses with native Git transport cover managed configuration loading, source changes, restart deduplication and blocked configuration changes. A real `oasdiff` and offline Docker integration completes a generic deterministic migration through an approved repository profile. No model request was used.

The live App evaluation at `~/.refit/evaluations/app-enrollment-2026-10-13` pushed the user-reviewed three-file billing configuration on `codex/refit-onboarding`, then merged it into remote `main` at `cfa192fd2bab995da81bf7f95ea97e0b0ea5f676`. Only `.refit.json` and the historical before/after contract projections were added. The actual App confirmed access, fetched that commit, verified the approved fingerprint and detected two `.charges` usages. The deterministic history patch passed 14 baseline tests, 14 patched before-contract tests, 14 patched after-contract tests and TypeScript in network-disabled Docker. Prepared npm dependencies were verified and reused. A second service run reused the saved job, and six evidence files passed integrity verification. The final 0.8.0 archive was installed globally; from outside the checkout, its enrollment review matched the approval fingerprint and its real App service poll reused the same validated result without rerunning checks.

GitHub App access and checkout were real. Stripe responses were simulated loopback HTTP through the real SDK, using the historical `PaymentIntent.charges` removal; this did not discover a new upstream change or call Stripe servers. No AI, new draft PR or migration commit was requested. The user's original billing checkout remained clean at its original commit with the migration unapplied. See [App onboarding](APP-ONBOARDING.md) for the commands and remaining hosted activation boundary.

## October 13, 2026: repository readiness and shared SDK inventory

`refit doctor` inspects a root `.refit.json` or an explicitly selected operator workflow, checks clean committed Git state, validates contracts and adapter rules through the shared scanner, records API-version applicability and mapped/unmapped SDK calls, checks committed npm preparation inputs when enabled, and resolves the existing Docker image. It does not run application code, install dependencies, request AI, fetch provider sources, contact GitHub or activate a repository. Known setup failures are reported together with next steps; unexpected failures remain errors. Unsupported breaking changes and missing live-source baseline evidence block readiness. Full comparison defaults on, matching the worker; disabling it is an explicit review boundary.

Adapter suggestions now use the same symbol-based client inventory as the scanner, including supported direct relative named imports of shared clients. Suggestions contain reconstructed method expressions and bounded locations, excluding arguments and inline source comments. This is still review-only mapping evidence, not verified SDK semantics. npm preparation and doctor share the same committed-manifest input gate.

The fully gated suite passed **470 tests across 50 files with no skips**. Production build, typecheck and formatting passed. Tests cover dirty Git, version mismatch, unavailable Docker, unknown SDK methods, preparation mismatch, unsupported breaking changes, unpinned/conflicting live-source settings, sensitive configuration values, outside-directory CLI execution and refusal of AI flags. The installed archive includes the command. No live model evaluation was used.

A retained local evaluation at `~/.refit/evaluations/repository-readiness-2026-10-13` inspected a committed simulated catalog `.refit.json`, then explicitly ran that same configuration through real `oasdiff` and offline Docker validation. The original repository stayed clean. A separate doctor report for the independent billing app passed setup checks and reported **3 mapped calls out of 9 observed SDK calls**, with `charges.list`, `customers.create` and `refunds.create` outside the current adapter mappings. Passing setup permits an attempt at validation; it does not establish complete coverage or migration correctness.

The chosen onboarding direction is a checked-in `.refit.json` reviewed before activation. Doctor does not retain approval or load repository configuration automatically through the App; service activation still uses explicit operator profiles. See [repository setup](REPOSITORY-SETUP.md) for working local commands and the current boundary.

## October 13, 2026: configured endpoint replacements across providers

Refit 0.6 adds `operationReplacements` for custom adapters: an explicit old SDK resource/method and a replacement method mapped to a new OpenAPI endpoint. Refit activates a rule only when the old endpoint disappears, the replacement endpoint is newly introduced, its operation ID resolves uniquely, and the supported recorded request/response, HTTP-method, path-parameter, server and security contracts match after traversing local component references. It edits only direct, non-optional calls on immutable, unescaped clients and preserves arguments, dependencies and client API-version configuration. Reports retain the configured mapping, contract hash and source locations. Unresolved usages or unrelated breaking changes still block automation.

The complete local workflow uses deterministic edits, offline baseline/patched checks and the shared draft publisher. Configured endpoint proposals skip AI generation and repair; a failing or unavailable replacement SDK method remains a failed run. A simulated catalog SDK makes real loopback HTTP requests and verifies successful retrieval, header/query options and propagated 404 behavior. Native tests prove the original after-contract failure and patched success, including a resource-and-method replacement. Real `oasdiff` plus Docker checks pass the complete migration and retain the untouched original repository. Controlled GitHub API tests cover readable draft publication; no real PR or live model call was made for this feature.

Worker job identity now includes configured endpoint-change IDs and endpoint removals after deprecation, including severity-1 removal records. A later removal cannot reuse an earlier receipt for an unchanged contract. Restart tests verify one fresh job for the removal and deduplication of subsequent polls, with and without a configured replacement.

The fully gated suite passed **457 tests across 49 files with no skips**, including installed CLI packaging, real `oasdiff`, offline Docker checks, the independent Stripe billing migration, dependency preparation, SDK HTTP simulations, and the new endpoint failure/success gates. Production build, typecheck, formatting and diff checks passed. These results do not include a live model request or a real provider endpoint migration.

The installed 0.6 CLI also completed a retained worker evaluation at `~/.refit/evaluations/endpoint-worker-2026-10-13`: an unchanged-contract poll recorded a review receipt, replacing the local source with the simulated after contract produced a validated deterministic patch, and a third poll returned `already-processed`. Both offline Docker checks passed, evidence integrity verified, and the original demo repository stayed clean. An initial configuration missing `formatVersion` was rejected before a job started and was corrected. This evaluation used no AI, real provider requests or publication.

A fresh Stripe service evaluation at `~/.refit/evaluations/stripe-service-0.6-2026-10-13` confirmed real GitHub App access and fetched the billing demo's committed `main` into a managed checkout. The historical fixture detected two `.charges` usages and proposed the deterministic Charges API history migration. Baseline checks passed 14 billing tests; patched checks passed the same 14 tests, 14 after-contract tests and TypeScript. Cached dependency preparation was verified and reused, and workflow evidence passed integrity verification. This used the real Stripe SDK against the offline HTTP simulator, not a live Stripe API change, and requested no AI or PR publication.

The mappings are operator-authored semantic assumptions. Matching contracts do not prove equivalent business behavior or that a method exists in the installed SDK, and the version rollout needs review. This is a generic migration mechanism tested with a synthetic vendor, not a second real-provider migration claim. See [endpoint configuration and reproduction](ENDPOINT-MIGRATIONS.md).

## October 13, 2026: review-only provider adapter suggestions

`refit adapter-suggest` can propose an initial SDK-to-OpenAPI mapping for an npm SDK without adding provider-specific Refit code. A local TypeScript symbol pass finds direct calls on `const client = new ImportedConstructor()` instances; the optional OpenAI request receives only those call names and a bounded list of unique OpenAPI operations with supported JSON component response schemas. Refit checks each proposed SDK method, operation ID and schema against that evidence, then writes a new adapter file only when at least one mapping survives validation. The command uses the shared token counter and spending ledger, and does not overwrite an existing output.

This is advisory setup, not automatic SDK discovery: it does not establish semantic equivalence, trace arbitrary factories or wrappers, propose migration rules, activate a profile or make a change. Review the mapping against official SDK documentation, then scan the repository and inspect evidence before using it in a migration workflow. The model request is optional; generic breaking changes without a verified migration rule remain review-only. No live model call was used to verify this implementation.

The fully gated test suite passed **427 tests across 46 files with no skips**, including a mocked adapter-suggestion-to-scan flow, package installation, SDK fixtures, offline Docker migration validation, npm dependency preparation, and `oasdiff`. The production build and formatting checks passed. Adapter-suggestion tests verify that source contents and unrelated code are not sent; they do not verify real model mapping quality.

## October 13, 2026: mapped callers for breaking OpenAPI changes

Custom SDK adapters can optionally map each `resource.method` to a unique `operationId` in the pinned baseline. With `--full-diff`, Refit joins unresolved level-2/3 `oasdiff` changes to the baseline path and HTTP method, then reports change IDs, summaries and statically traced SDK call locations. Endpoint removals are also reported when marked non-breaking after deprecation. Adapter IDs that are missing or duplicated in the baseline fail preflight. These findings remain review-only; generic endpoint, request and response migration rules are not registered. Automated runs block AI generation, Docker validation and publication when mapped calls have unresolved breaking changes. Focused workflow tests verify the evidence and confirm no model or validator request occurs; a real `oasdiff` integration test covers endpoint removal and response-type changes.

## October 13, 2026: provider-neutral RSS and Atom changelog feeds

Configured documentation sources now accept RSS 2.0 and Atom XML in addition to HTML, Markdown and plain text. Entries become stable readable records of title, published/updated date, link and summary, so the existing watcher can store a hash-pinned baseline and unified diff without provider-specific parsing. XML is validated, custom entity declarations are rejected, expansion limits are set, and feeds with more than 250 entries stop rather than silently truncate. Packaging tests verify the CLI carries the parser dependency. This still requires the operator to supply each public feed URL; Refit does not discover provider feeds or treat feed prose as verified migration guidance. Feed-only updates remain review signals and do not invoke AI or PR publication.

## October 13, 2026: provider-neutral documentation change signals

`watch` and local-service profiles can now monitor up to eight manually configured public documentation, changelog or release-note sources per provider target. Capture accepts bounded HTML, Markdown, plain text and RSS/Atom, strips non-visible HTML chrome from pages, uses ETags, and stores hash-verified snapshots plus unified text diffs. A docs-only update is surfaced as review evidence and does not invoke AI, validation or GitHub publication. URLs are operator-selected; Refit does not discover feeds or treat documentation text as verified migration instructions. When an API contract update happens in the same poll, the documentation diff remains separate evidence and is not included in the model prompt or PR.

## October 13, 2026: explicit API-version applicability

Reports compare an operator-supplied application API-version pin with `info.version` in both OpenAPI snapshots. Automated `run`, `watch` and `serve` stop at the scan stage unless the pin exactly matches the before contract; an after-version, unrelated version or missing evidence cannot spend on AI, start Docker validation or publish. Direct `validate --publish-draft` checks the pin before repository validation, and the publisher enforces it again. The Stripe billing profile uses the demo application's explicit `2022-08-01` client pin against the historical `2022-08-01` → `2022-11-15` change. This is provider-neutral but operator-declared; SDK lockfiles and account defaults are not treated as proof, and providers using `info.version` for another purpose remain review-only. Evidence includes current/before/after versions and human CLI output summarizes them.

The default suite passed **372 tests** with 28 environment-gated tests skipped. With Stripe/OpenAI SDK fixtures, Docker, the billing repository, npm preparation, oasdiff and packaged CLI enabled, the full suite passed **400 tests with no skips**. Production build and formatting also passed. These checks used simulated provider HTTP and GitHub responses; no live model request or PR publication was part of this feature verification.

## October 13, 2026: provider-neutral OpenAPI baseline capture

`refit source-snapshot` now saves a verified, hash-pinned baseline from a user-supplied public HTTPS URL or local OpenAPI JSON/YAML file for any provider ID. The existing generic watcher can compare later captures from the same URL, while Stripe retains its dedicated upstream revision discovery. This does not discover generic-provider feeds, documentation pages or changelogs. Generic migrations still require an explicit SDK adapter and application checks. See [CLI usage](CLI.md#discover-current-stripe-specifications-or-check-against-a-retained-baseline) and [local automation](AUTOMATION.md#use-a-real-upstream-source).

## October 13, 2026: nested component-schema response fields

Configured provider adapters can now trace removed fields through direct local OpenAPI component-schema `$ref`s, nested property chains, and immutable local aliases, including destructuring of an intermediate object. The same schema graph is used when rescanning deterministic and AI proposals. A nested catalog SDK fixture passes old and new runtime contracts in offline Docker. Arrays and inline/composed/external schemas remain review cases. Refit can report removed-field indexes or destructuring but does not auto-edit them. See [provider adapter limits](../README.md#configure-another-sdk) and [architecture](ARCHITECTURE.md#provider-independent-core).

## October 13, 2026: explicit OpenAPI array item tracing

The provider analyzer now follows literal non-negative numeric indexes into arrays when the array's `items` reference a local component schema. It carries that evidence through immutable array aliases, object destructuring of an array property and immutable array destructuring. A configured nested-field rename passes the before and after contracts in offline Docker. Dynamic indexes and inline, composed, tuple-style or external item schemas remain review cases. This traces an array element; it does not auto-edit a dynamic or destructured read of the removed field itself.

## October 13, 2026: array iteration flow

The analyzer also traces `const` `for...of` bindings and inline callbacks to common array iteration methods (`every`, `filter`, `find`, `flatMap`, `forEach`, `map` and `some`) when the callback has one identifier parameter and the array item uses a local component `$ref`. It treats callback mutations or item escape as response mutations, which downgrades findings to review. Named callbacks, additional callback parameters, mutable loop bindings and transformed array chains remain review cases. The array rename passes old and new runtime contracts in offline Docker through an inline `.map()` callback.

## October 13, 2026: provider mapping preflight

Before analysis, every adapter operation must resolve through local component `$ref`s to an object schema with directly declared properties in the baseline. Missing, composed, external and cyclic response-schema mappings fail with the SDK operation name instead of producing an unhelpful no-finding result. The analyzer and preflight share the same component resolver. Tests cover missing mappings and a valid local schema alias. The gated suite passed **382 tests across 40 files with no skips**, including Docker checks, Stripe and OpenAI SDK simulators, the independent billing migration, and `oasdiff`; build and formatting passed.

## October 13, 2026: configured property-rename rules

Custom provider adapters may now declare `propertyRenames`. Refit activates a rule only when the before/after OpenAPI documents show the configured field was removed and a new replacement field appears on the same schema with the same simple scalar type (`string`, `integer`, `number` or `boolean`). The scanner must also trace a direct property read through the adapter's resource/method mapping. It then changes only that property-name token. Indexed reads, destructuring and unsupported source forms remain for review.

This provides a horizontal deterministic mechanism without a new provider-specific patch implementation, while leaving migration semantics explicit in the adapter authored by the operator. Matching field types do not prove equivalent meaning, API-version applicability or runtime behavior. The synthetic catalog SDK passes old and new response contracts through the real offline Docker validator. A separate OpenAI SDK simulator test applies the same generic rule over actual SDK HTTP requests; its replacement field is synthetic. Neither is a real second-vendor API migration. Upstream automatic specification discovery remains Stripe-only. See the [adapter configuration](../README.md#configure-another-sdk), [catalog fixture](../pipeline/fixtures/catalog/README.md) and [OpenAI fixture](../pipeline/fixtures/openai/README.md).

The fully gated test suite passed **351 tests across 39 files with no skips**, including the real OpenAI Node SDK 7.32.0 sending requests only to the local simulator, the synthetic catalog migration in offline Docker, the Stripe billing migration, dependency preparation, and `oasdiff`. No model generation or live provider API call was part of these checks.

## October 13, 2026: automatic npm checks in offline validation

Refit 0.5 adds `refit prepare` and opt-in `prepareDependencies`/`--prepare-dependencies`. For supported single-root npm projects, it reads only committed `package.json` and `package-lock.json`, verifies matching dependency declarations and full SHA-256-or-stronger npm integrity values, installs locked public registry dependencies in a restricted container with install scripts disabled, and caches a hash-verified archive keyed by the immutable image and exact inputs. Baseline and patched checks extract the same prepared snapshot into network-disabled containers. This removes custom dependency-image preparation for ordinary supported npm projects.

The real billing demo was prepared from its committed npm lockfile. Refit verified that a deliberately added `postinstall` did not run, then used the prepared archive to pass the independent 14-test before/after contracts, strict TypeScript, 103-attempt pagination and empty history in offline Docker. The demo repository and its tests stayed unchanged. The gated full suite passed **342 tests across 39 files with no skips**, including dependency installation, cache safety, CLI packaging and offline Docker validation.

Interactive CLI output and migration PRs lead with the API change, confirmed usage and file counts, proposal summary, and check results. Exact commands, input hashes and detailed contract evidence remain in the local JSON report and a collapsed technical section in GitHub PR descriptions.

This does not support every npm layout: workspaces, private registries, local/Git URLs and lifecycle-dependent native builds still need a custom image. Installing dependencies is not proof the repository's checks are meaningful or that a proposed migration is semantically correct. Hosted execution, Go/Python/Java dependency preparation and customer onboarding remain open work. See [dependency preparation](DEPENDENCIES.md) for the exact support boundary.

## October 12, 2026: installation-aware local service

Refit 0.4 adds `refit serve`: a loopback HTTP receiver verifies GitHub's raw-byte SHA-256 signatures, atomically persists delivery receipts and installation inventory, and schedules up to 32 approved repository/source profiles. App access is confirmed through GitHub at startup and each poll. Duplicate deliveries survive restart, conflicting GUID reuse is rejected, revoked access cancels the affected worker, and status requires a separate bearer token. Unknown installed repositories are recorded without executing code. Checkout, comparison, migration, budgets, checks and publication reuse the existing core.

The service's real App evaluation fetched the billing demo at `a8ea0428ec7a3f2b90a24e2168791b4dba3e87c2`. A publishing poll verified/reused PR #3 without generation or revalidation. A separate deterministic migration passed both 14-test HTTP simulator contracts, strict TypeScript, 103-attempt pagination and empty history in offline Docker. The original billing checkout stayed clean and unmigrated. Its saved evidence passed integrity verification.

A continuous local HTTP evaluation confirmed public health, protected status, HTTP 202 acknowledgement, duplicate delivery handling, bad-signature rejection, installation-event wakeup and clean Ctrl+C shutdown. Those deliveries were **simulated locally**, signed with the actual local webhook secret; no real public GitHub delivery has been tested. The App API and checkout were real. No additional AI generation was needed; the shared $2 ledger remains at $0.00357075 with no pending reservation.

The gated suite passed **315 tests with none skipped** across 36 files, including actual Docker workflows, real Stripe/OpenAI SDK HTTP simulations, independent billing validation, frontend tests and independently installed CLI help/replay. Production build, typecheck and formatting passed. Service HTTP tests use real loopback requests with controlled GitHub/worker responses; they do not claim live Stripe behavior or hosted tenant isolation.

The global CLI was installed as **0.4.0**. From an unrelated directory, its `serve --once --publish-draft --json` command confirmed App access and reused the saved successful worker result without rerunning checks. Local evaluations are retained at `~/.refit/evaluations/local-service-app-2026-10-12` and `~/.refit/evaluations/local-service-validation-2026-10-12`; the first also contains `http-evaluation.json` identifying simulated deliveries and real App access.

See [local service setup](LOCAL-SERVICE.md) and [npm dependency preparation](DEPENDENCIES.md) for pilot commands. Hosted customer onboarding, hosted queues, tenant isolation, broader migration semantics, SDK/API-version applicability and dependency preparation outside single-root npm remain future work. Installing the App alone does not start an arbitrary repository.

## October 12, 2026: App-managed repository provisioning

Refit 0.3 adds `watch --sync-github`: the installed App fetches an explicit authorized repository into a private managed checkout and refreshes the base before every poll. A run configuration can omit the local repository. Contents read tokens serve checkout; publication gets a separate write token. Git credentials are restricted to a child-process environment, never saved in URLs/configuration, and never supplied to checks. Ownership/configuration hashes and tracked/untracked/ignored file checks stop unexpected edits from being overwritten. Native Git tests cover base advancement, held locks, interrupted preparation/update recovery, and state outside working copies.

The live App evaluation fetched the private billing demo at `a8ea0428ec7a3f2b90a24e2168791b4dba3e87c2`. One remote worker verified/reused PR #3 before generation. Another generated the supported deterministic patch and passed both 14-test contracts, TypeScript, 103-charge pagination and empty history in offline Docker. The original billing checkout stayed clean and unmigrated. No new AI spending was needed; the shared build ledger remains at $0.00357075.

The full gated suite passed **301 tests with none skipped** across 33 files. Production build, typecheck, formatting and evidence integrity verification passed.

See [App-managed commands](AUTOMATION.md#let-the-app-fetch-and-refresh-the-repository). This removes manual local checkout/pull setup; hosted installation enrollment and dependency provisioning remain future work.

## October 12, 2026: local automation and shared provider core

Refit 0.2 adds a persistent local worker, public HTTPS/file/Stripe source capture, JSON/YAML parsing, a shared oasdiff changelog, bounded migration gates, App preflight deduplication, durable AI spending reservations, and human-readable CLI/PR presentation. [Local automation](AUTOMATION.md) provides the exact Stripe commands and a change-arrival demonstration. [Architecture](ARCHITECTURE.md) separates the implemented core from hosted onboarding.

The live Stripe billing worker generated one OpenAI proposal for **$0.00357075** and passed both 14-test simulator contracts, TypeScript, 103-attempt pagination, and empty history. A repeated poll reused the job without generation. An App publishing poll verified and reused [draft PR #3](https://github.com/pierceluu10/refit-billing-demo/pull/3) before AI/validation; its description was updated to prose while preserving its original validation record. No new PR or merge was needed. The separate billing application remains unmigrated.

A real OpenAI SDK 7.32.0 conformance test verifies normal `models.retrieve()` HTTP usage against before/after simulated Model responses. It detects the removed field through the shared adapter but does not invent a replacement. This is not an announced OpenAI API change. General contract detection is broader than supported automatic code mapping.

The final gated suite passed **288 tests with none skipped** across 32 files: unit/controlled API checks, actual Docker workflows, real Stripe SDKs, the real OpenAI SDK, the independent billing migration, frontend behavior, and an independently installed CLI archive. Production build, typecheck and formatting passed. The current live AI patch was separately applied by the billing integration test without changing its tests.

The worker also captured Stripe's real current published revision (`bcfd59f49dcac84a84d63d304c62793dff6e5916`) and compared it with an identical pinned baseline using oasdiff. It found no changed usages and made no model request. This verifies live feed ingestion and comparison, not account/API-version applicability. A continuous polling evaluation started with the original historical contract, observed a changed contract arrive, found two confirmed reads, and reused the verified App draft before generation. Ctrl+C stopped it cleanly. Refit's global CLI was upgraded to **0.2.0**, and the installed executable repeated the saved App worker job without a new request. Evidence manifests passed integrity verification; the shared $2 ledger retains $0.00357075 spent with no pending reservation. Historical checkpoints below retain their original counts and limitations.

## September 28, 2026 checkpoint

**October 11 GitHub App update:** Refit created [draft PR #2](https://github.com/pierceluu10/refit-billing-demo/pull/2) using the installed **Refit Agent** App. GitHub verified `refit-agent[bot]` as PR author and commit author/committer. Two earlier runs were correctly blocked for pagination/empty-history regressions; after clarifying the AI migration guidance, the next live proposal passed without repair. The downloaded remote commit independently passed both 14-test simulator contracts, TypeScript, all 13 history entries, empty history and demos under both API versions. The full gated Refit suite passed 263 tests with none skipped; typecheck and formatting passed. This is a manually triggered installed CLI workflow, not hosted monitoring. See [the App evaluation](PR-EVALUATION.md#live-github-app-publication).

**October 9 update:** the independent billing application now has a generated migration verified against both simulator contracts, unchanged tests, strict TypeScript, multi-page history and the actual offline Docker workflow. See [billing evaluation](BILLING-EVALUATION.md) for commands and bounded wrapper/guard support. This does not verify live AI or GitHub publication; the September checkpoint below records the earlier state.

**Subsequent October 9 AI evaluation:** a live `gpt-5.4-mini` proposal passed both billing suites, TypeScript, multi-page and empty-history checks in Docker after earlier rejected and semantically incomplete proposals. See [AI evaluation](AI-EVALUATION.md) for the full outcomes and evidence paths. A subsequent [October 11 evaluation](PR-EVALUATION.md) verified a live AI repair and draft PR publication.

**October 11 update:** Refit created [draft PR #1](https://github.com/pierceluu10/refit-billing-demo/pull/1) in the private billing demo repository. Its first live AI candidate lost pagination; the extra check rejected it, one bounded repair passed, and only the repaired candidate was published. The downloaded remote branch independently passed both 14-test contracts, TypeScript, multi-page and empty-history checks, and the CLI demo. The full gated Refit suite passed 244 tests with none skipped. The CLI now accepts saved JSON run inputs and explicit `--env` loading, reports progress on stderr and retains JSON stdout. The updated full suite passed 249 tests with none skipped; build and formatting passed. An archive was installed globally and its `refit run --config` command validated the billing app from another directory. Original application files remain unchanged. This does not verify Stripe servers, arbitrary applications or a hosted product.

Refit has a working local migration pipeline and a reproducible real-SDK demo. It is not yet a hosted agent that continuously monitors arbitrary APIs or an application tested against a production repository.

## Verified paths

| Requirement                  | Current evidence                                                                                                                | Boundary                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Ingest specification changes | Pinned Stripe downloads, latest-revision discovery, hash-checked snapshots and historical upstream replay                       | Stripe downloading only; generic adapters consume supplied OpenAPI JSON                                    |
| Find affected code           | AST/symbol tests, direct relative imported clients, alias/mutation/escape tests and npm lock evidence                           | Direct removed properties and bounded ESM patterns; no complete OpenAPI differ or interprocedural analysis |
| Generate a migration         | Deterministic PaymentIntent history patch, configured scalar-property rename rules and exact scoped AI replacement checks       | Rename semantics are operator-authored; broader provider rules and reliability remain unverified           |
| Validate in isolation        | Actual offline Docker tests, baseline failure and regression gates, bounded repair attempts, stale-revision checks              | Caller supplies meaningful checks and local dependencies/image; no hosted execution service                |
| Demonstrate the loop         | `refit demo` uses real Stripe 10.17.0, an imported client, a simulated HTTP API, old-code failure and patched success in Docker | Synthetic application and API responses; no Stripe service or production application                       |
| Preserve review evidence     | Reports, diff, draft PR text and hash manifests; `refit verify` validates declared artifact bytes                               | Unsigned integrity evidence is not authenticity or proof of test quality                                   |
| Publish a draft PR           | Controlled GitHub API tests plus a live billing-demo draft PR cover publication                                                 | One test repository; no auto-merge                                                                         |
| Install independently        | npm archive installed into a disposable prefix; executable, replay and command help run outside checkout                        | Local archive only; no npm registry release                                                                |
| Explain the product          | Existing landing page, walkthrough, docs and sample workspace build and frontend tests pass                                     | Workspace remains illustrative and is not connected to the CLI                                             |

## Validation performed

`REFIT_PACKAGE_INSTALL=1 REFIT_STRIPE_SDK=1 REFIT_DOCKER_IMAGE=node:22-alpine npm test` passed **219 tests with none skipped**. This includes both real SDK versions (10.17.0 and 19.1.0), Docker validation/repair, the CLI demo and independent archive installation. `npm run build` and `npm run format:check` also passed. Subsequent package-help checks include `demo` and `verify`.

These results describe the code at this checkpoint, not future changes. The tests simulate OpenAI/GitHub responses; they do not substantiate live model or remote publication claims.

## Next external verification

1. Select a real application repository and a representative before/after API change. Start with a read-only scan, inspect the findings and define application-specific checks.
2. Configure `OPENAI_API_KEY` and an explicit `OPENAI_MODEL` locally to evaluate actual model proposals and repair quality. Neither is configured in the audited process. Keep credentials out of commits and reports.
3. Select a GitHub test repository and base branch whose commit matches the application being validated. GitHub CLI authentication is available, but the pipeline's `GITHUB_TOKEN` is not configured. Authentication alone does not establish permissions on the selected target.
4. Execute the full workflow, inspect the remote draft and record the live outcomes. A model or publisher failure should remain a failed run, not be replaced by a simulated success.

## Work beyond this checkpoint

The product architecture still needs broader API change semantics, provider and language coverage, provider-specific proof of effective API versions, dependency provisioning, application evaluations, scheduling, GitHub App onboarding and hosted job infrastructure. These are material product work, not capabilities implied by passing the local demo. The [architecture inventory](ARCHITECTURE.md) and [CLI guide](CLI.md) distinguish implemented behavior from that target.
