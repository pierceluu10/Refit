# Refit local agent

Refit compares API specifications with local TypeScript/JavaScript usage, proposes reviewable migrations, validates them in Docker, and optionally opens a GitHub draft PR. This is an experimental local agent, not automatic support for every API or codebase.

Requires Node.js 22.12+ or a supported newer release. Scanning needs no API key or Docker. Full contract comparisons and the default worker additionally require `oasdiff` on PATH (`brew install oasdiff` on macOS). Validation requires Git, tar, and a running Docker daemon. Use either a prebuilt image containing your check dependencies, or an existing Node/npm image plus `--prepare-dependencies` for a supported single-package project. See [dependency preparation](DEPENDENCIES.md).

`refit serve` runs multiple approved App-managed profiles, verifies installation webhooks, and exposes authenticated local status. [Local service setup](LOCAL-SERVICE.md) includes the Stripe pilot and exact HTTPS webhook steps. The service still requires configured baselines and checks; installing the App alone does not start arbitrary repositories.

For supported single-package npm projects, `refit prepare` installs committed lockfile dependencies in a restricted container for offline checks. Run workflows with `--prepare-dependencies` or set `prepareDependencies: true` in their JSON configuration. Read [dependency preparation](DEPENDENCIES.md) for requirements, security limits and the billing demo.

Pass `--env .env` to any command to load environment variables explicitly, including with an installed `refit` executable. Existing environment values take precedence. Refit does not automatically load files from the scanned repository. Keep credentials outside committed configuration files.

```sh
refit --help
refit --version
refit replay --propose-patch
refit scan --repository /path/to/repo --before before.json --after after.json
```

The replay uses bundled synthetic application code and curated historical Stripe specifications. It does not modify your application. Paths supplied to other commands are resolved from your current directory.

For a complete demonstrable migration with the real Stripe SDK:

```sh
refit demo --image node:22-alpine --output /tmp/new-refit-demo
```

Requires a running Docker daemon and that Node image already installed locally, plus npm registry access (or cache) for fixture dependencies. It installs Stripe 10.17.0 with install scripts disabled into a temporary synthetic application, verifies its old API behavior and expected new API failure, then generates a patch and validates old/new contracts in offline Docker containers. The API is a loopback simulation; no Stripe account, AI model or GitHub credentials are used. Temporary code and dependencies are removed. The output retains `contract-before-migration.json`, `demo.json`, and a `migration/` review bundle containing the patch, report, check logs and draft PR text. Existing output is never overwritten. Failure before `demo.json` leaves incomplete evidence, not a successful demo.

Run a complete local migration with supplied snapshots:

```sh
refit run --repository /path/to/clean-git-repo \
  --before before.json --after after.json \
  --output /tmp/new-refit-run \
  --image your-local-check-image --command '["npm","test"]'
```

By default, validation executes `--command` for both baseline and patched code. If migrating between distinct test contracts, pass `--baseline-command '["node","contract.mjs","before"]'` with `--command '["node","contract.mjs","after"]'`. Both are recorded in the report and draft text and run under identical isolation limits. Different commands do not establish equivalent regression coverage; reviewers must inspect both contracts. AI repair only reruns the patched command and never changes these configured commands.

Save the reusable inputs in a JSON run configuration to avoid repeating long commands:

```json
{
  "formatVersion": 1,
  "repository": "./application",
  "apiVersion": "1.0.0",
  "before": "./specifications/before.json",
  "after": "./specifications/after.json",
  "image": "application-checks:local",
  "command": ["npm", "test"]
}
```

```sh
refit run --config ./run.json --output /tmp/new-refit-run
refit run --env .env --config ./run.json --output /tmp/new-refit-ai-run --ai-patch
```

Set `apiVersion` in that configuration or pass `--api-version` when you know the API version the application actually uses. Refit compares it exactly with `info.version` in both OpenAPI documents and records the result in `scan.json`. This is an operator-supplied pin; Refit does not infer a Stripe account default or derive an API version from the SDK package lock. OpenAPI's `info.version` describes the API, separately from the OpenAPI format version.

Paths in the configuration are relative to its file; explicit CLI paths remain relative to your current directory. CLI values override configuration values. An explicit `--after` or `--latest-stripe` replaces the configured specification choice. Optional fields are `baselineCommand`, `providerConfig`, `apiVersion`, `fullDiff` and `latestStripe` (use it instead of `after`). Commands are argument arrays and run from the application root inside Docker; the image must already supply their dependencies. Unknown fields and files over 64 KiB are rejected. Output must always be supplied on the command line as a fresh directory. AI, repair and publication also require explicit CLI flags; configuration cannot enable them or contain credentials. This format is separate from the illustrative website's `refit.yml` export.

Automated `run`, `watch` and `serve` workflows proceed only when the supplied application API version exactly matches the before contract's OpenAPI `info.version`. Missing or different versions are saved as review evidence and stop before AI generation, Docker checks or PR publication. If the application already uses the after version, refresh and review the baseline before starting another migration. A direct `scan` still runs without a pin but marks applicability as unknown; `validate --publish-draft` performs the same check before validation begins. This conservative gate can leave a valid migration in review when a provider's `info.version` is not its actual API-version identifier.

The Refit checkout includes `examples/billing-demo.refit.json` for the adjacent independent billing demo and its prepared history-check image. See [billing evaluation](https://github.com/pierceluu10/refit-billing-demo) for the application; these are simulated Stripe contracts.

Discover current Stripe specifications or check against a retained baseline:

```sh
refit stripe-snapshot --latest --output /tmp/new-baseline.json
refit stripe-check --repository /path/to/repo \
  --baseline /tmp/new-baseline.json --output /tmp/new-refit-check
```

For another provider that publishes a public OpenAPI 3 document, capture a pinned baseline from its HTTPS URL or from a local JSON/YAML file:

```sh
refit source-snapshot --provider example \
  --url https://api.example.com/openapi.yaml \
  --output /absolute/path/provider-baseline.json
# Or replace --url with --file /absolute/path/openapi.yaml
```

Use the lowercase provider ID from the matching SDK adapter. Refit validates and saves the supplied document with that ID, source URL and SHA-256 content hash. The output path must be new; Refit will not overwrite a baseline. This command does not discover provider feeds or release notes. Use the pinned file as `before` and the matching `--source-url` with `refit watch` to monitor later versions. Generic sources must be public HTTPS without redirects, credentials or query parameters; bundle multi-file OpenAPI references first.

Use `refit run --latest-stripe` instead of `--after` to discover Stripe's latest spec during a complete run. The `--before` file must then be a pinned Refit snapshot. No baseline is automatically advanced. Other SDKs require an explicit `--provider-config` adapter. An adapter may include `propertyRenames` to propose direct reads changing from a removed field to a newly added field of the same simple scalar type. This mapping is an operator-authored semantic assumption and remains subject to application checks and human review. JSON and YAML OpenAPI 3 inputs are supported. Add `--full-diff` to `scan` or `run` for the shared oasdiff changelog; unmapped breaking changes stop automatic workflow proposals and publication. External OpenAPI references are disabled.

Use `refit watch --config run.json --state /path/outside-repository/state --once` to poll a configured source and process it once. Remove `--once` for continuous local polling. Override the OpenAPI source with `--source-url`, `--source-file` or `--latest-stripe`. Add up to eight `--documentation-source "changelog=https://docs.provider.example/changelog"` options to monitor public HTML, Markdown or plain-text release notes alongside OpenAPI. For Stripe, its public Markdown changelog is `https://docs.stripe.com/changelog.md`. The first poll records a baseline; later changes produce a unified text diff under `state/observations/documentation`. A docs-only update returns `documentation-changed` (exit 2) and never starts AI generation or PR publication. If docs and OpenAPI change together, the docs diff is recorded as separate review evidence and is not sent to the model. These URLs are configured manually; Refit does not discover provider feeds. The worker enables full contract comparison by default and retains job receipts across restarts; failed jobs require explicit `--retry --once`. See [local automation](AUTOMATION.md) for the verified Stripe command, spending controls, live sources and a change-arrival demo.

Add `--sync-github --github owner/repository --base main --github-app` to let the App fetch and refresh a managed checkout before each poll. The run configuration may omit `repository` in this mode. State must be outside existing Git working copies. Read tokens are repository-scoped; local edits in the managed directory are refused, and your working copy is not reset. Hosted installation enrollment remains planned.

AI is opt-in. Configure `OPENAI_API_KEY` and `OPENAI_MODEL`, then add `--ai-patch` or `--assess`. Patch generation sends affected source files and up to 12 transitively resolved relative-import modules as read-only context to OpenAI; only affected files remain editable. Ambiguous imports are not guessed, and oversized context fails explicitly. Assessment sends selected source context. Optional `--repair-attempts 1` sends failed-check output and allows a bounded retry (maximum 2). Logs and source can contain application data. Model quality must be evaluated against application checks. Baseline checks run before paid generation. The CLI uses a durable shared spending ledger (default $1 at `~/.refit/ai-budget`), pre-counts input tokens, reserves maximum generation cost, and records actual usage. Set `REFIT_AI_BUDGET_USD` and `REFIT_AI_BUDGET_DIRECTORY` for your shared allowance. Unknown model prices must be explicitly configured; unaccounted generation keeps its reservation.

Publication is also opt-in. Configure `GITHUB_TOKEN` with repository Contents and Pull requests write access, then add `--publish-draft --github owner/repository --base main`. It requires a matching remote base commit, passing checks and no unresolved detected findings. Refit never auto-merges. A live AI migration, bounded repair and draft publication were verified on the independent billing demo; see [the live PR evaluation](https://github.com/pierceluu10/refit-billing-demo/pull/1). This remains a simulated Stripe compatibility evaluation.

For an App bot identity and logo, add `--github-app` with `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_FILE` configured locally. This selects an installation token instead of your personal token, discovers the target installation automatically and verifies the bot author. Before new generation, App-mode runs can reuse a verified open App-authored draft covering the same base and changes. That result explicitly records that checks were not rerun. See [GitHub App setup](GITHUB-APP.md). [Testing another repository](TEST-REPOSITORIES.md) covers AI runs, check images and remote-base requirements.

`run` returns 0 for validated or published/reused PR results, 2 for review-required or failed-validation results, and 1 for errors. It retains a final manifest and completed evidence in a new directory outside the repository. Failed runs may have fewer artifacts; a missing manifest means interruption. An existing output directory is never overwritten. Original repository files are not patched.

`run` reports scanning, proposal generation, Docker checks, repairs and publication on stderr as they occur. Final stdout is human-readable in terminals and JSON when redirected. Use `--human` or `--json` to choose explicitly. JSON reports remain available in the evidence directory; PRs use prose with collapsed technical evidence. Use `--quiet` to suppress progress. Failure status, its reason and the retained evidence path are shown without needing to open the JSON report.

Use `refit <command> --help` for all options. The `watch` command is a local polling worker; there is no hosted scheduler or automatic installation enrollment. Supported analysis is bounded and conservative: no finding does not prove safety, and passing checks does not prove migration correctness. Every proposal requires human review.

Verify saved evidence before sharing it:

```sh
refit verify --directory /tmp/new-refit-demo/migration
```

This checks the declared SHA-256 hashes and byte counts in workflow, review-bundle and Stripe-check manifests. It rejects missing, changed, duplicate, linked or unlisted entries, unsupported manifest formats and paths outside the flat bundle. Limits are 16 artifacts, 256 MiB per artifact, 1 GiB total and a 64 KiB manifest. Exit 0 means the declared file bytes match the supplied manifest; exit 1 means verification failed. It makes no network requests and executes no repository code. The manifest is unsigned: matching hashes do not prove who produced it, whether it lists all required evidence, whether tests really ran or whether the migration is correct. Failed-run evidence can also pass this integrity check.
