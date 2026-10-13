# Refit implementation checkpoints

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
