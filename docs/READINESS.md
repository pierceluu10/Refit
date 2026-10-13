# Refit implementation checkpoints

## October 13, 2026: mapped callers for removed OpenAPI operations

Custom SDK adapters can optionally map each `resource.method` to a unique `operationId` in the pinned baseline. With `--full-diff`, Refit joins `oasdiff` operation-removal entries to the statically traced SDK calls and reports endpoint, method and call locations. Adapter IDs that are missing or duplicated in the baseline fail preflight. These findings remain review-only; no generic method replacement rule is registered. Automated runs block AI generation, Docker validation and publication when they detect mapped calls to removed operations. A focused workflow test verifies the evidence and confirms no model or validator request occurs.

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
