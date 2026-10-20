# Provider agents

A provider agent is a reviewed adapter for one API provider: which SDK it covers, how SDK calls map to API operations, and which migration rules apply. `refit agents` detects the providers a repository uses and suggests only the agents that match. Nothing activates on its own. The goal, status and priority of each provider agent are in [Provider goals](PROVIDER-GOALS.md).

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
| Stripe | `stripe`, `api.stripe.com`, `files.stripe.com`, `connect.stripe.com` | built-in |
| OpenAI | `openai`, `api.openai.com` | `examples/openai.provider.json` (preview: `models.retrieve`, `chat.completions.create`, `responses.create` and `embeddings.create`, with the response schemas and operation IDs of OpenAI's published OpenAPI document; extend it with `refit adapter-suggest`) |
| Anthropic | `@anthropic-ai/sdk`, `api.anthropic.com` | none yet; `examples/anthropic.provider.json` traces `messages` calls for [model replacement proposals](DEADLINES.md#propose-model-replacements), but Anthropic publishes no contract for `refit run` |
| Shopify | `@shopify/shopify-api`, `@shopify/admin-api-client`, `@shopify/shopify-app-remix`, `@shopify/shopify-app-react-router`, `@shopify/shopify-app-express`, `shopify-api-node`, `myshopify.com/admin/api` | built-in, Admin GraphQL ([Shopify](SHOPIFY.md)); `shopify-api-node` and REST calls are detected but not migrated |
| Meta Graph API | `facebook-nodejs-business-sdk`, `graph.facebook.com` | none yet; `refit meta-graph` lists Graph API requests with their version, edge and fields for review ([Meta Graph API](META-GRAPH.md)) |
| Twilio | `twilio`, `api.twilio.com` | none yet |
| SendGrid | `@sendgrid/mail`, `@sendgrid/client`, `api.sendgrid.com` | none yet |
| Resend | `resend`, `api.resend.com` | none yet |
| PayPal | `@paypal/paypal-server-sdk`, `@paypal/checkout-server-sdk`, `api-m.paypal.com`, `api-m.sandbox.paypal.com` | none yet |

## Add an agent

```sh
refit agents --add openai
```

This writes an integration scaffold into `.refit.json`, converting a single-workflow file to the multi-integration format if needed. A file-based agent's adapter is copied into `refit/<id>.provider.json`. Only detected agents with a shipped adapter can be added, and an agent already configured under another adapter ID is not added twice.

The scaffold names contract paths (`refit/<id>-before.json`, `refit/<id>-after.json`) and a check command, `npm test` when a real test script exists and otherwise `npm run build`. Save reviewed contracts with `refit stripe-snapshot`, `refit shopify-snapshot` or `refit source-snapshot`, review the command, and run `refit doctor`. Nothing runs until the configuration is committed and approved with `refit enroll`. See [multiple integrations](MULTIPLE-INTEGRATIONS.md) and [App onboarding](APP-ONBOARDING.md).

## Suggestions on pull requests

When `refit serve` receives a `pull_request` webhook (opened, reopened or synchronized) for a configured repository, it lists the pull request's changed files through the GitHub API. Every changed `package.json`, at the root or in any workspace, is compared at the pull request's base and head. Added lines in changed JavaScript and TypeScript files are checked for catalog API hostnames; a hostname the same file's patch also removes counts as moved code. If the pull request adds an SDK or raw API call that has an agent and no configured adapter covers it, the App posts one comment naming the agent, the file and the `refit agents --add` command. Each agent is suggested once per pull request, even across later pushes. A failed check is recorded in service status and is not retried until the pull request changes.

The comment uses a repository-scoped token with Contents read and Pull requests write. Subscribe the App to **Pull request** events; see [local service](LOCAL-SERVICE.md#receive-real-github-webhooks-through-https). The suggestion is advice only: no configuration is written, no worker starts and no code runs.

## Deadlines

`refit deadlines` uses the same catalog to say what happens next when a repository pins an API version or model that a provider is retiring. A configured integration runs the normal migration, an agent that exists can be added with `refit agents --add`, and a provider without an agent is reported as such. See [API deadlines](DEADLINES.md).

## Limits

- Detection covers JavaScript and TypeScript repositories and the providers listed above. A provider used through a generic HTTP client without its hostname in source is not detected.
- Pull request suggestions read the first 1,000 changed files. Files under `node_modules` are ignored, and a source file GitHub returns without a patch (very large diffs) is not checked for hostnames. Lockfile-only changes are not compared: a new direct SDK always enters through a manifest.
- An agent's quality depends on its adapter and rules. Stripe has migration rules and benchmarks; OpenAI's example adapter maps one operation and needs extending for real use.
