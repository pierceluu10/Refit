# Approve a repository workflow for the GitHub App

Collections with `formatVersion: 2` support up to eight named integrations in one repository. Manual `run`, `watch` and `doctor` commands require `--integration <id>`; enrollment reviews the whole collection and the App service expands it into independent targets such as `billing.stripe` and `billing.openai`, with separate draft PRs and retries. Existing single profiles keep their current commands. See [multiple integrations](MULTIPLE-INTEGRATIONS.md).

An installed repository can own its root `.refit.json`. Refit fetches the App-authorized base into a managed checkout, verifies a local operator approval, then uses that committed configuration through the shared worker. Installing the App alone does not activate a repository. Approval, GitHub access, AI and draft publication are separate settings. The same root profile can be polled locally with `refit watch --repository /path/to/repo --config /path/to/repo/.refit.json --state /path/outside-git/worker --once`; the command-line repository selector keeps it out of the approved file.

## Review the committed configuration

Commit `.refit.json`, its before contract and its provider adapter when needed. Paths must refer to committed regular files inside the repository. Parent paths, absolute paths, `.git`, symlinked profile inputs and submodules are unsupported. The profile cannot select another repository. Its API-version pin must match the before contract. Declared SDK versions must not conflict. Optional `apiVersionPolicy: "source-verified"` also requires supported source declarations to resolve; see [API-version policies](API-VERSIONS.md). Application declarations are rechecked even when approved configuration inputs are unchanged. Live Stripe discovery requires a pinned baseline; other providers can use an explicitly configured public HTTPS source in the service target.

Run the [readiness check](REPOSITORY-SETUP.md), then inspect the exact committed profile:

```sh
refit enroll --repository ~/Repos/refit-billing-demo \
  --github pierceluu10/refit-billing-demo --base main
```

This requires the reviewed configuration to exist in that checkout. The command prints the workflow settings, input files, reviewed commit and a full fingerprint. It does not execute the app, contact GitHub, install dependencies or request AI. `--json` produces a review record for automation or archiving. Review the commands, image, version pin, baseline and adapter files before approval. A fingerprint identifies the exact reviewed bytes; it does not establish their safety or migration semantics. A customer needs no setting of their own for dependencies: where Refit cannot prepare them itself, it runs the repository's own install in its build sandbox, and otherwise its customer-CI workflow pull request is the only thing it asks them to approve ([customer environment](CUSTOMER-ENVIRONMENT.md)).

## A repository with no `.refit.json`

For a Stripe app on npm, pnpm or Yarn that commits no `.refit.json`, `refit enroll` reviews the configuration Refit generates from the code: the API version the code sends, contracts from Refit's pinned table and the repository's own checks ([how it is chosen](INSTALL.md#a-repository-with-no-refitjson)). Save the two contracts first; `refit doctor` prints the exact command:

```sh
refit stripe-snapshot --version <api-version> --version 2026-09-30.endive
refit enroll --repository ~/Repos/app --github owner/app --base main
```

The review labels the configuration "Generated", lists the generated `.refit.json` and the saved before contract as its inputs, and fingerprints them exactly like committed files. Approval follows the same steps below. The fingerprint changes when the code's API version changes or Refit's table gains a newer target, and the worker then stops as `needs-review` until a new approval. If Refit cannot generate a configuration, enroll refuses with each reason and its fix; `refit doctor` reports them too. Under owner decision 1 (the default), a missing root lockfile or missing checks do not refuse: the review names them, and the patches are published untested as `[Needs review]` drafts. `--publish-validated-only` refuses them as before, and a worker run with it stops such an approval for review. The service worker runs an approved generated configuration, downloading its two pinned contracts (#265), and approval issues review it the same way (#267).

## Retain approval outside Git

After review, rerun the same command with the **full fingerprint it printed**:

```sh
refit enroll --repository ~/Repos/refit-billing-demo \
  --github pierceluu10/refit-billing-demo --base main \
  --approve <exact-reviewed-fingerprint> \
  --output ~/.refit/approvals/billing-demo.json
```

The receipt must be new and outside every Git checkout. It is created with owner-only permissions and contains target identity, the reviewed commit, hashes and byte counts; it does not embed source contents or credentials. A stale fingerprint is refused before writing. Receipts are unsigned local operator state, not authenticated hosted administrator approval. Keep them under the operator's control.

Approval covers the `.refit.json` bytes, before-contract bytes and adapter bytes. It is bound to the GitHub repository and base branch. Normal application code and the current API source may change without reapproval. SDK dependency changes still go through ordinary preparation and validation gates. Approval does not prove effective account versions, SDK method availability, meaningful tests or complete code coverage.

## Activate the reviewed profile

Create an operator service file with `approval` instead of `workflow`:

```json
{
  "formatVersion": 1,
  "targets": [
    {
      "id": "billing-demo-stripe",
      "repository": "pierceluu10/refit-billing-demo",
      "base": "main",
      "approval": "/home/you/.refit/approvals/billing-demo.json"
    }
  ]
}
```

Use the existing [App credentials and service secrets](LOCAL-SERVICE.md), then run `refit serve --env .env --config /absolute/path/to/service.json --state /path/to/new-state --once`. Omit `--once` for continuous polling. No AI or publication is enabled by this command. Add those options explicitly only after inspecting a validated run and configuring the shared spending allowance.

Each target selects exactly one `workflow` or `approval`. Existing operator workflow profiles continue to work. Optional `source` and `documentationSources` remain operator-selected service settings and participate in service identity. A source override permits public HTTPS monitoring; without one, the repository profile selects its committed after file or latest Stripe discovery.

Every poll verifies GitHub installation access, refreshes the managed base, reads the profile from immutable Git objects and matches its fingerprint. The approved baseline and adapter are copied to private worker state and hash-checked on reuse. An incomplete, linked or changed cached input stops instead of being overwritten. Application checks execute only through the existing isolated validation path.

Changed profile, baseline or adapter inputs produce `needs-review` before source polling, AI, preparation, tests or publication. Other approved targets continue. The status record keeps `approvalFingerprint`; normal worker receipts still deduplicate unchanged jobs across restarts. Revoked App access retains the existing cancellation behavior. A failed approved worker can be retried after resolving its cause with the same `serve` configuration/state and `--retry-target <id> --once`. Stop any running service first; only selected targets are polled, old evidence is preserved and successful jobs remain cached. See [service retry commands](LOCAL-SERVICE.md#retry-a-failed-target-once).

Inspect the new configuration and issue a new receipt when approved inputs change. Changing a service target's approval requires fresh service state under the existing configuration identity rules; preserve old state for inspection. Baselines are never automatically advanced. This is explicit local onboarding for configured repositories, not automatic activation of every installed repository or a hosted enrollment service.
