# npm workspace conformance fixture

This is synthetic test and demo code for Refit's dependency preparation. It is not a production billing system or a live Stripe migration.

The root depends on Stripe 19.1.0. The TypeScript billing workspace deliberately uses 10.17.0, which forces a nested SDK installation. The local `@refit-fixture/ids` workspace verifies that npm links resolve actual application source during offline checks. Root and workspace postinstall traps assert that preparation never runs lifecycle scripts.

The test assembles a separate Git repository from `repository/` and copies `../stripe-sdk/contract.mjs` to its `simulator/stripe-contract.mjs`. The canonical HTTP simulator is shared rather than duplicated. The wrapper selects pagination/empty scenarios, verifies both installed SDK versions and calls that simulator. No real credentials or Stripe servers are needed.

From the Refit checkout, with Docker and the local image available:

```sh
REFIT_NPM_PREPARE=1 REFIT_DOCKER_IMAGE=node:22-alpine \
  npm test -- pipeline/npm-workspace-docker.test.ts
```

The original code passes the before simulator and fails after removal of `PaymentIntent.charges`. Refit proposes a paginated Charges list migration without applying it to the source repository. See [workspace setup and boundaries](../../../docs/NPM-WORKSPACES.md).
