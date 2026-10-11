# Refit local agent

Refit compares API specifications with local TypeScript/JavaScript usage, proposes reviewable migrations, validates them in Docker, and optionally opens a GitHub draft PR. This is an experimental local agent, not automatic support for every API or codebase.

Requires Node.js 22.12+ or a supported newer release. Scanning needs no API key or Docker. Validation additionally requires Git, tar, a running Docker daemon, and a prebuilt local image containing your check dependencies.

Pass `--env-file .env` to any command to load environment variables explicitly, including with an installed `refit` executable. Existing environment values take precedence. Refit does not automatically load files from the scanned repository. Keep credentials outside committed configuration files.

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
  "before": "./specifications/before.json",
  "after": "./specifications/after.json",
  "image": "application-checks:local",
  "command": ["npm", "test"]
}
```

```sh
refit run --config ./run.json --output /tmp/new-refit-run
refit run --env-file .env --config ./run.json --output /tmp/new-refit-ai-run --ai-patch
```

Paths in the configuration are relative to its file; explicit CLI paths remain relative to your current directory. CLI values override configuration values. An explicit `--after` or `--latest-stripe` replaces the configured specification choice. Optional fields are `baselineCommand`, `providerConfig` and `latestStripe` (use it instead of `after`). Commands are argument arrays and run from the application root inside Docker; the image must already supply their dependencies. Unknown fields and files over 64 KiB are rejected. Output must always be supplied on the command line as a fresh directory. AI, repair and publication also require explicit CLI flags; configuration cannot enable them or contain credentials. This format is separate from the illustrative website's `refit.yml` export.

The Refit checkout includes `examples/billing-demo.refit.json` for the adjacent independent billing demo and its prepared history-check image. See [billing evaluation](https://github.com/pierceluu10/refit-billing-demo) for the application; these are simulated Stripe contracts.

Discover current Stripe specifications or check against a retained baseline:

```sh
refit stripe-snapshot --latest --output /tmp/new-baseline.json
refit stripe-check --repository /path/to/repo \
  --baseline /tmp/new-baseline.json --output /tmp/new-refit-check
```

Use `refit run --latest-stripe` instead of `--after` to discover Stripe's latest spec during a complete run. The `--before` file must then be a pinned Refit snapshot. No baseline is automatically advanced. Other SDKs require supplied snapshots and an explicit `--provider-config` adapter.

AI is opt-in. Configure `OPENAI_API_KEY` and `OPENAI_MODEL`, then add `--ai-patch` or `--assess`. Patch generation sends affected source files and up to 12 transitively resolved relative-import modules as read-only context to OpenAI; only affected files remain editable. Ambiguous imports are not guessed, and oversized context fails explicitly. Assessment sends selected source context. Optional `--repair-attempts 1` sends failed-check output and allows a bounded retry (maximum 2). Logs and source can contain application data. Model quality must be evaluated against application checks.

Publication is also opt-in. Configure `GITHUB_TOKEN` with repository Contents and Pull requests write access, then add `--publish-draft --github owner/repository --base main`. It requires a matching remote base commit, passing checks and no unresolved detected findings. Refit never auto-merges. A live AI migration, bounded repair and draft publication were verified on the independent billing demo; see [the live PR evaluation](https://github.com/pierceluu10/refit-billing-demo/pull/1). This remains a simulated Stripe compatibility evaluation.

`run` returns 0 for validated or published/reused PR results, 2 for review-required or failed-validation results, and 1 for errors. It retains a final manifest and completed evidence in a new directory outside the repository. Failed runs may have fewer artifacts; a missing manifest means interruption. An existing output directory is never overwritten. Original repository files are not patched.

Use `refit <command> --help` for all options. There is no background scheduler. Supported analysis is bounded and conservative: no finding does not prove safety, and passing checks does not prove migration correctness. Every proposal requires human review.

Verify saved evidence before sharing it:

```sh
refit verify --directory /tmp/new-refit-demo/migration
```

This checks the declared SHA-256 hashes and byte counts in workflow, review-bundle and Stripe-check manifests. It rejects missing, changed, duplicate, linked or unlisted entries, unsupported manifest formats and paths outside the flat bundle. Limits are 16 artifacts, 256 MiB per artifact, 1 GiB total and a 64 KiB manifest. Exit 0 means the declared file bytes match the supplied manifest; exit 1 means verification failed. It makes no network requests and executes no repository code. The manifest is unsigned: matching hashes do not prove who produced it, whether it lists all required evidence, whether tests really ran or whether the migration is correct. Failed-run evidence can also pass this integrity check.
