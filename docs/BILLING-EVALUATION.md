# Independent billing application evaluation

On October 9, 2026, Refit scanned the separate `refit-billing-demo` repository, traced its imported `retrievePayment()` wrapper, and generated a deterministic migration for its guarded `PaymentIntent.charges` history function. The billing repository and its tests were left unchanged.

## Verified results

- Original application: 14 tests pass against the original contract; three history-dependent tests fail against the explicitly upgraded contract.
- Generated patch: all 14 original tests pass against both contracts without changing assertions. Strict TypeScript checks pass.
- Additional pagination evaluation: 12 declined attempts and one successful retry produce all 13 unique charges, newest first, with the partial refund preserved. This exceeds the simulator's default page size of 10.
- Refit's actual workflow validates the committed application in network-disabled Docker containers and retains a review bundle. The baseline checks the old contract; the patched check runs both contracts and TypeScript. No AI calls, GitHub publication, or real Stripe requests occur.

The application uses the actual Stripe 10.17.0 SDK with a stateful HTTP simulator. Its specifications are independently authored projections of the historical 2022-11-15 removal, not complete upstream specifications. These results establish compatibility with this authored evaluation application, not production readiness.

The full Refit suite passed **239 tests with none skipped**, with the independent billing, actual Docker, real SDK and independent package-install checks enabled. Production build and formatting checks passed.

## Reproduce

The independent repository must be clean and committed, with dependencies already installed for local evaluation. From the Refit checkout:

```sh
REFIT_BILLING_REPOSITORY=/Users/pierceluu/Repos/refit-billing-demo npm test
```

This opt-in integration test creates a disposable copy, applies Refit's generated patch, runs the original and upgraded suites and typechecking, verifies test bytes remain unchanged, and checks multi-page history. It deletes its temporary copy afterward.

For the Docker workflow, build a local dependency image. Image preparation downloads npm dependencies; the actual validation containers have no external network:

```sh
docker build --pull=false \
  --file /Users/pierceluu/Repos/Refit/scripts/billing-validation.Dockerfile \
  --tag refit-billing-check:local \
  /Users/pierceluu/Repos/refit-billing-demo

node bin/refit.mjs run \
  --repository /Users/pierceluu/Repos/refit-billing-demo \
  --before /Users/pierceluu/Repos/refit-billing-demo/docs/contracts/before.json \
  --after /Users/pierceluu/Repos/refit-billing-demo/docs/contracts/after.json \
  --output /tmp/refit-billing-review \
  --image refit-billing-check:local \
  --baseline-command '["sh","-c","ln -s /opt/billing/node_modules node_modules && npm test"]' \
  --command '["sh","-c","ln -s /opt/billing/node_modules node_modules && npm test && npm run test:after && npm run typecheck"]'

node bin/refit.mjs verify --directory /tmp/refit-billing-review
```

The output directory must not exist. Review `migration.patch`, `report.json`, and `pull-request.md`. The recorded local evaluation bundle is in `dist-cli/billing-evaluation-2026-10-09`, an ignored directory. The workflow stages and tests the patch without applying it to the billing repository.

## Supported boundaries

Wrapper tracing accepts a top-level function with exactly one required parameter and a body containing only a return of one mapped SDK call using that parameter. Direct relative named imports are supported. Extra arguments, defaults, transformations, wrapper chains, re-exports, namespace imports, mutation and client escape prevent confirmation or require review.

The new deterministic history rule accepts an async function body containing exactly a response declaration, a missing-`charges` guard throwing a constructed error with literal string arguments, and a direct return of `charges.data`. It retains the original retrieval, imports the proven exported client under a collision-checked alias, replaces the obsolete guard and return with async iteration of the Charges list, and retains existing exports. New Charges API failures propagate. This changes the missing-field error branch and introduces extra requests; human review is still required.

Direct unguarded migrations keep their existing single-page behavior. Guarded-history migrations collect every page in memory; very large histories can consume significant memory. Account/request options, expansions, custom error semantics and broader application behavior still require review. Remaining findings are obtained by rescanning the generated code, not by subtracting edit counts from finding counts.
