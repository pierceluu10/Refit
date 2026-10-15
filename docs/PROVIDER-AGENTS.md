# Provider agents

A provider agent is a reviewed adapter for one API provider: which SDK it covers, how SDK calls map to API operations, and which migration rules apply. `refit agents` detects the providers a repository uses and suggests only the agents that match. Nothing activates on its own.

## Detect providers

```sh
refit agents --repository .
```

Refit reads committed `package.json` declarations and the matching npm, pnpm or yarn lockfile versions. It also scans JavaScript and TypeScript source for raw API hostnames such as `api.stripe.com` or `graph.facebook.com`. No repository code runs and no provider is contacted. Each detected provider shows its evidence and one of three states:

- **configured:** an integration in `.refit.json` already uses an adapter for this SDK.
- **agent available:** Refit ships an agent; the line shows the `--add` command.
- **no agent yet:** the provider is detected but Refit has no reviewed adapter for it.

| Provider | Detected from | Agent |
|---|---|---|
| Stripe | `stripe`, `api.stripe.com` | built-in |
| OpenAI | `openai`, `api.openai.com` | `examples/openai.provider.json` (preview: extend it with `refit adapter-suggest`) |
| Anthropic | `@anthropic-ai/sdk`, `api.anthropic.com` | none yet |
| Shopify | `@shopify/shopify-api`, `@shopify/admin-api-client`, `shopify-api-node`, `myshopify.com/admin/api` | none yet |
| Meta Graph API | `facebook-nodejs-business-sdk`, `graph.facebook.com` | none yet |
| Twilio | `twilio`, `api.twilio.com` | none yet |

## Add an agent

```sh
refit agents --add openai
```

This writes an integration scaffold into `.refit.json`, converting a single-workflow file to the multi-integration format if needed. A file-based agent's adapter is copied into `refit/<id>.provider.json`. Only detected agents with a shipped adapter can be added, and an agent already configured under another adapter ID is not added twice.

The scaffold names contract paths (`refit/<id>-before.json`, `refit/<id>-after.json`) and a check command, `npm test` when a real test script exists and otherwise `npm run build`. Save reviewed contracts with `refit stripe-snapshot` or `refit source-snapshot`, review the command, and run `refit doctor`. Nothing runs until the configuration is committed and approved with `refit enroll`. See [multiple integrations](MULTIPLE-INTEGRATIONS.md) and [App onboarding](APP-ONBOARDING.md).

## Suggestions on pull requests

When `refit serve` receives a `pull_request` webhook (opened, reopened or synchronized) for a configured repository, it compares the root `package.json` at the pull request's base and head through the GitHub API. If the head adds an SDK that has an agent and no configured adapter covers it, the App posts one comment naming the agent and the `refit agents --add` command. Each agent is suggested once per pull request, even across later pushes. A failed check is recorded in service status and is not retried until the pull request changes.

The comment uses a repository-scoped token with Contents read and Pull requests write. Subscribe the App to **Pull request** events; see [local service](LOCAL-SERVICE.md#receive-real-github-webhooks-through-https). The suggestion is advice only: no configuration is written, no worker starts and no code runs.

## Limits

- Detection covers JavaScript and TypeScript repositories and the providers listed above. A provider used through a generic HTTP client without its hostname in source is not detected.
- Pull request suggestions compare the root `package.json` only. Workspace manifests are not compared yet.
- An agent's quality depends on its adapter and rules. Stripe has migration rules and benchmarks; OpenAI's example adapter maps one operation and needs extending for real use.
