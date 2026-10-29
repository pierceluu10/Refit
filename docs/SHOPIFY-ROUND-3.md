# Shopify round 3: REST and GraphQL blockers

Written 2026-10-29. The base is `bench/iter1-shopify-meta`, with #424 (proof gate), #425 (AI) and #427 (REST contract) merged.

## Diagnosis

The data is 310 practice rows from refit-bench runs on dev-60 (40950547981), practice-50 (40950561596) and fresh-200 (40953254697), at #427's head. No blind repo was opened.

- **Outcomes:**

  | Outcome                  | Rows |
  | ------------------------ | ---: |
  | Stopped before any patch |  220 |
  | Patched                  |   54 |
  | Validated                |   10 |
  | Needs review             |   31 |

  The first stop, not proof, is what decides the score.

- **First stop per stopped row:**

  | Blocker                    |                           Rows | What it really is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
  | -------------------------- | -----------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | SDK / `LATEST_API_VERSION` |                       about 93 | Mostly `@shopify/shopify-api` 11.x (Remix template). `ApiVersion.October26` needs SDK 14+. The SDK upgrade stops on documented breaks: `customShopDomains` → `domainTransformations`, billing future flags, `apiVersion` required, and the React Router template being embedded-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
  | GraphQL "already fails"    |                             33 | These are not bad documents. The repos pin retired versions (2024-04, 2025-01), so Shopify already serves them the oldest supported version (2026-01), and the app is **broken in production today**. The errors are documented migrations: `productVariantUpdate`/`ProductVariantInput` → bulk variant mutations (17); `Shop.privacyPolicy`/`refundPolicy`/`shippingPolicy`/`termsOfService` → `shopPolicies` (7); `Order.financialStatus`/`fulfillmentStatus` → `displayFinancialStatus`/`displayFulfillmentStatus` (4); `Customer.ordersCount` → `numberOfOrders` (4); `ProductVariant.weight`/`weightUnit`/`inventoryManagement`/`requiresShipping` → `inventoryItem` (3); `AppPlanV2` fragment spreads (4); unused variables. Refit refuses exactly the repos that need it most. |
  | GraphQL unreadable         | 26 rows (65 calls in 30 repos) | The document is passed into a helper (`adminQuery(query, vars)`, CLI wrappers) or built in another file. AI reconstruction didn't run on fresh-200 (no credit).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
  | REST, after the contract   |                       about 21 | REST records built and saved, a client also used outside traced calls, wrapped clients, non-literal paths, unknown methods, and responses flowing into code Refit can't follow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

- **Stops are layered.** Clearing REST alone (#427, 13 rows) exposed the SDK and "already fails" stops behind it. So every agent measures **validated end to end** and follows each target row through every gate.

## Work

| Agent                            | Target                                                                                                                                                                                                                                                     | Owns                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| SH11: retired-version migrations | The 33 "already fails" rows. The fall-forward break becomes the fix target: documented migrations as rules with quotes, AI for the rest, proof by graphql-js on the target plus checks.                                                                    | `data/shopify*` migration rules, the GraphQL document fixer |
| SH12: SDK upgrade path           | The ~93 `LATEST_API_VERSION` and SDK rows. Codemods for each documented `@shopify/shopify-api` 11→14+ and app-template break, honouring lockfiles. Also check whether an explicit dated `apiVersion` string is a sound, smaller fix for GraphQL-only apps. | `pipeline/shopify-sdk-upgrade.ts` and its codemods          |
| SH13: GraphQL document tracing   | The 30 repos with unreadable documents. Interprocedural tracing: query parameters resolved from every call site, imports, re-exports, template concatenation. AI reconstruction is the fallback.                                                           | `pipeline/shopify-tracing.ts`, document collection          |
| SH14: REST residue               | The ~21 remaining REST stops. Wrapped clients, saved resource records, non-literal paths and method inference, all proven against `data/shopify-rest-contract.json`. GraphQL or AI rewrite only where the contract can't prove the call.                   | `pipeline/shopify-rest-*.ts`                                |

## Rules for every agent

- Measure on dev-60 and the 250 practice repos only. Never open `subsets/shopify-blind-100.json`.
- Report validated before and after for the same rows. Hand-check every newly validated row in `docs/benchmarks/fix-reviews.json`; a single wrong fix blocks the work.
- AI runs need OpenAI credit. It ran out on 2026-10-29 (HTTP 429 `credit_balance_exhausted`). Build the AI paths, but measure them only after a top-up.
- Refit-bench `shopify.yml` (branch `shopify-ai`): `size=1`, an explicit `count`, `--sdk-upgrade`, and `ai_budget` of 300 or more (it is split per shard).
- When all four land, merge them into `bench/iter1-shopify-meta` and rerun blind-100 once.
