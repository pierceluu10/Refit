<p align="center">
  <img src=".github/logo.png" alt="Refit" width="88" height="88" />
</p>

<h1 align="center">Refit</h1>

<p align="center">
  <strong>An AI agent that keeps your code up to date with every API you depend on.</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#supported-providers">Providers</a> ·
  <a href="#architecture">Architecture</a>
</p>

<p align="center">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" />
  <img alt="Node 22+" src="https://img.shields.io/badge/node-22%2B-339933?logo=node.js&logoColor=white" />
  <img alt="Docker" src="https://img.shields.io/badge/sandbox-Docker-2496ED?logo=docker&logoColor=white" />
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-black" />
</p>

---

APIs change under you. Shopify retires an Admin API version every quarter, Stripe pins you to an API date, OpenAI retires models, Meta expires Graph API versions. Refit watches those changes, finds the code they break, rewrites it, proves the fix builds and passes your tests, and opens a pull request.

Install it once as a GitHub App. It reads every repo in your organization, remembers how your team fixed things before, and gets faster and cheaper with every merged PR.

## Features

- **Understands your code.** An agent maps every external API call in each repo: provider, SDK or raw HTTP/GraphQL, pinned version and call site.
- **Watches providers.** Reads changelogs, API specs, SDK releases and deprecation notices, and records each change with a quote from the source.
- **Migrates the code.** Edits a copy of the repo with provider-specific tools: GraphQL schema validation for Shopify, API-version diffs for Stripe, model lookups for OpenAI.
- **Proves it works.** Runs install, type check, build and tests in an isolated Docker sandbox, before and after the change. A PR only opens once nothing new breaks.
- **Remembers your company.** Every merged fix becomes a recipe, embedded with [Voyage](https://www.voyageai.com/) `voyage-code-3`. Your organization's own past fixes are retrieved first, so the next migration starts from how your team already does it.
- **Opens a reviewable PR.** One branch per change, explaining what changed, why, the proof and anything left unproven. It never pushes to your default branch.
- **Upgrades dependencies too.** End-of-life runtimes, framework majors, SDK majors, base images and CI actions go through the same loop.

## Supported providers

| Provider    | What Refit migrates                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| **Shopify** | Admin GraphQL version upgrades, REST to GraphQL, deprecated fields and mutations, webhook topics, app SDK majors |
| **Stripe**  | API version upgrades, removed parameters and fields, Checkout and Billing changes, `stripe` SDK majors           |
| **OpenAI**  | Model retirements, Chat Completions and Assistants to Responses, SDK majors                                      |
| **Meta**    | Graph API and Marketing API version expiries, removed metrics and fields, Business SDK majors                    |
| **Twilio**  | Product end-of-life, API path versions, helper library majors                                                    |
| **GitHub**  | REST API versions, GraphQL breaking changes, Octokit majors, Actions runner images                               |

## How it works

```text
 install ──▶ understand ──▶ watch ──▶ match ──▶ migrate ──▶ prove ──▶ open PR ──▶ learn
   │             │            │         │          │           │          │          │
 GitHub App   API usage    provider  change ×   agent edits  Docker:   branch +   merged
 on your org  map per repo changelogs call site  a sandboxed  build +   proof in   fixes become
                                                 copy         tests     the body   recipes
```

1. **Install** the GitHub App on your organization.
2. **Understand.** Refit reads each repo and builds a map of every external API it calls. It re-reads on every push.
3. **Watch.** Provider watchers read changelogs and specs and record each breaking change.
4. **Match.** An agent decides which changes affect which call sites, and ranks the work by deadline.
5. **Migrate.** The Claude-powered harness edits the code with file, shell and provider tools, guided by your organization's recipes.
6. **Prove.** Build, type check and tests run in Docker before and after. Only new failures count.
7. **Ship.** A PR with the diff, the source of the change, the proof and what still needs a human eye.
8. **Learn.** Your verdict on the PR (merged, edited or closed) feeds back into memory.

## Quick start

Requires Node.js 22.12+ and Docker.

```sh
git clone https://github.com/pierceluu10/Refit.git
cd Refit
npm ci
cp .env.example .env   # add ANTHROPIC_API_KEY, and VOYAGE_API_KEY for memory
```

Scan a repo for the APIs it uses and what's changed:

```sh
npx refit scan --repo ../your-repo
```

Migrate it and open PRs (add `--dry-run` to stop before the PR):

```sh
npx refit run --repo ../your-repo
```

To run Refit as a GitHub App for your organization, see [app/SETUP.md](app/SETUP.md).

## Evals

`evals/` holds Refit's eval harness: frozen sets of real public repos, a runner that takes each one through the full pipeline, scoring, and an AI reviewer for the PRs it opens. The main set, `six-providers-780`, pins 130 repos for each provider to an exact commit.

```sh
node evals/sets/build-six.ts                         # rebuild the 780-repo set from GitHub
node evals/runner/cli.ts run --set six-providers-780 --limit 10 --concurrency 2 --budget-usd 10
```

## Architecture

```text
refit/
├── app/            GitHub App: webhooks, org and repo sync, job queue, PR opener
├── orchestrator/   The end-to-end loop, the match agent and the `refit` CLI
├── inventory/      Codebase-understanding agent that produces the API usage map
├── providers/      One folder per provider: watcher, knowledge, tools and playbooks
├── harness/        The migration agent: prompt, tools, Docker sandbox, checks, PR writer
├── memory/         Run records, recipe extraction, Voyage retrieval, skill promotion
├── evals/          Repo sets, benchmark runner, scoring and the PR reviewer
├── shared/         types.ts, the contract every package codes against
└── src/            The web dashboard
```

Built with TypeScript, the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk), Voyage embeddings, Docker and the GitHub App APIs.

## Development

```sh
npm run typecheck
npm test
npm run format:check
npm run build
```

## License

[MIT](LICENSE)
