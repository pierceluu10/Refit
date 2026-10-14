# Monitor several APIs in one repository

Refit 0.11 accepts one checked-in `.refit.json` with **1–8 named integrations**. Each integration has its own contract, adapter, API-version policy and check commands. One enrollment reviews the complete file and all baseline/adapter inputs. The App service expands that approval into independent workers, with a **separate draft PR per integration** when publication is explicitly enabled and its gates pass.

This groups configuration and approval; it does not discover integrations automatically or supply missing SDK mappings. Each worker scans the same repository using its selected adapter. Integration names do not restrict scanning to a directory. Overlapping migrations are separate proposals against the monitored base and need ordinary conflict and semantic review.

## Repository configuration

Approved workflow, baseline and adapter inputs must use distinct committed file paths, including across integrations.

Use `formatVersion: 2` for a collection. Each entry has an `id` and the existing workflow fields, without its own `formatVersion` or `repository`. Names start with a lowercase letter and contain lowercase letters, digits or hyphens, up to 64 characters. Names must be unique.

This complete configuration is the bundled offline conformance fixture:

```json
{
  "formatVersion": 2,
  "integrations": [
    {
      "id": "stripe",
      "before": "./contracts/stripe-before.json",
      "after": "./contracts/stripe-current.json",
      "apiVersion": "2022-08-01",
      "apiVersionPolicy": "source-verified",
      "image": "node:22-alpine",
      "prepareDependencies": true,
      "fullDiff": true,
      "baselineCommand": ["node", "--experimental-strip-types", "simulator/check.mjs", "before"],
      "command": ["node", "--experimental-strip-types", "simulator/check.mjs", "stripe-after"]
    },
    {
      "id": "openai",
      "before": "./contracts/openai-before.json",
      "after": "./contracts/openai-current.json",
      "providerConfig": "./openai-provider.json",
      "apiVersion": "1",
      "image": "node:22-alpine",
      "prepareDependencies": true,
      "fullDiff": true,
      "baselineCommand": ["node", "--experimental-strip-types", "simulator/check.mjs", "before"],
      "command": ["node", "--experimental-strip-types", "simulator/check.mjs", "openai-after"]
    }
  ]
}
```

The Stripe behavior is a historical simulation. The OpenAI `model` → `model_id` change is **invented for testing**, not an announced migration. Its `apiVersion: "1"` identifies the simulated contract, not a live OpenAI API release. See [the fixture README](../pipeline/fixtures/multiple-integrations/README.md). Both SDKs make real HTTP requests only to a loopback server using explicit dummy keys. Only locked dependency preparation needs npm access; Docker checks run with external networking disabled. `oasdiff` and a running Docker daemon with the configured image are required.

For an actual application, supply its own contracts, reviewed provider mapping, version policy and meaningful commands. Each integration's patched checks should cover that migration **and regressions in the other integrations**. Before and after commands using different API behavior need semantic review. Passing one worker does not prove the combined application upgrade works.

## Select an integration manually

`run`, `watch` and `doctor` require `--integration <id>` for a collection, even when it contains one entry. Legacy `formatVersion: 1` workflows keep their existing commands and reject a named selector.

```sh
refit doctor --repository /absolute/path/to/application \
  --config /absolute/path/to/application/.refit.json --integration stripe

refit run --repository /absolute/path/to/application \
  --config /absolute/path/to/application/.refit.json --integration stripe \
  --output /absolute/path/outside-git/new-stripe-run --human

refit watch --repository /absolute/path/to/application \
  --config /absolute/path/to/application/.refit.json --integration stripe \
  --state /absolute/path/outside-git/stripe-worker --once --human

refit watch --repository /absolute/path/to/application \
  --config /absolute/path/to/application/.refit.json --integration openai \
  --state /absolute/path/outside-git/openai-worker --once --human
```

Use a different state directory per integration. Switching a selector in existing worker state is refused. Missing/unknown selectors and invalid collection entries fail before execution. Human output and workflow manifests identify the selected integration. AI generation, repair and publication remain explicit opt-ins; these commands use none.

To reproduce a change, copy the fixture's `repository/` into a disposable Git repository and commit it. Poll both integrations once with the unchanged current contracts. They produce review-required no-change receipts (exit 2), without requesting AI or running checks. Replace each `*-current.json` with its `*-after.json`, commit and poll again. Both migrations validate independently. Repeat the same commands to reuse their saved results. The application stays unmigrated; only the isolated validation copies receive patches.

## Approve once and run the App service

Commit the root file and every baseline/adapter, then inspect all integrations together:

```sh
refit enroll --repository /absolute/path/to/application \
  --github owner/application --base main
```

Review the displayed settings and inputs. Rerun with `--approve <exact-fingerprint> --output /absolute/path/outside-git/approval.json`. Approval pins the whole collection, each integration's baseline and adapter, and the repository/base identity. Configuration membership, commands, baselines or adapters changing anywhere in the group require a new receipt. Current contract and application changes do not require reapproval; version declarations are rechecked on each poll. A broken current source or conflicting SDK version in one integration can stop that worker while the sibling continues. Invalid shared configuration or changed approved inputs block the group.

Use a service file outside the monitored checkout:

```json
{
  "formatVersion": 1,
  "targets": [
    {
      "id": "billing",
      "repository": "owner/application",
      "base": "main",
      "approval": "./approval.json"
    }
  ]
}
```

After [App credential and service-secret setup](LOCAL-SERVICE.md), run:

```sh
refit serve --env /absolute/path/to/.env \
  --config /absolute/path/to/service.json \
  --state /absolute/path/outside-git/service-state --once
```

The target expands to **`billing.stripe`** and **`billing.openai`**. Each has its own managed checkout, approval cache, job receipts, validation evidence and publication identity. Workers run sequentially; there is no combined PR. The service still permits at most 32 expanded workers. Installation access applies to every integration in the repository; revocation blocks them all and preserves their evidence.

Omit `--once` to poll continuously while the local service runs. Add `--publish-draft` in fresh state only after inspecting validated results. Add `--ai-patch` and repair options explicitly when needed, keeping all integrations on the same operator spending ledger. Deterministic supported migrations need no model request. Installing the App alone still does not activate an unapproved repository.

To retry only Stripe, stop the service, retain its exact configuration/state/generation/publication settings, then add:

```sh
refit serve --env /absolute/path/to/.env \
  --config /absolute/path/to/service.json \
  --state /absolute/path/outside-git/service-state \
  --retry-target billing.stripe --once
```

The sibling is not polled or retried. Successful receipts remain cached. Changed inputs still require approval; retry cannot bypass that gate. Named PR discovery and branch identities cannot reuse a sibling draft, including profiles for the same provider. Existing unscoped workflows preserve their historical identity and legacy reconciliation.

Optional service overrides belong under the approved integration name:

```json
"integrations": {
  "stripe": {
    "source": { "kind": "stripe-latest" },
    "documentationSources": [{ "label": "Stripe changelog", "url": "https://docs.stripe.com/changelog.md" }]
  },
  "openai": {
    "source": { "kind": "https", "url": "https://provider.example/openapi.yaml" }
  }
}
```

This fragment goes on the `billing` service target. The example provider URL must be replaced with an authoritative public contract; it is not an OpenAI specification address. `stripe-latest` requires a pinned Refit Stripe baseline. Only `source` and `documentationSources` are override fields. Top-level source overrides on collection targets, unknown IDs and executable override fields are rejected. Changing service settings requires fresh state. Documentation changes alone stay review-only.

This is local operator automation with explicitly reviewed mappings and tests, not a hosted multi-tenant service or universal migration support.
