# Inventory benchmark

This benchmark tests the claim "Refit detects the APIs a repository uses". It is independent of every other frozen list. The repositories were not chosen because they use a provider Refit knows, and they were labelled by hand before Refit was run on any of them.

- Frozen list: [`benchmarks/2026-10-22-inventory-repos.json`](benchmarks/2026-10-22-inventory-repos.json) (150 repositories: 100 JS/TS, 30 Python, 20 Go).
- Labels: [`benchmarks/2026-10-22-inventory-labels.json`](benchmarks/2026-10-22-inventory-labels.json).
- Results on `main`: [`benchmarks/2026-10-22-inventory-results.json`](benchmarks/2026-10-22-inventory-results.json).
- Scripts: `scripts/inventory-benchmark-select.mjs` (sampling), `scripts/inventory-benchmark-candidates.mjs` (the labeller's independent search), `scripts/inventory-benchmark.mjs` (runs Refit and scores). The pure scoring functions are in `scripts/inventory-benchmark-score.mjs` and are tested by `pipeline/inventory-benchmark.test.ts`.

## Labelling guide

This guide was written before any repository was sampled or labelled. Labels follow it exactly, and any case it did not foresee is decided once, added below under "Rulings", and applied to every repository.

### What counts as an API use

A **label** is one external API that the repository's **production code** really calls over the network, through either:

- **`sdk`**: the provider's own client package, or a third-party package whose only purpose is to call that provider (for example `@langchain/openai` or `@ai-sdk/anthropic`). The package must be imported and used to make a call, or to construct a client that production code then uses.
- **`http`**: a request the repository builds itself (`fetch`, axios, `requests`, `http.Get`, a GraphQL client) to a fixed host the provider operates.

An **external API** is a network service run by a third party and reached through its documented API. That includes payments, AI models, email and messaging, maps, cloud services (AWS, Google Cloud, Azure), hosted backends (Supabase, Firebase, Appwrite Cloud, Convex), analytics, error tracking, search, storage and auth providers, and public data APIs (weather, exchange rates, GitHub's REST API).

### What does not count

- **Database, cache and queue drivers** that speak their own wire protocol (`pg`, `mysql2`, `mongodb`, `mongoose`, `redis`, `ioredis`, `amqplib`, `kafkajs`, Prisma, Drizzle, SQLAlchemy, `database/sql`), even when the database is a managed cloud service. They are infrastructure, not an API whose contract Refit monitors. HTTP-API databases with their own SDK do count: Upstash REST, `@vercel/kv`, `@planetscale/database`, `@neondatabase/serverless` (HTTP), Supabase and Firebase clients.
- **Self-hosted services.** That covers the repository's own backend, localhost, and services the operator runs themselves (a self-hosted Ollama, Meilisearch or MinIO with a configured URL). A configurable base URL whose default is a provider's host counts as that provider.
- **Indirect use through a framework that hides the provider.** Examples are OAuth providers configured in NextAuth/Auth.js or Passport (the library makes the calls), webhooks the provider sends *to* the repository with no outgoing call, and a build tool talking to a registry.
- **Links and assets**: hyperlinks, images, fonts, CDN script URLs for libraries, schema URLs, and documentation links.
- **Declared but unused**: a dependency in a manifest that no production file imports.
- **Non-production code**: tests, fixtures, mocks, examples, demos, docs, Storybook, benchmarks, seed and one-off maintenance scripts, and CI configuration. "Production code" is code that runs when the application is used: server, client, CLI, worker, bot and cron jobs that ship with it.
- **Client-side script tags** count only when production code then calls the provider's API (for example `Stripe(...)` after loading Stripe.js). A tag that only loads an analytics snippet counts as that analytics provider, because the snippet's purpose is to send events to it.

### Provider identity

- `provider` is a stable lower-case id for the company or product family whose API is called: `stripe`, `openai`, `aws`, `google-maps`, `firebase`, `supabase`, `sentry` and so on.
- When the provider is in Refit's agent catalog (`pipeline/agent-catalog.ts`), the label uses the catalog id: `stripe`, `openai`, `anthropic`, `gemini`, `shopify`, `meta-graph`, `twilio`, `sendgrid`, `resend`, `paypal`. Using the catalog's names is not looking at Refit's output.
- Google is split by product, because each is a separately versioned API: `gemini` (Gemini Developer API), `vertex-ai`, `firebase`, `google-maps`, `google-analytics`, `google-cloud` (Storage, Pub/Sub and the rest), `google-oauth`, `google-workspace` (Gmail, Drive, Sheets, Calendar) and `youtube`. Meta's Graph API (Facebook, Instagram, WhatsApp Cloud) is `meta-graph`. AWS is one provider, `aws`, with the service in `package` or `host`.
- An OpenAI-compatible endpoint on another provider's host (for example `api.groq.com` through the `openai` package) is labelled as that provider (`groq`), with `package: "openai"` and a note. Refit's catalog would match the `openai` package, so the scorer reports it as a false positive for `openai`. That is a real ambiguity, not a scorer error.

### What a label records

```json
{
  "provider": "stripe",
  "via": "sdk",
  "package": "stripe",
  "host": null,
  "language": "typescript",
  "file": "src/server/billing.ts",
  "line": 3,
  "notes": "server SDK; checkout sessions"
}
```

- One label per distinct `(provider, via, package or host)` in a repository. A provider called through two packages (`stripe` and `@stripe/stripe-js`) has two labels. The repository uses the provider once either way: scoring is per repository and provider.
- `file` and `line` point at one production line that shows the use: the import or construction of the SDK in a file that calls it, or the line with the provider host for `http`. The labeller reads the file to confirm the call, not just the import.
- `language` is the language of the evidence file: `javascript`, `typescript`, `python` or `go`.
- `package` is the package or module path as written (`@aws-sdk/client-s3`, `boto3`, `github.com/stripe/stripe-go/v76`). `host` is the API host for `http` labels.
- `monorepo` is `true` when the evidence file is in a workspace package or app below the root (`apps/*`, `packages/*`, `services/*` and similar), not in the root project.
- A repository with no external API use has `"labels": []` and `"none": true`. That is a valid label, and it is what makes precision measurable on repositories Refit should stay quiet on.

### Blind procedure

1. Sample and freeze the list (below) before any labelling.
2. For each repository, at its pinned commit, the labeller reads the output of `scripts/inventory-benchmark-candidates.mjs`. It lists every declared dependency, every bare import with its first production file and line, and every URL host in source. It imports no Refit pipeline code. The labeller then reads the files and decides each label by this guide.
3. Labels for all 150 repositories are committed before Refit is run on any of them. The commit that adds the last label comes before the commit that adds the first results.
4. After scoring, labels are not edited to match Refit. If reading Refit's output reveals a labelling mistake, it is fixed in a separate commit, listed under "Label corrections" with the reason, and the score is reported both before and after.

## Sampling procedure

`scripts/inventory-benchmark-select.mjs` builds the frozen list. Every stage is cached in `--work`, so a rerun against the same cache rewrites the same file. GitHub's search index moves, so the frozen file, not a rerun against the live index, is the reproducible record.

1. **Pool.** It runs GitHub repository search (`gh api search/repositories`) for each language with `stars:<bucket> pushed:>=<date> fork:false archived:false`, using four star buckets per language (`10..49`, `50..199`, `200..999`, `1000..20000`). Results are sorted by most recently updated, three pages of 100 per bucket. TypeScript and JavaScript are both searched and pooled as JS/TS. The exact queries, the date they ran and the number collected are in the frozen file.
2. **Exclusions before checking.** It drops:
   - forks, archived repositories and templates;
   - repositories already in any frozen list under `docs/benchmarks/`;
   - names or topics matching tutorial, course, example, demo, template, boilerplate, starter, awesome, learn, homework, exercise, interview, cheatsheet, roadmap, dotfiles, config, sdk, library, framework, plugin, wrapper or client.
3. **Shuffle.** It shuffles the pool with a seeded generator (seed in the frozen file), so selection does not favour stars or any provider.
4. **Application check, in shuffled order, until the quota per language is met.** It reads the repository tree at the default branch's head (that commit is pinned) and requires:
   - **JS/TS**: a root or `apps/*` or `packages/*` `package.json` that `appShape` (`scripts/ai-app-helpers.mjs`) classes as an application;
   - **Python**: a dependency manifest (`requirements*.txt`, `pyproject.toml`, `Pipfile` or `setup.py`), plus an entry point or deployment file (`manage.py`, `app.py`, `main.py`, `server.py`, `bot.py`, `run.py`, `wsgi.py`, `asgi.py`, a `Dockerfile`, `docker-compose.yml` or a `Procfile`);
   - **Go**: a root `go.mod`, plus `main.go` at the root or `cmd/<name>/main.go`;
   - **all languages**: between 10 and 1,000 source files in the language, a tree GitHub did not truncate, and a commit on or after the cutoff. The size cap keeps hand labelling exhaustive; it biases the sample away from very large codebases, and that bias is stated with the results.
5. **Pin.** Each entry records the full name, the commit SHA, its commit date, stars, primary language, the reason it counts as an application, and its source file count.

Search does not filter on any provider, package or keyword, so the sample's provider mix is whatever real applications use.

## Scoring

`scripts/inventory-benchmark.mjs` checks out each repository at its pinned commit (shallow, no submodules, nothing installed or run). On each one it runs every detector on `main` that reports which providers a repository uses:

- `refit agents --json`, which is `detectProviders`: manifests, lockfiles and catalog API hostnames;
- `refit deadlines --json`, whose live exposures name a provider.

It records the Refit commit, whether the tree was clean, and the catalog at that commit.

A detection is the pair `(repository, provider)`. It is a true positive when the repository has a label for that provider, and a false positive otherwise. A labelled pair with no detection is a false negative. Precision and recall are reported:

- **per catalog provider**;
- **over catalog providers only**, which measures what Refit claims to cover;
- **over every labelled provider**, which is the honest answer to "does Refit detect the APIs a repository uses".

Every false positive and false negative is listed with its file. Each miss gets one category, decided by rule from the label:

1. **language not supported**: the evidence is Python or Go;
2. **provider not in catalog**: the provider id is not in the catalog at that commit;
3. **raw HTTP**: an `http` label whose host is not one of the catalog's hostnames for that provider;
4. **monorepo**: the evidence is in a workspace package and the provider's package is declared only there;
5. **other**: anything else (for example a catalog provider used through a package the catalog does not list), with a note.

The first matching rule wins, in that order.
