# Refit implementation checkpoints

## October 12, 2026: installation-aware local service

Refit 0.4 adds `refit serve`: a loopback HTTP receiver verifies GitHub's raw-byte SHA-256 signatures, atomically persists delivery receipts and installation inventory, and schedules up to 32 approved repository/source profiles. App access is confirmed through GitHub at startup and each poll. Duplicate deliveries survive restart, conflicting GUID reuse is rejected, revoked access cancels the affected worker, and status requires a separate bearer token. Unknown installed repositories are recorded without executing code. Checkout, comparison, migration, budgets, checks and publication reuse the existing core.

The service's real App evaluation fetched the billing demo at `a8ea0428ec7a3f2b90a24e2168791b4dba3e87c2`. A publishing poll verified/reused PR #3 without generation or revalidation. A separate deterministic migration passed both 14-test HTTP simulator contracts, strict TypeScript, 103-attempt pagination and empty history in offline Docker. The original billing checkout stayed clean and unmigrated. Its saved evidence passed integrity verification.

A continuous local HTTP evaluation confirmed public health, protected status, HTTP 202 acknowledgement, duplicate delivery handling, bad-signature rejection, installation-event wakeup and clean Ctrl+C shutdown. Those deliveries were **simulated locally**, signed with the actual local webhook secret; no real public GitHub delivery has been tested. The App API and checkout were real. No additional AI generation was needed; the shared $2 ledger remains at $0.00357075 with no pending reservation.

The gated suite passed **315 tests with none skipped** across 36 files, including actual Docker workflows, real Stripe/OpenAI SDK HTTP simulations, independent billing validation, frontend tests and independently installed CLI help/replay. Production build, typecheck and formatting passed. Service HTTP tests use real loopback requests with controlled GitHub/worker responses; they do not claim live Stripe behavior or hosted tenant isolation.

The global CLI was installed as **0.4.0**. From an unrelated directory, its `serve --once --publish-draft --json` command confirmed App access and reused the saved successful worker result without rerunning checks. Local evaluations are retained at `~/.refit/evaluations/local-service-app-2026-10-12` and `~/.refit/evaluations/local-service-validation-2026-10-12`; the first also contains `http-evaluation.json` identifying simulated deliveries and real App access.

See [local service setup](LOCAL-SERVICE.md) for exact pilot commands and public HTTPS webhook steps. Customer onboarding, automatic dependency provisioning, hosted queues, tenant isolation, broader migration semantics and SDK/API-version applicability remain future work. Installing the App alone does not start an arbitrary repository.

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

| Requirement | Current evidence | Boundary |
| --- | --- | --- |
| Ingest specification changes | Pinned Stripe downloads, latest-revision discovery, hash-checked snapshots and historical upstream replay | Stripe downloading only; generic adapters consume supplied OpenAPI JSON |
| Find affected code | AST/symbol tests, direct relative imported clients, alias/mutation/escape tests and npm lock evidence | Direct removed properties and bounded ESM patterns; no complete OpenAPI differ or interprocedural analysis |
| Generate a migration | Deterministic PaymentIntent charge-history patch, exact scoped AI replacement checks | One deterministic Stripe rule and authored live AI evaluation; broader reliability remains unverified |
| Validate in isolation | Actual offline Docker tests, baseline failure and regression gates, bounded repair attempts, stale-revision checks | Caller supplies meaningful checks and local dependencies/image; no hosted execution service |
| Demonstrate the loop | `refit demo` uses real Stripe 10.17.0, an imported client, a simulated HTTP API, old-code failure and patched success in Docker | Synthetic application and API responses; no Stripe service or production application |
| Preserve review evidence | Reports, diff, draft PR text and hash manifests; `refit verify` validates declared artifact bytes | Unsigned integrity evidence is not authenticity or proof of test quality |
| Publish a draft PR | Controlled GitHub API tests plus a live billing-demo draft PR cover publication | One test repository; no auto-merge |
| Install independently | npm archive installed into a disposable prefix; executable, replay and command help run outside checkout | Local archive only; no npm registry release |
| Explain the product | Existing landing page, walkthrough, docs and sample workspace build and frontend tests pass | Workspace remains illustrative and is not connected to the CLI |

## Validation performed

`REFIT_PACKAGE_INSTALL=1 REFIT_STRIPE_SDK=1 REFIT_DOCKER_IMAGE=node:22-alpine npm test` passed **219 tests with none skipped**. This includes both real SDK versions (10.17.0 and 19.1.0), Docker validation/repair, the CLI demo and independent archive installation. `npm run build` and `npm run format:check` also passed. Subsequent package-help checks include `demo` and `verify`.

These results describe the code at this checkpoint, not future changes. The tests simulate OpenAI/GitHub responses; they do not substantiate live model or remote publication claims.

## Next external verification

1. Select a real application repository and a representative before/after API change. Start with a read-only scan, inspect the findings and define application-specific checks.
2. Configure `OPENAI_API_KEY` and an explicit `OPENAI_MODEL` locally to evaluate actual model proposals and repair quality. Neither is configured in the audited process. Keep credentials out of commits and reports.
3. Select a GitHub test repository and base branch whose commit matches the application being validated. GitHub CLI authentication is available, but the pipeline's `GITHUB_TOKEN` is not configured. Authentication alone does not establish permissions on the selected target.
4. Execute the full workflow, inspect the remote draft and record the live outcomes. A model or publisher failure should remain a failed run, not be replaced by a simulated success.

## Work beyond this checkpoint

The product architecture still needs broader API change semantics, provider and language coverage, SDK/API-version applicability, dependency provisioning, application evaluations, scheduling, GitHub App onboarding and hosted job infrastructure. These are material product work, not capabilities implied by passing the local demo. The [architecture inventory](ARCHITECTURE.md) and [CLI guide](CLI.md) distinguish implemented behavior from that target.
