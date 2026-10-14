# Inspect a repository before activation

For a collection in one `.refit.json`, add `--integration <id>` to inspect one integration. Enrollment then reviews all integrations together. See [multiple integrations](MULTIPLE-INTEGRATIONS.md).

`refit doctor` explains whether a local repository and workflow can attempt validation. It reads the configuration, scans supported SDK usage, inspects Git and the existing Docker image, and checks committed npm preparation inputs when enabled. It does not execute application code, install dependencies, fetch API sources, request AI, contact GitHub or activate a worker.

For the independent Stripe billing demo, use the existing operator workflow:

```sh
cd /Users/pierceluu/Repos/Refit
refit doctor --repository /Users/pierceluu/Repos/refit-billing-demo \
  --config examples/billing-demo.npm.refit.json
```

Use `--json` for a saved machine report. Human output is the default, including when redirected. Exit 0 permits an attempt at validation; exit 2 identifies setup blockers; exit 1 is an invalid invocation or unexpected execution failure. Review items can coexist with exit 0: for example, some SDK methods can be mapped while unrelated methods remain outside automatic coverage. Neither a passing check nor a mapped-call count proves complete API/code coverage, meaningful tests or equivalent migration behavior.

The check requires a clean committed Git root, valid before/after contracts and adapter mappings, an exact operator-declared before-contract API-version pin, at least one observed mapped SDK call, and an existing local Docker image. Unresolved breaking changes without a supported rule block readiness. Full contract comparison uses `oasdiff` by default, matching the worker default; `fullDiff: false` is explicitly reported as limited coverage. Missing tools, invalid inputs and preparation mismatches include next steps. Check commands are parsed but never run. Dependency input acceptance does not verify installation, engine compatibility or available SDK methods.

For `latestStripe`, doctor checks only the pinned baseline and setup. It rejects a custom provider or unpinned baseline but does not discover the latest revision. `currentSourceChecked: false` records that boundary.

## Use a checked-in repository configuration

The preferred onboarding format is a root `.refit.json`, reviewed before activation. It uses the same workflow schema as `refit run`. Relative paths resolve from the configuration file. Keep credentials, output/state paths, AI settings and publication choices outside this file.

This complete example works with the simulated catalog fixture. From the Refit checkout, use a new temporary directory:

```sh
cp -R pipeline/fixtures/endpoint-replacement/repository /tmp/refit-setup-demo
cp pipeline/fixtures/endpoint-replacement/{before,after,provider}.json /tmp/refit-setup-demo/
cat > /tmp/refit-setup-demo/.refit.json <<'JSON'
{
  "formatVersion": 1,
  "before": "./before.json",
  "after": "./after.json",
  "providerConfig": "./provider.json",
  "apiVersion": "1",
  "fullDiff": true,
  "image": "node:22-alpine",
  "baselineCommand": ["node", "--experimental-strip-types", "simulator/check.mjs", "before"],
  "command": ["node", "--experimental-strip-types", "simulator/check.mjs", "after"]
}
JSON
git -C /tmp/refit-setup-demo init -b main
git -C /tmp/refit-setup-demo add .
git -C /tmp/refit-setup-demo commit -m "test: configure simulated API migration"
refit doctor --repository /tmp/refit-setup-demo
```

The fictional SDK supplies its own simulator dependency for checks. Review the reported custom-image/dependency boundary, the configuration and adapter. After deciding to run this local example explicitly:

```sh
refit run --config /tmp/refit-setup-demo/.refit.json \
  --repository /tmp/refit-setup-demo \
  --output /tmp/refit-setup-demo-evidence --human
```

Docker must be running, `node:22-alpine` must already exist, and `oasdiff` must be on PATH. The output directory must be new and outside the repository. The run validates the simulated endpoint migration in isolated copies and leaves the original repository unchanged. See [endpoint migration limits](ENDPOINT-MIGRATIONS.md).

Installing the GitHub App or running doctor does not approve or activate `.refit.json`. `refit enroll` can review its committed settings and retain a fingerprint-bound local approval; `serve` then loads that configuration from the App-managed checkout. See [App onboarding](APP-ONBOARDING.md). Existing operator workflows still work. Local runs use an explicit `--config` and repository selection. Review changed commands, adapter rules, source baselines and version pins before any new activation.
