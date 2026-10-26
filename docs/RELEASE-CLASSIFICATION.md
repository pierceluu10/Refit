# AI release classification

`refit classify-release` asks OpenAI to classify each breaking change of a Stripe release, and scores the answer against the hand catalog in [`benchmarks/stripe-changelog/catalog/`](benchmarks/stripe-changelog/catalog/) (79 pages, 125 change statements over `2025-03-31.basil`, `2025-09-30.clover`, `2026-03-25.dahlia` and `2026-09-30.endive`). It is a measurement, not part of `refit run`: nothing it predicts edits code or feeds a rule pack.

```sh
refit classify-release --release 2026-09-30.endive [--release ...] --output <new-directory> --env .env
```

## What it sends and returns

- **Input, per changelog page:** the page's Markdown as saved in [`benchmarks/stripe-changelog/pages/`](benchmarks/stripe-changelog/pages/) (captured by `node scripts/stripe-changelog-pages.mjs`, URL and SHA-256 kept), without the Ruby, Python, PHP, Java, Go and .NET tabs, which repeat the REST tables and pushed one page past the 64 KiB input limit. With it go the catalog entry's `changed` statements, numbered. The catalog's `handling`, `how`, `reason`, `parts` and `fullDiffOnly` are never sent; a test checks the recorded prompts for that.
- **Output, strict JSON checked by code:** the page's category (`api` or `stripejs`) and, per statement, a handling (`none`, `stop`, `ai`, `generic`, `rule`, as the catalog defines them), a rule-pack family (`moved-value`, `moved-id`, `period-helper`, `request-rename`, `request-wrap`, `read-review` or `none`), the affected `object.property` and `METHOD /v1/path` identifiers (at most 20) and a short rationale. An output that does not match, or a refused request, is recorded as the page's error and scored as wrong; nothing is retried or guessed.
- **Audit:** `audit.json` holds the instructions and, per page, the exact evidence, the raw model output, the response id, the model and the cost. `results.json` holds the predictions and the score.
- **Budget:** one request per page through the shared OpenAI client and spending ledger (`REFIT_AI_BUDGET_USD`, default $1), with the same token counting and reservation as AI patches.

## How it is scored

- **Units.** One row per catalog change statement; its expected handling is the handling of the catalog part that contains it. A page's handling is its weakest statement's, in the catalog's order `none` < `stop` < `ai` < `generic` < `rule`.
- **Families.** The catalog implies a family for 26 statements: each `rule` part by the function its `how` names (`release-classification-score.ts`), and `read-review` for each `ai` part (a removed read kept for review). The invoice preview move changes the called method, which no family covers, so it expects `none`.
- **Dangerous error:** the model predicts `rule` or `ai` (a code edit) where the catalog says `stop` or `none`.

## Measured accuracy (refit-bench run 40283655210, `gpt-6.1-sol`, $0.56)

Results: [`benchmarks/2026-10-26-release-classification-results.json`](benchmarks/2026-10-26-release-classification-results.json); prompts and outputs: [`benchmarks/2026-10-26-release-classification-audit.json`](benchmarks/2026-10-26-release-classification-audit.json); run details in [Benchmarks](BENCHMARKS.md#ai-release-classification-against-the-stripe-catalog-october-26).

| Release | Statements | Handling correct | Dangerous | Pages | Category correct | Page handling correct |
| ------- | ---------- | ---------------- | --------- | ----- | ---------------- | --------------------- |
| basil   | 54         | 39               | 5         | 22    | 22               | 15                    |
| clover  | 23         | 20               | 1         | 18    | 18               | 15                    |
| dahlia  | 13         | 11               | 0         | 11    | 11               | 9                     |
| endive  | 35         | 25               | 2         | 28    | 27               | 22                    |
| All     | 125        | 95 (76%)         | 8         | 79    | 78               | 61                    |

Handling confusion (rows: catalog, columns: model):

| Catalog \ model | none | stop | ai  | generic | rule | unclassified |
| --------------- | ---- | ---- | --- | ------- | ---- | ------------ |
| none (64)       | 46   | 6    | 3   | 6       | 2    | 1            |
| stop (22)       | 0    | 17   | 1   | 2       | 2    | 0            |
| ai (17)         | 2    | 0    | 14  | 0       | 1    | 0            |
| generic (12)    | 1    | 0    | 0   | 11      | 0    | 0            |
| rule (10)       | 0    | 3    | 0   | 0       | 7    | 0            |

- **The 8 dangerous errors.** Five are statements the catalog marks `none` because of Refit's own limits, which the page cannot show: `invoiceItems.*` and `invoices.createPreview` calls are not mapped (the model read price and unit_amount moving under `pricing`, and the polymorphic preview `billing_cycle_anchor`, as `request-wrap` rules), the recorded contracts still declare `line_item.subscription` and `plan`, and `checkout.session.currency_conversion` is still in the contract (these three predicted `ai`). The other three are changes the catalog stops on: `price` in `invoices.addLines` and the polymorphic `billing_cycle_anchor` on `subscriptions.update`, predicted as wraps, and `price.recurring.aggregate_usage` behind a nullable `anyOf`, predicted `ai`.
- **Rules.** 7 of the 10 rule statements were predicted `rule`, and 5 more statements were predicted `rule` where the catalog has none. The 3 missed are both `payment_method_types` card renames and the invoice preview move, predicted `stop`: the card rename is an owner decision, not something the page names.
- **Missed signals (catalog has one, model says `none`): 3.** Literal expand paths through a removed invoice field, the shipping fields Checkout drops, and `reversed` to `expired` on Issuing authorizations.
- **Families:** 21 of 26 where the catalog implies one; 8 statements got a family where the catalog implies none.
- **Category:** 78 of 78 classified pages; the endive `rejected-accounts-v2-capabilities` output listed 98 identifiers, over the limit, so the page was refused.
- **Per prediction:** `none` was right 46 of 49 times, `generic` 11 of 19, `stop` 17 of 26, `ai` 14 of 18 and `rule` 7 of 12.

## Recommended review level

- **Every `rule` and `ai` prediction needs a human before it changes code or becomes a pack entry.** 8 of 30 such predictions were dangerous, and `rule` was right 7 of 12 times. The model reads what Stripe changed, not what Refit can trace, so it cannot see unmapped SDK calls, fields the contracts keep or owner decisions.
- **`stop` and `generic` predictions are safe to act on as reported, since they never edit code, but are often wrong.** 9 of 26 `stop` predictions are wrong (6 changes Refit has no signal for, 3 rules Refit applies) and 8 of 19 `generic` ones (6 with no signal, 2 that stop).
- **`none` predictions can be triaged by a person with a sample check.** 46 of 49 were right; the 3 misses each hid a real read or value the code may use.
- **Category can be taken as given:** 78 of 78.

So AI classification can draft a release's catalog and rule-pack candidates, but a person reviews each change before anything is automated. A second run (other releases, another model, or the OpenAPI diff added to the input) is needed before relaxing that.

## Limits

- The change statements come from the hand catalog, so this measures classification, not extracting the changes from a new page. Some statements were written with Refit's handling in mind (for example "`.price.id` reads"), which helps the model.
- The input is the changelog page only. The OpenAPI diff between the pinned spec versions is not sent; it would show which fields the contracts still declare, the source of most dangerous errors.
- One run of one model at default reasoning settings; repeat runs were not measured. Identifiers are recorded but not scored, because the catalog has no field for them.
- The OpenAI key on refit-bench accepts only `gpt-6.1-sol`: run 40283460948 with `gpt-5.6-luna` was refused with HTTP 403 on all 79 pages and billed nothing.
