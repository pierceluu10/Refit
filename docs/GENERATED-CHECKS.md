# Generated Stripe checks

Refit validates a migration by running the repository's own checks before and after the patch. 83 of the 100 repositories in the [Stripe benchmark](STRIPE-BENCHMARK.md) have no real test script. Generated checks add version-specific Stripe evidence for them. Refit calls the migrated code paths against Stripe's own mock server, serving the old and new API versions, with networking still disabled.

## Configure

Add `generatedChecks` to a workflow or `.refit.json`:

```json
"generatedChecks": {
  "stripeMockImage": "stripe/stripe-mock:latest",
  "beforeFixtures": "./refit/stripe-2025-02-24.acacia.fixtures.json",
  "afterFixtures": "./refit/stripe-2025-04-30.basil.fixtures.json"
}
```

- `stripeMockImage` must already exist locally; Refit never pulls it. Pull the official image once with `docker pull stripe/stripe-mock:latest`. Evidence records its image ID and the hash of the binary used.
- The fixtures files come from the same `stripe/openapi` releases as your `before` and `after` contracts (`openapi/fixtures3.json` next to `openapi/spec3.json`). Both contracts must be JSON.
- Generated checks run in addition to `baselineCommand` and `command`, after those pass. Changing these settings changes the reviewed configuration, so `refit enroll` asks for approval again.

## What runs

stripe-mock's README says it serves only the latest API version, but its `-spec` and `-fixtures` flags accept any release's published files. Refit verified this with the official image and Stripe's acacia and basil releases. Invoices had top-level `subscription` under acacia and `parent.subscription_details.subscription` under basil.

1. **Entry points.** For each confirmed finding, Refit takes the innermost exported function around it. That can be a function declaration, an exported `const` arrow or function expression, a default export, or a top-level function or `const` exported through an `export { … }` list, so findings inside inline callbacks count for their caller. A function qualifies if it has at most three parameters, each untyped or typed `string`. Other findings are counted as uncovered, never guessed.
2. **Runs.** Original code runs against stripe-mock serving the before contract and fixtures. Patched code runs against the after contract and fixtures. Each qualifying function is called with placeholder IDs (`refit_placeholder_1`, …), and its result is recorded separately. A function that throws on the original code cannot run in isolation, for example because it needs a database, so it is excluded and listed with its error. Every function that ran on the original code must also complete on the patched code; a failure there is a regression and fails validation. A harness that cannot start fails validation too. No AI repair is attempted for generated checks.
3. **Sandbox.** Both runs use the normal validation container: `--network none`, read-only root, no capabilities, non-root user, and the validation profile's workspace and memory (2 GiB and 3 GiB by default). stripe-mock runs inside that container on `127.0.0.1`. A Node preload redirects HTTPS requests for `api.stripe.com` to it, and replaces the Authorization header with stripe-mock's standard test key. The redirect also handles the Stripe SDK writing request bodies only after `secureConnect`. The stripe-mock binary, contract, fixtures and generated harness are mounted read-only. There is no network, certificate or TLS change, and placeholder `STRIPE_SECRET_KEY`, `STRIPE_API_KEY` and `STRIPE_KEY` variables are set for code that reads them at import.
4. **Evidence.** The validation report records the entry points, functions not runnable in isolation, regressions, uncovered usages, both results, the image ID, the binary hash and the contract and fixtures hashes. The terminal summary and the PR's validation table show both runs. The PR text says the checks use placeholder data and check response shapes, not business behavior.

## Limits

- Only simple exported functions are called. Route handlers, class methods, and functions taking request objects or Stripe objects need application-specific arguments and stay uncovered.
- stripe-mock fixtures use placeholder values, and they differ between versions, so return values are not compared. The check catches crashes and type errors on the new response shape, such as reading a property of a removed field, not wrong results.
- Code that does not crash on a missing field, for example by returning `undefined`, passes on both versions. Review stays necessary.
- Only the Stripe SDK's default Node HTTP client is redirected. Clients configured with a custom host, a custom HTTP client or `fetch` are not redirected, and fail in the offline sandbox.
- TypeScript files are transpiled in the sandbox by Refit's bundled TypeScript compiler, mounted read-only, rather than by Node's type stripping, which keeps imports of type-only names and fails at runtime. Imports resolve through a map Refit computes with its own verified resolver: extensionless relative paths, `index` files and `tsconfig`/`jsconfig` aliases. CommonJS `require` of TypeScript and unverified alias configurations are not handled.

## Real repositories

The lab also covers a TypeScript module that imports its client through an extensionless `@/client` alias. On the Stripe benchmark, 5 of 6 deterministically patched repositories have an entry point. Under the then-default 256 MiB archive limit none could run; with the 2 GiB profile (now the default) three load, and their helpers stop at creating a Supabase client, so they are excluded as not runnable in isolation. See [the benchmark re-run](STRIPE-BENCHMARK.md#re-run-with-ai-october-15). Generated checks fit libraries and service code more than full-stack apps today.

## Verified lab

The local lab at `~/Repos/refit-stripe-lab` used the actual `stripe` 17.7.0 SDK, the curated basil move adapter, and Stripe's acacia and basil specs and fixtures. `refit run` called five exported functions, including a line-item callback's caller, with no uncovered usages. They passed on the original code against acacia stripe-mock and on the migrated code against basil stripe-mock, offline. Evidence is at `~/.refit/evaluations/generated-checks-2-2026-10-15`. A unit test with a Stripe-like client confirms the redirect, the test-key substitution and failure on a thrown error. Without the `secureConnect` handling, the request hangs.

## Behaviour tests written by a model (opt-in)

`refit run --write-behaviour-tests` (and `benchmark:stripe --behaviour-tests`, which needs `--validate` and `--env` with `OPENAI_API_KEY` and `OPENAI_MODEL`) makes one OpenAI request per repository for node:test files that the behaviour-test harness then runs on both API versions (`pipeline/behaviour-tests.ts`; grade A when every test passes on both sides and every changed Stripe line ran on both). It never turns on AI patches.

- **What the model sees.** The original modules with confirmed findings, the modules they import (nearest first, up to 8,000 tokens), the findings, the contract excerpt for them (the removed field or parameter and what the after contract adds beside it), both versions, the harness contract, and two owner policies: never assert that a removed request parameter is absent, and test webhook handlers with a payload in the old shape too. It never sees a patch or any AI output: the request is built before any proposal exists. The files are sent to OpenAI.
- **What is refused.** Every file is dropped, with the reasons recorded, when any file is outside `refit-behaviour/<name>.test.mjs`, imports anything but node builtins, `stripe`, `refit:behaviour` and repository files, calls `fetch` or opens a socket, starts a process, writes outside a `mkdtemp` directory under `os.tmpdir()`, skips or narrows tests, exits the process, or defines no test. A refused or failed answer is never regenerated.
- **When it runs.** On every patched copy of the repository whose code can load, whether or not the repository's own checks ran: after both checks pass, and also where the baseline failed or timed out (the patched checks are then not run). Never where the patched checks ran and failed, because that patch is not published. When the repository's dependencies cannot be prepared, the patch stays untested, and behaviour tests still run if every changed Stripe module loads with only `stripe`: each side installs stripe and the closure its own npm lockfile records, with the lockfile's integrity and scripts off, then runs offline. `validation.stripeOnly` says why that could not happen. Where the writer does not run, its record is `skipped` with the reason.
- **Dry run.** `refit run --write-behaviour-tests-dry-run` and `benchmark:stripe --behaviour-tests-dry-run` (which needs `--validate` and no key) build every request exactly as the real run would, send nothing, and record per repository `status: dry-run`, whether the real run would send it (`wouldRun`) and why not, with an estimate: input tokens at 3.5 bytes per token and the cost at `gpt-6.1-sol` prices with no output, a typical 8,000-token answer and the 25,000 output tokens every request reserves. Benchmark rows that never reach validation carry the record at the top level.
- **Spend.** Through the AI budget ledger like every other request: about $0.09 per repository at `gpt-6.1-sol` prices, at most $0.32 reserved per request. `validation.behaviourTestWriter` records the model, prompt hash, tokens, cost and each file's SHA-256.
