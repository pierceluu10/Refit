# Refit

The agent that keeps your API integrations up to date.

Refit is being built to turn external API changes into repository-specific, validated draft pull requests. Engineers retain the final review and merge decision.

## Current release

A working frontend with:

- A responsive landing page with text entrances and an animated migration diagram.
- An interactive walkthrough with affected, unaffected, and failed-validation scenarios.
- Product documentation and a downloadable full specification.
- A sample workspace with repository search, URL-backed filters, impact evidence, and migration-run details.
- A configuration builder that copies or downloads a valid example `refit.yml`.
- Keyboard-accessible mobile navigation and reduced-motion support.

**The workspace is a frontend preview.** Its data remains illustrative. A separate local Stripe pipeline analyzes repositories and supplied OpenAPI snapshots, proposes migration patches, and can validate checks in Docker; it is not connected to the UI. Optional AI assessment and patch proposals are implemented but have not been verified with a live model. There is no live GitHub installation, provider monitoring, iterative repair agent or PR publication. The configuration builder produces a file locally; it does not apply settings to a remote repository.

## Stripe pipeline

```sh
npm run stripe:replay
npm run stripe:scan -- --repository /path/to/repo --before /path/to/before.json --after /path/to/after.json
```

The replay uses curated fixtures for Stripe's historical `PaymentIntent.charges` removal. The scan accepts real local repositories and OpenAPI 3 JSON snapshots, detects direct schema-property removals, traces supported Stripe calls, and produces JSON evidence with source locations and input hashes. It requires no API key and does not execute or change the scanned repository. Use `--output /path/to/new-report.json` to save a report without overwriting existing files.

This is a bounded impact analyzer, not a complete OpenAPI differ or migration agent. Unresolved code requires review; absence of a match never proves safety. See [the architecture and capability inventory](docs/ARCHITECTURE.md) for exact coverage, the full AI architecture and delivery order.

### Optional AI assessment

Set `OPENAI_API_KEY` and `OPENAI_MODEL` in your local environment, then add `--assess` to `stripe:scan`, `stripe:replay`, or `stripe:validate`. Choose a model that supports Responses API structured outputs; Refit does not select one automatically.

```sh
npm run stripe:replay -- --assess
```

This explicitly sends detected changes, finding metadata, and up to three source lines on either side of each finding to OpenAI. Source context can contain sensitive values; inspect your input before enabling it. The ordinary offline workflow makes no model request. Assessment uses a single request with `store: false`, a 60-second timeout, a 64 KiB evidence limit and a 4,096 output-token limit, with no automatic retries. `store: false` is not a claim of zero data retention.

The response is advisory: it can suggest a migration or request review, but it cannot mark code safe, modify the deterministic findings, edit files, execute checks or publish. Refit validates the result and requires every cited finding ID to exist in the supplied evidence. A migration candidate must cite a confirmed finding. Refusals, incomplete responses, invalid references and API failures stop the command with an explicit error. Assessment evidence and its hash are saved with the report; review bundles include the advisory result.

The integration has been exercised with controlled API responses, not a live model call: this environment has no configured API key or model. See [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) for the API contract used here.

### Optional AI patch proposals

With the same environment configuration, use `--ai-patch` to select model-generated edits instead of the deterministic migration rule:

```sh
npm run stripe:replay -- --ai-patch
```

This sends the complete source files containing confirmed findings, plus impact evidence, to OpenAI. The same 64 KiB request-evidence limit applies. Each edit must reference a confirmed finding, match exactly one existing source string, and cover that finding's location. Refit rejects edits outside the supplied file set, overlapping replacements, unchanged replacements and syntactically invalid resulting code. It rescans the proposed code and reports remaining findings; disappearing findings are not proof of behavioral correctness.

Use `stripe:validate --ai-patch` with your image and check command to apply the proposal only in the disposable copy and run baseline/patched checks. Add `--bundle` to export the exact model-generated diff and validation evidence. `--assess` is independent and adds a separate advisory model call if both flags are selected. A no-edit model response is reported as unsupported by the scan; validation stops because there is no patch to test. No repair loop, model tool execution or automatic publication is implemented.

Tests cover controlled model output through actual Docker validation. Live generation quality remains unverified, and semantic review is required even when tests pass.

### Propose a migration

```sh
npm run stripe:replay -- --propose-patch
```

The report's `patch.diff` contains a Git-compatible unified diff. It proposes replacing a direct `return intent.charges.data` with `(await stripe.charges.list({ payment_intent: intent.id })).data`, using the locally traced client. Only a one-argument PaymentIntent retrieval and a direct return in the same async function are supported. Other findings remain counted as unresolved.

The proposal needs review: it adds a network request, uses default pagination, and can change error, timing and expansion behavior. No repository files are modified, no application tests are executed, and the report explicitly records `validation: not-run`. The diff contains source code; check it before sharing. Test coverage verifies Git application and executes the migrated fixture against a controlled Stripe client; that is not validation of your application's behavior.

### Replay real upstream specifications

Download pinned Stripe OpenAPI revisions, then pass the resulting snapshots to the same scanner:

```sh
npm run stripe:snapshot -- --revision da4ef11c8691eb41e6b2a8d86c13343a973633e4 --output /tmp/refit-before.json
npm run stripe:snapshot -- --revision 37236d21d9ef0c3e109e26f7a398c783ca1dde8c --output /tmp/refit-after.json
npm run stripe:scan -- --repository pipeline/fixtures/repository --before /tmp/refit-before.json --after /tmp/refit-after.json --propose-patch
```

These are upstream commits from November 10 and November 17, 2022. This replay uses real specifications and the local sample codebase. Replace `--repository` with your own repository to scan real application code. Downloads require network access; subsequent scans work offline. Choose new output paths if these already exist.

Snapshots preserve the original JSON text, its SHA-256 hash, full commit SHA and upstream URL in one JSON artifact. The scanner checks this structure and content hash before processing it, and includes provenance in the report. This detects accidental modification; it is not a cryptographic signature proving origin. Only full commit SHAs are accepted, downloads are bounded and redirects are refused. API-version applicability, scheduled monitoring and complete OpenAPI comparison remain future work.

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

| Route | Surface |
| --- | --- |
| `/` | Landing page |
| `/demo` | Interactive workflow; accepts `?scenario=affected`, `unaffected`, or `failed` |
| `/docs` | Product documentation |
| `/app` | Sample workspace overview |
| `/app/repositories` | Searchable and filterable sample repositories |
| `/app/repositories/:id` | Repository-specific impact evidence |
| `/app/changes` | Sample provider change |
| `/app/changes/:id` | Change detail and repository impact |
| `/app/runs` | Successful and failed sample runs |
| `/app/runs/:id` | Timeline, diff, validation, and review; selected view is stored in `?tab=` |
| `/app/settings` | Repository configuration builder |

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
