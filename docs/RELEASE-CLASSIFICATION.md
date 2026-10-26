# AI release classification

`refit classify-release` asks OpenAI to classify each breaking change of a Stripe release, and scores the answer against the hand catalog in [`benchmarks/stripe-changelog/catalog/`](benchmarks/stripe-changelog/catalog/) (79 pages, 125 change statements over `2025-03-31.basil`, `2025-09-30.clover`, `2026-03-25.dahlia` and `2026-09-30.endive`). It is a measurement, not part of `refit run`: nothing it predicts edits code or feeds a rule pack.

```sh
refit classify-release --release 2026-09-30.endive [--release ...] --statements none|catalog --output <new-directory> --env .env
```

## Two input modes

- **`--statements none` (pages only, the primary measurement).** The model gets each changelog page and nothing else, lists the breaking changes itself and classifies each. This is all a new release offers, since nobody has catalogued it yet.
- **`--statements catalog` (statements given, an upper bound).** The catalog entry's hand-written `changed` statements go with the page, numbered, and the model classifies each. The statements were written by someone who knew Refit's handling (for example "`.price.id` reads"), so this overstates what a new release allows.

In both modes the catalog's `handling`, `how`, `reason`, `parts` and `fullDiffOnly` are never sent; tests check the recorded prompts for that.

## What it sends and returns

- **Input:** the page's Markdown as saved in [`benchmarks/stripe-changelog/pages/`](benchmarks/stripe-changelog/pages/) (captured by `node scripts/stripe-changelog-pages.mjs`, URL and SHA-256 kept), without the Ruby, Python, PHP, Java, Go and .NET tabs, which repeat the REST tables and pushed one page past the 64 KiB input limit. The OpenAPI diff between the pinned spec versions is not sent (see [Limits](#limits)).
- **Output, strict JSON checked by code:** the page's category (`api` or `stripejs`) and, per change, a handling (`none`, `stop`, `ai`, `generic`, `rule`, as the catalog defines them), a rule-pack family (`moved-value`, `moved-id`, `period-helper`, `request-rename`, `request-wrap`, `read-review` or `none`), the affected `object.property` and `METHOD /v1/path` identifiers (at most 20), a short rationale and, in pages-only mode, the change's own one-sentence statement (at most 30 per page). An output that does not match, or a refused request, is recorded as the page's error and scored as wrong; nothing is retried or guessed.
- **Audit:** `audit.json` holds the instructions and, per page, the exact evidence, the raw model output, the response id, the model and the cost. `results.json` holds the predictions and the score.
- **Budget:** one request per page through the shared OpenAI client and spending ledger (`REFIT_AI_BUDGET_USD`, default $1), with the same token counting and reservation as AI patches.

## How it is scored

- **Units.** One row per catalog change statement; its expected handling is the handling of the catalog part that contains it. A page's handling is its weakest change's, in the catalog's order `none` < `stop` < `ai` < `generic` < `rule`.
- **Matching, pages only.** Each change the model lists is assigned to the catalog statement on the same page it shares the most content words with (Dice coefficient, the first statement on a tie). Content words are the statement's and identifiers' words, lowercased, with camelCase and snake_case split (keeping the whole snake_case name) and words about how something changed (removed, added, field, parameter and so on) dropped. Several changes may share one catalog statement. A change that shares no word with any catalog statement on its page is **extra**; a catalog statement no change is assigned to is **unmatched**. A catalog statement counts as correct only when at least one change is assigned and every assigned change has its handling; when they disagree its handling is `mixed`. With statements given, change _i_ is statement _i_.
- **Families.** The catalog implies a family for 26 statements: each `rule` part by the function its `how` names (`release-classification-score.ts`), and `read-review` for each `ai` part (a removed read kept for review). The invoice preview move changes the called method, which no family covers, so it expects `none`.
- **Dangerous error:** a change predicted `rule` or `ai` (a code edit) on a catalog statement that says `stop` or `none`, plus any extra change predicted `rule` or `ai`.
- **Hand review.** Word matching is approximate, so every pages-only change predicted `rule` or `ai` was also matched to the catalog statements it describes by reading both: [`benchmarks/2026-10-26-release-classification-pages-review.json`](benchmarks/2026-10-26-release-classification-pages-review.json). The dangerous count and the `rule` precision below use that review.

## Measured accuracy (gpt-6.1-sol)

Pages only: refit-bench run 40285557374, $0.70 ([results](benchmarks/2026-10-26-release-classification-pages-results.json), [audit](benchmarks/2026-10-26-release-classification-pages-audit.json)). Statements given: run 40283655210, $0.56 ([results](benchmarks/2026-10-26-release-classification-results.json), [audit](benchmarks/2026-10-26-release-classification-audit.json)). Commands and the side-by-side table with checked claims are in [Benchmarks](BENCHMARKS.md#ai-release-classification-against-the-stripe-catalog-october-26).

| Measure                                             | Pages only  | Statements given |
| --------------------------------------------------- | ----------- | ---------------- |
| Catalog statements with the catalog's handling      | 70/125      | 95/125           |
| Catalog statements no change was matched to         | 17          | 1                |
| Dangerous catalog statements (word matching)        | 8           | 8                |
| Dangerous catalog statements (hand review)          | 8           | 8                |
| Page category                                       | 78/79       | 78/79            |
| Page handling (weakest change)                      | 62/79       | 61/79            |
| Pack family, where the catalog implies one          | 9/26        | 21/26            |
| Predicted `rule` that the catalog also calls `rule` | 7/18 (hand) | 7/12             |
| Catalog `rule` statements predicted `rule`          | 7/10 (hand) | 7/10             |

Pages only, by release:

| Release | Statements | Changes listed | Matched | Extra | Handling correct | Dangerous | Pages | Category correct | Page handling correct |
| ------- | ---------- | -------------- | ------- | ----- | ---------------- | --------- | ----- | ---------------- | --------------------- |
| basil   | 54         | 82             | 46      | 0     | 27               | 5         | 22    | 22               | 17                    |
| clover  | 23         | 40             | 20      | 2     | 13               | 1         | 18    | 18               | 14                    |
| dahlia  | 13         | 22             | 12      | 0     | 9                | 0         | 11    | 11               | 9                     |
| endive  | 35         | 45             | 30      | 0     | 21               | 2         | 28    | 27               | 22                    |
| All     | 125        | 189            | 108     | 2     | 70 (56%)         | 8         | 79    | 78               | 62                    |

Pages-only handling, by catalog statement (rows: catalog, columns: model; `mixed`: assigned changes disagree):

| Catalog \ model | none | stop | ai  | generic | rule | mixed | unmatched |
| --------------- | ---- | ---- | --- | ------- | ---- | ----- | --------- |
| none (64)       | 44   | 4    | 3   | 5       | 2    | 2     | 4         |
| stop (22)       | 1    | 10   | 1   | 2       | 1    | 2     | 5         |
| ai (17)         | 0    | 0    | 7   | 0       | 1    | 5     | 4         |
| generic (12)    | 0    | 0    | 0   | 7       | 0    | 4     | 1         |
| rule (10)       | 0    | 1    | 0   | 0       | 2    | 4     | 3         |

- **Dangerous errors: the same 8 catalog statements in both modes,** by hand review. Five are statements the catalog marks `none` because of Refit's own limits, which the page cannot show: `invoiceItems.*` and `invoices.createPreview` calls are not mapped (the model read the request moves under `pricing` and the polymorphic preview `billing_cycle_anchor` as `rule`), the recorded contracts still declare `line_item.subscription` and `plan`, and `checkout.session.currency_conversion` is still in the contract (all three predicted `ai`). Three are changes the catalog stops on: `price` in `invoices.addLines`, the polymorphic `billing_cycle_anchor` on `subscriptions.update` (predicted as rules) and `price.recurring.aggregate_usage` behind a nullable `anyOf` (predicted `ai`). Pages only, 9 of the model's 50 `rule` or `ai` changes land on them. Word matching also counts 8, but one is a mismatch (the removed `paid` fields put on the `amount_paid` behaviour change) and it misses `invoices.addLines`, which it put on a rule statement.
- **Word matching is noisy.** It put 15 of the 50 hand-reviewed changes on a different catalog statement than the hand reading. So the pages-only handling (70 of 125) and family (9 of 26) scores mix model errors with matching errors, and the 17 unmatched statements include catalog splits the page does not make, such as `payment_method_types` with the literal `['card']` against every other value, an owner decision.
- **Rules.** Pages only, the model predicted `rule` 18 times; 7 are catalog rules, 6 are removed reads the catalog leaves to AI (tax amounts and rates, `InvoiceItem.subscription`, line item `subscription_item`, unit amounts), and 5 are the dangerous request changes above. It found 7 of the 10 catalog rules; it missed the invoice preview move and both card renames.
- **Category** was right on all 78 pages with a usable output in both runs. In both, the endive `rejected-accounts-v2-capabilities` output listed more than 20 identifiers and was refused.
- **Page-level handling barely moves** (62 against 61 of 79), because a page's weakest change does not depend on how its changes are split.

## Recommended review level

From the pages-only run, which is what a new release gets:

- **A person reviews every `rule` and `ai` prediction before it changes code or becomes a pack entry.** Only 7 of 18 `rule` predictions were catalog rules, and 9 of 50 `rule` or `ai` changes were dangerous. The model reads what Stripe changed, not what Refit can trace, so it cannot see unmapped SDK calls, fields the contracts keep or owner decisions.
- **The change list itself needs review.** The model's own split matched 108 of 125 catalog statements; 17 were not found as separate changes, including request changes the catalog stops on.
- **`stop`, `generic` and `none` predictions never edit code** and can be triaged by a person with a sample check. Missed signals are the risk there: 13 catalog statements with a signal (`stop`, `ai`, `generic` or `rule`) were not found as separate changes, and 1 `stop` statement was called `none`.
- **Category can be taken as given:** 78 of 78 usable pages in both modes.

AI classification can draft a release's catalog and rule-pack candidates; it cannot replace the person who decides which become rules. Giving it the hand statements raises statement-level agreement (95 against 70 of 125) but not safety: the dangerous set is the same.

[Release PRs](RELEASE-PRS.md) apply this to each new Stripe release: every `rule` and `ai` prediction is listed for a person's decision.

## Limits

- One run per mode, one model at default reasoning settings; repeat runs were not measured.
- The OpenAPI diff between the pinned spec versions is not sent. It would show which fields the contracts still declare, the source of five of the eight dangerous errors, but the Stripe specs are large and are not committed, so it was not cheap to add here.
- Word matching is a deterministic approximation; the hand review covers only the 50 `rule` or `ai` changes, not the other 139.
- Identifiers are recorded but not scored, because the catalog has no field for them.
- The OpenAI key on refit-bench accepts only `gpt-6.1-sol`: run 40283460948 with `gpt-5.6-luna` was refused with HTTP 403 on all 79 pages and billed nothing.
