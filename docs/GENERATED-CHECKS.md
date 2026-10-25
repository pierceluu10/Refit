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
- They never raise the evidence grade above D: a changed file that only a generated check ran, and that neither the repository's tests reach nor a type check covers, leaves the validation at grade D, a `[Needs review]` draft (`pipeline/check-selection.ts`). Their placeholder fixtures check response shapes, so they are not the behaviour tests grade A requires.

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
