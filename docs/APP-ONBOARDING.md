# Approve a repository workflow for the GitHub App

An installed repository can own its root `.refit.json`. Refit fetches the App-authorized base into a managed checkout, verifies a local operator approval, then uses that committed configuration through the shared worker. Installing the App alone does not activate a repository. Approval, GitHub access, AI and draft publication are separate settings.

## Review the committed configuration

Commit `.refit.json`, its before contract and its provider adapter when needed. Paths must refer to committed regular files inside the repository. Parent paths, absolute paths, `.git`, tracked symlinks and submodules are unsupported. The profile cannot select another repository. Its API-version pin must match the before contract. Live Stripe discovery requires a pinned baseline; other providers can use an explicitly configured public HTTPS source in the service target.

Run the [readiness check](REPOSITORY-SETUP.md), then inspect the exact committed profile:

```sh
refit enroll --repository /Users/pierceluu/Repos/refit-billing-demo \
  --github pierceluu10/refit-billing-demo --base main
```

This requires the reviewed configuration to exist in that checkout. The command prints the workflow settings, input files, reviewed commit and a full fingerprint. It does not execute the app, contact GitHub, install dependencies or request AI. `--json` produces a review record for automation or archiving. Review the commands, image, version pin, baseline and adapter files before approval. A fingerprint identifies the exact reviewed bytes; it does not establish their safety or migration semantics.

## Retain approval outside Git

After review, rerun the same command with the **full fingerprint it printed**:

```sh
refit enroll --repository /Users/pierceluu/Repos/refit-billing-demo \
  --github pierceluu10/refit-billing-demo --base main \
  --approve <exact-reviewed-fingerprint> \
  --output /Users/pierceluu/.refit/approvals/billing-demo.json
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
      "approval": "/Users/pierceluu/.refit/approvals/billing-demo.json"
    }
  ]
}
```

Use the existing [App credentials and service secrets](LOCAL-SERVICE.md), then run `refit serve --env .env --config /absolute/path/to/service.json --state /path/to/new-state --once`. Omit `--once` for continuous polling. No AI or publication is enabled by this command. Add those options explicitly only after inspecting a validated run and configuring the shared spending allowance.

Each target selects exactly one `workflow` or `approval`. Existing operator workflow profiles continue to work. Optional `source` and `documentationSources` remain operator-selected service settings and participate in service identity. A source override permits public HTTPS monitoring; without one, the repository profile selects its committed after file or latest Stripe discovery.

Every poll verifies GitHub installation access, refreshes the managed base, reads the profile from immutable Git objects and matches its fingerprint. The approved baseline and adapter are copied to private worker state and hash-checked on reuse. An incomplete, linked or changed cached input stops instead of being overwritten. Application checks execute only through the existing isolated validation path.

Changed profile, baseline or adapter inputs produce `needs-review` before source polling, AI, preparation, tests or publication. Other approved targets continue. The status record keeps `approvalFingerprint`; normal worker receipts still deduplicate unchanged jobs across restarts. Revoked App access retains the existing cancellation behavior.

Inspect the new configuration and issue a new receipt when approved inputs change. Changing a service target's approval requires fresh service state under the existing configuration identity rules; preserve old state for inspection. Baselines are never automatically advanced. This is explicit local onboarding for configured repositories, not automatic activation of every installed repository or a hosted enrollment service.
