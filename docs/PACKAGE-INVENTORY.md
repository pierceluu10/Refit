# Package inventory across ecosystems

Refit lists the SDKs a repository depends on from its manifests and lockfiles. It reads npm through the existing `readRepository`, and seven more ecosystems through `readPackageManifests` (`pipeline/package-manifests.ts`). `detectProviders` maps those dependencies to catalog providers, so `refit agents`, and the hosted inventory built from `detectProviders`, report Stripe, OpenAI, Anthropic, Twilio and the other catalog providers in Python, Go, Ruby, PHP, Java/Kotlin, .NET and Rust repositories. Nothing is installed, resolved against a registry or executed.

## What is read

| Ecosystem | Manifests | Lockfiles and pins | Name rule |
|---|---|---|---|
| Python (`pypi`) | `requirements*.txt` / `.in` with `-r` includes, `pyproject.toml` (PEP 621, dependency groups, Poetry), `Pipfile` | `uv.lock`, `poetry.lock`, `Pipfile.lock` | PEP 503 normalised |
| Go (`go`) | `go.mod` (`// indirect` kept, not a detection) | `go.sum` confirms go.mod's version | module path; catalog names match any `/vN` suffix |
| Ruby (`rubygems`) | `Gemfile`, `*.gemspec` | `Gemfile.lock` | as written |
| PHP (`packagist`) | `composer.json` (`require`, `require-dev`; platform packages skipped) | `composer.lock` | lower-cased |
| Java/Kotlin (`maven`) | `pom.xml` (literal versions and same-POM properties), `build.gradle(.kts)` literal coordinates, `gradle/libs.versions.toml` | none | `group:artifact` |
| .NET (`nuget`) | `*.csproj` / `.fsproj` / `.vbproj` `PackageReference`, `$(Name)` from the project and the nearest `Directory.Build.props` | `Directory.Packages.props` (declared version), `packages.lock.json` | case-insensitive |
| Rust (`cargo`) | `Cargo.toml` (renames, `[workspace.dependencies]`, target tables) | `Cargo.lock` | as written |

Each dependency carries `ecosystem`, `name`, `declared` (as written, or null), `locked` (from the nearest lockfile in the manifest's directory or an ancestor), `file`, `line` and `direct`. Directories with installed or generated packages are skipped: `node_modules`, `vendor`, `.venv`, `venv`, `site-packages`, `target`, `bin`, `obj`, `.gradle`, `Pods` and similar.

Anything Refit cannot read literally becomes a named stop rather than an error: `unparseable-toml`, `unparseable-json`, `unparseable-xml`, `unparseable-manifest`, `version-not-literal` (for example a Gradle `$var`, an MSBuild property the nearest props file does not define, or a parent-POM property), `include-missing`, `include-outside-repository` (including a `-r` include whose real path, after symlinks, leaves the repository), `manifest-too-large` (over 4 MiB) and `scan-limit` (the walk stopped after 50,000 directory entries). Every line of a requirements file counts as direct, because the format does not say which lines a person chose; a `pip freeze` file therefore over-reports direct dependencies rather than missing any. Parent POMs, Gradle scripts, `setup.py` and MSBuild imports are not evaluated.

**End of support.** Registry `kind: "sdk"` entries can name an `ecosystem`. `scanDeadlines` then reports every direct declaration of that package as dependency evidence, with test paths marked `test`, so `refit deadlines` and the hosted inventory show it. The registry has two such entries, both read from the package's own README on 2026-10-22: `google-generativeai` on PyPI and `github.com/google/generative-ai-go`, whose support ended on 2025-11-30.

## Catalog names

Each catalog provider lists its package names per registry in `ecosystems`; `packages` stays npm only. All 74 names were checked against their registry on 2026-10-22 by `scripts/catalog-registry-check.mjs`. Every one returned 200 and links the source repository recorded in [`2026-10-22-catalog-registry-check.json`](benchmarks/2026-10-22-catalog-registry-check.json), which is how each was confirmed to belong to its provider. Official SDKs come first. Widely used community clients are listed where they are the usual way to call the API (`ruby-openai`, `sashabaranov/go-openai`, `openai-php/client`, `async-openai`, `async-stripe`, `Anthropic.SDK`, `Google_GenerativeAI`, `gemini-ai`, `ShopifySharp`, `go-shopify`).

## Benchmark (2026-10-22)

**Sample.** [`2026-10-22-package-inventory-repos.json`](benchmarks/2026-10-22-package-inventory-repos.json) holds 100 repositories pinned at shallow-clone commits: 15 each for Python, Go, Ruby, PHP, .NET and Rust, and 10 for Java/Kotlin. They were selected by `scripts/package-inventory-select.mjs`. GitHub search was not reachable from the session that built it, so candidates come from public reverse-dependency listings of catalog SDKs (pkg.go.dev "Imported by", rubygems.org `reverse_dependencies`, packagist.org dependents by downloads, crates.io `reverse_dependencies`, and nuget.org's "GitHub Usage"). Python and Java/Kotlin come from gitlab.com project search with a language filter and provider keywords. Every query, every rejection (8 SDK vendor repositories, 13 failed clones) and the order rule are in the frozen file.

What that means for the numbers:

- The Go, Ruby, PHP and Rust repositories are mostly libraries and tools that declare a catalog SDK.
- The .NET ones are large applications.
- The GitLab Python and Java sets match on names and descriptions, so most of those repositories use no catalog SDK at all.

**Labels.** 35 repositories (5 per ecosystem, seed 20261022) were labelled blind from their dependency-declaring files, using `scripts/package-inventory-label-candidates.mjs`, which imports no pipeline code. The labels were committed (`e6877cc`) before Refit ran on them: [labels](benchmarks/2026-10-22-package-inventory-labels.json). A unit is one provider declared directly in one file. The labelling rules (what counts as a provider package, adapters that do not) are recorded in the labels file. `pipeline/package-manifests-score.ts` scores them, and its own test covers the scorer.

| Run | Refit commit | Units | Precision | Recall | Provider-level recall |
|---|---|---:|---:|---:|---:|
| First run, labelled set | `e6877cc` | 47 | 100% (36/36) | 76.6% (36/47) | 74.3% (26/35) |
| After fixes, labelled set (fixes informed by these labels) | `7975aff` | 47 | 100% (47/47) | 100% (47/47) | 100% (35/35) |
| After fixes, **held-out set** (14 repositories, seed 20261023, labelled after the fixes) | `7975aff` | 17 | **100% (16/16)** | **94.1% (16/17)** | 100% (14/14) |

The held-out row is the honest estimate. The labelled-set "after" row measures the same labels the fixes were built from.

**What the first run missed (11 units), and the fix for each:**

- 7 dependencies declared only in `*.gemspec` files. Fix: literal `add_dependency`, `add_runtime_dependency` and `add_development_dependency` are now read.
- 4 catalog name gaps. Fix: added Stripe's Android and Terminal artifacts, Twilio's `Twilio.AspNet.*` helpers, `Google_GenerativeAI`, and the pre-move module path `github.com/resendlabs/resend-go`, each checked on its registry.

The first run also surfaced two parser problems, now fixed:

- 174 `version-not-literal` stops were MSBuild `$(Name)` versions that the project itself or its nearest `Directory.Build.props` defines (171 of them in bitwarden/server).
- One `unparseable-toml` stop was a multi-line inline table, which TOML 1.1 and Cargo accept.

**Held-out miss.** `com.twilio:video-android` (Twilio Video for Android) is not in the catalog. It is recorded here and not tuned on.

**Whole sample at `7975aff`** ([results](benchmarks/2026-10-22-package-inventory-results-after.json); first run [here](benchmarks/2026-10-22-package-inventory-results-before.json)):

| Sampled for | Repositories | With a manifest of that ecosystem | With a catalog provider in that ecosystem | With a stop |
|---|---:|---:|---:|---:|
| Python | 15 | 9 | 3 | 1 |
| Go | 15 | 14 | 14 | 0 |
| Ruby | 15 | 15 | 15 | 0 |
| PHP | 15 | 15 | 15 | 0 |
| Java/Kotlin | 10 | 10 | 3 | 4 |
| .NET | 15 | 15 | 14 | 2 |
| Rust | 15 | 15 | 15 | 0 |

There are 98 stops left. 97 are `version-not-literal`: 81 MSBuild properties defined outside the nearest props file or imported, and 16 Gradle variables. The last one is a test-fixture `pom.xml` with no `<project>` element.

- **Scan error.** `detectProviders` refused microsoft/aspire with "Repository exceeds scan limits": the JS/TS source read behind it caps a repository at 10,000 files. In that case the benchmark records the non-npm evidence separately, but the product path returns the error.
- **End of support.** None of the 100 repositories declares `google-generativeai` or `generative-ai-go`, so the sample shows no end-of-support exposure.
- **Not measured.** Python and Java/Kotlin have few labelled positives (0 and 2 units in the first set, 1 and 1 in the held-out set), so their recall rests on very few cases. Lockfile version accuracy (`locked`) is not separately labelled; the parser tests check it against real lockfiles.

## Reproduce

```sh
node scripts/catalog-registry-check.mjs --output docs/benchmarks/<date>-catalog-registry-check.json
node scripts/package-inventory-select.mjs --output <frozen.json> --work <clones>   # listings move; the frozen file is the record
node scripts/package-inventory-label-candidates.mjs --list docs/benchmarks/2026-10-22-package-inventory-repos.json --root <clones> --per-ecosystem 5 --seed 20261022
node scripts/package-inventory-benchmark.mjs --list docs/benchmarks/2026-10-22-package-inventory-repos.json --root <clones> \
  --output <results.json> --labels docs/benchmarks/2026-10-22-package-inventory-labels.json
```

The benchmark expects each repository cloned at its frozen commit under `<clones>/<host>/<path>`. It refuses a checkout at any other commit and records whether `pipeline/` was dirty. Both runs above came from clean commits.
