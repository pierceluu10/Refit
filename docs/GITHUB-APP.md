# Publish as Refit Agent

GitHub attributes API actions to the authenticated account. A personal token opens a PR as its owner; a GitHub App installation token opens it as the App bot. Changing commit display text does not change the PR author or avatar. Refit supports both modes.

## One-time GitHub setup

1. Open [New GitHub App](https://github.com/settings/apps/new) in your signed-in account. Name it **Refit Agent** if available. GitHub requires a globally unique name and renders its normalized slug in activity, for example `refit-agent[bot]`.
2. Use your product homepage or owning GitHub account URL as the homepage. This local CLI does not need a callback URL, OAuth user authorization, device flow or webhook. Deselect **Active** under Webhook.
3. Grant repository **Contents: Read and write** and **Pull requests: Read and write**. Metadata read access is automatic. For your own evaluation, choose **Only on this account**; public installation is a separate onboarding decision.
4. Create the App, upload [the Refit logo](../public/refit-agent-avatar.png) in its Display information settings, and generate a private key. Keep the downloaded PEM outside your repositories.
5. Install the App on your account with access to **only the test repository**. Installing it grants persistent access to that selected repository until you revoke it.
6. Add the numeric **App ID** and the absolute path to that PEM to your existing `.env` as `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_FILE`. Keep your existing OpenAI variables. See [the environment example](../.env.example) for names. Neither a client secret nor a manually copied installation token is needed.

The checkout logo is `public/refit-agent-avatar.png`. An installed CLI archive also includes it at `public/refit-agent-avatar.png` inside the package. The name and logo are GitHub App settings, not per-PR overrides. Existing PR authors cannot be changed; PR #1 remains personally authored.

These settings follow GitHub's [registration instructions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) and [installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).

## Run

From the Refit checkout, with the independent billing repository and prepared history-check Docker image:

```sh
refit run --env .env --config examples/billing-demo.refit.json \
  --output /tmp/refit-app-demo-001 --ai-patch --repair-attempts 2 \
  --publish-draft --github pierceluu10/refit-billing-demo --base main --github-app
```

Choose a fresh output directory on each run. `--github-app` selects App authentication even if `GITHUB_TOKEN` is present. Without that flag, publication uses `GITHUB_TOKEN` as before. AI still requires explicit `--ai-patch`, `OPENAI_API_KEY` and `OPENAI_MODEL`.

Refit validates the source and patch before authenticating the App. It signs a short-lived RSA JWT, verifies the App ID, discovers the installation for the selected repository, and requests an installation token scoped to that repository with only Contents and Pull requests write access. It verifies expiry, permissions, repository scope and bot identity before writing Git objects. GitHub's installation token expires after one hour; Refit does not persist it.

The commit uses the verified App bot's GitHub noreply email for author and committer. App runs use a distinct deterministic branch identity, so they do not reuse a personally authored PR for the same patch. Publication verifies the returned PR author against the authenticated bot. `publication.json` records the non-secret publisher identity. Tokens and private keys stay in the host publisher and are not sent to OpenAI, Docker or the review bundle.

## Verification boundary

On October 11, 2026, the installed CLI created [draft PR #2](https://github.com/pierceluu10/refit-billing-demo/pull/2) as `refit-agent[bot]` using the registered **Refit Agent** App (ID `5275879`, owned by `refit-dev`) and its installation on the billing repository. GitHub confirmed the bot as both PR author and commit author/committer. The live OpenAI proposal passed offline Docker validation, and a separate download of the remote commit passed both simulator contracts, TypeScript, pagination/empty-history checks and both billing demos.

Tests also verify RSA signatures, controlled GitHub responses, expiry/scope/identity checks, rejection before publication and separation from personal-token branches. The full gated Refit suite passed 263 tests with none skipped. This verifies a manually triggered CLI run through one installed App; installing the App does not start a hosted worker, webhook processing or scheduled monitoring. Stripe traffic in this evaluation was simulated; OpenAI and GitHub requests were live.
