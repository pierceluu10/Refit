# Two integrations in one repository

This internal conformance fixture exercises Stripe **10.17.0** and OpenAI **7.32.0** through actual SDK HTTP requests to a loopback simulator. It has one shared client per provider, a root `.refit.json` with two named integrations, and a committed npm lockfile. Dummy keys are explicit; SDK requests never reach either vendor.

Stripe simulates the historical `PaymentIntent.charges` removal. Refit's existing history rule uses the Charges list endpoint. The OpenAI contract **invents a `ChatCompletion.model` → `model_id` rename** to test a reviewed adapter mapping; this is not an announced OpenAI change. The contracts are small projections for testing, not complete vendor specifications. Response behavior is selected by the simulator independently of the declared Stripe API version.

After copying `repository/` to a disposable directory and running `npm ci --ignore-scripts --no-audit --no-fund`, use Node 22.12+:

```sh
node --experimental-strip-types simulator/check.mjs before
node --experimental-strip-types simulator/check.mjs stripe-after
node --experimental-strip-types simulator/check.mjs openai-after
```

The original code passes `before` and deliberately fails both changed modes. Each integration's patched checks use its own changed response plus the sibling's original response. All checks exercise two-charge history, empty history, retrieval failure, a completion response and a failed completion request. `all-after` is available for inspection after applying both migrations; the worker creates separate proposals against the same original base.

The current contracts start equal to their baselines. Copy both `*-after.json` files over the corresponding `*-current.json` files and commit to simulate changes arriving. Configuration, baselines and adapter remain unchanged, so approval stays valid.

From the Refit checkout, the end-to-end App worker tests use native Git, controlled GitHub access responses, `oasdiff`, locked npm preparation and real offline Docker:

```sh
REFIT_DOCKER_IMAGE=node:22-alpine REFIT_OASDIFF=/opt/homebrew/bin/oasdiff \
REFIT_NPM_PREPARE=1 npm test -- pipeline/approved-repository-service.test.ts --maxWorkers=1
```

Only dependency preparation contacts npm. The tests use no AI or live GitHub publication, retain separate evidence and retries, and verify unchanged jobs reuse their receipts. This fixture does not establish live vendor rollout semantics or compatibility with arbitrary repositories. See [multiple integrations](../../../docs/MULTIPLE-INTEGRATIONS.md) for configuration and commands.
