# Provider detection and agent suggestions

Status: **detection and suggestion implemented** (`pipeline/provider-detection.ts`). Writing approved agents into `.refit.json`, the doctor display, the CLI command and the pull-request comment are not wired yet; see [what remains](#what-remains).

When Refit is added to a repository, it should find which provider SDKs the code uses and suggest only the agents that match. Nothing activates on its own. Approval and writing `.refit.json` stay with the existing enrollment flow.

## Detect providers

```ts
const detected = await detectProviders(repositoryRoot);
```

It reads files only; nothing is installed or run. It returns one entry per provider with evidence:

| Evidence | Meaning |
|---|---|
| `dependency` | A `package.json` (root or workspace) declares the provider's server SDK, with the version locked by the npm, pnpm or Yarn lockfile when one resolves it |
| `client-dependency` | A browser-only package, such as `@stripe/stripe-js`. It is reported but does not count as calling the API |
| `hostname` | A source file calls the provider's API host directly, for example `fetch('https://api.resend.com/emails')` |

`server` is true when there is a server SDK or a raw API host. `agentAvailable` is true when Refit can maintain the provider today.

`node_modules`, build output (`dist`, `build`, `out`, `.next`, `coverage`, `vendor`) and hidden directories are skipped. A host matches only as `//host` followed by a path, quote or port, so lookalikes such as `api.stripe.com.example.org` don't count.

The catalog in `PROVIDER_CATALOG` lists Stripe, OpenAI, Anthropic, Twilio, SendGrid, Resend and PayPal. Only Stripe has an agent: a built-in adapter and published contracts. The others are detected and reported, but never suggested.

## Suggest agents

```ts
const suggestions = await suggestAgents(repositoryRoot, detected);
```

It returns a suggestion only for providers that call the API (`server`) and have an agent. Each suggestion contains:
- `integration`: a `.refit.json` formatVersion 2 integration entry for review. For Stripe it contains:
  - `latestStripe: true`;
  - the code's pinned `apiVersion` with `source-verified`, when every literal pin agrees, otherwise `operator-pin`;
  - `prepareDependencies` when a root lockfile exists;
  - the package manager's `test` command when the repository has a real test script.
- `pending`: what approval must still supply. Always the `before` contract for the API version; also the API version when the code pins none or several, checks when there is no test script, and confirmation when no Stripe SDK call was traced.
- `reasons`: the evidence shown to the person approving, such as traced SDK calls and the locked SDK version.

It writes nothing.

## Measured on the 100-repository Stripe benchmark

About 0.7 seconds per repository, all 100 read without errors:

| | Repositories |
|---|---|
| Stripe server SDK detected, agent suggested | 100 (the benchmark selected Stripe users) |
| Suggested with the code's pinned API version | 40 |
| Suggested with a test command | 17 |
| Other providers detected (no agent yet) | OpenAI 19, Resend 25, Anthropic 4, Twilio 2, SendGrid 2, PayPal 4 |

A hand check of every hostname-only detection found real raw API calls in most cases. The rest were a settings placeholder string, a security allowlist and a test configuration; they name the provider's API but do not call it. Generated `.keystone/` output was the only false source, and hidden directories are now skipped.

## What remains

These belong to the enrollment and GitHub App flow:

1. **Write approved agents.** Merge an approved `integration` into `.refit.json` (formatVersion 2) and collect the `pending` inputs, such as pinning the `before` contract, before `refit enroll` fingerprints it.
2. **Doctor and onboarding.** Show detected providers, evidence and suggestions in `refit doctor` and the hosted enrollment page.
3. **CLI.** A `refit detect` command that prints `detectProviders` and `suggestAgents`.
4. **Re-detect on pull requests.** On `pull_request` events, compare `detectProviders` for the base and head revisions. When a new server SDK with an agent appears, comment with the suggestion; never change `.refit.json`. This needs pull-request read and comment permissions on the App.
