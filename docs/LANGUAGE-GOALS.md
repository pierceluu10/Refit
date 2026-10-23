# Language goals

How Refit reads and fixes TypeScript and JavaScript today, what in that path is language-neutral, and a goal per candidate language for doing the same there. Written 2026-10-20 from the files cited. It follows [Provider goals](PROVIDER-GOALS.md): frozen sets of real public repositories, measurable targets, zero wrong fixes on hand review, and every remaining stop named as an owner decision.

Rules, from [AGENTS.md](../AGENTS.md) and [PRD.md](PRD.md):

- Breaking changes first; non-breaking changes are recorded for review.
- Deterministic rules first; AI stays a bounded assistant behind the existing evidence, budget, validation and review gates.
- No new application language in Refit itself unless a dependency absolutely requires it (source: docs/PRD.md, section 10, "Technology choices"). `oasdiff` stays an external binary.
- A fact not confirmed from this repository is marked **unverified: check**. SDK package names below are from memory unless cited.

The PRD already names this direction: Python, Go and Java are listed as out of scope for the MVP and as future `PythonAnalyzer`, `GoAnalyzer` and `JavaAnalyzer` implementations behind a `LanguageAnalyzer` interface (source: docs/PRD.md, sections 4 and 22). Nothing of that exists in code yet.

## How the TypeScript path works today

Each layer, the file that owns it, and whether it depends on the language.

| Layer | What it does | Owner | Language-bound? |
|---|---|---|---|
| Repository reading | Walks committed files, keeps `.js/.ts/.jsx/.tsx/.mjs/.cjs/.mts/.cts`, reads `package.json` and npm, pnpm and Yarn lockfiles; limits of 10,000 files and 50 MiB | `pipeline/repository.ts` | Yes: extension filter, manifest and lockfile parsers |
| Provider detection | Matches catalog package names in manifests and lockfiles, and API hostnames in source | `pipeline/agent-catalog.ts` | Package names are npm names; hostname scan is neutral |
| Contracts | OpenAPI snapshots and `oasdiff`; Shopify GraphQL introspection snapshots | `pipeline/specifications.ts`, `pipeline/shopify-*.ts` | No |
| Adapter | SDK identity (`packageName`, `defaultImport`, `namedExport`) and `resource.method → schema` mappings | `examples/*.provider.json`, built-in Stripe | Identity is JS-module shaped; the operation map is neutral |
| Analyzer | TypeScript compiler symbols trace clients, aliases, class fields, helpers, factories, webhooks, mutations and escapes; produces `sdkCalls` with file, line, resource path, method and provenance | `pipeline/analyzer.ts` and 27 other modules that import the TypeScript compiler (`class-clients`, `helper-clients`, `factory-clients`, `mutations`, `source-modules`, `stripe-*`, …) | Entirely |
| Deterministic rules | Property renames and moves, request renames, endpoint replacements, Stripe period and card rules; each edits TypeScript AST nodes | `pipeline/request-migration.ts`, `pipeline/stripe-field-moves.ts`, `pipeline/history-migration.ts`, … | Entirely: rules are written against TS nodes |
| AI patches | Model returns exact text replacements inside confirmed files; a guard rescans with the analyzer and rejects edits outside scope | `pipeline/ai-patches.ts`, `pipeline/substitution-guard.ts`, `pipeline/patch-context.ts` | Prompting is neutral; the guard and rescan are TS |
| Dependency preparation | Installs the committed npm, pnpm or Yarn lockfile in a restricted container, cached by lockfile hash; upgrades `stripe` in the patch | `pipeline/dependency-preparation.ts`, `pipeline/manager-install.ts` | Entirely: npm ecosystem |
| Validation | Archives HEAD, runs the configured `command` in any existing local Docker `image`, offline, on original and patched copies | `pipeline/validation.ts`, `pipeline/docker-sandbox.ts` | No: image and command are configuration |
| Generated checks | Runs exported functions against versioned `stripe-mock` when the repository has no tests | `pipeline/generated-checks.ts` | Runner is Node; `stripe-mock` itself is HTTP and neutral |
| Deadline matcher | Finds pinned versions and model IDs in JS/TS source, manifests and lockfiles | `pipeline/deadline-exposure.ts` | Yes: parses JS/TS only (source: docs/DEADLINES.md, limits) |
| Publication, service, budget, evidence | Draft PRs as Refit Agent, webhooks, polling, AI ledger, receipts | `pipeline/github-*.ts`, `pipeline/service-*.ts`, `pipeline/ai-budget.ts` | No |

Two facts shape every goal below:

1. **Everything that decides whether code is affected, and everything that edits it, is TypeScript-specific.** A second language is a second analyzer and a second rule set, not a plugin.
2. **Everything around it is already neutral.** Contracts, diffing, evidence, budget, validation containers, publication and the catalog's hostname scan work unchanged. The provider goals carry over: a Python Stripe migration uses the same Stripe contracts, the same deadline registry and the same draft PR flow.

## The shared design

Before any language, three decisions, each an owner call:

1. **One syntax toolkit or one per language.** A WebAssembly tree-sitter build runs inside Node with no new runtime and gives a parse tree for every candidate language; it gives no types. Per-language toolchains (CPython `ast`, `go/types`, Roslyn, JavaParser) give types but each adds a runtime to Refit, which the PRD forbids without a hard reason. A middle path: tree-sitter for syntax everywhere, plus a type service only where one exists in TypeScript (Pyright is written in TypeScript and published on npm: unverified: check its programmatic API and licence). Record the choice in [ARCHITECTURE.md](ARCHITECTURE.md).
2. **A language-neutral SDK call record.** The analyzer's `sdkCalls` entries (location, resource path, method, provenance, mutation and escape state) become the contract between tracers and rules. Rules that today walk TS nodes are split into a neutral decision ("this read of `subscription.current_period_end` moves to the item period") and a per-language edit (the text replacement). The PRD's `LanguageAnalyzer` interface (`detect`, `indexRepository`, `findProviderUsages`, `expandContext`) is the shape to implement.
3. **Which edits are allowed without types.** In TypeScript, a confirmed finding needs proven provenance: the value came from a traced SDK response, a signed webhook or a declared `Stripe.*` type. Dynamic languages cannot offer the third. The owner decides whether "traced SDK response in the same function" is enough evidence for an automatic edit in Python or Ruby, or whether those languages are detection-and-review only until a type service exists.

The go/no-go gate for every language is a **tracing benchmark first**, the way [SDK coverage](SDK-COVERAGE.md) was run for TypeScript before any rule was written: a frozen set of 50 repositories using the Stripe SDK in that language (Stripe first, because its contracts, rules and labels exist), the likely SDK call sites counted by a loose search, and the share Refit traces with provenance. Proceed to rules only above 70% traced, with a hand check that traced calls are real SDK calls.

## What every language must supply

| Piece | TypeScript today | A new language needs |
|---|---|---|
| Source filter | `SOURCE_EXTENSION` in `repository.ts` | Its extensions and generated-file exclusions |
| Manifest and lockfile model | `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` | Its manifest, its lockfile, and a parser that yields declared and locked SDK versions |
| Catalog identity | npm package names | The provider's package name in that ecosystem, added per catalog entry |
| Adapter identity | `packageName`, `defaultImport`, `namedExport` | An import or constructor shape per language, in the same adapter file under a language key |
| Tracer | TS symbols | Calls on SDK clients with provenance, mutation and escape evidence, in the neutral record |
| Pin reader | `apiVersion` literal, constructor options, `.refit.json` | The same for its SDK's version setting |
| Editor | TS node edits | Position-based text edits that re-parse cleanly |
| Preparation | Offline-installable lockfile snapshot | An offline install recipe and cache key for its package manager |
| Validation image | `node:22-alpine` in examples | An existing local image and a check command (`pytest`, `go test`, …) |
| Generated checks | Node entry points against `stripe-mock` | Optional: a runner per language; `stripe-mock` is reused as is |
| Deadline matcher | JS/TS literals | Literal model IDs and version URLs in that language |

---

## Python

**Status today.** Not started. Listed as future in the PRD (source: docs/PRD.md, sections 4 and 22). No Python file is read, no manifest parsed, no benchmark run.

**Why it matters.** Every provider in [Provider goals](PROVIDER-GOALS.md) with an AI product ships an official Python SDK: `stripe`, `openai`, `anthropic` on PyPI are official (unverified: check current names); Shopify's `ShopifyAPI` and PayPal's server SDK: unverified: check. The OpenAI 2026-10-23 model shutdown applies to Python callers exactly as to JS ones, and the deadline registry already holds the models; only the matcher is missing.

**SDK patterns to trace.** `import stripe` then module-level `stripe.api_key = ...` and `stripe.PaymentIntent.create(...)`, or `client = stripe.StripeClient(key)` then `client.payment_intents.create(...)`; `from openai import OpenAI`, `client = OpenAI()`, `client.chat.completions.create(model=...)`; `from anthropic import Anthropic`, `client.messages.create(model=...)`. Keyword arguments carry the request body, so request-parameter rules read keywords, not object literals. Shapes from memory: unverified: check each SDK README. Clients live in module globals, FastAPI or Django settings, and dependency-injected parameters.

**What is hard.** No compiler to resolve symbols; type hints are optional and rare on SDK responses. Module-level `stripe.api_version = '...'` is the pin, and it can be set anywhere. Response objects are dict-like, so field reads appear as `obj['field']`, `obj.field` and `obj.get('field')`. Virtual environments and `requirements.txt` without hashes make offline preparation weaker than a lockfile.

**Definition of done.**

| Measure | Target |
|---|---|
| Frozen set | 50 public repositories declaring `stripe` in `pyproject.toml`, `requirements*.txt`, `Pipfile` or `poetry.lock`, selected as in [SHOPIFY-BENCHMARK.md](SHOPIFY-BENCHMARK.md#method); 15 hand-labelled for breaking reads |
| Gate: likely Stripe calls traced with provenance | ≥ 70% to proceed; ≥ 90% at done |
| Labelled breaking reads confirmed | ≥ 90% recall, ≥ 98% precision |
| Affected repositories ending in a validated fix | ≥ 70% of those with runnable checks |
| Wrong fixes on hand review | 0 |
| Remaining stops | each a named owner decision |

**Milestones.** 1. Source filter and manifest model (`pyproject.toml`, `requirements*.txt`, `poetry.lock`, `uv.lock`, `Pipfile.lock`; which lockfiles count is an owner decision). 2. Tracer producing the neutral call record for module-level and client-style Stripe calls, without a type service. 3. Tracing benchmark on the frozen 50; gate. 4. Deadline matcher for Python literals (OpenAI and Anthropic model IDs first, since the registry exists). 5. Port the Stripe basil rules (period reads, `invoice.subscription`, card `payment_method_types`) as neutral decisions plus Python edits. 6. Preparation recipe (download wheels online, install offline) and a `python:3.x` validation image with `pytest` or `mypy`. 7. Validated fixes on the frozen set, published like the Stripe sets.

**Blockers and owner decisions.** Decision 3 above (edits without types). Whether Pyright or any type service is acceptable. Which Python lockfiles count as pinned. A Python image is a sandbox choice. No provider credential is needed.

**Effort: L.** The first language pays for the shared design; everything after reuses it.

## Go

**Status today.** Not started (source: docs/PRD.md, section 22 lists `GoAnalyzer` as future).

**Why it matters.** Official Go SDKs exist for Stripe (`github.com/stripe/stripe-go`), OpenAI (`github.com/openai/openai-go`) and Anthropic (`github.com/anthropics/anthropic-sdk-go`): unverified: check module paths and majors. Go code is statically typed with explicit imports, so provenance is cheaper than anywhere else: a value of type `*stripe.Subscription` is a Stripe object by construction.

**SDK patterns to trace.** stripe-go uses a package per resource (`paymentintent.New(params)`) and a versioned module path (`stripe-go/v8x`) that fixes the API version: unverified: check. openai-go and anthropic-sdk-go use `client := openai.NewClient(...)` then `client.Chat.Completions.New(ctx, params)` with typed param structs: unverified: check. The SDK major in `go.mod` is the pin.

**What is hard.** The API version is tied to the module major, so a migration is a module upgrade plus code changes across every resource package, not a literal bump. Resolving types needs `go/types` or `gopls`, which need the Go toolchain; tree-sitter alone sees syntax. Offline validation needs the module cache prepared (`go mod download` in the online preparation step, then `GOFLAGS=-mod=mod GOPROXY=off` or a vendored tree: unverified: check the exact flags).

**Definition of done.** Same table as Python on 50 repositories with `stripe-go` in `go.mod`, with `go build` and `go test` as the checks. Because types are explicit, the precision target for confirmed reads is 100%.

**Milestones.** 1. Source filter and `go.mod`/`go.sum` model. 2. Tracer: imports plus typed declarations, tree-sitter first; a `go/types` service only if the gate fails without it. 3. Tracing benchmark; gate. 4. Deadline matcher for Go string literals. 5. Rules as neutral decisions plus Go edits; the module-major upgrade modelled on the stripe-node lockfile upgrade in [DEPENDENCIES.md](DEPENDENCIES.md#stripe-node-upgrade-in-a-patch). 6. Preparation and a `golang` validation image. 7. Validated fixes.

**Blockers and owner decisions.** Whether Refit may run the Go toolchain for type information (it already runs `oasdiff`, a Go binary, so a container-only toolchain is precedent). Module-major upgrade policy. Image choice.

**Effort: M.** Cheapest tracing; the module-upgrade rule is the main work.

### Go decisions (2026-10-22)

Taken for the Go tracer (`pipeline/go/`, lane FG2). They follow the shared decisions in [Architecture](ARCHITECTURE.md#other-languages-decisions-2026-10-22) from the Python tracer and are flagged for reconciliation with it.

1. **Syntax toolkit.** The same `web-tree-sitter` runtime with the `tree-sitter-go.wasm` published in `tree-sitter-go@0.25.0`, copied with its SHA-256. No `go` toolchain, `go/types` or `gopls` runs at scan time; an operator-supplied toolchain is not used either.
2. **Types without a type checker.** Go's explicit imports and declarations stand in for types: a client is proven by its constructor (`stripe.NewClient`, `client.New`, `openai.NewClient`, `anthropic.NewClient`), a declared type (`*openai.Client`, `*client.API`), a struct field or parameter of that type, or a package-level resource call (`paymentintent.New`). Anything else is not traced.
3. **Versions from `go.mod` and `go.sum`.** The module path's major (`github.com/stripe/stripe-go/v84`) and the required version are read from `go.mod`; `go.sum` confirms the version. stripe-go pins one Stripe API version per release, so `data/go-sdks.json` (generated by `scripts/go-sdks.mjs` from each release's `api_version.go` and the SDKs' model constants, never installed) maps the version to the API version Refit reports.
4. **Call record.** Each traced call is an `SdkCallRecord` (`language: 'go'`): Stripe calls carry no model, OpenAI and Anthropic calls carry the `Model` field of their params struct, followed through SDK constants (`openai.ChatModelGPT4o` → `gpt-4o`), conversions, package constants and `os.Getenv` fallbacks.
5. **Edits.** None. Go is detection and reporting only, like Python.

## Java and Kotlin

**Status today.** Not started (source: docs/PRD.md, section 22 lists `JavaAnalyzer` as future).

**Why it matters.** Official SDKs: `com.stripe:stripe-java`, `com.openai:openai-java`, Anthropic's Java SDK: unverified: check coordinates. Enterprise codebases that pay for API maintenance are often Java, but few are public, so a frozen set may be small; record the eligible count.

**SDK patterns to trace.** `Stripe.apiKey = ...` then `PaymentIntent.create(params)` with `PaymentIntentCreateParams.builder()...build()`, or `new StripeClient(key).paymentIntents().create(params)`: unverified: check. Builders mean request parameters are method chains, not literals. Kotlin uses the same libraries with different syntax, so it is a second grammar on the same rules.

**What is hard.** Two grammars. Builds are slow and download heavy; offline validation needs a primed Maven or Gradle cache, and a 2 GiB workspace may not hold it (the 4 GiB profile exists; see AGENTS.md). Type resolution needs the JDK (JavaParser with symbol solving) or a tree-sitter approximation from imports and declared types, which is usually enough because Java declares every type.

**Definition of done.** Same table on 50 repositories declaring `stripe-java` in `pom.xml` or `build.gradle(.kts)`, checks `mvn -o test` or `gradle --offline test`, precision target 100% on confirmed reads.

**Milestones.** 1. Source filter and `pom.xml`/Gradle model (lockfile semantics differ; Gradle lockfiles are optional: an owner decision on what counts as pinned). 2. Tracer from imports and declared types. 3. Tracing benchmark; gate. 4. Deadline matcher. 5. Rules plus Java and Kotlin edits; builder-chain request rules. 6. Preparation with a primed cache and a JDK image. 7. Validated fixes.

**Blockers and owner decisions.** Workspace and memory profile for JVM builds. Whether Gradle projects without lockfiles are in scope. Kotlin in the same goal or later.

**Effort: L.**

## Ruby

**Status today.** Not started; not named in the PRD.

**Why it matters.** Stripe's and Shopify's Ruby SDKs (`stripe` gem, `shopify_api` gem) are official and Rails apps are a large Stripe population: unverified: check gem names. OpenAI's official Ruby SDK: unverified: check whether it exists and its name.

**SDK patterns to trace.** `Stripe.api_key = ...`, `Stripe.api_version = '...'`, `Stripe::PaymentIntent.create(amount: ...)`, or `client = Stripe::StripeClient.new(key)`; Shopify's `ShopifyAPI::Context.setup(api_version: '2026-01', ...)` and `ShopifyAPI::Clients::Graphql::Admin.new(session:).query(query:)`: unverified: check. Keyword-argument hashes carry request bodies.

**What is hard.** Fully dynamic; no declared types outside Sorbet or RBS, which are rare. Metaprogramming (`send`, `method_missing`, concerns) hides calls. Pins are global settings or Rails initializers. Offline validation needs a primed `vendor/cache` (`bundle package`) and a Ruby image; Rails test suites need databases, so `tsc`-style cheap checks do not exist and many repositories will have no runnable check.

**Definition of done.** Same table on 50 Rails or Ruby repositories with `stripe` in `Gemfile.lock`. Precision depends on decision 3; until it is made, Ruby is detection-and-review only, and the target is recall of labelled breaking reads ≥ 90% with every finding reported as review.

**Milestones.** 1. Source filter and `Gemfile`/`Gemfile.lock` model. 2. Tracer for constant-style (`Stripe::X.create`) and client-style calls. 3. Tracing benchmark; gate. 4. Deadline matcher (Shopify `api_version` strings, OpenAI model IDs). 5. Rules only if decision 3 allows typed-free edits; otherwise review reports with exact lines. 6. Preparation and a `ruby` image with `rspec`/`minitest`. 7. Validated fixes where checks exist.

**Blockers and owner decisions.** Decision 3. Whether review-only is worth shipping for Ruby. Rails test dependencies (databases) are outside the offline sandbox.

**Effort: L.**

## PHP

**Status today.** Not started; not named in the PRD.

**Why it matters.** `stripe/stripe-php` is official and the WordPress, Laravel and WooCommerce ecosystems carry many Stripe integrations: unverified: check. Shopify PHP SDK status and an official OpenAI PHP SDK: unverified: check (the common `openai-php/client` is community).

**SDK patterns to trace.** `$stripe = new \Stripe\StripeClient($key)` then `$stripe->paymentIntents->create([...])`, or static `\Stripe\PaymentIntent::create([...])` after `\Stripe\Stripe::setApiKey(...)`; the pin is `\Stripe\Stripe::setApiVersion('...')` or a client option: unverified: check. Request bodies are associative arrays.

**What is hard.** Dynamic, with partial type declarations; framework containers (Laravel service providers) create clients. Mixed HTML and PHP files. Offline validation needs a primed Composer cache and a `php` image with `phpunit`; WordPress plugins rarely have tests, so generated checks matter more than elsewhere.

**Definition of done.** Same table on 50 repositories with `stripe/stripe-php` in `composer.lock`. Precision tied to decision 3, as for Ruby.

**Milestones.** 1. Source filter and `composer.json`/`composer.lock` model. 2. Tracer for client and static styles. 3. Tracing benchmark; gate. 4. Deadline matcher. 5. Rules or review-only per decision 3. 6. Preparation and image. 7. Validated fixes.

**Blockers and owner decisions.** Decision 3. Whether WordPress plugins without `composer.lock` are in scope.

**Effort: L.**

## C# and .NET

**Status today.** Not started; not named in the PRD.

**Why it matters.** `Stripe.net` is official; OpenAI's official .NET SDK and Anthropic's .NET status: unverified: check. Statically typed like Go and Java, so precision can be high, but public .NET Stripe repositories are fewer: record the eligible count.

**SDK patterns to trace.** `StripeConfiguration.ApiKey = ...`, `new PaymentIntentService().Create(options)` with `PaymentIntentCreateOptions { ... }` object initializers; newer `new StripeClient(key)` passed to services: unverified: check. The pin is the NuGet package version plus `StripeConfiguration.ApiVersion` if settable: unverified: check.

**What is hard.** Type resolution needs Roslyn (the .NET SDK); tree-sitter plus declared types is the fallback. Offline validation needs a primed NuGet cache and `dotnet test` in a .NET SDK image, which is large.

**Definition of done.** Same table on up to 50 repositories with `Stripe.net` in a `.csproj` or `packages.lock.json`, precision 100% on confirmed reads.

**Milestones.** 1. Source filter and project-file model (lockfiles are opt-in in NuGet: owner decision on unpinned projects). 2. Tracer. 3. Benchmark; gate. 4. Deadline matcher. 5. Rules with object-initializer request edits. 6. Preparation and image. 7. Validated fixes.

**Blockers and owner decisions.** Image size against the sandbox profiles. Unpinned projects.

**Effort: L.**

---

## Priority order

| # | Language | Reason |
|---|---|---|
| 1 | Python | Every AI provider's main SDK; the OpenAI shutdown and Anthropic goal apply directly; the deadline registry already has the models |
| 2 | Go | Static types make tracing and precision cheap; official SDKs for Stripe, OpenAI and Anthropic; Refit already runs a Go binary (`oasdiff`) |
| 3 | Java and Kotlin | Static types; the enterprise population that pays for maintenance; heavy builds are the cost |
| 4 | Ruby | Large Stripe and Shopify population, but dynamic; depends on decision 3 |
| 5 | PHP | Large Stripe population, but dynamic and often untested; depends on decision 3 |
| 6 | C# and .NET | Static and clean, but the smallest public population and the largest validation image |

Python goes first even though it is the hardest of the typed-or-not choices, because it is where the provider goals already point: OpenAI, Anthropic and Gemini users are mostly Python. Go second proves the shared design on a typed language cheaply. Counts of how common each SDK is in public repositories are not measured anywhere in this repository; confirm with a code search before freezing a set.

## Shared work

1. **The three design decisions** (syntax toolkit, neutral call record, edits without types), recorded in ARCHITECTURE.md before the first tracer is written.
2. **Splitting each rule into decision and edit.** Start with the Stripe basil rules that produced the 74 validated fixes (source: docs/READINESS.md, 2026-10-16); each becomes a neutral decision plus one editor per language.
3. **Manifest and lockfile models per ecosystem**, feeding the catalog, the pin reader and preparation from one parser.
4. **Preparation recipes per package manager** (wheels, module cache, Maven cache, gem cache, Composer cache, NuGet cache), each cached by lockfile hash like npm today, each an owner decision because it changes what the online container may fetch.
5. **Validation images per language**, each an existing local image the operator chose, never pulled by Refit.
6. **Deadline matcher per language**, reusing the registry and the live/non-live classes from [DEADLINES.md](DEADLINES.md#live-and-non-live-evidence).
7. **The AI patch guard** rescans with the language's tracer, so a model edit outside confirmed sites is rejected in every language, as it is today in TypeScript.
8. **A tracing benchmark harness** that is language-neutral (`pipeline/sdk-coverage.ts` today), so every language's gate is measured the same way.
