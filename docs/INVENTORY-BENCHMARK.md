# Inventory benchmark

This benchmark tests the claim "Refit detects the APIs a repository uses". It is independent of every other frozen list. The repositories were not chosen because they use a provider Refit knows, and every repository was labelled, by reading its code, before Refit was run on any of them. The labeller is the AI agent that ran this lane (Claude), not a human; see "Labelling summary".

- Frozen list: [`benchmarks/2026-10-22-inventory-repos.json`](benchmarks/2026-10-22-inventory-repos.json) (150 repositories: 100 JS/TS, 30 Python, 20 Go).
- Labels: [`benchmarks/2026-10-22-inventory-labels.json`](benchmarks/2026-10-22-inventory-labels.json).
- Results on `main`: [`benchmarks/2026-10-22-inventory-results.json`](benchmarks/2026-10-22-inventory-results.json).
- Scripts: `scripts/inventory-benchmark-select.mjs` (sampling), `scripts/inventory-benchmark-candidates.mjs` (the labeller's independent search), `scripts/inventory-benchmark.mjs` (runs Refit and scores). The pure sampling, candidate and scoring functions are in `scripts/inventory-benchmark-helpers.mjs` and are tested by `pipeline/inventory-benchmark.test.ts`.

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
- `file` and `line` point at one production line that shows the use: the import or construction of the SDK in a file that calls it, or the line with the provider host for `http`. The labeller reads the evidence line, and the surrounding code wherever the line alone does not show that a request is made (a comment, a link, a type-only import or a configuration value).
- `language` is the language of the evidence file: `javascript`, `typescript`, `python` or `go`.
- `package` is the package or module path as written (`@aws-sdk/client-s3`, `boto3`, `github.com/stripe/stripe-go/v76`). `host` is the API host for `http` labels.
- `monorepo` is `true` when the evidence file is in a workspace package or app below the root (`apps/*`, `packages/*`, `services/*` and similar), not in the root project.
- A repository with no external API use has `"labels": []` and `"none": true`. That is a valid label, and it is what makes precision measurable on repositories Refit should stay quiet on.

### Blind procedure

1. Sample and freeze the list (below) before any labelling.
2. For each repository, at its pinned commit, the labeller reads the output of `scripts/inventory-benchmark-candidates.mjs`. It lists every declared dependency, every bare import with its first production file and line, and every URL host in source. It imports no Refit pipeline code. The labeller then reads the files and decides each label by this guide.
3. Labels for all 150 repositories are committed before Refit is run on any of them. The commit that adds the last label comes before the commit that adds the first results.
4. After scoring, labels are not edited to match Refit. If reading Refit's output reveals a labelling mistake, it is fixed in a separate commit, listed under "Label corrections" with the reason, and the score is reported both before and after.

### Rulings

Cases the guide did not foresee, decided once while labelling and applied to every repository:

- Blockchain node JSON-RPC (viem, ethers, web3.js, @solana/web3.js, raw RPC URLs) is a chain protocol client, like a database driver, and is not labelled.
- A protocol endpoint configured only by URL with no provider default (an x402 facilitator, a dead-man's-switch ping URL, a generic webhook) is not labelled.
- Static file and media downloads (raw.githubusercontent.com, CDN assets, audio streams) and image URLs (favicon services, Gravatar) are not API uses.
- A Google API not in the guide's list gets `google-<product>` (for example `google-postmaster`). An OAuth token exchange the repository builds itself is labelled `google-oauth`.
- Signature verification of incoming webhooks is not a use; the outgoing client of the same provider is.
- Ad and analytics snippets loaded by script tag count as their provider (`google-adsense`, `goatcounter`), as the guide says for analytics.
- Maintainer tools run by hand (`tools/*.mjs` bots, generators) are non-production even when not under `scripts/`.
- Only JS/TS, Python and Go code is labelled; calls made from Rust, Swift, Kotlin, PHP and other languages in the same repository are out of scope.
- Code written for one specific provider counts even when the deployment switches it off by default (an empty analytics endpoint). A self-hosted service with no provider default does not.
- Self-hosted tools reached by a user-configured URL (torrent clients, *arr apps, Torznab indexers, Mattermost, OTLP collectors, MinIO clients that require an endpoint) are not labelled. An AWS SDK S3 client is labelled `aws` even with an optional endpoint setting, because it defaults to AWS.
- A user-supplied webhook URL for a specific provider (Discord, Microsoft Teams) is labelled as that provider, because the payload is written for its API; the host is the provider's documented webhook host.
- A provider preset table (the user picks one of several hosts for one shared client) labels every provider and host in the table, since the shipped code sends requests to whichever is chosen.
- OAuth sign-in configured through Passport, NextAuth or Better Auth providers is framework-mediated and not labelled; a token exchange or user lookup the repository codes itself is.
- Evaluation harnesses (`evals/`) and promotional video projects (`promo/`) are non-production.
- A type-only import of a provider SDK in an adapter that receives the user's client (`import type { Redis } from '@upstash/redis'`) is not labelled; the repository never constructs or configures the provider client.
- WebSocket endpoints of a provider's public API (exchange market data streams) count as `http` labels with the WebSocket host.
- Content Security Policy entries and image URLs built from an API host (QR or verse images) are not API uses.
- Map tile servers are image URLs and are not labelled. Kubernetes, Helm and other YAML configuration is outside the labelled languages.
- An S3 client pointed at another provider's S3-compatible API by code written for it (an R2 client) is labelled as that provider.
- The candidate tool's path heuristic is only a hint: where a repository's production server lives under `scripts/` (ProxMenux's Flask backend), it is labelled as production.
- Websites a browser automation tool drives (job boards, their internal front-end APIs) are not documented APIs and are not labelled.
- A code snippet the application shows its users (a string containing an SDK import) is not a use.
- Registry metadata lookups a shipped CLI makes for self-update checks (npm registry, GitHub releases API) are labelled, like any other public API.
- Support and chat widgets (Zendesk, Freshdesk, Crisp, donation buttons) loaded for their UI are not labelled.
- Build-time data fetches of a static site generator (an Astro page reading the GitHub API while building) do not run when the application is used and are not labelled.
- Cloud data warehouses reached through an HTTPS API SDK (BigQuery, Snowflake) count like the guide's HTTP-API databases; wire-protocol drivers (pg, mysql2, mssql, oracledb) do not.
- A PostHog (or other analytics) SDK pointed at the project's own self-hosted instance is not labelled.
- Django management commands that import or scrape data on demand (`erp/management/commands/*`) are operator maintenance and are not labelled.
- Model hub SDKs (huggingface_hub, modelscope) are labelled: they call the hub's metadata API. Downloading a model file by URL alone is a static download and is not.
- Source archives a package manager downloads (OpenCores SVN, GitHub tarballs) are static downloads and are not labelled.
- DNS-over-HTTPS resolvers are a DNS protocol transport and are not labelled.
- Container registry and OCI distribution protocol clients are a protocol and are not labelled; a registry's own management API would be.

### Labelling summary

- 150 repositories labelled, 463 labels, 414 distinct (repository, provider) pairs, 205 distinct providers.
- 53 repositories have no external API use in production JS/TS, Python or Go code (`"none": true`).
- Pairs by group: JS/TS 275, Python 95, Go 44.
- Most common providers (repositories): `github` 38, `openai` 19, `aws` 14, `gemini` 12, `cloudflare` 12, `sentry` 11, `telegram` 10, `anthropic` 10, `openrouter` 8, `google-analytics` 7.
- **Who labelled:** every label was made in one pass by a single labeller, the AI agent (Claude) running this overnight lane. It read each candidate summary and the code it pointed to. These are not human labels, and no human reviewed them.
- **Agreement:** there was no second labeller, so inter-rater agreement is not measured. The rulings above are where a second labeller, human or AI, would most likely disagree.

## Sampling procedure

`scripts/inventory-benchmark-select.mjs` builds the frozen list. Every stage is cached in `--work`, so a rerun against the same cache rewrites the same file. GitHub's search index moves, so the frozen file, not a rerun against the live index, is the reproducible record.

1. **Pool.** It runs GitHub repository search (`gh api search/repositories`) for each language with `stars:<bucket> pushed:>=<date> fork:false archived:false`, using four star buckets per language (`10..49`, `50..199`, `200..999`, `1000..20000`). Results are sorted by most recently updated, three pages of 100 per bucket. TypeScript and JavaScript are both searched and pooled as JS/TS. The exact queries, the date they ran and the number collected are in the frozen file.
2. **Exclusions before checking.** It drops:
   - forks, archived repositories and templates;
   - repositories already in any frozen list under `docs/benchmarks/`;
   - names or topics matching tutorial, course, example, sample, demo, template, boilerplate, starter, awesome, learn, homework, exercise, interview, cheatsheet, roadmap, dotfiles, config, docs, documentation, sdk, library, framework, plugin, extension, wrapper or client.
3. **Shuffle.** It shuffles the whole pool with a seeded generator (seed in the frozen file), so selection does not favour stars or any provider. The shuffle comes before the exclusions, so changing an exclusion only removes repositories and never reorders the rest.
4. **Application check, in shuffled order, until the quota per language is met.** It reads the repository tree at the default branch's head (that commit is pinned) and requires:
   - **JS/TS**: an app marker in the root package or in a workspace package. An app marker is:
     - a framework or deployment config (Next, Vite, Nuxt, SvelteKit, Astro, Remix, Angular, Expo, Electron-Vite, Wrangler, Tauri, `app.json`);
     - an `app/`, `pages/` or `routes/` directory;
     - or a server, desktop, mobile or bot runtime dependency (Express, Fastify, Hono, Koa, Nest, Electron, React Native, Expo, Tauri, discord.js, Telegraf, grammY).

     A single-package root must also be unpublished: private, or without `main`, `exports`, `bin` or `files`. A workspace root (a `workspaces` field, `pnpm-workspace.yaml`, `lerna.json`, `turbo.json`, `nx.json` or `rush.json`) is private by convention, so it counts only through a workspace package with an app marker. A workspace package is a top-level directory or a direct child of `apps/`, `packages/` or `services/`. Trial runs showed why each part is needed: a private root alone let library monorepos through, and a `package.json` alone let solution and notes repositories through.
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
4. **monorepo**: some label for the pair is marked `monorepo` (its evidence is in a workspace package below the root);
5. **other**: anything else (for example a catalog provider used through a package the catalog does not list), with a note.

The first matching rule wins, in that order. A repository where a detector errored (for example over Refit's scan limits) reported nothing, so every labelled provider in it counts as a miss in **other**, with the error as its detail. The repository is also listed as errored.

## Results on `main`

- **Run:** Refit commit `ab0cb9a` on this branch, a clean tree that is `main` at `7b2c86a` plus only this benchmark's scripts, labels and docs, so detection code is identical to `main`. Command: `node scripts/inventory-benchmark.mjs --root <checkouts> --results <results.json> --score <score.json>`, written outside the repository and copied in afterwards so the tree stayed clean during the run. A first run at `2a3ae60`, before per-detector error handling, produced identical detections. Rescore without rerunning: `node scripts/inventory-benchmark.mjs --results docs/benchmarks/2026-10-22-inventory-results.json`.
- **Detectors run:** `refit agents --json` (`detectProviders`) and `refit deadlines --json`, the two detectors on `main` that name providers.
- **Files:** [results](benchmarks/2026-10-22-inventory-results.json) (every detection with its files) and [score](benchmarks/2026-10-22-inventory-score.json) (every true positive, false positive and false negative, with its category).
- **Labels:** these numbers use the labels exactly as committed before the run. The later corrections are scored separately under "Label corrections".

### Headline

| Scope | TP | FP | FN | Precision | Recall |
|---|---:|---:|---:|---|---|
| Catalog providers | 28 | 6 | 22 | 82.4% (28/34; 95% CI 66.5–91.7) | 56% (28/50; 95% CI 42.3–68.8) |
| Every labelled provider | 28 | 6 | 386 | 82.4% (28/34; 95% CI 66.5–91.7) | 6.8% (28/414; 95% CI 4.7–9.6) |
| go: catalog providers | 0 | 0 | 1 | n/a | 0% (0/1; 95% CI 0–79.3) |
| go: every labelled provider | 0 | 0 | 44 | n/a | 0% (0/44; 95% CI 0–8) |
| js-ts: catalog providers | 27 | 6 | 8 | 81.8% (27/33; 95% CI 65.6–91.4) | 77.1% (27/35; 95% CI 61–87.9) |
| js-ts: every labelled provider | 27 | 6 | 248 | 81.8% (27/33; 95% CI 65.6–91.4) | 9.8% (27/275; 95% CI 6.8–13.9) |
| python: catalog providers | 1 | 0 | 13 | 100% (1/1; 95% CI 20.7–100) | 7.1% (1/14; 95% CI 1.3–31.5) |
| python: every labelled provider | 1 | 0 | 94 | 100% (1/1; 95% CI 20.7–100) | 1.1% (1/95; 95% CI 0.2–5.7) |

- **When Refit reports a provider, it is usually right.** The precision is 82.4%, but across 34 detections only.
- **For the providers it knows, it finds about half.** Recall is 56% overall, and 77.1% for JS/TS, the language Refit supports.
- **For the question a customer asks ("which APIs does my repository use?") it finds 6.8% of what is there.** The catalog has 10 providers, and the sample's applications use 205.

### Catalog providers

| Catalog provider | TP | FP | FN | Precision | Recall |
|---|---:|---:|---:|---|---|
| `anthropic` | 3 | 2 | 7 | 60% (3/5; 95% CI 23.1–88.2) | 30% (3/10; 95% CI 10.8–60.3) |
| `gemini` | 7 | 1 | 5 | 87.5% (7/8; 95% CI 52.9–97.8) | 58.3% (7/12; 95% CI 32–80.7) |
| `meta-graph` | 0 | 1 | 0 | 0% (0/1; 95% CI 0–79.3) | n/a |
| `openai` | 12 | 2 | 7 | 85.7% (12/14; 95% CI 60.1–96) | 63.2% (12/19; 95% CI 41–80.9) |
| `resend` | 5 | 0 | 0 | 100% (5/5; 95% CI 56.6–100) | 100% (5/5; 95% CI 56.6–100) |
| `stripe` | 1 | 0 | 2 | 100% (1/1; 95% CI 20.7–100) | 33.3% (1/3; 95% CI 6.1–79.2) |
| `twilio` | 0 | 0 | 1 | n/a | 0% (0/1; 95% CI 0–79.3) |

### Misses by category

| Miss category | Pairs |
|---|---:|
| language not supported | 155 |
| provider not in catalog | 210 |
| raw HTTP | 0 |
| monorepo | 0 |
| other | 21 |

- **provider not in catalog (210):** the provider has no catalog entry. The most common, by repositories, are `github` 38, `aws` 14, `cloudflare` 12, `sentry` 11, `telegram` 10, `openrouter` 8, `google-analytics` 7, `deepseek` 7, `azure` 6, `alibaba-cloud` 6, `google-cloud` 6, `vercel` 5, `google-workspace` 5, `google-oauth` 4 and `zhipu` 4. A further 190 providers appear in 1 to 3 repositories each.
- **language not supported (155):** Python or Go evidence. `detectProviders` reads `package.json` and JS/TS sources only, and the deadline scan reads JS/TS. Of these, 17 are catalog providers: OpenAI, Anthropic and Gemini in Python (14), Stripe and Twilio in Python, and OpenAI in Go.
- **raw HTTP (0):** every `http` label of a catalog provider in JS/TS used a catalog hostname, and `detectProviders` found it by hostname. Raw HTTP to uncatalogued providers is counted under "provider not in catalog", which comes first.
- **monorepo (0):** `detectProviders` reads workspace manifests and sources, and no catalog provider was missed only because it sat in a workspace package.
- **other (21):**
  - 3 are catalog providers used through packages the catalog does not list: `@stripe/stripe-js` with `@stripe/react-stripe-js` (`datalayer/core`), `@ai-sdk/openai` (`zeitword/zeitword`) and `@ai-sdk/anthropic` (`Peon-sh/Peon`).
  - 18 are labelled providers in the 8 repositories where Refit's scan failed, all with `PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total)`. One counted file over a limit makes detection report nothing for the whole repository. Measured with the same file rules as `readRepository`:
    - 4 repositories exceed 2 MiB only because they commit their Yarn Berry release, which Yarn 2+ projects normally do: `gardener/dashboard` (`.yarn/releases/yarn-4.17.1.cjs`, 2.9 MiB), `UI5/webcomponents-react` (3.6 MiB), `tidepool-org/blip` (2.1 MiB) and `HSLdevcom/digitransit-ui` (2.9 MiB).
    - 3 repositories have a generated or bundled JS file over 2 MiB: `holistics/dbml` (five ANTLR parsers, up to 8.3 MiB), `timoncool/ACE-Step-Studio` (a 2.6 MiB built asset under `app/public/`) and `chedim/babyseat` (a 5.5 MiB `vosk.js` bundle, twice).
    - 1 repository, `OpenCCU/OpenCCU`, has 96 counted files totalling 62.3 MiB, over the 50 MiB total.

Every miss, with its evidence file and category, is listed in the appendix and in the score file.

### False positives

The labelling agent read all 6 in full.

| Repository | Provider | Detector | Evidence Refit reported |
|---|---|---|---|
| Bellows-AI/factory | `anthropic` | deadlines | `web/src/workspace/executors.ts:50` |
| apify/apify-mcp-server | `openai` | agents | `package.json` |
| syncular/syncular | `openai` | deadlines | `packages/conformance/src/catalog/conflict.ts:52`, `packages/conformance/src/catalog/conflict.ts:56`, `packages/conformance/src/catalog/conflict.ts:63` (+15) |
| evanbaker315/AttentionOS | `anthropic` | agents | `packages/runner/package.json` |
| evanbaker315/AttentionOS | `meta-graph` | agents, deadlines | `packages/providers/scrape-iggraph/src/index.ts:124`, `packages/providers/scrape-iggraph/src/index.ts:125`, `packages/providers/scrape-iggraph/src/index.ts:17` |
| Jaxton07/percho | `gemini` | agents | `scripts/verify-vertex-auth.mts:116` |

- **`Bellows-AI/factory`, `anthropic`:** `claude-sonnet-4-5` is the `modelExample` hint in a settings form. The deadline scan counts the string as a live model use, but no request sends it. **Cause:** a UI hint string is classified live.
- **`apify/apify-mcp-server`, `openai`:** `openai` is declared in `package.json` and imported only under `evals/`, the evaluation harness. **Cause:** a dependency declaration counts with no production import.
- **`syncular/syncular`, `openai`:** the model IDs sit in `packages/conformance/src/catalog/*`, a conformance test catalog that the test-path rule does not recognise. **Cause:** test data outside a `test`/`tests` directory is classified live.
- **`evanbaker315/AttentionOS`, `anthropic`:** `@anthropic-ai/sdk` is declared in `packages/runner/package.json` and never imported; the runner shells out to the Claude CLI. **Cause:** declared but unused.
- **`evanbaker315/AttentionOS`, `meta-graph`:** a labelling mistake, not a Refit error. The Instagram Graph API client builds `https://${host}/…` with the default host `graph.facebook.com` written as a bare string. My candidate search only finds hosts that follow a scheme, so it missed this one. See "Label corrections".
- **`Jaxton07/percho`, `gemini`:** the Gemini API hostname appears only in `scripts/verify-vertex-auth.mts`, a maintenance script. **Cause:** hostname evidence counts in any file.

So 5 of the 6 are real Refit false positives, from three mechanisms:
- dependency declarations with no production import (2);
- hostnames or model IDs in non-production files (2);
- a UI hint classified as live (1).

### Label corrections

Two rounds of corrections were made after the results were committed. Each is in its own commit, and the tables above keep the numbers from the labels as committed.

1. **Found by reading Refit's output (`25a4898`): `evanbaker315/AttentionOS`.** Added `meta-graph`, `http`, host `graph.facebook.com`, at `packages/providers/scrape-iggraph/src/index.ts:124`. The Instagram Graph API client uses that default host, written as a bare string with no scheme. My candidate search only finds hosts that follow a scheme, so I missed it.
2. **Second labelling pass.** It was prompted by an FG4 branch detection (`api.apify.com` in `Affitor/open-affiliate`). The cause was mine: my summary viewer cut off long host lists, so I never saw that host. The second pass then listed every API-like production host in every candidate summary that had no label (`api.*`, `graph.*`, `oauth2.*`, `hooks.*` and similar) and reviewed each one by the guide. It added 5 labels in 3 repositories:
   - `Affitor/open-affiliate`: `apify`, `api.apify.com`, at `src/lib/social.ts:103`.
   - `MTES-MCT/acceslibre`: a second `api-gouv` host, `recherche-entreprises.api.gouv.fr`, at `erp/provider/entreprise.py:13`. The pair already existed.
   - `juicedata/juicefs`: object-store backends that talk HTTP or the S3 client instead of a provider SDK:
     - `bunny` (`pkg/object/bunny.go:34`);
     - `qingcloud`, QingStor through the S3 client (`pkg/object/qingstor.go:34`);
     - `ucloud` (`pkg/object/ufile.go:115`).

   The juicefs B2, Storj, EOS and OOS backends were left unlabelled: their code does not name a provider host I could confirm.

| Scope | Labels as committed before the run | After correction 1 | After both |
|---|---|---|---|
| Catalog providers, precision | 82.4% (28/34) | 85.3% (29/34) | 85.3% (29/34) |
| Catalog providers, recall | 56% (28/50) | 56.9% (29/51) | 56.9% (29/51) |
| Every labelled provider, recall | 6.8% (28/414) | 7% (29/415) | 6.9% (29/419) |

The score with both corrections is in [`2026-10-22-inventory-score-corrected.json`](benchmarks/2026-10-22-inventory-score-corrected.json).

**What the corrections show about the labelling method.** Hosts written without a scheme, and hosts in very long candidate lists, were found only by reading. For catalog providers, Refit's own bare-hostname matching covers the first gap. For uncatalogued providers there may be more misses of both kinds, so the overall recall is an upper bound by a small margin.

### What this measures and what it does not

- **The sample is real applications, not libraries,** and it is biased toward small and medium codebases: 10 to 1,000 source files, picked from recently pushed repositories. A few framework and library monorepos that ship an app (for example `wakujs/waku`, `UI5/webcomponents-react`, `ijry/uview-plus`) passed the application check.
- **One labeller made every label** (see "Labelling summary"). Agreement between labellers is not measured.
- **Detection is scored per provider and repository.** It does not check whether Refit's evidence file is the right one, or how many call sites it finds.
- **Only JS/TS, Python and Go code is labelled.** Calls from other languages in the same repositories are out of scope.
- **The score is for `main` at `7b2c86a`.** Branches that add detectors are compared below, under "Detection branches".

## Appendix: every miss on `main`

One row per labelled (repository, provider) pair that Refit did not report, with the first evidence line (`+N` when the pair has more labels).

| Category | Repository | Provider | Evidence | Detail |
|---|---|---|---|---|
| language not supported | M9nx/CodexA | `openai` | `semantic_code_intelligence/llm/openai_provider.py:47` | python |
| language not supported | MCDReforged/MCDReforged | `github` | `mcdreforged/constants/core_constant.py:20` | python |
| language not supported | MTES-MCT/acceslibre | `api-gouv` | `erp/provider/public_erp.py:14` | python |
| language not supported | MTES-MCT/acceslibre | `aws` | `erp/export/s3.py:14` | python |
| language not supported | MTES-MCT/acceslibre | `brevo` | `core/mailer.py:5` | python |
| language not supported | MTES-MCT/acceslibre | `deepl` | `api/frontend_views.py:23` | python |
| language not supported | MTES-MCT/acceslibre | `geopf` | `erp/provider/generic_geoloc.py:13` | python |
| language not supported | MTES-MCT/acceslibre | `matomo` | `core/settings.py:494` | python |
| language not supported | MTES-MCT/acceslibre | `openstreetmap` | `erp/provider/osm.py:13` | python |
| language not supported | MTES-MCT/acceslibre | `panoramax` | `erp/provider/panoramax.py:3` | python |
| language not supported | MacRimi/ProxMenux | `anthropic` | `AppImage/scripts/ai_providers/anthropic_provider.py:15` | python |
| language not supported | MacRimi/ProxMenux | `discord` | `AppImage/scripts/notification_channels.py:536` | python |
| language not supported | MacRimi/ProxMenux | `gemini` | `AppImage/scripts/ai_providers/gemini_provider.py:18` | python |
| language not supported | MacRimi/ProxMenux | `groq` | `AppImage/scripts/ai_providers/groq_provider.py:18` | python |
| language not supported | MacRimi/ProxMenux | `openai` | `AppImage/scripts/ai_providers/openai_provider.py:27` | python |
| language not supported | MacRimi/ProxMenux | `openrouter` | `AppImage/scripts/ai_providers/openrouter_provider.py:19` | python |
| language not supported | MacRimi/ProxMenux | `pushover` | `AppImage/scripts/notification_channels.py:402` | python |
| language not supported | MacRimi/ProxMenux | `telegram` | `AppImage/scripts/notification_channels.py:205` | python |
| language not supported | Oaklight/llm-rosetta | `anthropic` | `packages/llm-rosetta/src/llm_rosetta/formats/catalog.py:51` | python |
| language not supported | Oaklight/llm-rosetta | `gemini` | `packages/llm-rosetta/src/llm_rosetta/formats/catalog.py:87` | python |
| language not supported | Oaklight/llm-rosetta | `github` | `packages/llm-rosetta-gateway/src/llm_rosetta_gateway/shims/sources.py:703` | python |
| language not supported | Oaklight/llm-rosetta | `ip-api` | `packages/llm-rosetta-gateway/src/llm_rosetta_gateway/admin/routes/observability.py:354` | python |
| language not supported | Oaklight/llm-rosetta | `openrouter` | `packages/llm-rosetta/src/llm_rosetta/formats/catalog.py:67` | python |
| language not supported | Optexity/optexity | `1password` | `optexity/onepassword_integration.py:4` | python |
| language not supported | Optexity/optexity | `aws` | `optexity/utils/aws_secret_manager.py:7` | python |
| language not supported | Optexity/optexity | `browser-use` | `optexity/inference/infra/actual_browser.py:305` | python |
| language not supported | QuinnDamerell/OctoPrint-OctoEverywhere | `bambulab` | `bambu_octoeverywhere/bambucloud.py:250` | python |
| language not supported | QuinnDamerell/OctoPrint-OctoEverywhere | `sentry` | `octoeverywhere/sentry.py:15` | python |
| language not supported | TimSoethout/goodwe-sems-home-assistant | `goodwe-sems` | `custom_components/sems/sems_api.py:24` | python |
| language not supported | VocaHQ/vocalinux | `github` | `src/vocalinux/utils/update_checker.py:58` | python |
| language not supported | aidotse/LeakPro | `huggingface` | `leakpro/synthetic_data_attacks/syn_text_pii_scanner/pii_token_classif_models/ner_longformer_model.py:9` | python |
| language not supported | algorithmicsuperintelligence/openevolve | `openai` | `openevolve/embedding.py:10` | python |
| language not supported | andrebuilds/melodyc | `modal` | `backend/main.py:5` | python |
| language not supported | aws-samples/aws-pod-eip-controller | `aws` | `pkg/aws/ec2.go:15` | go |
| language not supported | calibrain/shelfmark | `alldebrid` | `shelfmark/download/clients/alldebrid.py:39` | python |
| language not supported | calibrain/shelfmark | `debrid-link` | `shelfmark/download/clients/debridlink.py:50` | python |
| language not supported | calibrain/shelfmark | `google-books` | `shelfmark/metadata_providers/googlebooks.py:50` | python |
| language not supported | calibrain/shelfmark | `hardcover` | `shelfmark/metadata_providers/hardcover.py:52` | python |
| language not supported | calibrain/shelfmark | `openlibrary` | `shelfmark/metadata_providers/openlibrary.py:40` | python |
| language not supported | calibrain/shelfmark | `real-debrid` | `shelfmark/download/clients/realdebrid.py:37` | python |
| language not supported | calibrain/shelfmark | `torbox` | `shelfmark/download/clients/torbox.py:39` | python |
| language not supported | cdalar/onctl | `aws` | `internal/provideraws/common.go:17` | go |
| language not supported | cdalar/onctl | `azure` | `internal/providerazure/common.go:12` | go |
| language not supported | cdalar/onctl | `boxctl` | `internal/providerboxes/client.go:25` | go |
| language not supported | cdalar/onctl | `cloudflare` | `internal/domain/cloudflare.go:9` | go |
| language not supported | cdalar/onctl | `google-cloud` | `internal/providergcp/common.go:10` | go |
| language not supported | cdalar/onctl | `hetzner` | `internal/providerhtz/common.go:7` | go |
| language not supported | cdalar/onctl | `ovh` | `internal/providerovh/common.go:6` | go |
| language not supported | dalibo/temboard | `twilio` | `ui/temboardui/application.py:151` | python |
| language not supported | damonto/sigmo | `bark` | `internal/pkg/notify/bark/sender.go:20` | go |
| language not supported | damonto/sigmo | `cloudflare` | `pro/call/ice.go:19` | go |
| language not supported | damonto/sigmo | `github` | `internal/app/update/github.go:15` | go |
| language not supported | damonto/sigmo | `ipinfo` | `internal/pkg/internet/ipinfo.go:17` | go |
| language not supported | damonto/sigmo | `lark` | `internal/pkg/notify/lark/sender.go:54` | go |
| language not supported | damonto/sigmo | `serverchan` | `internal/pkg/notify/sc3/sender.go:50` | go |
| language not supported | damonto/sigmo | `telegram` | `internal/pkg/notify/telegram/sender.go:17` | go |
| language not supported | damonto/sigmo | `wecom` | `internal/pkg/notify/wecom/sender.go:54` | go |
| language not supported | databasus/databasus | `azure` | `backend/internal/features/storages/models/azure_blob/model.go:18` | go |
| language not supported | databasus/databasus | `cloudflare` | `backend/internal/util/cloudflare_turnstile/cloudflare_turnstile_service.go:27` | go |
| language not supported | databasus/databasus | `discord` | `backend/internal/features/notifiers/models/discord/model.go:55` | go |
| language not supported | databasus/databasus | `github` | `backend/internal/features/users/services/user_services.go:503` | go |
| language not supported | databasus/databasus | `google-workspace` | `backend/internal/features/storages/models/google_drive/model.go:18` | go |
| language not supported | databasus/databasus | `microsoft-teams` | `backend/internal/features/notifiers/models/teams/model.go:93` | go |
| language not supported | databasus/databasus | `slack` | `backend/internal/features/notifiers/models/slack/model.go:94` | go |
| language not supported | databasus/databasus | `telegram` | `backend/internal/features/notifiers/models/telegram/bot_api_url.go:10` | go |
| language not supported | deep-learning-indaba/Baobab | `google-workspace` | `api/app/documents/google_client.py:20` | python |
| language not supported | deep-learning-indaba/Baobab | `invoice-generator` | `api/app/invoice/generator.py:15` | python |
| language not supported | deep-learning-indaba/Baobab | `stripe` | `api/app/invoice/api.py:6` | python |
| language not supported | digitalmethodsinitiative/4cat | `4chan` | `datasources/fourchan/scrapers/scrape_boards.py:172` | python |
| language not supported | digitalmethodsinitiative/4cat | `anthropic` | `common/lib/llm/adapter.py:11` | python |
| language not supported | digitalmethodsinitiative/4cat | `bluesky` | `datasources/bsky/search_bsky.py:10` | python |
| language not supported | digitalmethodsinitiative/4cat | `clarifai` | `processors/machine_learning/clarifai_api.py:7` | python |
| language not supported | digitalmethodsinitiative/4cat | `deepseek` | `common/lib/llm/adapter.py:16` | python |
| language not supported | digitalmethodsinitiative/4cat | `gemini` | `common/lib/llm/adapter.py:12` | python |
| language not supported | digitalmethodsinitiative/4cat | `github` | `common/lib/helpers.py:267` | python |
| language not supported | digitalmethodsinitiative/4cat | `google-perspective` | `processors/machine_learning/perspective.py:6` | python |
| language not supported | digitalmethodsinitiative/4cat | `mistral` | `common/lib/llm/adapter.py:15` | python |
| language not supported | digitalmethodsinitiative/4cat | `openai` | `processors/machine_learning/audio_to_text.py:6` (+1) | python |
| language not supported | digitalmethodsinitiative/4cat | `telegram` | `datasources/telegram/search_telegram.py:19` | python |
| language not supported | digitalmethodsinitiative/4cat | `tumblr` | `datasources/tumblr/search_tumblr.py:12` | python |
| language not supported | digitalmethodsinitiative/4cat | `vk` | `datasources/vk/search_vk.py:6` | python |
| language not supported | digitalmethodsinitiative/4cat | `x` | `datasources/twitterv2/search_twitter.py:109` | python |
| language not supported | digitalmethodsinitiative/4cat | `youtube` | `processors/visualisation/youtube_thumbnails.py:7` | python |
| language not supported | eee555/saolei_website | `bilibili` | `back_end/saolei/accountlink/utils.py:3` | python |
| language not supported | fclairamb/ftpserver | `aws` | `fs/s3/s3.go:11` | go |
| language not supported | fclairamb/ftpserver | `dropbox` | `fs/dropbox/dropbox.go:8` | go |
| language not supported | fclairamb/ftpserver | `google-cloud` | `fs/gcs/gcs.go:9` | go |
| language not supported | fclairamb/ftpserver | `google-workspace` | `fs/gdrive/gdrive.go:11` | go |
| language not supported | fclairamb/ftpserver | `telegram` | `fs/telegram/telegram.go:18` | go |
| language not supported | fumingyang2004/Tulpa | `deepseek` | `chatlocal/config.py:33` | python |
| language not supported | git-hulk/clime | `github` | `internal/githubrelease/githubrelease.go:19` | go |
| language not supported | gpustack/gpustack | `digitalocean` | `gpustack/cloud_providers/digital_ocean.py:12` | python |
| language not supported | gpustack/gpustack | `huggingface` | `gpustack/utils/hub.py:11` | python |
| language not supported | gpustack/gpustack | `modelscope` | `gpustack/utils/hub.py:42` | python |
| language not supported | green-coding-solutions/green-metrics-tool | `electricitymaps` | `metric_providers/carbon/intensity/electricitymaps/machine/provider.py:11` | python |
| language not supported | green-coding-solutions/green-metrics-tool | `github` | `lib/utils.py:318` | python |
| language not supported | green-coding-solutions/green-metrics-tool | `ip-api` | `cron/backfill_geo.py:169` | python |
| language not supported | green-coding-solutions/green-metrics-tool | `ipapi` | `cron/backfill_geo.py:142` | python |
| language not supported | green-coding-solutions/green-metrics-tool | `ipinfo` | `cron/backfill_geo.py:195` | python |
| language not supported | hypercodism/alpine-code | `anthropic` | `packages/core/src/alpine_core/models.py:11` | python |
| language not supported | hypercodism/alpine-code | `gemini` | `packages/core/src/alpine_core/providers.py:65` | python |
| language not supported | hypercodism/alpine-code | `github` | `packages/core/src/alpine_core/github.py:36` | python |
| language not supported | hypercodism/alpine-code | `minimax` | `packages/core/src/alpine_core/providers.py:93` | python |
| language not supported | hypercodism/alpine-code | `models-dev` | `packages/core/src/alpine_core/catalog.py:26` | python |
| language not supported | hypercodism/alpine-code | `moonshot` | `packages/core/src/alpine_core/providers.py:85` | python |
| language not supported | hypercodism/alpine-code | `openrouter` | `packages/core/src/alpine_core/providers.py:70` | python |
| language not supported | hypercodism/alpine-code | `skills-sh` | `packages/core/src/alpine_core/skill_fetch.py:37` | python |
| language not supported | hypercodism/alpine-code | `zhipu` | `packages/core/src/alpine_core/providers.py:77` | python |
| language not supported | juicedata/juicefs | `alibaba-cloud` | `pkg/object/oss.go:35` | go |
| language not supported | juicedata/juicefs | `aws` | `pkg/object/s3.go:34` | go |
| language not supported | juicedata/juicefs | `azure` | `pkg/object/azure.go:32` | go |
| language not supported | juicedata/juicefs | `baidu-cloud` | `pkg/object/bos.go:35` | go |
| language not supported | juicedata/juicefs | `google-cloud` | `pkg/object/gs.go:35` | go |
| language not supported | juicedata/juicefs | `huawei-cloud` | `pkg/object/obs.go:38` | go |
| language not supported | juicedata/juicefs | `ibm-cloud` | `pkg/object/ibmcos.go:34` | go |
| language not supported | juicedata/juicefs | `kingsoft-cloud` | `pkg/object/ks3.go:37` | go |
| language not supported | juicedata/juicefs | `qiniu` | `pkg/object/qiniu.go:40` | go |
| language not supported | juicedata/juicefs | `scaleway` | `pkg/object/scw.go:28` | go |
| language not supported | juicedata/juicefs | `tencent-cloud` | `pkg/object/cos.go:37` | go |
| language not supported | juicedata/juicefs | `volcengine` | `pkg/object/tos.go:33` | go |
| language not supported | juicedata/juicefs | `wasabi` | `pkg/object/wasabi.go:27` | go |
| language not supported | line/promgen | `line-notify` | `promgen/notification/linenotify.py:48` | python |
| language not supported | line/promgen | `pagerduty` | `promgen/notification/pagerduty.py:64` | python |
| language not supported | line/promgen | `sentry` | `promgen/settings.py:178` | python |
| language not supported | line/promgen | `slack` | `promgen/notification/slack.py:58` | python |
| language not supported | linux-do/credit | `aws` | `internal/storage/s3.go:27` | go |
| language not supported | moby/buildkit | `aws` | `cache/remotecache/s3/s3.go:18` | go |
| language not supported | moby/buildkit | `azure` | `cache/remotecache/azblob/exporter.go:13` | go |
| language not supported | moby/buildkit | `github` | `cache/remotecache/gha/gha.go:36` | go |
| language not supported | mortennordbye/homelab | `quafu` | `quantum/shor/shor.py:22` | python |
| language not supported | odoo/runbot | `github` | `forwardport/models/forwardport.py:224` | python |
| language not supported | odoo/runbot | `sentry` | `forwardport/models/forwardport.py:9` | python |
| language not supported | openai/openai-cli | `openai` | `generated/commands/adminorganizationadminapikey.go:11` | go |
| language not supported | openedx/license-manager | `aws` | `license_manager/apps/api/utils.py:8` | python |
| language not supported | openedx/license-manager | `braze` | `license_manager/apps/api/tasks.py:7` | python |
| language not supported | openedx/license-manager | `segment` | `license_manager/apps/subscriptions/apps.py:6` | python |
| language not supported | osmosis-labs/osmosis | `google-cloud` | `ingest/indexer/service/client/pubsub_client.go:9` | go |
| language not supported | shuxiachai/academic-commercialization-agent | `alibaba-cloud` | `src/academic_agent/llm_config.py:36` | python |
| language not supported | shuxiachai/academic-commercialization-agent | `anthropic` | `src/academic_agent/llm_config.py:149` | python |
| language not supported | shuxiachai/academic-commercialization-agent | `crossref` | `src/academic_agent/source_clients.py:1009` | python |
| language not supported | shuxiachai/academic-commercialization-agent | `deepseek` | `src/academic_agent/llm_config.py:146` | python |
| language not supported | shuxiachai/academic-commercialization-agent | `lens` | `src/academic_agent/source_clients.py:882` | python |
| language not supported | shuxiachai/academic-commercialization-agent | `openai` | `src/academic_agent/llm_config.py:148` | python |
| language not supported | shuxiachai/academic-commercialization-agent | `openalex` | `src/academic_agent/source_clients.py:683` | python |
| language not supported | shuxiachai/academic-commercialization-agent | `semantic-scholar` | `src/academic_agent/source_clients.py:77` | python |
| language not supported | spr-networks/super | `cloudflare` | `api/code/wan_health.go:135` | go |
| language not supported | spr-networks/super | `github` | `superd/code/attest.go:145` | go |
| language not supported | spr-networks/super | `sigstore` | `superd/code/attest.go:27` | go |
| language not supported | supersonictw/popsenzawa-echo | `google-recaptcha` | `pop/util_recatcha.go:9` | go |
| language not supported | suzuki-shunsuke/pinact | `github` | `pkg/github/github.go:16` | go |
| language not supported | whoahaow/rjsxrd | `github` | `source/utils/github_handler.py:16` (+1) | python |
| language not supported | whoahaow/rjsxrd | `ifconfig-me` | `source/utils/ip_verifier.py:24` | python |
| language not supported | whoahaow/rjsxrd | `ipify` | `source/utils/ip_verifier.py:23` | python |
| language not supported | whoahaow/rjsxrd | `ipwho` | `source/utils/ip_verifier.py:22` | python |
| language not supported | whoahaow/rjsxrd | `telegram` | `source/utils/telegram_notifier.py:33` | python |
| other | HSLdevcom/digitransit-ui | `fmi` | `server/configs/config.default.js:106` | Refit scan failed: agents: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total).; deadlines: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total). |
| other | HSLdevcom/digitransit-ui | `matomo` | `server/configs/config.matka.js:471` | Refit scan failed: agents: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total).; deadlines: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total). |
| other | Peon-sh/Peon | `anthropic` | `src/services/internal/chat/providers/anthropic.ts:1` | package not in catalog: @ai-sdk/anthropic |
| other | chedim/babyseat | `anthropic` | `membrane/auth.py:90` (+1) | Refit scan failed: agents: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total).; deadlines: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total). |
| other | chedim/babyseat | `gemini` | `membrane/auth.py:108` | Refit scan failed: agents: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total).; deadlines: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total). |
| other | chedim/babyseat | `github` | `membrane/auth.py:126` | Refit scan failed: agents: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total).; deadlines: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total). |
| other | chedim/babyseat | `groq` | `membrane/auth.py:117` | Refit scan failed: agents: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total).; deadlines: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total). |
| other | chedim/babyseat | `mistral` | `membrane/auth.py:150` | Refit scan failed: agents: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total).; deadlines: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total). |
| other | chedim/babyseat | `opencode` | `membrane/auth.py:139` | Refit scan failed: agents: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total).; deadlines: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total). |
| other | chedim/babyseat | `openrouter` | `membrane/auth.py:99` | Refit scan failed: agents: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total).; deadlines: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total). |
| other | chedim/babyseat | `pypi` | `membrane/update.py:43` | Refit scan failed: agents: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total).; deadlines: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total). |
| other | datalayer/core | `stripe` | `src/components/checkout/StripeCheckout.tsx:34` (+1) | package not in catalog: @stripe/stripe-js, @stripe/react-stripe-js |
| other | gardener/dashboard | `github` | `backend/lib/github/octokit.js:9` | Refit scan failed: agents: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total).; deadlines: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total). |
| other | gardener/dashboard | `google-oauth` | `packages/kube-config/lib/Config.js:8` | Refit scan failed: agents: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total).; deadlines: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total). |
| other | holistics/dbml | `google-cloud` | `packages/dbml-connector/src/connectors/bigquery/index.ts:1` | Refit scan failed: agents: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total).; deadlines: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total). |
| other | holistics/dbml | `snowflake` | `packages/dbml-connector/src/connectors/snowflake/index.ts:9` | Refit scan failed: agents: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total).; deadlines: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total). |
| other | tidepool-org/blip | `github` | `app/components/uploaderbutton/uploaderbutton.js:3` | Refit scan failed: agents: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total).; deadlines: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total). |
| other | tidepool-org/blip | `launchdarkly` | `app/bootstrap.js:22` | Refit scan failed: agents: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total).; deadlines: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total). |
| other | tidepool-org/blip | `rollbar` | `app/rollbar.js:2` | Refit scan failed: agents: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total).; deadlines: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total). |
| other | timoncool/ACE-Step-Studio | `webamp-skin-museum` | `app/services/winamp.ts:49` | Refit scan failed: agents: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total).; deadlines: PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total). |
| other | zeitword/zeitword | `openai` | `server/api/ai/translate.post.ts:1` | package not in catalog: @ai-sdk/openai |
| provider not in catalog | 8starlabs/ui | `vercel` | `app/layout.tsx:11` | vercel |
| provider not in catalog | Affitor/open-affiliate | `cloudflare` | `src/components/turnstile.tsx:19` | cloudflare |
| provider not in catalog | Affitor/open-affiliate | `posthog` | `src/lib/posthog-noise.ts:1` | posthog |
| provider not in catalog | Affitor/open-affiliate | `supabase` | `src/app/api/content-lab/route.ts:2` | supabase |
| provider not in catalog | Bearisbug/Quilt | `alibaba-cloud` | `packages/core/src/schemas.ts:432` | alibaba-cloud |
| provider not in catalog | Bearisbug/Quilt | `aws` | `apps/api/src/lib/storage.ts:66` (+1) | aws |
| provider not in catalog | Bearisbug/Quilt | `deepseek` | `packages/core/src/schemas.ts:431` | deepseek |
| provider not in catalog | Bearisbug/Quilt | `moonshot` | `packages/core/src/schemas.ts:433` | moonshot |
| provider not in catalog | Bearisbug/Quilt | `openrouter` | `packages/core/src/schemas.ts:435` | openrouter |
| provider not in catalog | Bearisbug/Quilt | `siliconflow` | `packages/core/src/schemas.ts:437` | siliconflow |
| provider not in catalog | Bearisbug/Quilt | `zhipu` | `packages/core/src/schemas.ts:434` | zhipu |
| provider not in catalog | Bellows-AI/factory | `atlassian` | `server/src/routes/connector-jira.ts:23` | atlassian |
| provider not in catalog | Bellows-AI/factory | `github` | `server/src/config.ts:297` | github |
| provider not in catalog | Brajesh31/LangSQL | `datastax` | `Server/src/routes/trinotest.routes.js:4` (+1) | datastax |
| provider not in catalog | Brajesh31/LangSQL | `emailjs` | `Client/src/utils/emailjs.js:1` | emailjs |
| provider not in catalog | Brajesh31/LangSQL | `firebase` | `Client/src/Firebase/firebase.js:1` (+1) | firebase |
| provider not in catalog | Brajesh31/issue-tracker-next.js-app | `sentry` | `app/global-error.jsx:3` | sentry |
| provider not in catalog | CaoMeiYouRen/rsshub-never-die | `rsshub` | `src/routes/index.ts:10` | rsshub |
| provider not in catalog | ChurchApps/B1App | `google-analytics` | `src/app/[sdSlug]/mobile/MobileGoogleAnalytics.tsx:28` | google-analytics |
| provider not in catalog | ChurchApps/B1App | `sentry` | `src/app/global-error.tsx:10` | sentry |
| provider not in catalog | ChurchApps/B1App | `youversion` | `src/app/[sdSlug]/(public)/[pageSlug]/components/BiblePage.tsx:6` | youversion |
| provider not in catalog | CoderJackZhu/Thingary | `goatcounter` | `site/calc/app.js:39` | goatcounter |
| provider not in catalog | Felix-Lai-12/whospost | `apify` | `server/providers/apify.mjs:2` | apify |
| provider not in catalog | Felix-Lai-12/whospost | `cloudflare` | `frontend/src/Turnstile.jsx:2` (+1) | cloudflare |
| provider not in catalog | Felix-Lai-12/whospost | `cofacts` | `server/providers/cofacts.mjs:45` | cofacts |
| provider not in catalog | Felix-Lai-12/whospost | `google-analytics` | `frontend/src/analytics.mjs:42` | google-analytics |
| provider not in catalog | FontWoW/FontWoW.github.io | `countapi` | `src/Landing.jsx:50` | countapi |
| provider not in catalog | FontWoW/FontWoW.github.io | `counter-dev` | `src/analytics.js:4` | counter-dev |
| provider not in catalog | FontWoW/FontWoW.github.io | `github` | `src/App.jsx:44` | github |
| provider not in catalog | HelloQun54321/nai-atelier | `alibaba-cloud` | `services/agentProviders.ts:37` (+1) | alibaba-cloud |
| provider not in catalog | HelloQun54321/nai-atelier | `ant-ling` | `services/agentProviders.ts:34` | ant-ling |
| provider not in catalog | HelloQun54321/nai-atelier | `cerebras` | `services/agentProviders.ts:30` | cerebras |
| provider not in catalog | HelloQun54321/nai-atelier | `deepseek` | `services/agentProviders.ts:12` | deepseek |
| provider not in catalog | HelloQun54321/nai-atelier | `fireworks` | `services/agentProviders.ts:29` | fireworks |
| provider not in catalog | HelloQun54321/nai-atelier | `github` | `services/appReleases.mjs:4` | github |
| provider not in catalog | HelloQun54321/nai-atelier | `groq` | `services/agentProviders.ts:26` | groq |
| provider not in catalog | HelloQun54321/nai-atelier | `huggingface` | `services/agentProviders.ts:32` | huggingface |
| provider not in catalog | HelloQun54321/nai-atelier | `minimax` | `services/agentProviders.ts:20` (+1) | minimax |
| provider not in catalog | HelloQun54321/nai-atelier | `mistral` | `services/agentProviders.ts:27` | mistral |
| provider not in catalog | HelloQun54321/nai-atelier | `moonshot` | `services/agentProviders.ts:17` (+2) | moonshot |
| provider not in catalog | HelloQun54321/nai-atelier | `novelai` | `mobile/gateway.ts:74` | novelai |
| provider not in catalog | HelloQun54321/nai-atelier | `nvidia` | `services/agentProviders.ts:31` | nvidia |
| provider not in catalog | HelloQun54321/nai-atelier | `opencode` | `services/agentProviders.ts:35` | opencode |
| provider not in catalog | HelloQun54321/nai-atelier | `openrouter` | `services/agentProviders.ts:25` | openrouter |
| provider not in catalog | HelloQun54321/nai-atelier | `together` | `services/agentProviders.ts:28` | together |
| provider not in catalog | HelloQun54321/nai-atelier | `vercel` | `services/agentProviders.ts:33` | vercel |
| provider not in catalog | HelloQun54321/nai-atelier | `xai` | `services/agentProviders.ts:16` | xai |
| provider not in catalog | HelloQun54321/nai-atelier | `xiaomi-mimo` | `services/agentProviders.ts:24` (+3) | xiaomi-mimo |
| provider not in catalog | HelloQun54321/nai-atelier | `zhipu` | `services/agentProviders.ts:22` (+1) | zhipu |
| provider not in catalog | HkingAuditore/civ-game | `allorigins` | `src/components/common/MusicPlayer.jsx:182` | allorigins |
| provider not in catalog | HkingAuditore/civ-game | `gameanalytics` | `src/analytics/gaInit.js:4` | gameanalytics |
| provider not in catalog | Jaxton07/percho | `opencode` | `packages/backend/src/settings/quota.ts:5` | opencode |
| provider not in catalog | Jaxton07/percho | `pi-dev` | `packages/backend/src/packages/catalog.ts:6` | pi-dev |
| provider not in catalog | Kylrix/kylrix | `blockbee` | `lib/billing/providers/blockbee.ts:4` | blockbee |
| provider not in catalog | Kylrix/kylrix | `cloudflare` | `lib/ai/workers-ai.ts:94` | cloudflare |
| provider not in catalog | Kylrix/kylrix | `github` | `lib/actions/contributor-ops.ts:80` | github |
| provider not in catalog | Kylrix/kylrix | `npm-registry` | `packages/cli/src/updater/index.ts:46` | npm-registry |
| provider not in catalog | Kylrix/kylrix | `openrouter` | `lib/ai/agent-scheduler.ts:103` | openrouter |
| provider not in catalog | Kylrix/kylrix | `telegram` | `app/api/telegram/webhook/route.ts:41` | telegram |
| provider not in catalog | MTES-MCT/acceslibre | `sentry` | `core/settings_prod.py:28` (+1) | sentry |
| provider not in catalog | OpenByteInc/QuantDinger-Vue | `binance` | `src/utils/exchangeWs.js:110` (+1) | binance |
| provider not in catalog | OpenByteInc/QuantDinger-Vue | `bitget` | `src/utils/exchangeWs.js:159` | bitget |
| provider not in catalog | OpenByteInc/QuantDinger-Vue | `bybit` | `src/utils/exchangeWs.js:193` | bybit |
| provider not in catalog | OpenByteInc/QuantDinger-Vue | `cloudflare` | `src/components/Turnstile/index.vue:55` | cloudflare |
| provider not in catalog | OpenByteInc/QuantDinger-Vue | `gate` | `src/utils/exchangeWs.js:225` (+1) | gate |
| provider not in catalog | OpenByteInc/QuantDinger-Vue | `htx` | `src/utils/exchangeWs.js:255` (+1) | htx |
| provider not in catalog | OpenByteInc/QuantDinger-Vue | `okx` | `src/utils/exchangeWs.js:130` | okx |
| provider not in catalog | PapillonApp/Papillon | `alise` | `app/(onboarding)/restaurants/alise.tsx:20` | alise |
| provider not in catalog | PapillonApp/Papillon | `appscho` | `app/(onboarding)/services/appscho/credentials.tsx:28` | appscho |
| provider not in catalog | PapillonApp/Papillon | `ard` | `app/(onboarding)/restaurants/ard.tsx:6` | ard |
| provider not in catalog | PapillonApp/Papillon | `ecoledirecte` | `app/(onboarding)/services/ed/credentials.tsx:2` | ecoledirecte |
| provider not in catalog | PapillonApp/Papillon | `esup-multi` | `app/(onboarding)/services/multi/credentials.tsx:3` | esup-multi |
| provider not in catalog | PapillonApp/Papillon | `geopf` | `utils/native/georeverse.ts:10` | geopf |
| provider not in catalog | PapillonApp/Papillon | `github` | `utils/github/contributors.ts:11` | github |
| provider not in catalog | PapillonApp/Papillon | `izly` | `app/(onboarding)/restaurants/izly.tsx:4` | izly |
| provider not in catalog | PapillonApp/Papillon | `pronote` | `app/(onboarding)/services/pronote/browser.tsx:15` | pronote |
| provider not in catalog | PapillonApp/Papillon | `skolengo` | `app/(features)/(news)/specific.tsx:11` | skolengo |
| provider not in catalog | PapillonApp/Papillon | `turboself` | `app/(onboarding)/restaurants/turboself.tsx:13` | turboself |
| provider not in catalog | Peon-sh/Peon | `aws` | `src/lib/mcp/tools/workspace-infra.ts:3` (+3) | aws |
| provider not in catalog | Peon-sh/Peon | `github` | `src/app/(app)/sources/page.tsx:60` | github |
| provider not in catalog | Peon-sh/Peon | `google-oauth` | `src/services/external/google/auth.ts:5` | google-oauth |
| provider not in catalog | Peon-sh/Peon | `posthog` | `instrumentation-client.ts:1` | posthog |
| provider not in catalog | Peon-sh/Peon | `pushover` | `src/services/internal/notifications/notifications.ts:288` | pushover |
| provider not in catalog | Peon-sh/Peon | `telegram` | `src/services/internal/notifications/notifications.ts:277` | telegram |
| provider not in catalog | ProjectSidewalk/SidewalkWebpage | `google-maps` | `frontend/js/common/pano-viewer/GsvViewer.js:90` | google-maps |
| provider not in catalog | ProjectSidewalk/SidewalkWebpage | `infra3d` | `frontend/js/common/pano-viewer/sdk/infra3d.js:6` | infra3d |
| provider not in catalog | ProjectSidewalk/SidewalkWebpage | `mapbox` | `frontend/js/common/mapboxgl.js:9` (+2) | mapbox |
| provider not in catalog | ProjectSidewalk/SidewalkWebpage | `mapillary` | `frontend/js/common/pano-viewer/MapillaryViewer.js:316` | mapillary |
| provider not in catalog | ProjectSidewalk/SidewalkWebpage | `panoramax` | `frontend/js/common/pano-viewer/PanoramaxViewer.js:48` | panoramax |
| provider not in catalog | VocaHQ/vocalinux | `creatr` | `web/src/lib/api/util.ts:244` | creatr |
| provider not in catalog | VocaHQ/vocalinux | `google-analytics` | `web/src/app/layout.tsx:189` | google-analytics |
| provider not in catalog | YanQuan-dozzy/Boss-Claw | `alibaba-cloud` | `desktop-app/src/lib/bossclaw/providerPresets.ts:44` | alibaba-cloud |
| provider not in catalog | YanQuan-dozzy/Boss-Claw | `deepseek` | `desktop-app/src/lib/bossclaw/llm.ts:481` | deepseek |
| provider not in catalog | YanQuan-dozzy/Boss-Claw | `microsoft-edge-tts` | `desktop-app/electron/edgeTts.cjs:23` | microsoft-edge-tts |
| provider not in catalog | YanQuan-dozzy/Boss-Claw | `siliconflow` | `desktop-app/src/lib/bossclaw/providerPresets.ts:56` | siliconflow |
| provider not in catalog | YanQuan-dozzy/Boss-Claw | `volcengine` | `desktop-app/src/lib/bossclaw/providerPresets.ts:70` | volcengine |
| provider not in catalog | YanQuan-dozzy/Boss-Claw | `zhipu` | `desktop-app/src/lib/bossclaw/providerPresets.ts:50` | zhipu |
| provider not in catalog | ZengLiangYi/ChatCrystal | `azure` | `server/src/services/providers.ts:4` | azure |
| provider not in catalog | ZengLiangYi/ChatCrystal | `github` | `electron/updates.ts:9` | github |
| provider not in catalog | ZengLiangYi/ChatCrystal | `orcarouter` | `server/src/services/modelDiscovery.ts:70` | orcarouter |
| provider not in catalog | ZyFou/ProceduralTerrains | `openstreetmap` | `src/components/ui/RealWorldMapPicker.jsx:20` | openstreetmap |
| provider not in catalog | ZyFou/ProceduralTerrains | `overpass` | `src/engine/terrain/RealWorldBuildings.js:12` (+2) | overpass |
| provider not in catalog | alharkan7/beeblio | `brave-search` | `agent/tools/brave_search.ts:22` | brave-search |
| provider not in catalog | alharkan7/beeblio | `crossref` | `app/[projectId]/bibliography-actions.ts:235` | crossref |
| provider not in catalog | alharkan7/beeblio | `defuddle` | `agent/tools/read_webpage_markdown.ts:22` | defuddle |
| provider not in catalog | alharkan7/beeblio | `monid` | `agent/lib/monid.ts:3` | monid |
| provider not in catalog | alharkan7/beeblio | `ncbi` | `lib/literature/search.ts:356` | ncbi |
| provider not in catalog | alharkan7/beeblio | `openalex` | `agent/lib/openalex.ts:8` | openalex |
| provider not in catalog | alharkan7/beeblio | `openrouter` | `agent/agent.ts:1` | openrouter |
| provider not in catalog | alharkan7/beeblio | `worldbank` | `agent/tools/fetch_demographic_data.ts:34` | worldbank |
| provider not in catalog | andrebuilds/melodyc | `aws` | `frontend/src/actions/avatar.ts:3` (+2) | aws |
| provider not in catalog | andrebuilds/melodyc | `github` | `frontend/src/app/api/github/stars/route.ts:2` | github |
| provider not in catalog | andrebuilds/melodyc | `inngest` | `frontend/src/app/api/inngest/route.ts:1` | inngest |
| provider not in catalog | andrebuilds/melodyc | `upstash` | `frontend/src/actions/generation.ts:16` (+1) | upstash |
| provider not in catalog | andrebuilds/melodyc | `vercel` | `frontend/src/components/consented-analytics.tsx:3` (+1) | vercel |
| provider not in catalog | apify/apify-mcp-server | `algolia` | `src/utils/apify_docs.ts:8` | algolia |
| provider not in catalog | apify/apify-mcp-server | `apify` | `src/apify_client.ts:1` | apify |
| provider not in catalog | apify/apify-mcp-server | `segment` | `src/telemetry.ts:3` | segment |
| provider not in catalog | apify/apify-mcp-server | `sentry` | `src/instrument.ts:10` | sentry |
| provider not in catalog | bel-frontend/bel-frontend.github.io | `firebase` | `src/modules/firebase/index.ts:2` | firebase |
| provider not in catalog | bel-frontend/bel-frontend.github.io | `goman` | `src/helpers/localization.ts:9` | goman |
| provider not in catalog | betagouv/mon-aide-cyber | `brevo` | `mon-aide-cyber-api/src/infrastructure/adaptateurs/adaptateursRequeteBrevo.ts:130` | brevo |
| provider not in catalog | betagouv/mon-aide-cyber | `sentry` | `mon-aide-cyber-api/src/infrastructure/adaptateurs/AdaptateurGestionnaireErreursSentry.ts:1` | sentry |
| provider not in catalog | chamals3n4/OpenATS | `cloudflare` | `backend/src/shared/services/r2.service.ts:6` | cloudflare |
| provider not in catalog | chamals3n4/OpenATS | `google-workspace` | `backend/src/shared/integrations/google-meet.provider.ts:2` | google-workspace |
| provider not in catalog | databasus/databasus | `google-oauth` | `frontend/src/pages/OauthStorageComponent.tsx:29` | google-oauth |
| provider not in catalog | databasus/databasus | `paddle` | `website/app/components/PaddleInitComponent.tsx:22` | paddle |
| provider not in catalog | datalayer/core | `github` | `src/hooks/useCache.ts:8985` | github |
| provider not in catalog | deep-learning-indaba/Baobab | `google-analytics` | `webapp/src/App.js:24` | google-analytics |
| provider not in catalog | deep-learning-indaba/Baobab | `google-cloud` | `api/app/utils/storage.py:3` (+1) | google-cloud |
| provider not in catalog | evanbaker315/AttentionOS | `apify` | `packages/providers/scrape-apify/src/index.ts:34` | apify |
| provider not in catalog | evanbaker315/AttentionOS | `blotato` | `packages/providers/publish-blotato/src/mapping.ts:10` | blotato |
| provider not in catalog | evanbaker315/AttentionOS | `discord` | `packages/providers/notify-discord/src/client.ts:29` | discord |
| provider not in catalog | evanbaker315/AttentionOS | `github` | `packages/providers/trends-web/src/index.ts:247` | github |
| provider not in catalog | evanbaker315/AttentionOS | `gohighlevel` | `packages/providers/crm-webhook/src/gohighlevel.ts:6` | gohighlevel |
| provider not in catalog | evanbaker315/AttentionOS | `google-news` | `packages/providers/trends-web/src/index.ts:87` | google-news |
| provider not in catalog | evanbaker315/AttentionOS | `hacker-news` | `packages/providers/trends-web/src/index.ts:136` | hacker-news |
| provider not in catalog | evanbaker315/AttentionOS | `hubspot` | `packages/providers/crm-webhook/src/hubspot.ts:6` | hubspot |
| provider not in catalog | evanbaker315/AttentionOS | `reddit` | `packages/providers/trends-web/src/index.ts:186` | reddit |
| provider not in catalog | evanbaker315/AttentionOS | `telegram` | `packages/providers/notify-telegram/src/client.ts:35` | telegram |
| provider not in catalog | evanbaker315/AttentionOS | `voyageai` | `packages/knowledge/src/embedder.ts:153` | voyageai |
| provider not in catalog | evanbaker315/AttentionOS | `zernio` | `packages/providers/publish-zernio/src/mapping.ts:14` | zernio |
| provider not in catalog | facenox/facenox | `ably` | `app/src/electron/managers/BackgroundSyncManager.ts:1` | ably |
| provider not in catalog | facenox/facenox | `github` | `app/src/electron/updater.ts:17` | github |
| provider not in catalog | guaner-334/civ-atlas | `alibaba-cloud` | `src/ai/providers/bailian.ts:20` (+1) | alibaba-cloud |
| provider not in catalog | guaner-334/civ-atlas | `deepseek` | `src/ai/providers/deepseek.ts:16` | deepseek |
| provider not in catalog | huilang-me/CF-Server-Monitor | `bark` | `src/services/notification.js:902` | bark |
| provider not in catalog | huilang-me/CF-Server-Monitor | `cloudflare` | `src/handlers/admin.js:280` (+1) | cloudflare |
| provider not in catalog | huilang-me/CF-Server-Monitor | `exchangerate-api` | `src/frontend/utils/finance.js:88` | exchangerate-api |
| provider not in catalog | huilang-me/CF-Server-Monitor | `frankfurter` | `src/frontend/utils/finance.js:84` | frankfurter |
| provider not in catalog | huilang-me/CF-Server-Monitor | `github` | `src/frontend/views/admin/components/ThemeStorePanel.vue:448` | github |
| provider not in catalog | huilang-me/CF-Server-Monitor | `serverchan` | `src/services/notification.js:936` | serverchan |
| provider not in catalog | huilang-me/CF-Server-Monitor | `telegram` | `src/services/notification.js:991` | telegram |
| provider not in catalog | huilang-me/CF-Server-Monitor | `wecom` | `src/services/notification.js:920` | wecom |
| provider not in catalog | huilang-me/CF-Server-Monitor | `wxpusher` | `src/services/notification.js:953` | wxpusher |
| provider not in catalog | iam567/rich4-renew-app | `peerjs` | `game/src/ui/party-check.ts:6` | peerjs |
| provider not in catalog | jaygupta17/otto | `boat` | `src/lib/providers/boat.ts:11` | boat |
| provider not in catalog | jaygupta17/otto | `boxd` | `src/lib/providers/boxd.ts:9` | boxd |
| provider not in catalog | jaygupta17/otto | `composio` | `src/lib/composio.ts:16` | composio |
| provider not in catalog | jaygupta17/otto | `daytona` | `src/lib/providers/daytona.ts:18` | daytona |
| provider not in catalog | jaygupta17/otto | `e2b` | `src/lib/providers/e2b.ts:18` | e2b |
| provider not in catalog | kinora-dev/kinora | `aws` | `packages/server/src/lib/storage.ts:8` (+2) | aws |
| provider not in catalog | kinora-dev/kinora | `github` | `packages/core/src/lib/pr-comment.ts:113` | github |
| provider not in catalog | kinora-dev/kinora | `gitlab` | `packages/core/src/lib/pr-comment.ts:81` | gitlab |
| provider not in catalog | kinora-dev/kinora | `polar` | `packages/server/src/billing/polar.ts:2` | polar |
| provider not in catalog | kinora-dev/kinora | `sentry` | `packages/server/src/app.ts:3` (+2) | sentry |
| provider not in catalog | kinora-dev/kinora | `slack` | `packages/server/src/slack/oauth.ts:133` | slack |
| provider not in catalog | leftos/towercab-3d | `aviationweather` | `src/renderer/constants/api.ts:32` | aviationweather |
| provider not in catalog | leftos/towercab-3d | `cesium` | `src/renderer/App.tsx:1` (+1) | cesium |
| provider not in catalog | leftos/towercab-3d | `realtraffic` | `src/renderer/constants/realtraffic.ts:20` | realtraffic |
| provider not in catalog | leftos/towercab-3d | `vatsim` | `src/renderer/constants/api.ts:22` | vatsim |
| provider not in catalog | lingcang728/ZeppBridge | `github` | `functions/api/release.js:2` | github |
| provider not in catalog | lingcang728/ZeppBridge | `zepp` | `src/composables/settings/useAuthFlow.ts:12` | zepp |
| provider not in catalog | mantrakp04/ardia | `baidu` | `packages/core/src/engines.ts:78` | baidu |
| provider not in catalog | mantrakp04/ardia | `bing` | `packages/core/src/engines.ts:34` | bing |
| provider not in catalog | mantrakp04/ardia | `bitbucket` | `apps/browser/src/live/net.ts:17` | bitbucket |
| provider not in catalog | mantrakp04/ardia | `brave-search` | `packages/core/src/engines.ts:56` | brave-search |
| provider not in catalog | mantrakp04/ardia | `duckduckgo` | `packages/core/src/engines.ts:40` | duckduckgo |
| provider not in catalog | mantrakp04/ardia | `ecosia` | `packages/core/src/engines.ts:49` | ecosia |
| provider not in catalog | mantrakp04/ardia | `github` | `apps/browser/src/live/net.ts:15` | github |
| provider not in catalog | mantrakp04/ardia | `google-oauth` | `apps/browser/src/live/net.ts:21` | google-oauth |
| provider not in catalog | mantrakp04/ardia | `google-search` | `packages/core/src/engines.ts:32` | google-search |
| provider not in catalog | mantrakp04/ardia | `google-workspace` | `apps/browser/src/live/net.ts:22` | google-workspace |
| provider not in catalog | mantrakp04/ardia | `notion` | `apps/browser/src/live/net.ts:18` | notion |
| provider not in catalog | mantrakp04/ardia | `startpage` | `packages/core/src/engines.ts:64` | startpage |
| provider not in catalog | mantrakp04/ardia | `yahoo` | `packages/core/src/engines.ts:71` | yahoo |
| provider not in catalog | mantrakp04/ardia | `yandex` | `packages/core/src/engines.ts:85` | yandex |
| provider not in catalog | mortennordbye/homelab | `github` | `portfolio/src/app/api/v1/github/route.ts:36` | github |
| provider not in catalog | mwakidenis/mwakidenis.com | `formspree` | `src/data/app.json:4` | formspree |
| provider not in catalog | neo4j-contrib/neodash | `azure` | `src/extensions/text2cypher/clients/AzureOpenAi/AzureOpenAiClient.ts:1` | azure |
| provider not in catalog | neo4j-contrib/neodash | `sentry` | `src/index.tsx:12` | sentry |
| provider not in catalog | organui/organui | `github` | `apps/web/components/github-link.tsx:32` | github |
| provider not in catalog | organui/organui | `vercel` | `apps/web/components/analytics.tsx:3` | vercel |
| provider not in catalog | plhery/peek-delivery-tracker | `apple` | `src/server/appleSignIn.ts:8` | apple |
| provider not in catalog | plhery/peek-delivery-tracker | `cloudflare` | `app/api/public/native/turnstile/route.ts:22` | cloudflare |
| provider not in catalog | plhery/peek-delivery-tracker | `sentry` | `src/server/metrics.ts:3` (+1) | sentry |
| provider not in catalog | plhery/peek-delivery-tracker | `supabase` | `src/auth/AuthContext.tsx:57` | supabase |
| provider not in catalog | ralscha/blog | `hibp` | `passwordcheck/client/src/main.js:4` | hibp |
| provider not in catalog | ralscha/blog | `usgs` | `dexiejs/src/app/earthquake.service.ts:39` | usgs |
| provider not in catalog | ravidsrk/slop-detect | `cloudflare` | `apps/web/functions/api/_middleware.ts:168` (+1) | cloudflare |
| provider not in catalog | ravidsrk/slop-detect | `github` | `packages/action/scan.mjs:383` | github |
| provider not in catalog | shpyrd-io/shpyrd | `github` | `apps/website/app/api/github/route.ts:9` | github |
| provider not in catalog | shpyrd-io/shpyrd | `google-analytics` | `apps/website/app/layout.tsx:2` | google-analytics |
| provider not in catalog | skuqre/nikke-font-generator | `dotgg` | `src/pages/blabla-pfps.astro:172` | dotgg |
| provider not in catalog | skuqre/nikke-font-generator | `google-analytics` | `src/pages/banner.astro:32` | google-analytics |
| provider not in catalog | wakujs/waku | `github` | `packages/create-waku/src/helpers/example-option.ts:43` | github |
| provider not in catalog | wakujs/waku | `google-analytics` | `packages/website/src/components/analytics.tsx:14` | google-analytics |
| provider not in catalog | zeitword/zeitword | `aws` | `server/utils/s3.ts:1` (+1) | aws |
| provider not in catalog | zordhalo/runs-on.dev | `github` | `app/api/auth/github/callback/route.js:27` | github |
| provider not in catalog | zordhalo/runs-on.dev | `vercel` | `app/layout.jsx:7` (+1) | vercel |
