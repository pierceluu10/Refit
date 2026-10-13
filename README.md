# Refit

The agent that keeps your API integrations up to date.

Refit is being built to turn external API changes into repository-specific, validated draft pull requests. Engineers retain the final review and merge decision.

## Current release

**Local agent 0.8:** `refit serve` runs approved App-managed repository profiles and verifies installation webhooks. `refit watch` and service profiles can track manually selected public changelog pages or RSS 2.0/Atom feeds beside OpenAPI, save hash-verified text diffs, and report documentation-only changes without spending on AI or creating PRs. `refit prepare` installs locked public npm dependencies in a restricted container so supported projects can run checks offline without a hand-built dependency image. The shared engine still requires provider mappings and meaningful checks for each integration. [Run the Stripe service profile](docs/DEPENDENCIES.md), or [set up installation webhooks](docs/LOCAL-SERVICE.md).

`refit doctor` inspects a checked-in `.refit.json` or an operator workflow before activation, explaining Git, contract, mapping, API-version, preparation and Docker setup without running app code or spending on AI. `refit enroll` reviews its committed workflow, baseline and adapter, then records explicit approval outside Git. The App-managed service verifies those inputs before each poll and stops changed configuration for review. See [repository setup](docs/REPOSITORY-SETUP.md) and [App onboarding](docs/APP-ONBOARDING.md).

The core is shared across providers; an actual OpenAI SDK conformance evaluation complements Stripe. SDK mappings, migration semantics and application checks still need verification. This is a local operator product, not a hosted service automatically activated by installing the App.

A working frontend with:

- A responsive landing page with text entrances and an animated migration diagram.
- An interactive walkthrough with affected, unaffected, and failed-validation scenarios.
- Product documentation and a downloadable full specification.
- A sample workspace with repository search, URL-backed filters, impact evidence, and migration-run details.
- A configuration builder that copies or downloads a valid example `refit.yml`.
- Keyboard-accessible mobile navigation and reduced-motion support.

**The workspace is a frontend preview.** Its data remains illustrative. A separate local pipeline analyzes repositories and supplied OpenAPI snapshots, proposes migration patches, validates checks in Docker, and can explicitly publish a draft PR; it is not connected to the UI. Optional AI assessment, patch proposals and bounded repair are implemented. A live AI migration, one repair and GitHub draft publication have been verified against the independent billing demo; live assessment quality and broader repair reliability remain unverified. The installed GitHub App supports bot publication, and `watch` supports local polling. Hosted installation enrollment remains planned. The configuration builder produces a file locally; it does not apply settings to a remote repository.

## Stripe pipeline

### Install the local CLI

From a checkout with dependencies installed, build an installable archive:

```sh
npm run package:cli
npm install --global ./dist-cli/refit-0.8.0.tgz
refit --help
refit replay --propose-patch
```

The build creates a new `dist-cli` directory and refuses to replace existing output. Use `npm run package:cli -- --output /path/to/new-directory` for another build. The archive contains agent sources, example fixtures and CLI docs, with every CLI runtime dependency pinned to the installed version used to build it. Installation may download their dependencies. It excludes the frontend and tests. This is a local archive; no package has been published to npm.

The executable works from any directory and ignores that directory's TypeScript configuration. Use `refit scan`, `run`, `validate`, `stripe-snapshot`, `source-snapshot` and `stripe-check` for the main pipeline commands. `refit replay` locates its own bundled fixtures. In a checkout, use `npm run refit -- <command>`. See [CLI usage](docs/CLI.md) for installed-command examples and requirements.

Save repeated repository/specification/image/check inputs in a JSON run configuration, then use `refit run --config run.json --output /tmp/new-run`. Set `apiVersion` to the API version the application actually uses; automated runs compare it with the before OpenAPI `info.version` and stop for review when missing or different, before any AI request or Docker validation. This is an explicit operator pin, not an SDK-version guess. `--env .env` explicitly loads credentials and `--quiet` suppresses progress on stderr; final stdout is readable in terminals and JSON when redirected (`--human` and `--json` override it). AI and publication remain explicit flags. The checkout includes `examples/billing-demo.refit.json` for the adjacent independent evaluation application and its prepared Docker image.

The isolated-install test builds a fresh archive, installs it into a temporary prefix, executes its bin entry and runs replay without this checkout's `node_modules`. Enable it with `REFIT_PACKAGE_INSTALL=1 npm test`; it may access the npm registry. No global install or registry publication occurs during tests.

### Run the complete local workflow

To demonstrate the whole local migration with bundled application code, run:

```sh
npm run refit -- demo --image node:22-alpine --output /tmp/new-refit-demo
```

This requires Docker, a locally available Node image and npm registry access or cache. It installs the actual Stripe 10.17.0 SDK into a disposable synthetic application, demonstrates the old API passing and the new API breaking, then generates a patch and validates both contracts in restricted Docker containers. The API is simulated on loopback; no Stripe account, AI key or GitHub publication is involved. Review the retained `migration/report.json`, `migration/migration.patch` and `migration/pull-request.md`. Enable the automated end-to-end demo test with `REFIT_STRIPE_SDK=1 REFIT_DOCKER_IMAGE=node:22-alpine npm test`.

```sh
npm run api:run -- \
  --repository /absolute/path/to/clean-git-repository \
  --before /tmp/refit-before.json --after /tmp/refit-after.json \
  --output /tmp/new-refit-run \
  --image your-local-validation-image --command '["npm","test"]'
```

This stages immutable input copies, scans for impact, proposes a patch, runs baseline and patched checks in Docker, and saves a review bundle in one invocation. Add `--ai-patch` and/or `--assess` to use the configured OpenAI model during validation. Add `--publish-draft --github owner/repository --base main` to publish after the existing validation and remote-revision gates pass. AI and GitHub configuration, transmission scope and verification limitations are described below.

Both checks normally use `--command`. An explicit `--baseline-command '<JSON argument array>'` can check the original code against an old contract while `--command` checks the patch against the new contract, as the demo does. Both commands appear in validation evidence and PR text. Different contracts require review and do not prove equivalent regression coverage. Repairs keep these commands fixed.

Use `npm run refit -- verify --directory /tmp/new-refit-run` to check saved artifact hashes and byte counts against their manifest. This read-only command rejects missing, changed, linked, duplicate or unlisted entries. It verifies consistency with an unsigned manifest, not authenticity, completeness, successful checks or migration correctness; failed-run evidence can verify too. See [CLI usage](docs/CLI.md) for limits.

For automatic Stripe revision discovery, replace `--after /tmp/refit-after.json` with `--latest-stripe`; `--before` must then be a pinned Refit snapshot. For another configured SDK, use two supplied specifications and `--provider-config adapter.json`. The workflow preserves a copy of the selected adapter, does not advance the baseline, and never changes the original repository.

The output directory must be new, outside the scanned repository, with an existing parent. It contains copied specifications, `scan.json`, then `report.json`, `migration.patch` and `pull-request.md` when validation completes. Successful publication adds `publication.json`. A final `manifest.json` records the stopping stage, status, error when present, and hashes of completed artifacts. A directory without a valid manifest is incomplete. Setup/network failures retain completed evidence rather than claiming success. A publication failure may leave a remote branch or PR; rerun into a new output directory to reconcile the candidate.

| Workflow status     | Meaning                                                                                     | Exit |
| ------------------- | ------------------------------------------------------------------------------------------- | ---- |
| `needs-review`      | No confirmed supported usage, no deterministic rule, or unresolved findings; no publication | 2    |
| `validation-failed` | Baseline, patched checks, execution or revision freshness failed                            | 2    |
| `validated`         | Both checks passed with zero unresolved detected findings; publication not requested        | 0    |
| `draft-created`     | GitHub returned a new draft PR                                                              | 0    |
| `existing-pr`       | Reused the matching PR; inspect `publication.json` for its current open/closed/draft state  | 0    |
| `error`             | Input, setup, model, network or publication error                                           | 1    |

No-match results remain review-required, and passing tests do not prove migration semantics. The preflight scan makes no model calls; validation rescans a clean committed snapshot before generating the tested proposal. Workflow tests cover real Docker checks, failure gates and controlled GitHub responses. A live AI patch was validated against the billing demo; broader model evaluations remain outstanding. The [live PR evaluation](docs/PR-EVALUATION.md) records draft publication and one successful repair on the billing demo. This one-shot command also powers the persistent local `watch` worker; hosted scheduling remains planned.

### Scan without executing repository code

```sh
npm run stripe:replay
npm run stripe:scan -- --repository /path/to/repo --before /path/to/before.json --after /path/to/after.json
```

The replay uses curated fixtures for Stripe's historical `PaymentIntent.charges` removal. The scan accepts real local repositories and OpenAPI 3 JSON snapshots, detects direct schema-property removals, traces supported Stripe calls, and produces JSON evidence with source locations and input hashes. It requires no API key and does not execute or change the scanned repository. Use `--output /path/to/new-report.json` to save a report without overwriting existing files.

An additional [real-SDK contract fixture](pipeline/fixtures/stripe-sdk/README.md) installs Stripe **10.17.0** and **19.1.0** and runs their actual HTTP clients against a simulated loopback API. For each version, it verifies the old code works before the field removal, fails afterward, and works after applying Refit's generated patch. It checks the exact Charges list request and preserves both returned charge IDs. Run `REFIT_STRIPE_SDK=1 npm test` to include these tests; package installation may use the npm registry. This does not exercise Stripe's live service or a production application.

Dependency evidence includes manifest ranges and, when available, recorded SDK versions from a root `package-lock.json` v2/v3. The importer declaration must match the manifest; the nearest package entry takes precedence over a hoisted entry. Reports and review bundles retain lockfile hashes and package paths without registry URLs. Changing the lockfile changes the run identity. The real-SDK tests also check this evidence against npm-generated lockfiles.

This reads the recorded graph; it does not verify installation, range satisfaction or API-version applicability. Missing/stale entries, aliases, linked packages, unsupported lock versions and the presence of `npm-shrinkwrap.json` produce unknown version evidence. Shrinkwrap selection depends on npm version. Nested lockfiles and Yarn, pnpm and Bun formats are not resolved. Root npm lockfiles share the scanner's 2 MiB per-file and 50 MiB total limits; malformed JSON fails explicitly.

This is a bounded impact analyzer, not a complete OpenAPI differ or migration agent. Unresolved code requires review; absence of a match never proves safety. See [the architecture and capability inventory](docs/ARCHITECTURE.md) for exact coverage, the full AI architecture and delivery order.

`const` does not make SDK clients or responses immutable. The scanner downgrades detected property writes/deletes, updates, mutations through aliases, and references passed to functions or stored in objects/arrays to review. Replacing a client method also invalidates response evidence derived from that client. These findings cannot drive deterministic patches or serve as confirmed AI edit targets. This check is intentionally flow-insensitive: even a later write or a harmless helper receiving a field can prevent confirmation. It is not full interprocedural mutation analysis; dynamic behavior and unresolved module effects remain unsupported.

Clients declared with `export const` can be consumed through direct relative named imports, including renamed imports. Resolution uses only scanned files: exact source paths, unique extensionless file/index paths, and unambiguous `.js` → `.ts` equivalents (also JSX, MJS and CJS counterparts). Ambiguous source/output pairs are not guessed. Mutations through supported imports downgrade all linked usage; namespace imports, re-exports and default exports of a shared client also require review. Default client imports, tsconfig path aliases, package exports, factory wrappers and dynamic imports are not traced. The real-SDK fixture exercises a separate client module through scan, patch generation and Docker validation.

Returning, yielding or throwing an entire client/response binding also prevents confirmation, including concise getters and conditional branches. Returning an SDK resource exposes the shared client as well, even through a mutable alias. Ordinary response-field returns remain eligible for the narrow migration rule; this is conservative reference tracking, not a proof of arbitrary object or closure behavior.

### Configure another SDK

`api:scan` and `api:validate` accept `--provider-config adapter.json`. Omitting it uses the built-in Stripe adapter; the existing `stripe:*` scripts remain available. A custom adapter declares the SDK package, constructor imports, and the schema returned by each supported resource/method pair:

```json
{
  "id": "catalog-example",
  "packageName": "@example/catalog",
  "defaultImport": false,
  "namedExport": "Catalog",
  "operations": [{ "resource": "items", "method": "retrieve", "schema": "item" }],
  "propertyRenames": [
    { "schema": "item", "removed": "legacy_label", "replacement": "display_label" }
  ]
}
```

Before scanning, Refit checks that every configured operation resolves through local `$ref`s to a supported object schema in the before specification. Missing, composed or external response schemas fail with the operation name so an adapter typo cannot silently look like no impact. An optional `operationId` maps an SDK method to exactly one operation in the before contract. With `--full-diff`, Refit joins unresolved breaking changes from `oasdiff` to that operation's path and HTTP method, then reports matching call sites and change details. A removed operation is reported even when its removal is classified as non-breaking after deprecation. Unconfigured endpoint and response migrations remain review-only; they stop automatic generation, validation and publication until a supported rule exists. This supports immutable ESM constructors and `await client.resource.method(...)` calls returning one mapped schema, including local response aliases and transparent one-parameter wrappers imported directly from relative modules. It does not automatically discover SDK semantics or support arbitrary fetch calls, factory clients, nested resources, transformed or multi-step wrappers, or other languages. You must verify each mapping against the SDK. A confirmed finding means traced under that supplied mapping, not independently verified SDK behavior.

An optional `operationReplacements` mapping can change a retired SDK resource/method to an explicit replacement after the old endpoint disappears and a newly introduced endpoint has the same supported recorded contract. Refit follows local references and compares parameters, bodies, responses, servers and security; it preserves call arguments and requires all tracked usages to be supported. The mapping remains operator-authored, and the SDK/API-version rollout still needs review. The complete [endpoint migration guide](docs/ENDPOINT-MIGRATIONS.md) includes an offline HTTP reproduction and exact limits.

`refit adapter-suggest` offers an optional, budgeted OpenAI proposal for a new provider adapter. It sends only direct SDK call names and a bounded OpenAPI operation inventory, validates the returned IDs and schemas locally, and writes a new adapter file for human review. It does not validate SDK semantics or activate the adapter automatically. See [CLI usage](docs/CLI.md#refit-local-agent) for its supported call shape and limitations.

Custom adapters use supplied OpenAPI JSON/YAML or a pinned snapshot from a user-supplied public HTTPS URL or local file. Stripe remains the only provider with automatic upstream revision discovery. The complete adapter is recorded in the report and included in run identity. An optional `propertyRenames` mapping can propose direct property-read edits when the removed field and newly added replacement are both the same simple OpenAPI scalar type (`string`, `integer`, `number` or `boolean`). Reads can follow direct component-schema `$ref`s through nested objects, immutable aliases, literal numeric indexes, `const` `for...of` bindings, and inline callbacks to common array iteration methods when the item parameter is a single identifier. This is an operator-authored semantic assumption: matching types do not establish equivalent meaning, API-version applicability or runtime behavior. String-indexed or destructured reads of the removed field can be reported but are not auto-edited; dynamic array indexes, mutable loop bindings, named or multi-parameter callbacks, transformed array chains, inline/composed/external array schemas and other unsupported source shapes remain for review. Validation still depends on meaningful application checks. Providers without an applicable mapping can use `--ai-patch` for a reviewed proposal. Assessment, AI patch checks, Docker validation and review bundles carry the selected adapter. The synthetic [catalog fixture](pipeline/fixtures/catalog/README.md) and real-SDK [OpenAI fixture](pipeline/fixtures/openai/README.md) exercise the shared path with simulated contracts; neither claims a real second-vendor API migration.

### Optional AI assessment

Set `OPENAI_API_KEY` and `OPENAI_MODEL` in your local environment, then add `--assess` to `stripe:scan`, `stripe:replay`, or `stripe:validate`. Choose a model that supports Responses API structured outputs; Refit does not select one automatically.

```sh
npm run stripe:replay -- --assess
```

This explicitly sends detected changes, finding metadata, and up to three source lines on either side of each finding to OpenAI. Source context can contain sensitive values; inspect your input before enabling it. The ordinary offline workflow makes no model request. Assessment uses a single request with `store: false`, a 60-second timeout, a 64 KiB evidence limit and a 4,096 output-token limit, with no automatic retries. `store: false` is not a claim of zero data retention.

The response is advisory: it can suggest a migration or request review, but it cannot mark code safe, modify the deterministic findings, edit files, execute checks or publish. Refit validates the result and requires every cited finding ID to exist in the supplied evidence. A migration candidate must cite a confirmed finding. Refusals, incomplete responses, invalid references and API failures stop the command with an explicit error. Assessment evidence and its hash are saved with the report; review bundles include the advisory result.

Advisory assessment has controlled-response tests; live assessment quality remains unverified. Live patch evaluation is recorded separately below. See [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) for the API contract used here.

### Optional AI patch proposals

With the same environment configuration, use `--ai-patch` to select model-generated edits instead of the deterministic migration rule:

Patch evidence also includes up to 12 relative-import modules as read-only context, so the model can inspect wrapper signatures and existing client exports. These modules cannot be edited unless they independently contain confirmed findings. Relative-import resolution follows the scanner's ambiguity rules; the existing total input-size limit still applies.

The [live AI evaluation](docs/AI-EVALUATION.md) records a successful `gpt-5.4-mini` migration of the independent billing application, along with rejected proposals and a pagination bug caught by stronger checks. This verifies one simulated migration, not general model reliability. A subsequent [live PR evaluation](docs/PR-EVALUATION.md) verified draft publication and one bounded repair.

```sh
npm run stripe:replay -- --ai-patch
```

This sends the complete source files containing confirmed findings, plus impact evidence, to OpenAI. The same 64 KiB request-evidence limit applies. When a watch migration runs with `--ai-patch`, Refit also attaches the saved HTML, Markdown or plain-text vendor snapshot; oversized notes are truncated and marked, and feed entries are left in the review diff. See [vendor notes](docs/VENDOR_NOTES.md). Each edit must reference a confirmed finding, match exactly one existing source string, and cover that finding's location. Refit rejects edits outside the supplied file set, overlapping replacements, unchanged replacements and syntactically invalid resulting code. It rescans the proposed code and reports remaining findings; disappearing findings are not proof of behavioral correctness.

Use `stripe:validate --ai-patch` with your image and check command to apply the proposal only in the disposable copy and run baseline/patched checks. Add `--bundle` to export the exact model-generated diff and validation evidence. `--assess` is independent and adds a separate advisory model call if both flags are selected. A no-edit initial model response is reported as unsupported by the scan; validation stops because there is no patch to test. The model has no tool execution or publication permissions.

### Optional bounded repair

Add `--ai-patch --repair-attempts 1` to `api:run` or `api:validate` to allow one repair request after a failing patched check. The default is zero; the hard maximum is two additional proposals after the initial proposal. Each request uses the same configurable model and existing 60-second, 64 KiB evidence and 4,096 output-token limits. API failures and refusals are not retried automatically.

Repair explicitly sends the previous failed diff and up to 4,096 characters from each check output stream to OpenAI, in addition to the original affected source/evidence. A truncation flag records omitted output. Logs can contain application data; enabling repair authorizes this additional transmission. Full check output remains in the local report.

Only a passing baseline and an ordinary failing patched check can trigger repair. Baseline failures, execution errors and changed source revisions stop it. Each candidate is a complete proposal against the original source, tied to the original confirmed findings and subjected to the same scope, exact-match, overlap and syntax checks. It is applied to a fresh archive copy and checked in a fresh container. The command, image and baseline stay fixed. A repeated proposal, no-edit response, invalid edit or exhausted limit stops repair. Failed repair preserves the last tested candidate and its failing status; it never invents success.

The report includes every tested diff, its hash, check output, response ID, and the repair count/stop reason. The final patch and publication files always correspond to the last tested candidate. Publication still requires passing checks, zero unresolved detected findings and a matching remote base. This is bounded proposal regeneration, not an agent with unrestricted tools or a guarantee that the model preserves semantics.

Tests cover controlled model output through actual Docker validation. The [live PR evaluation](docs/PR-EVALUATION.md) also verified one model repair after a pagination failure. This does not establish broader generation quality; semantic review remains required.

### Propose a migration

```sh
npm run stripe:replay -- --propose-patch
```

The report's `patch.diff` contains a Git-compatible unified diff. Direct local `return intent.charges.data` migrations use `(await stripe.charges.list({ payment_intent: intent.id })).data`. Refit also traces transparent one-parameter wrappers through direct relative named imports. A narrow guarded-history rule retains the initial retrieval, removes the obsolete missing-field guard and collects all pages using the proven client's async Charges iterator. Request options, transformed wrappers and other shapes require review. Remaining findings are counted by rescanning the proposed code.

The proposal needs review: it adds a network request, uses default pagination, and can change error, timing and expansion behavior. No repository files are modified, no application tests are executed, and the report explicitly records `validation: not-run`. The diff contains source code; check it before sharing. Test coverage verifies Git application and executes the migrated fixture against a controlled Stripe client; that is not validation of your application's behavior.

The [independent billing evaluation](docs/BILLING-EVALUATION.md) verifies the new guarded-history migration against both HTTP simulator contracts, unchanged billing tests, strict TypeScript, multi-page history and Refit's offline Docker workflow. Scan-only reports still record `validation: not-run`; workflow reports retain the actual check outcomes. Direct-return migrations use default pagination; guarded-history migrations collect all pages.

### Publish a validated draft PR

Set `GITHUB_TOKEN` in your environment with repository **Contents: write** and **Pull requests: write** permissions for the intended target. Then explicitly add publication to a fresh validation run:

```sh
npm run api:validate -- \
  --repository /absolute/path/to/clean-git-repository \
  --before /tmp/refit-before.json --after /tmp/refit-after.json \
  --image your-local-validation-image --command '["npm","test"]' \
  --output /tmp/new-validation-report.json \
  --publish-draft --github owner/repository --base main
```

This sends changed source files and a review description to the selected GitHub repository. It requires both checks to pass, zero unresolved detected findings, and the remote base to match the validated commit. These gates do not prove migration semantics or test quality. Review the diff, source evidence and configured checks before enabling publication. `--ai-patch` and `--provider-config` work with the same command.

Refit builds a Git tree on the existing remote base, preserving unrelated files and the changed files' committed executable modes. It creates a deterministic `refit/…` branch and a **draft** PR. It never force-updates a branch, merges, or reopens a closed PR. Retries reuse a matching branch/PR; a branch with unexpected contents or parents is rejected. A base change requires fresh validation. Base/head checks are repeated before publication, but GitHub does not provide an atomic transaction across those reads and PR creation; reviewers must still check the current base.

The token remains in the host publisher and is not sent to OpenAI or Docker. Full check logs stay local. The command only accepts freshly generated validation, not a saved report or unsigned bundle. The saved report remains pre-publication evidence; the final stdout object supplies the PR URL and whether it was created or reused. Setup, API or publication failures exit 1; partial failures can leave a branch or unreferenced Git objects. Rerun with a new output path to reconcile the same candidate. With AI enabled, a newly generated different patch has a different branch identity.

Currently this supports `github.com`, an existing same-repository base commit, and either an explicitly supplied personal token or a registered GitHub App. The standalone publisher does not install the App or upload local-only base history. Use `watch --sync-github` for managed repository fetching and local polling; hosted installation enrollment remains planned. Publication is covered by controlled GitHub responses for successful drafts, stale revisions, collisions, retries and concurrency; a [live draft PR](https://github.com/pierceluu10/refit-billing-demo/pull/1) was also verified against the independent simulated billing app.

You can also publish under a GitHub App bot identity using `--github-app`, `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_FILE`. Refit signs a JWT and obtains a short-lived installation token scoped to the chosen repository, verifies the bot identity, and uses its noreply email for commit authorship. Register and install the App once and upload its logo in GitHub settings; existing PR authors cannot be renamed. See [App setup](docs/GITHUB-APP.md) and [running AI on a test repository](docs/TEST-REPOSITORIES.md). This authentication mode is tested with real RSA signing and controlled API responses; live App publication requires those external settings.

### Replay real upstream specifications

Download pinned Stripe OpenAPI revisions, then pass the resulting snapshots to the same scanner:

```sh
npm run stripe:snapshot -- --revision da4ef11c8691eb41e6b2a8d86c13343a973633e4 --output /tmp/refit-before.json
npm run stripe:snapshot -- --revision 37236d21d9ef0c3e109e26f7a398c783ca1dde8c --output /tmp/refit-after.json
npm run stripe:scan -- --repository pipeline/fixtures/repository --before /tmp/refit-before.json --after /tmp/refit-after.json --propose-patch
```

These are upstream commits from November 10 and November 17, 2022. This replay uses real specifications and the local sample codebase. Replace `--repository` with your own repository to scan real application code. Downloads require network access; subsequent scans work offline. Choose new output paths if these already exist.

### Check the latest upstream revision

Create a baseline at the latest specification revision, or use a pinned snapshot corresponding to the integration you want to compare:

```sh
npm run stripe:snapshot -- --latest --output /tmp/refit-baseline.json
npm run stripe:check -- \
  --repository /absolute/path/to/repository \
  --baseline /tmp/refit-baseline.json \
  --output /tmp/new-refit-check --propose-patch
```

`--latest` discovers the most recent commit touching `openapi/spec3.json` on Stripe's default branch, then downloads using that immutable SHA. Discovery uses the public GitHub API without credentials, with bounded requests and explicit rate-limit errors. This is the published specification, not proof that your account or SDK uses that API version.

`stripe:check` discovers the revision again, downloads it if different, and scans the local repository against the supplied baseline. It saves `before.json`, `after.json`, `report.json`, and a final `manifest.json` with content hashes in a new private directory outside the scanned repository. It rescans local code even when upstream is unchanged. `upstream: unchanged` describes specification content only; it never means the code is safe.

The baseline is never advanced automatically. Keep using it until you have reviewed or migrated the relevant changes, then explicitly choose a newer baseline. Starting from today's snapshot does not detect migrations that happened before that snapshot. Checks compare the two endpoints; intermediate changes that were later reverted are not replayed. Failed checks remove the newly created directory and leave the baseline intact; an interrupted run without a manifest is incomplete. Existing output is never replaced. Exit 0 means the check completed, including when it found affected code; exit 1 means failure.

This is a one-shot discovery-and-scan command, not a background scheduler. To validate or publish its proposal, use `api:validate` with the saved `before.json` and `after.json`, plus your Docker command and optional publication flags. A real upstream discovery and both unchanged/changed paths have been exercised against the sample repository; see [upstream evidence](docs/UPSTREAM-REPLAY.md).

Snapshots preserve the original JSON text, its SHA-256 hash, full commit SHA and upstream URL in one JSON artifact. The scanner checks this structure and content hash before processing it, and includes provenance in the report. This detects accidental modification; it is not a cryptographic signature proving origin. Downloads resolve to full commit SHAs, are bounded, and refuse redirects. API-version applicability is checked only against an explicit operator pin; an upstream snapshot alone cannot establish which API version an application uses. The local `watch` worker and optional oasdiff contract comparison are available; see [automation](docs/AUTOMATION.md).

## Develop

### Validate a proposed migration in Docker

```sh
npm run stripe:validate -- \
  --repository /absolute/path/to/clean-git-repository \
  --before /tmp/refit-before.json --after /tmp/refit-after.json \
  --image your-local-validation-image \
  --command '["npm","test"]' \
  --output /tmp/refit-validation.json
```

This runs the chosen command against separate baseline and patched copies of committed `HEAD`. The repository must be clean and must not contain tracked symlinks or submodules. The report binds results to the commit, archive hash, patch hash, command and immutable local image ID. If the original checkout changes during the run, validation is marked stale. Original repository files are never patched.

The image must already exist locally and contain the tools/dependencies your command needs. Refit does not pull images or install dependencies during validation. Containers run without networking, host environment variables, Git metadata or the Docker socket. All archived tracked files are copied, so committed credentials would still be present. The source mount and container root are read-only; disposable writable directories support checks. Each check is limited to 120 seconds, 1 MiB per output stream, 1 CPU, 1 GiB memory and 128 processes. Containers and temporary files are removed after each run. This is local Docker isolation, not a hardened multi-tenant execution service.

Validation distinguishes `passed`, `baseline-failed`, `regression`, `error` and `stale`. Exit code 0 means both checks passed on the same revision, 2 means a completed validation did not pass, and 1 means setup/input/output failure. Passing the configured command does not prove complete migration correctness or authorize publication. Logs may contain application output; review artifacts before sharing.

Replace `--output` with `--bundle /tmp/new-refit-review` to export a private review directory containing:

- `migration.patch`: the exact diff tested in the patched container.
- `report.json`: scan evidence, provenance, input hashes and full check results.
- `pull-request.md`: a draft PR description with validation status, affected usage, limitations and review requirements.
- `manifest.json`: file sizes and SHA-256 hashes, the source revision, and an explicit unpublished status.

The bundle directory must not already exist. Choose an output location outside the scanned repository to keep its working tree clean. Failed validations also produce bundles, clearly labeled with the failure; they retain exit code 2. Bundles are local artifacts and do not push a branch or open a PR. Hashes detect content changes relative to the manifest; they are not signatures or proof of trusted execution. If a process is interrupted while writing, a missing or invalid manifest means the bundle is incomplete.

Container integration tests are opt-in and require a local Node image:

```sh
docker pull node:22-alpine
REFIT_DOCKER_IMAGE=node:22-alpine npm test
```

They execute a controlled Stripe fixture in actual containers, including successful migration, regression and baseline failure cases. The standard test run skips container-dependent cases.

## Frontend development

Use Node.js 22.12+ or a newer supported Node.js release.

```sh
npm ci
npm run dev
```

Vite prints the local address, normally `http://127.0.0.1:5173`. No environment variables or API keys are required for the frontend.

```sh
npm test          # Behavior tests with verbose output
npm run typecheck
npm run build    # Typecheck and generate dist/
npm run preview  # Inspect the production build locally
npm run format
npm run format:check
```

## Routes

| Route                   | Surface                                                                       |
| ----------------------- | ----------------------------------------------------------------------------- |
| `/`                     | Landing page                                                                  |
| `/demo`                 | Interactive workflow; accepts `?scenario=affected`, `unaffected`, or `failed` |
| `/docs`                 | Product documentation                                                         |
| `/app`                  | Sample workspace overview                                                     |
| `/app/repositories`     | Searchable and filterable sample repositories                                 |
| `/app/repositories/:id` | Repository-specific impact evidence                                           |
| `/app/changes`          | Sample provider change                                                        |
| `/app/changes/:id`      | Change detail and repository impact                                           |
| `/app/runs`             | Successful and failed sample runs                                             |
| `/app/runs/:id`         | Timeline, diff, validation, and review; selected view is stored in `?tab=`    |
| `/app/settings`         | Repository configuration builder                                              |

Deploy `dist/` to a static host with SPA fallback to `index.html` for application routes. Do not rewrite asset requests. The development and preview servers provide this routing behavior locally.

## Project structure

```text
src/
  components/       Shared branding, navigation, walkthrough, and controls
  pages/            Landing, demo, docs, workspace, activity, and settings
  configuration.ts  Validated configuration generation
  data.ts           Explicitly illustrative frontend data
  test/             Browser API mocks and test setup
pipeline/           Local Stripe scanner, CLI, fixtures and integration tests
docs/ARCHITECTURE.md Current implementation and full target architecture
docs/PRD.md         Full product and UI/UX requirements
PRODUCT.md          Product truth and scope
DESIGN.md           Implemented design tokens and visual guidance
```

The frontend uses React, TypeScript, Vite, React Router, native CSS animation, Phosphor icons, and locally bundled Geist fonts. Screenpipe and Nango informed the UI/UX only; their code and assets were not copied.

See the [product requirements document](docs/PRD.md) for the planned migration pipeline and [verification notes](docs/VERIFICATION.md) for the checks performed on this frontend.
