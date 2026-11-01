# GUT4: Shopify judges

Written 2026-10-31. Branch `gut/shopify-judges`, a draft PR into `refit/gut`.

## API for GUT2

```ts
import { shopifyJudge, shopifyLiveJudge } from './shopify-judge.ts';

check: (repoDir) => shopifyJudge(repoDir, target, { ai, environment: process.env });
// → { passed, errors, unjudged, extracted, sdk, live, costUsd }
```

- `errors` are `file:line: reason` strings, ready to feed back to the agent: the schema error, the REST contract reason, or the version and the release the judge read it from.
- `unjudged` is the subset of `errors` that means "Refit cannot tell", not "this fails". It still fails `passed`.
- `extracted` lists the requests the AI read from code Refit could not read statically. Errors on them say "AI read from lines …". Keep those apart when grading proof levels.
- `ai` is optional. Without it, unreadable calls are `unjudged`. With `REFIT_AI_PROVIDER=anthropic`, `assessmentConfiguration(true, process.env)` builds it.
- The live judge runs only when `environment` has `SHOPIFY_TEST_STORE` and its credentials. Store-side failures are `not-run`, as in #435.
- Other new exports, all additive:
  - `installedShopifyApi(root)` (`shopify-analysis.ts`);
  - `aiExtractShopifyRequests` and `extractionProblem` (`shopify-ai-rewrite.ts`);
  - `checkDocument` (`shopify-proof.ts`);
  - `RestEntryProof.untraced` (`shopify-rest-contract.ts`).

  `liveShopifyProof` sends each operation once when `before` equals `after`. `ShopifyScan` is unchanged.

## Measurement

These are Claude's migrated copies of the 5 manual-test dev repos, judged alone with no fixing, at Admin API 2026-10.

- The before column is the old checker's verdict on the same copies: refit-iter1's Shopify benchmark after round 3.
- The AI extraction ran through the `claude` CLI (`claude-sonnet-5-5`, no tools) with the same instructions, schema and acceptance check. No Anthropic API key was in this session's environment. Cost: $0.029.
- No development store was configured, so the live judge did not run.

| Repository                                    | Old checker                                         | Judge now  | Why                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hasan-araav/shopify-order-sync                | passed                                              | **passed** |                                                                                                                                                                                                                                                                                                                                                            |
| matheuscpatricio/omafit                       | passed                                              | **passed** |                                                                                                                                                                                                                                                                                                                                                            |
| ksyp-7/shopify-theme-app-extension-vite-react | can't judge (`LATEST_API_VERSION` is not a literal) | **failed** | `.graphqlrc.js:9`: the installed `@shopify/shopify-api` 14.0.1 does not export `LATEST_API_VERSION`, so the codegen `apiVersion` reads undefined.                                                                                                                                                                                                          |
| mdrahbar21/shopifyApp                         | can't judge (REST URL constant computes its URL)    | **failed** | `orderByPhone.js:35`: `GET orders.json` sends `customer_id`, which the 2026-10 contract does not list, so Shopify ignores the filter and returns every order. The computed URL at `:21` was extracted by AI as `GET customers/search.json`. It is otherwise valid, but one read goes inside `default_address`, which the contract types only as an object. |
| umxr/shopify-product-reviews                  | can't judge (document not readable)                 | **failed** | `app/shopify.server.ts:15` and `:43` and `.graphqlrc.ts:9` and `:15` still pin `ApiVersion.January24` (2024-01), on the locked SDK 9.0.1. The current tracer reads all 7 of its documents, and they validate on 2026-10.                                                                                                                                   |

Before: 2 passed, 3 can't judge. Now: 2 passed, 3 failed, and every repo has a real verdict.

Read the three failures as the judge working, not as regressions:

- In ksyp, Claude upgraded the SDK and left a dead import in the codegen config.
- In mdrahbar, there is a real REST bug.
- In umxr, Claude did not upgrade at all.

## Not done

- AI case writing for live mutations (`writeShopifyLiveCases`) is not wired into the judge. Mutations without `options.cases` are `not-run`.
- An AI-extracted REST read always counts as a field read, never as use of the whole record.
- No refit-bench run and no development-store run were made.
