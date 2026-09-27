# Refit local agent

Refit compares API specifications with local TypeScript/JavaScript usage, proposes reviewable migrations, validates them in Docker, and optionally opens a GitHub draft PR. This is an experimental local agent, not automatic support for every API or codebase.

Requires Node.js 22.12+ or a supported newer release. Scanning needs no API key or Docker. Validation additionally requires Git, tar, a running Docker daemon, and a prebuilt local image containing your check dependencies.

```sh
refit --help
refit --version
refit replay --propose-patch
refit scan --repository /path/to/repo --before before.json --after after.json
```

The replay uses bundled synthetic application code and curated historical Stripe specifications. It does not modify your application. Paths supplied to other commands are resolved from your current directory.

Run a complete local migration with supplied snapshots:

```sh
refit run --repository /path/to/clean-git-repo \
  --before before.json --after after.json \
  --output /tmp/new-refit-run \
  --image your-local-check-image --command '["npm","test"]'
```

Discover current Stripe specifications or check against a retained baseline:

```sh
refit stripe-snapshot --latest --output /tmp/new-baseline.json
refit stripe-check --repository /path/to/repo \
  --baseline /tmp/new-baseline.json --output /tmp/new-refit-check
```

Use `refit run --latest-stripe` instead of `--after` to discover Stripe's latest spec during a complete run. The `--before` file must then be a pinned Refit snapshot. No baseline is automatically advanced. Other SDKs require supplied snapshots and an explicit `--provider-config` adapter.

AI is opt-in. Configure `OPENAI_API_KEY` and `OPENAI_MODEL`, then add `--ai-patch` or `--assess`. Patch generation sends affected source files to OpenAI; assessment sends selected source context. Optional `--repair-attempts 1` sends failed-check output and allows a bounded retry (maximum 2). Logs and source can contain application data. Live model quality remains unverified.

Publication is also opt-in. Configure `GITHUB_TOKEN` with repository Contents and Pull requests write access, then add `--publish-draft --github owner/repository --base main`. It requires a matching remote base commit, passing checks and no unresolved detected findings. Refit never auto-merges. Remote publication is covered by controlled API tests; live GitHub verification remains outstanding.

`run` returns 0 for validated or published/reused PR results, 2 for review-required or failed-validation results, and 1 for errors. It retains a final manifest and completed evidence in a new directory outside the repository. Failed runs may have fewer artifacts; a missing manifest means interruption. An existing output directory is never overwritten. Original repository files are not patched.

Use `refit <command> --help` for all options. There is no background scheduler. Supported analysis is bounded and conservative: no finding does not prove safety, and passing checks does not prove migration correctness. Every proposal requires human review.
