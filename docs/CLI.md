# Refit local agent

From a configured repository root, run `refit doctor` to inspect setup, then `refit run` to attempt the migration. Both find the root `.refit.json`; `--repository` selects another root and `--config` selects an operator workflow. Collections still require `--integration <id>`. AI and publication remain explicit flags.

When `run` has no `--output`, evidence goes to a fresh private `refit-run-<uuid>` directory under the operating system's temporary directory. Its path is printed and included in JSON output. The OS may eventually remove temporary files; use `--output <new-directory-outside-repository>` for a chosen retained location. Existing output is never replaced. Manual specification flags do not silently load a root profile, and external operator workflows still need a repository selection. No contracts, mappings or check commands are guessed.

Refit follows supported class-held SDK clients through field initializers, direct constructor assignments and lexical instance/arrow methods. Unstable class origins stop automation before AI, checks or publication. See [class-client support](CLASS-CLIENTS.md).

SDK arguments also trace into supported private helper functions. Exported or uncertain helpers retain review evidence and block automation; type annotations alone never establish an SDK origin. See [helper-client support](HELPER-CLIENTS.md).

`scan` and `replay` use a readable summary in terminals and JSON when redirected. Use `--human` or `--json` to select explicitly. `--output <new-report.json>` always saves the complete JSON report; add `--human` to also print a summary. Scan summaries explicitly identify that checks have not run and repository files remain unchanged.

The Stripe scanner maps supported single-object SDK responses from the supplied contract. Explicit Stripe types provide review hints; they cannot authorize a migration. Unparseable skipped files also block automation. Full contract diff output describes its adapter-selected scope. Historical benchmark scores apply only to their recorded commits.

Shared clients support direct relative named/default ESM imports and static CommonJS requires/exports, including Stripe callable initialization. Mutation and source-version checks follow the same module graph. See [client module forms and boundaries](CLIENT-MODULES.md).

Recorded `tsconfig.json`/`jsconfig.json` `paths` and `baseUrl` can resolve shared clients and supported wrappers. Local inherited configurations are captured in scan evidence; ambiguous or unsupported resolution stops confirmation and appears in setup diagnostics. Runtime imports still need application checks. See [configured aliases](SOURCE-ALIASES.md).

Supported Stripe snapshot webhook reads carry separate incoming-version evidence. Affected webhook findings stop automation unless a supported deterministic policy defines incoming-version behavior. The first rule preserves historical subscription periods and selects new item periods by an explicitly configured price ID, with runtime signed-event version checks. Other webhook migrations and direct webhook AI generation remain blocked. See [Stripe webhooks](STRIPE-WEBHOOKS.md) and [price-policy configuration](STRIPE-SUBSCRIPTION-PERIODS.md).

Configured `requestPropertyRenames` cover top-level JSON body fields on mapped SDK calls after checking that the recorded operation changes only by those names. Direct, quoted and shorthand properties retain their values and other arguments; uncertain requests stop for review, and these explicit rules use no AI generation or repair. See [request migrations](REQUEST-MIGRATIONS.md).

Collections with `formatVersion: 2` support up to eight named integrations in one repository. Manual `run`, `watch` and `doctor` commands require `--integration <id>`; enrollment reviews the whole collection and the App service expands it into independent targets such as `billing.stripe` and `billing.openai`, with separate draft PRs and retries. Existing single profiles keep their current commands. See [multiple integrations](MULTIPLE-INTEGRATIONS.md).

Inspect setup before running a migration with `refit doctor --repository /path/to/repo`. It defaults to a root `.refit.json`; `--config` selects an operator workflow instead. Human diagnostics explain Git, contract, mapping, API-version, preparation and Docker blockers without application execution, installs, AI or GitHub requests. `--json` supplies machine output. This does not approve or activate a repository. See [repository setup](REPOSITORY-SETUP.md).

`refit enroll --repository /path/to/repo --github owner/repository --base main` reviews the committed `.refit.json`, baseline and adapter. After review, add `--approve <exact-fingerprint> --output /path/outside-git/approval.json`. Select that receipt through an `approval` service target to load the reviewed configuration from an App-managed checkout. Changed approved inputs stop before execution. See [App onboarding](APP-ONBOARDING.md).

Refit compares API specifications with local TypeScript/JavaScript usage, proposes reviewable migrations, validates them in Docker, and optionally opens a GitHub draft PR. This is an experimental local agent, not automatic support for every API or codebase.

Requires Node.js 22.12+ or a supported newer release. Scanning needs no API key or Docker. Full contract comparisons and the default worker additionally require `oasdiff` on PATH (`brew install oasdiff` on macOS). Validation requires Git, tar, and a running Docker daemon. Use either a prebuilt image containing your check dependencies, or an existing Node/npm image plus `--prepare-dependencies` for a supported npm root or workspace project. See [dependency preparation](DEPENDENCIES.md).

`refit serve` runs multiple approved App-managed profiles, verifies installation webhooks, and exposes authenticated local status. [Local service setup](LOCAL-SERVICE.md) includes the Stripe pilot and exact HTTPS webhook steps. The service still requires configured baselines and checks; installing the App alone does not start arbitrary repositories. `serve --retry-target <id> --once` retries only explicitly named targets in the same state, preserves old attempts and reuses successful jobs. Keep the original AI/publication settings and stop an existing service first; changed approved inputs still require reapproval.

For supported single-package and npm workspace projects, `refit prepare` installs committed lockfile dependencies in a restricted container for offline checks. Run workflows with `--prepare-dependencies` or set `prepareDependencies: true` in their JSON configuration. A Stripe repository can set `stripePaymentMethodTypes: "keep-listed"` to keep listed payment methods when `payment_method_types` moves to `allowed_payment_method_types` ([policy](STRIPE-PAYMENT-METHOD-TYPES.md#proposed-2026-10-17-a-repository-opt-in-for-case-b-awaiting-owner-sign-off)). Read [dependency preparation](DEPENDENCIES.md) for requirements, security limits and the billing demo, and [npm workspaces](NPM-WORKSPACES.md) for monorepo checks and supported layouts.

The same preparation supports pinned pnpm roots and bounded catalog/workspace layouts, including pnpm 12's separate environment lock document. See [pnpm requirements](PNPM-WORKSPACES.md).

Run `refit agents` to detect the provider SDKs a repository uses and `refit agents --add <id>` to add a matching agent to `.refit.json`. See [provider agents](PROVIDER-AGENTS.md).

Run `refit deadlines --repository /path/to/repo` to list the API versions and models a repository pins that a provider has scheduled to retire (Shopify Admin API, Meta Graph API, and OpenAI and Anthropic models), with `file:line` evidence and days left. `--json` gives machine output. `--fail-within <days>` makes it a CI check that exits 2 when a live exposure is past due or within that many days, with reviewed, expiring exceptions in `.refit-deadlines-ignore.json`. `refit deadlines --propose-model-fixes` proposes, as a patch for review, replacing a retiring OpenAI or Anthropic model ID with the registry replacement where it is a literal `model` in a traced SDK call; it never applies or validates the patch. `refit deadlines --check-registry` validates the reviewed registry in `data/deadlines.json`. `refit serve --deadline-alerts` can also open one GitHub issue per enrolled repository and deadline, and `refit serve --model-fixes` replaces retiring models in enrolled repositories on its own, validates the change with the approved checks and, with `--publish-draft`, opens a draft pull request; both are off by default. See [API deadlines](DEADLINES.md).

Set `REFIT_SLACK_WEBHOOK_URL` to post one Slack line when a validated draft PR is created, and an `[URGENT]` line for a regression, a publication that failed partway or a deadline alert 7 days or less before the date or after it. See [Slack notifications](SLACK.md).

Pass `--env .env` to any command to load environment variables explicitly, including with an installed `refit` executable. Existing environment values take precedence. Refit does not automatically load files from the scanned repository. Keep credentials outside committed configuration files.

```sh
refit --help
refit --version
refit replay --propose-patch
refit scan --repository /path/to/repo --before before.json --after after.json
```

The replay uses bundled synthetic application code and curated historical Stripe specifications. It does not modify your application. Paths supplied to other commands are resolved from your current directory.

Use a committed App-style profile locally without adding a repository selector to it:

```sh
refit watch --repository /path/to/repo --config /path/to/repo/.refit.json --state /path/outside-git/worker --once
```

The explicit local root overrides an operator profile's `repository` value. Paths to contracts and adapters still resolve relative to the configuration file. Choose either `--repository` or App-managed `--sync-github`; combining those command-line selectors is rejected. This does not approve or activate the profile for the App.

For another OpenAPI provider, `adapter-suggest` can propose an initial SDK-to-operation adapter without adding provider-specific Refit code:

```sh
refit adapter-suggest --repository /path/to/repo \
  --spec /path/to/openapi.json --id example-provider \
  --package @example/sdk --default-import \
  --output ./refit-provider.json --env .env
```

Use `--export Client` instead of `--default-import` for a named SDK constructor; exactly one import style is required. The command sends OpenAI only the configured package/import style, direct `client.resource.method` call names, including named nested resources such as `chat.completions`, with a few file/line samples, and unique OpenAPI operation IDs, paths, HTTP methods and supported JSON response schema names. It does not send whole source files or descriptions from the API spec. It requires explicit `OPENAI_API_KEY` and `OPENAI_MODEL`; the normal token counter and shared budget ledger apply. The output uses a new file with owner-only permissions and is never overwritten. For models without built-in budget pricing, configure all four token prices as documented under [optional AI assessment](#optional-ai-assessment). The model's choices are checked against observed calls and component response schemas, but matching SDK behavior remains a human judgment. Review the config, then run `refit scan --provider-config ./refit-provider.json` before any migration workflow. This suggestion supports up to 100 observed SDK methods and 500 candidate operations; repeat `--operation-id <id>` to narrow a large contract. It recognizes direct calls on `const client = new ImportedConstructor()` instances, including shared clients imported through supported direct relative named/default ESM imports or static CommonJS requires. Namespace imports, re-exports, factories and other languages remain outside the suggestion inventory; mutation and response semantics still need review. A resource can be an identifier path separated by dots, up to 256 characters; computed resource paths remain unsupported. Generated adapters retain that exact observed resource path and require the same semantic review as simple resources.

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

Refit also records SDK constructor versions and request overrides when the adapter declares their option locations. Literal conflicts block automatic work. Use `apiVersionPolicy: "source-verified"` or `--api-version-policy source-verified` to require static confirmation; the compatibility default is `operator-pin`, which leaves dynamic declarations visibly unverified. See [version policies and supported declarations](API-VERSIONS.md).

Automated `run`, `watch` and `serve` workflows proceed only when the supplied application API version exactly matches the before contract's OpenAPI `info.version`. Missing or different versions are saved as review evidence and stop before AI generation, Docker checks or PR publication. If the application already uses the after version, refresh and review the baseline before starting another migration. A direct `scan` still runs without a pin but marks applicability as unknown; `validate --publish-draft` performs the same check before validation begins. This conservative gate can leave a valid migration in review when a provider's `info.version` is not its actual API-version identifier.

The Refit checkout includes `examples/billing-demo.refit.json` for the adjacent independent billing demo and its prepared history-check image. See [billing evaluation](https://github.com/pierceluu10/refit-billing-demo) for the application; these are simulated Stripe contracts.

Discover current Stripe specifications or check against a retained baseline:

```sh
refit stripe-snapshot --latest --output /tmp/new-baseline.json
refit stripe-check --repository /path/to/repo \
  --baseline /tmp/new-baseline.json --output /tmp/new-refit-check
```

Shopify publishes its Admin API as a GraphQL schema per supported version. Save one with:

```sh
refit shopify-snapshot --version 2026-10 --output refit/shopify-after.json
```

It introspects Shopify's public documentation proxy: no store, credentials or store operation are involved, and only supported versions are published. Shopify runs use two such snapshots as `before` and `after`; see [Shopify](SHOPIFY.md).

For another provider that publishes a public OpenAPI 3 document, capture a pinned baseline from its HTTPS URL or from a local JSON/YAML file:

```sh
refit source-snapshot --provider example \
  --url https://api.example.com/openapi.yaml \
  --output /absolute/path/provider-baseline.json
# Or replace --url with --file /absolute/path/openapi.yaml
```

Use the lowercase provider ID from the matching SDK adapter. Refit validates and saves the supplied document with that ID, source URL and SHA-256 content hash. The output path must be new; Refit will not overwrite a baseline. This command does not discover provider feeds or release notes. Use the pinned file as `before` and the matching `--source-url` with `refit watch` to monitor later versions. Generic sources must be public HTTPS without redirects, credentials or query parameters; bundle multi-file OpenAPI references first.

Use `refit run --latest-stripe` instead of `--after` to discover Stripe's latest spec during a complete run. The `--before` file must then be a pinned Refit snapshot. No baseline is automatically advanced. Other SDKs require an explicit `--provider-config` adapter. An adapter may include `propertyRenames` to propose direct reads changing from a removed field to a newly added field of the same simple scalar type, or to a [moved nested path](PROPERTY-MOVES.md) with the same declared shape. An optional `operationId` on an SDK operation mapping lets `--full-diff` correlate unresolved breaking changes to SDK calls through the baseline path and HTTP method. The report names each change and affected code location; removals after deprecation are included. Unconfigured operation impacts remain review-only and stop automated patching. Explicit `operationReplacements` can support a retired endpoint when Refit matches the recorded old/new contract and all tracked calls are eligible; see [endpoint migrations](ENDPOINT-MIGRATIONS.md) for configuration, deterministic generation, offline testing and rollout limits. Property mappings are operator-authored semantic assumptions and remain subject to application checks and human review. JSON and YAML OpenAPI 3 inputs are supported. Add `--full-diff` to `scan` or `run` for the shared oasdiff changelog; unmapped breaking changes stop automatic workflow proposals and publication. External OpenAPI references are disabled.

Use `refit watch --config run.json --state /path/outside-repository/state --once` to poll a configured source and process it once. Remove `--once` for continuous local polling. Override the OpenAPI source with `--source-url`, `--source-file` or `--latest-stripe`. Add up to eight `--documentation-source "changelog=https://docs.provider.example/changelog"` options to monitor public HTML, Markdown, plain text, RSS 2.0 or Atom release notes alongside OpenAPI. For example, Stripe's [public Markdown changelog](https://docs.stripe.com/changelog.md) can be paired with `--documentation-source "Stripe SDK=https://github.com/stripe/stripe-node/releases.atom"`. Feed entries are normalized to title, date, link and summary text. The first poll records a baseline; later changes produce a unified text diff under `state/observations/documentation`. A docs-only update returns `documentation-changed` (exit 2) and never starts AI generation or PR publication. If docs and OpenAPI change together, the docs diff stays in the watcher observation. When that migration runs with `--ai-patch`, each saved HTML, Markdown or plain-text snapshot is attached to the model evidence. Feed entries stay in the review diff and are recorded as omitted. See [vendor notes](VENDOR_NOTES.md). Sources are configured manually; Refit does not discover provider feeds. The worker enables full contract comparison by default and retains job receipts across restarts; failed jobs require explicit `--retry --once`. See [local automation](AUTOMATION.md) for the verified Stripe command, spending controls, live sources and a change-arrival demo.

Add `--sync-github --github owner/repository --base main --github-app` to let the App fetch and refresh a managed checkout before each poll. The run configuration may omit `repository` in this mode. State must be outside existing Git working copies. Read tokens are repository-scoped; local edits in the managed directory are refused, and your working copy is not reset. Hosted installation enrollment remains planned.

AI is opt-in. Configure `OPENAI_API_KEY` and `OPENAI_MODEL`, then add `--ai-patch` or `--assess`. Patch generation sends affected source files and up to 12 transitively resolved relative-import modules as read-only context to OpenAI; only affected files remain editable. Ambiguous imports are not guessed, and oversized context fails explicitly. Assessment sends selected source context. With `refit run --ai-patch`, add up to eight `--documentation-snapshot <file>` options to attach saved vendor notes (a `refit-documentation-snapshot` JSON with URL, text and SHA-256, such as the pinned Stripe changelog pages in `docs/benchmarks/stripe-changelog/`). Optional `--repair-attempts 1` sends failed-check output and allows a bounded retry (maximum 2). With `compareTypeErrors`, each round repairs the failed candidate at the type errors it introduced; an edit must lie in the statement enclosing a reported error. Rejected literal comparisons (often misspelled webhook event names) are listed as `validation.reviewTypeErrors` and flagged in the pull request instead of repaired, a repair that changes an event-type string or drops a removed request parameter stops for review, and the loop stops with `review-required` when only such errors remain. Logs and source can contain application data. Model quality must be evaluated against application checks. Baseline checks run before paid generation. The CLI uses a durable shared spending ledger (default $1 at `~/.refit/ai-budget`), pre-counts input tokens, reserves maximum generation cost, and records actual usage. Set `REFIT_AI_BUDGET_USD` and `REFIT_AI_BUDGET_DIRECTORY` for your shared allowance. The built-in price table covers `gpt-5.6-luna` (the default in `.env.example`) and `gpt-5.4-mini`, including their dated snapshots; for another model, set all four `REFIT_AI_INPUT_USD_PER_MILLION`, `REFIT_AI_CACHED_INPUT_USD_PER_MILLION`, `REFIT_AI_CACHE_WRITE_USD_PER_MILLION` and `REFIT_AI_OUTPUT_USD_PER_MILLION` values using that model's current prices. If usage cannot be accounted for, the reservation remains charged.

Publication is also opt-in. Configure `GITHUB_TOKEN` with repository Contents and Pull requests write access, then add `--publish-draft --github owner/repository --base main`. It requires a matching remote base commit, passing checks and no unresolved detected findings. Add `--publish-unresolved` to publish a `[Needs review]` draft whose checks passed while confirmed findings remain; the PR states how many are still unmigrated. The same flag lets a draft publish when the only blocker is the unverified incoming webhook API version: the PR opens with what to check on the Stripe webhook endpoint and lists every changed handler, and `report.json` and the manifest record the waived gate. Two more sole blockers are waivable the same way. When a traced call still sends a request parameter the target version removed (for example Stripe's `payment_method_types`), the deterministic migration proceeds around it, and the draft lists each call and why Refit left it for the owner; AI runs still stop. When dependency preparation fails for a repository-side reason (no lockfile, a lockfile out of sync with `package.json`, lockfile entries without integrity, or a dependency archive over the profile limit), the checks do not run, and the patch is published marked untested, with the reason and what the owner must fix. Any other review reason, a regression or any other validation error still refuses. `--publish-unresolved` without `--publish-draft` saves the same `[Needs review]` artifacts locally. Refit never auto-merges. A live AI migration, bounded repair and draft publication were verified on the independent billing demo; see [the live PR evaluation](https://github.com/pierceluu10/refit-billing-demo/pull/1). This remains a simulated Stripe compatibility evaluation.

For an App bot identity and logo, add `--github-app` with `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_FILE` configured locally. This selects an installation token instead of your personal token, discovers the target installation automatically and verifies the bot author. Before new generation, App-mode runs can reuse a verified open App-authored draft covering the same base and changes. That result explicitly records that checks were not rerun. See [GitHub App setup](GITHUB-APP.md). [Testing another repository](TEST-REPOSITORIES.md) covers AI runs, check images and remote-base requirements.

`run` returns 0 for validated or published/reused PR results, 2 for review-required or failed-validation results, and 1 for errors. It retains a final manifest and completed evidence in a new directory outside the repository. Failed runs may have fewer artifacts; a missing manifest means interruption. An existing output directory is never overwritten. Original repository files are not patched.

`run` reports scanning, proposal generation, Docker checks, repairs and publication on stderr as they occur. Final stdout is human-readable in terminals and JSON when redirected. Use `--human` or `--json` to choose explicitly. JSON reports remain available in the evidence directory; PRs use prose with collapsed technical evidence. Use `--quiet` to suppress progress. Failure status, its reason and the retained evidence path are shown without needing to open the JSON report.

Use `refit <command> --help` for all options. The `watch` command is a local polling worker; there is no hosted scheduler or automatic installation enrollment. Supported analysis is bounded and conservative: no finding does not prove safety, and passing checks does not prove migration correctness. Every proposal requires human review.

Verify saved evidence before sharing it:

```sh
refit verify --directory /tmp/new-refit-demo/migration
```

This checks the declared SHA-256 hashes and byte counts in workflow, review-bundle and Stripe-check manifests. It rejects missing, changed, duplicate, linked or unlisted entries, unsupported manifest formats and paths outside the flat bundle. Limits are 16 artifacts, 1 GiB per artifact (the largest dependency archive), 1 GiB plus 64 MiB total and a 64 KiB manifest. Exit 0 means the declared file bytes match the supplied manifest; exit 1 means verification failed. It makes no network requests and executes no repository code. The manifest is unsigned: matching hashes do not prove who produced it, whether it lists all required evidence, whether tests really ran or whether the migration is correct. Failed-run evidence can also pass this integrity check.
