# SDK call coverage on real repositories

Before Refit can migrate anything, its scanner must **trace** a call: it must recognize that `x.chat.completions.create(...)` is an OpenAI SDK call on a known client. Untraced calls are invisible to Refit; they are never reported, patched or validated. This benchmark measures how much real-world code Refit can see.

## Method

- **Repositories:** 45 public GitHub repositories found by code search for imports of `openai`, `@anthropic-ai/sdk` and `stripe` (TypeScript and JavaScript, ES modules and `require`). The 15 most-starred per SDK were chosen among those that are not forks or archived, are under 50 MB and were pushed since June 2024. Each was shallow-cloned at the commit in [`benchmarks/2026-10-14-sdk-repos.json`](benchmarks/2026-10-14-sdk-repos.json). Nothing was installed or executed.
- **Candidate call sites:** every call shaped like `<receiver>.<sdk resource>…<method>(…)`, where the resource is a known top-level SDK resource (for example `chat`, `messages`, `customers`). Common array and collection methods are excluded. A candidate counts as **likely SDK** if its file imports the SDK or its receiver's name suggests a client (`openai`, `stripe`, `client`, …). The 114 others, such as `db.customers.create`, are excluded.
- **Traced:** the same position appears in `analyzeRepository().sdkCalls` from Refit's real scanner, with the provider's adapter.
- **Why missed:** each untraced call is classified by how its receiver was obtained, using the TypeScript checker within the file.

Run it with `npm run benchmark:coverage -- --repos <dir> --list <pinned.json> --output <new-dir>`. The tool is `pipeline/sdk-coverage.ts`, with a classifier test in `pipeline/sdk-coverage.test.ts`.

## Baseline results (October 14, 2026, before 0.13)

The full report, including per-repository rows and examples of each miss, is in [`benchmarks/2026-10-14-sdk-coverage.md`](benchmarks/2026-10-14-sdk-coverage.md).

| | OpenAI | Anthropic | Stripe | All |
|---|---|---|---|---|
| Likely SDK call sites | 187 | 61 | 104 | **352** |
| Traced by Refit | 38 (20%) | 28 (46%) | 16 (15%) | **82 (23%)** |

- **One repository (`i-am-alice/3rd-devs`) holds 103 class-field misses.** Without it, coverage is **32%**.
- Of the **40** repositories with likely SDK calls, Refit traces **none** of their calls in **22**, and all of them in only **9**. The **median repository coverage is 0%**.
- **One repository could not be scanned at all.** A single file that fails to parse (`auth.ts: ',' expected`) aborts the whole analysis.

### Why calls are missed

Ranked by how many repositories each pattern affects, since one repository can repeat a pattern many times:

| Pattern | Example | Repos | Calls |
|---|---|---|---|
| **Path-alias import** of a shared client | `import stripeClient from '@/lib/stripe'`, `import { stripe } from '~/stripe'` | **10** | 35 |
| **Class field** | `this.openai.chat.completions.create(…)` | **7** | 160 |
| **Factory function result** | `const client = getClient(); client.messages.create(…)` | **7** | 25 |
| **Function parameter / injected client** | `function run(openai) { openai.models.list() }`, `({ openai }) => …` | **6** | 22 |
| **Object property** | `deps.client.chat.completions.create(…)` | 5 | 10 |
| **Client created inside a function**, SDK subpath import, or a `Proxy` wrapper | `const client = new Anthropic()` inside a handler; `from '@anthropic-ai/sdk/index'` | 5 | 9 |
| **Inline factory call** | `getAnthropic().messages.create(…)` | 2 | 5 |
| Destructured or other variables | | 2 | 4 |

The shared-client patterns, path aliases and factories, are the norm in Next.js and Node services. That baseline predates 0.13. Refit now follows supported default-exported and CommonJS clients, including documented Stripe callable initialization. The table above retains the original measurement; it must not be read as a post-change result. See [current client forms](CLIENT-MODULES.md).

## Configured-alias rerun (October 14, 2026)

The same 45 pinned commits were fetched again and measured before (`19fed87`, Refit 0.14.0) and after configured aliases. Only repository source and local configuration were read; no application dependencies or scripts were installed or executed. The before run reproduces the original 82/352 traced-call count. The [new report](benchmarks/2026-10-14-source-alias-coverage.md) retains per-repository rows and miss examples.

| Provider | Before | After |
|---|---|---|
| OpenAI | 38 / 187 (20%) | 38 / 187 (20%) |
| Anthropic | 28 / 61 (46%) | 27 / 61 (44%) |
| Stripe | 16 / 104 (15%) | 43 / 104 (41%) |
| All | 82 / 352 (23%) | 108 / 352 (31%) |
| Repositories with likely calls and zero traced | 22 / 40 | 18 / 40 |

Configured aliases add **34 traced Stripe calls across nine repositories**. Eight previously traced calls (seven Stripe, one Anthropic) are now declined in two projects whose standard configuration delegates to unresolved project references. This is an explicit conservative boundary, not a claim those calls are non-SDK usages. One path-alias miss remains; other missing calls mostly involve class fields, factories, injected clients or unresolved project selection. The original parse-error repository still cannot be scanned.

These counts measure call tracing, not confirmed breaking reads, recall/precision against ground truth, successful migrations or validated PRs. The [100-repository Stripe migration benchmark](STRIPE-BENCHMARK.md) has not been rerun for this slice. See [supported alias resolution](SOURCE-ALIASES.md).

## Class-client rerun (0.19)

The same 45 clean pinned repository commits were read with main 0.18 and the class-client implementation. Their candidate count is 354, rather than the older reports' 352. Structural call tracing improves from **110/354 (31%) to 249/354 (70%)**: OpenAI 38→172, Anthropic 27→32 and Stripe unchanged at 45/106. Of the 41 repositories with candidates, zero-traced repositories decrease from 18 to 15. One repository contributes 103 of the 139 newly traced calls. Both runs complete all 45 scans.

These counts include class clients that remain review-only when their stability is uncertain. They do not establish migration success or ground-truth recall/precision. No public application was installed or executed. See [the measured comparison and complete after report](benchmarks/2026-10-14-class-client-coverage.md) and [class-client boundaries](CLASS-CLIENTS.md).

## Limits of this benchmark

The separate [webhook field scan](benchmarks/2026-10-14-stripe-webhook-coverage.md) found no traced historical subscription-period or Invoice.subscription webhook reads in the 15 pinned Stripe repositories, with one parse refusal. It exposed and removed three same-name Checkout Session review matches; those were not affected Invoice reads. This is not a change to the call-tracing table above or a migration-success measurement.

- Candidates are found by shape, so a few non-SDK calls slip in. For example, one Mistral client's `client.chat.complete` was counted under OpenAI. Excluded candidates may also hide some real SDK calls.
- Miss reasons come from a per-file heuristic. They explain where the receiver came from, not whether Refit could safely trace it.
- It measures **call tracing** only. Field-read tracing on traced responses, and migration success, are measured separately by the [AI evaluations](AI-EVALS.md).
- 45 repositories is a sample, skewed toward AI side projects and SaaS starters.

## Recommended scanner work, in order

1. **Resolve remaining project configurations:** recorded local `paths`/`baseUrl` aliases now work. Project references and package-based inherited configuration remain unresolved; preserve review evidence until those mappings can be established.
2. **Extend conservative class tracing where evidence supports it:** ordinary constructor/field clients now work. Lazy getters, injected fields and unsafe receiver lifetimes remain gaps.
3. **Trace simple factories:** functions returning `new SDK(...)` or a module-level client, including memoized getters. Affects 7 repositories, plus 2 with inline factory calls.
4. **Keep skipped-source review evidence:** unparseable files no longer fail the whole scan, but their unknown usages block automation.
5. Then injected clients (parameters and object properties), clients created inside functions, and SDK subpath imports.

Rerun this benchmark after each change. Coverage and the zero-traced repository count are the measures of progress.
