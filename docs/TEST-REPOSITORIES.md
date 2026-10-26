# Run an AI migration on a test repository

Start with the separate `refit-billing-demo`: it intentionally retains Stripe's historical `PaymentIntent.charges` usage and has meaningful old/new contract tests. Docker Desktop must be running. The prepared local `refit-billing-check:history` image supplies all dependencies; [billing evaluation](BILLING-EVALUATION.md) documents rebuilding it.

## Generate and validate without publishing

From the Refit checkout:

```sh
refit run --env .env --config examples/billing-demo.refit.json \
  --output /tmp/refit-my-ai-run-001 --ai-patch --repair-attempts 1
```

The existing `.env` needs `OPENAI_API_KEY` and `OPENAI_MODEL` (`gpt-5.4-mini` is the model used for the verified demo). `--ai-patch` makes billable OpenAI requests and sends the affected source plus bounded imported-module context. A repair can additionally send the failed diff and check output. The model cannot run commands or change your original repository. All check commands are supplied by you and run in offline Docker.

Success returns `validated` and exit 0. Inspect `migration.patch`, `report.json.gz` (gzip-compressed; `gunzip -c`) and `pull-request.md` inside the output directory. Review the recorded baseline/patched checks and all candidate attempts. An unchanged source repository is expected: the tested patch exists only in a disposable copy and the evidence bundle.

## Also open a draft PR

Using the existing GitHub CLI login:

```sh
GITHUB_TOKEN="$(gh auth token)" refit run \
  --env .env --config examples/billing-demo.refit.json \
  --output /tmp/refit-my-ai-pr-001 --ai-patch --repair-attempts 1 \
  --publish-draft --github pierceluu10/refit-billing-demo --base main
```

This opens the PR as the token owner. To use Refit Agent's logo and bot account, complete [GitHub App setup](GITHUB-APP.md), add `--github-app`, and omit the `GITHUB_TOKEN` assignment. `draft-created` means a new draft; `existing-pr` means the exact matching candidate was already published. Inspect its current state in `publication.json`. Refit never merges.

## Use another application

Copy the JSON run configuration to a new file and change its repository, before/after specifications, Docker image and check commands. See [configuration syntax](CLI.md). Configuration paths are relative to that file; explicit CLI paths are relative to your working directory. Do not place evidence output inside the target repository.

The repository must be a clean, committed Git root without submodules that `.gitmodules` declares; a gitlink it does not declare has no URL, so it is the empty directory every clone has, and validation reads it the same way. Tracked symbolic links are accepted when every one resolves inside the repository, following links in its target; an absolute or escaping link refuses validation. For publication, that committed HEAD must match the selected remote base branch, and the token/App must have access to the named GitHub repository. Commit and push your application setup before starting a run; do not apply the migration first.

The local image must already contain the application's actual test dependencies and tools. Refit does not infer installation commands or enable network access in validation. Choose meaningful baseline and patched checks; include typechecking, regression tests and migration-specific edge cases. `command` is an argument array, not a shell string. Use an explicit `sh -c` array only when your prepared checks require shell composition, as in the billing example.

Supply specifications representing an API change applicable to that application. The bundled billing projections isolate the 2022-11-15 PaymentIntent field removal and should not be used as arbitrary current Stripe upgrade docs. Modern code without the removed field may correctly produce no findings. This scanner currently supports direct removed schema properties and bounded TypeScript/ESM Stripe patterns; arbitrary APIs, wrapper chains and SDK upgrades are not automatic.

`needs-review` (exit 2) does not mean the application is safe: it can mean no supported confirmed usage or unresolved impact. `validation-failed` (exit 2) means the configured checks did not pass. `error` (exit 1) retains completed evidence when possible. Progress goes to stderr and the final result is JSON on stdout; use `--quiet` for scripts. Use a fresh output directory on every run.
