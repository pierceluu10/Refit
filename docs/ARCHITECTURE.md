# Refit: current implementation and architecture goal

## Goal

Connect a GitHub repository once. Refit watches Stripe's API specification, identifies changes relevant to that repository, generates a focused migration in an isolated checkout, runs the project's checks, and opens a draft PR with evidence. An engineer reviews and merges.

AI helps interpret application intent and edit code. Source diffs, job state, validation outcomes, and publishing permissions remain deterministic.

## What exists now

| Capability | Implemented state |
| --- | --- |
| Website and workspace | React/Vite frontend, interactive demo, docs, sample repositories/runs and configuration export. Workspace data remains illustrative. |
| Local pipeline | Runnable TypeScript CLI in `pipeline/`; accepts a real local repository and two supplied OpenAPI JSON files. No credentials or network needed. |
| Snapshot ingestion | `stripe:snapshot --latest` discovers the latest default-branch commit touching the spec and downloads at its full SHA. `stripe:check` discovers, compares against a pinned baseline, scans and exports replayable snapshots/report/manifest without advancing the baseline. Bounded requests, no redirects; live changed/unchanged checks exercised. No background polling. |
| Dependency detection | Reads Stripe declarations from package manifests, including nested workspaces. Reports declared ranges, not resolved lockfile versions. |
| Provider adapters | Built-in Stripe plus explicit custom SDK mappings through `--provider-config`. Maps ESM constructors and shallow resource/method responses to OpenAPI schemas. Package detection, change IDs, run identity, AI and validation use the selected adapter. Synthetic second-provider tests pass; arbitrary APIs are not automatically supported. |
| Specification comparison | Detects direct property removals in existing non-composed OpenAPI 3 component schemas. This limited detector is **not oasdiff** and does not implement the full PRD diff engine. |
| Code analysis | TypeScript AST and lexical symbols trace local ESM Stripe clients, awaited PaymentIntent calls, immutable aliases, direct/string-indexed reads and destructuring. |
| Evidence | JSON report with schema pointers, file/line/column, confirmed local matches versus review candidates, source hashes and repeatable run ID. |
| Replay | Minimal offline fixtures plus a documented replay using real upstream commits from November 10 and 17, 2022. Both were exercised against the sample repository. |
| Patch proposals | Opt-in `--propose-patch` returns a unified diff for direct `charges.data` returns from a locally traced one-argument PaymentIntent retrieval. Remaining findings and semantic caveats remain explicit. |
| Local validation | `stripe:validate` archives clean committed HEAD, applies a proposal to a disposable copy, and runs explicit baseline/patched commands in separate restricted offline Docker containers using a local image ID. Records logs, exit codes, hashes and stale-revision checks. Dependencies must be available in the image. |
| Review artifacts | `stripe:validate --bundle <new-directory>` exports the exact patch, report, draft PR description and file-hash manifest. Failed validation is preserved explicitly. No remote publication. |
| Draft publication | `api:validate --publish-draft --github owner/repository --base main` requires fresh passing checks, no unresolved findings and a matching remote base. Publishes exact changed files on a deterministic branch, refuses branch collisions and reuses existing PRs. Controlled GitHub API tests pass; live publication remains unverified. |
| AI assessment | Opt-in OpenAI Responses integration with strict structured output, bounded source context, evidence-ID validation and advisory decisions. Controlled-response tests pass; live model verification requires configuration. AI cannot edit code or publish. |
| AI patch proposals | Opt-in `--ai-patch` requests exact source replacements tied to confirmed findings. Local checks enforce file scope, unique matches, non-overlap and parseable output, then rescan. Integrates with Docker validation and review bundles. Controlled model output has been exercised in actual containers; live quality and iterative repair remain unverified/unimplemented. |
| Verification | Pipeline and frontend tests; opt-in real Docker tests exercise baseline/patched behavior, isolation checks, regressions, baseline failures and output limits. No production application or Stripe account has been exercised. |
| Service integration | No HTTP service, database, queue, GitHub App or scheduled monitoring. Draft publication uses an explicit host token; the CLI is not connected to the frontend. |

The analyzer is conservative: `affected` means a removed property has a locally traced PaymentIntent receiver. It does not prove that the repository is upgrading to the relevant API version. `needs-review` means Stripe is present but no such direct match is confirmed. `no-stripe-signal` means the supported scan found no Stripe import/dependency signal; it does not prove the absence of REST calls or dynamic integrations.

Cross-file wrappers, CommonJS client resolution, webhooks, mutation, list responses and dynamic flows need additional analysis. A same-named property on an unproven receiver is a review candidate, not confirmed evidence. No-match results never become an automatic “safe” decision.

## Run it

```sh
npm ci
npm run stripe:replay

npm run stripe:scan -- \
  --repository /absolute/path/to/repository \
  --before /absolute/path/to/previous-openapi.json \
  --after /absolute/path/to/current-openapi.json \
  --output /absolute/path/to/new-report.json
```

Omit `--output` to print JSON. An existing output file is never overwritten. Exit code 0 means the scan completed, including when it found affected code; exit code 1 means invalid arguments or a scan/output error. The report has no timestamps, so the same supported inputs produce the same run ID. Reports do not include full source snippets or constructor arguments.

The scanner reads source files without importing them, installing dependencies or executing scripts. It skips dependency/build directories and symlinks, reports skipped symlinks, and rejects repositories over 10,000 relevant files, 2 MiB per file or 50 MiB total. Malformed source and JSON fail explicitly.

The frontend's TypeScript 7 package does not expose the legacy compiler API used by this analyzer. `typescript-compiler` is an npm alias for TypeScript 5.9.3, used only by the local pipeline. Syntax newer than that parser supports fails explicitly. `tsx` runs the CLI; neither is bundled into the browser.

## Target architecture — planned

```mermaid
flowchart TD
  UI[React workspace] --> API[Authenticated TypeScript API]
  GH[GitHub App and webhooks] --> API
  API --> DB[(PostgreSQL state and durable jobs)]
  POLL[Stripe revision poller] --> BLOBS[Snapshot and artifact storage]
  POLL --> DB
  DB --> WORKER[Job worker]
  BLOBS --> WORKER
  WORKER --> DIFF[oasdiff and normalized change events]
  DIFF --> SCAN[Dependency and AST analysis]
  SCAN --> IMPACT[AI impact assessment with cited evidence]
  IMPACT --> GATE{Migration warranted?}
  GATE -->|Uncertain| REVIEW[Needs human review]
  GATE -->|No| SKIP[Record no action]
  GATE -->|Yes| AGENT[AI patch agent]
  AGENT <--> SANDBOX[Isolated Docker checkout and restricted tools]
  SANDBOX --> CHECKS[Baseline and patched validation]
  CHECKS -->|Bounded repair| AGENT
  CHECKS -->|Failure or budget exhausted| BLOCKED[Blocked run with logs]
  CHECKS -->|Pass and current revision| PR[Draft PR publisher]
  PR --> HUMAN[Engineer review and merge]
  WORKER --> DB
  SANDBOX --> BLOBS
  DB --> API
```

### 1. Control plane

The existing React app calls a TypeScript API for installations, repositories, changes, runs and artifacts. Authentication and installation ownership checks apply to every resource. GitHub webhooks are signature-verified and deduplicated. HTTP handlers validate requests and enqueue work; long jobs run separately.

### 2. Persistence and orchestration

PostgreSQL holds tenants, installations, repositories, provider revisions, normalized changes, impact decisions, runs and durable jobs. Jobs have idempotency keys, leases, bounded attempts, retry scheduling and explicit failure states. The planned uniqueness boundary for a migration is repository + base revision + change identity; a repeated delivery must not publish another PR.

Local artifact storage supports development; an S3-compatible store holds deployment snapshots, patches and logs. Keep large files out of ordinary database rows. Polling and workers must recover after restart. No Redis or separate workflow platform is needed for the initial design.

### 3. Provider ingestion and deterministic analysis

Pinned Stripe snapshot downloads, latest revision discovery and one-shot checks against a retained baseline are implemented through the local CLI. Custom SDK adapters now share the direct-property diff and local analysis pipeline, with provider-scoped change IDs and adapter-sensitive run identity. Background polling and **oasdiff** integration for a complete machine-readable comparison are planned. Replace the current narrow property detector at this boundary; do not expand it into a homegrown full OpenAPI differ.

The scanner then checks manifests and lockfiles, API-version configuration, imports, usages and references. Extend the current analyzer with cross-file symbol flow, typed SDK responses, wrappers and webhook payloads. Preserve uncertainty rather than filtering ambiguous repositories out. The generic worker consumes adapter results so another API provider can be added without rewriting orchestration.

### 4. AI responsibilities

Optional advisory assessment and one-shot AI patch proposals are implemented for the local Stripe pipeline. `--assess` transmits bounded finding context; `--ai-patch` transmits affected files and evidence. Both are explicit opt-ins. Patch proposals are checked locally before they can enter container validation. There is no model tool execution, automatic retry or repair loop. No live model evaluation has been run because credentials/model configuration are absent. The agent design below remains the target for those later capabilities.

Use OpenAI's Responses API behind a single server-side integration with a configurable `OPENAI_MODEL`. Select the deployed model using migration evaluations and measured cost; do not couple business logic to a model name.

Two steps share the same evidence bundle:

1. **Impact assessment:** return a schema-validated decision, affected usage IDs, source references, uncertainty and a proposed migration approach. Reject references not present in the evidence bundle. Schema validity alone does not prove correctness.
2. **Patch generation:** work in an isolated checkout using narrow tools for reading/searching files, applying patches and invoking predefined validation commands. The worker executes tool calls and enforces path, attempt, time and cost limits.

The model receives the provider change, relevant source context, repository configuration and actual tool results. Repository text is untrusted input, not authorization. The model cannot invent a passing check, choose its own publishing permissions, access installation credentials or merge a PR. A refusal, timeout, malformed result or unresolved impact becomes a visible run state.

This design uses [function calling](https://developers.openai.com/api/docs/guides/function-calling) for controlled tools and [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) for validated decisions. No AI is needed to execute the current replay.

### 5. Execution and validation

The local CLI implements baseline and patched command execution against an archived Git commit. It records exit codes, logs, revision, image ID and archive/patch hashes, and distinguishes baseline failure, regression, execution error and stale input. It does not install dependencies, perform repair attempts, or publish results. Configured checks and migration semantics still require human review.

Sandbox workers use disposable non-root containers with resource/time limits, a restricted filesystem and controlled network access. Installation and application credentials stay outside the container. Dependency installation is an explicit sandbox stage. Cleanup runs on success, failure and cancellation. A Docker container alone is not a complete boundary for arbitrary hostile repositories; assess stronger isolation before opening the service broadly.

For the historical example, `charges` is a collection while `latest_charge` identifies the most recent charge. A list-to-single-value replacement may silently change business behavior. The optional deterministic proposal uses the Charges list endpoint filtered by PaymentIntent. It requires review of pagination, expansion, timing and additional request failures; no application validation is claimed. See [Stripe's change documentation](https://docs.stripe.com/changelog/2022-11-15/removes-charges-attribute-paymentintent) and [Charges list reference](https://docs.stripe.com/api/charges/list).

### 6. Publication and product integration

Local review bundles and explicit remote draft publication are implemented. The publisher consumes a fresh validation result in the same CLI process; it does not trust imported reports or bundle manifests. It verifies the remote base, uses the exact changed contents and committed file modes retained by validation, and creates a tree based on the original remote tree. Unrelated files stay intact. Existing migration branches must match the expected tree and single parent; existing PRs, including closed ones, are reused. The CLI never force-pushes or merges. GitHub is exercised with controlled responses; a live repository/token is still needed for remote verification.

The current publisher uses an explicit `GITHUB_TOKEN` on the host. It has bounded requests, no redirects, and keeps full check logs out of the PR. Partial failures can leave remote objects or a branch; retries reconcile a matching candidate. Repeated remote revision checks reduce stale publication but are not an atomic transaction with PR creation. GitHub App ownership, hosted audit state and installation-token lifecycle below remain planned.

Only the publisher owns the short-lived GitHub installation token. It checks installation access, current base revision, passing recorded validation, allowed patch paths and idempotency before pushing a branch and opening a draft PR. A base revision change invalidates earlier validation and requires rerunning. The PR contains the provider source, exact usages, diff explanation and real check results. Refit never auto-merges.

The frontend then renders API-backed runs with loading, empty, failure and cancellation states. Existing illustrative records remain clearly separated from connected repositories.

## Delivery order

1. **Completed:** offline Stripe evidence scan, deterministic replay, tests and run instructions.
2. **Provider ingestion:** pinned real snapshots, provenance, oasdiff, historical corpus and API-version applicability.
3. **Service:** authenticated API, PostgreSQL state/queue, GitHub installation and read-only checkout ingestion; connect actual reports to the workspace.
4. **Execution:** local offline Docker validation is implemented; dependency provisioning, cancellation recovery, hosted workers and broader application evaluations remain planned.
5. **AI:** schema-validated impact assessment, restricted patch tools, bounded repair and fixture-based evaluations.
6. **Publication:** local draft publisher, retry reconciliation and stale-revision checks are implemented; live verification, installation tokens, durable audit trail and service operational limits remain.

The existing CLI functions can be called from a worker, but none of the planned services are implied to exist yet. Keep the current npm layout until multiple deployable packages justify the PRD's proposed workspace migration.
