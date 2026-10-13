# Doc-Grounded Patches: Evaluation Results

Date: 2026-10-13

Commit: results and scripts are ab797e1b8a712232852f7f1e9ee742ed2b2b3a08, on retrieval implementation f25973ad2dbb0df3c5ae216f6f033711ff36c96d. Those scripts do not change retrieval, patch, repair, or validation logic.

Model: not set. `OPENAI_API_KEY` and `OPENAI_MODEL` were unset, so no model name was returned by an API.

Runs per case: 5 requested by `eval/patch-quality.ts --runs=5`. 0 executed.

Machine: Linux 6.12.94+ x86_64, 4 vCPU, Intel(R) Xeon(R) Processor, MemTotal 16,387,416 kB, Node v22.14.0. Docker is not installed (`docker info` failed with `spawn docker ENOENT`). `hyperfine` is not installed.

Result files:

- `eval/results/retrieval-quality-2026-10-13T19-46-01-677Z.json`
- `eval/results/patch-quality-2026-10-13T19-46-02-884Z.json`
- `eval/results/perf-2026-10-13T19-46-04-322Z.json`
- `eval/results/baseline-identity-2026-10-13T19-46-07-231Z.json`

## Summary

Retrieval found the labeled passage at rank 1 for 3 of 23 queries (hit@1 and hit@4 0.130, MRR 0.130) against the pinned 4-passage index. Those three are the changes the pinned pages already describe: `PaymentIntent.charges`, the synthetic `owned_by` to `owner_name` rename, and the synthetic `max_tokens` removal. The other 20 confirmed sources are not in the index. Whether retrieval raises the fix pass rate was not measured: no model call ran, Docker was absent, and the billing demo checkout was absent. On the three local fixtures, turning retrieval on added 792 to 1,317 evidence characters (about 198 to 329 estimated tokens at 4 characters per token) and kept passage text at 217 to 450 characters. Retrieval p95 over 1,000 queries was 0.063 ms.

## Layer 1: Correctness

Tests: 389 passed / 0 failed / 28 skipped (417 total). Test files: 42 passed / 2 skipped (44).

`npx tsc -b` passed. `npm run format:check` passed. The format script does not include `eval/` or `docs/`; the new eval scripts were formatted with Prettier before the check.

The 28 skips are the existing Docker, real-SDK, packaging, and billing-demo tests. They skip unless `REFIT_DOCKER_IMAGE` or the matching SDK opt-in is set. Docker is not installed here.

Checklist results:

- An AI edit with no `passageIds` is rejected. Covered by `rejects invalid or ungrounded edits` (`passageIds: []`) and `rejects an uncited edit and a passage that was not supplied`. Both passed.
- An edit citing a passage ID that was not supplied is rejected. Same tests, including `0123456789abcdef` and `0000000000000000`. Passed.
- A confirmed finding with zero retrieved passages is not sent to the model and stays unresolved with reason `no supporting docs found`. Covered by `leaves a confirmed finding unresolved when no passage matches`. Passed. Confidence stays `confirmed`.
- Repair runs a new retrieval using terms from the failing check output and records it on the proposal. Covered by `retrieves again from failing check terms during repair`: `extraTerms` includes `repair_test_failure` and `citedPassageIds` matches the edit. Passed. Copying that retrieval onto the validation attempt is asserted inside `bounds AI repair and retains tested candidates in actual containers`, which was skipped with the other container tests. That attempt record was not executed here.
- The proposal object that the CLI serializes records the query, returned passage IDs with scores, and cited passage IDs. Covered by `stores the query, scored passages, and citations that report.json serializes`. Passed for the Stripe fixture proposal. A Docker validation `report.json` was not written.
- Runs without `--ai-patch` match main on the Stripe replay. `eval/baseline-identity.ts` scanned this checkout and `origin/main` at `113626e0c8d23b7eada45595ca9f27e9fbe14bbd`. The JSON documents were identical (5,267 bytes each), `runId` `4bc176068c1cab325172ba9c624486fcfb397274c745d63c767059ea8be4aeaf`, status `affected`. The billing demo comparison was skipped: `examples/billing-demo.refit.json` resolves to `/refit-billing-demo`, which is not present, and Docker is not installed.
- Retrieval is deterministic for the same index and query across 3 runs. Covered by the synthetic cap test (3 calls) and `returns the same pinned passages for one query across 3 runs`. Both passed.
- Passage text per request stays within 6,000 characters, and evidence stays within 64 KiB. The cap test passed. The new proposal test checks the Stripe evidence JSON is at most `MAX_INPUT_BYTES` (65,536) and the attached passage text is at most 6,000 characters. The perf script measured passage text of 450, 365, and 217 characters, and evidence JSON of 3,058, 2,521, and 2,122 characters, on the three fixtures with retrieval on.

## Layer 2: Retrieval quality

23 labels in `eval/retrieval-labels.json`: Stripe 10, OpenAI 8, Anthropic 5. Each label has a confirmation URL and heading. Expected passage IDs are set only when that passage is in the pinned index.

The index built by `createPassageIndex` has 4 passages (`sha256` `fe2c4de5c7ca261aa1acb7b91d54b3b3db845b20c7b8fddffef3dcb843064db3`): Stripe Charges list `44da6e513ed90cd5`, Stripe changelog pin `b7b90ec76b4fd90c`, OpenAI `owned_by` `4df5e016e680249d`, Anthropic `max_tokens` `d445209964cfad26`.

Command: `node --import tsx eval/retrieval-quality.ts`

| Provider | Labels | hit@1 | hit@4 | MRR | Zero results |
| --- | --- | --- | --- | --- | --- |
| Anthropic | 5 | 1/5 (0.200) | 1/5 (0.200) | 0.200 | 0 |
| OpenAI | 8 | 1/8 (0.125) | 1/8 (0.125) | 0.125 | 7 |
| Stripe | 10 | 1/10 (0.100) | 1/10 (0.100) | 0.100 | 5 |
| Overall | 23 | 3/23 (0.130) | 3/23 (0.130) | 0.130 | 12 |

Rank-1 hits:

- `stripe-payment-intent-charges` (`44da6e513ed90cd5` and `b7b90ec76b4fd90c`)
- `openai-owned-by-owner-name` (`4df5e016e680249d`)
- `anthropic-fixture-max-tokens` (`d445209964cfad26`)

The separate 3-row fixture file `pipeline/fixtures/docs/labeled.json` still scores top-4 1/1 for each provider in `npm test`. That is a different, smaller set.

Notable misses and likely causes:

- 20 labels have an empty expected-id list. Their confirmation pages (Stripe node changelog entries, OpenAI chat-completions deprecations, Assistants and legacy endpoint shutdowns, Anthropic Python SDK v1 migration, and the live Messages `system` parameter) are not pinned. Retrieval cannot return a passage that was never indexed. That is why hit@4 is 0.130 rather than the 80% goal.
- 12 of those queries returned no passages. The field and operation tokens do not occur in the four pinned texts.
- Eight misses still returned a passage, and it was the wrong one. Stripe queries whose operation contains `retrieve` (`orders.retrieve`, `skus.retrieve`, `customers.retrieve`, `recipients.retrieve`) ranked the PaymentIntent charges passages first, because those passages contain `retrieve`. Anthropic queries for `completions.create`, `temperature`, `output_format`, and `system` ranked the `max_tokens` passage first, because it contains `messages.create`. Those rows stay misses: the confirmed source was not in the top 4.
- The OpenAI rename and the Anthropic `max_tokens` removal are fixture changes. The pinned passages say so. They are included because the plan asks for the existing rename proof and an Anthropic fixture case. They are not live API removals.

Every miss, with query, top passages, and expected source, is printed by the script and stored in the retrieval-quality result file.

## Layer 3: Fix quality

Command: `node --import tsx eval/patch-quality.ts --runs=5`

Status: skipped. No pass rate, repair count, rejected edit, or unresolved count was produced.

| Case | Retrieval | Pass rate | Avg repairs | Rejected edits | Unresolved |
| --- | --- | --- | --- | --- | --- |
| Stripe billing demo | off | skipped | skipped | skipped | skipped |
| Stripe billing demo | on | skipped | skipped | skipped | skipped |
| OpenAI rename proof | off | skipped | skipped | skipped | skipped |
| OpenAI rename proof | on | skipped | skipped | skipped | skipped |
| Anthropic fixture | off | skipped | skipped | skipped | skipped |
| Anthropic fixture | on | skipped | skipped | skipped | skipped |

Blockers recorded by the script:

- `OPENAI_API_KEY` is unset.
- `OPENAI_MODEL` is unset.
- Docker is not available (`spawn docker ENOENT`).
- The billing demo repository is not present at `/refit-billing-demo`.
- `pipeline/fixtures/openai/repository` and `pipeline/fixtures/anthropic/repository` are not Git roots, and neither fixture has a Docker image or check command. `validateMigration` requires a clean Git root and an image.
- `runPipeline` and `validateMigration` do not accept retrieval off. `proposeAiPatch` does, through `retrieval: 'disabled'`. There is no CLI flag. This run did not add one.

Sample PR review notes: no `pull-request.md` files were generated. `eval/results/samples/` was not created.

## Layer 4: Speed and cost

Command: `node --import tsx eval/perf.ts`

Prompt size was measured by intercepting `fetch` inside `proposeAiPatch` and returning a local stub response. That captures the request body. It is not a completed API call, and the token numbers are `ceil(characters / 4)`, not tokenizer or response usage.

| Measurement | Off | On | Difference |
| --- | --- | --- | --- |
| Stripe replay evidence characters | 1,741 | 3,058 | +1,317 |
| OpenAI rename evidence characters | 1,559 | 2,521 | +962 |
| Anthropic fixture evidence characters | 1,330 | 2,122 | +792 |
| Stripe replay estimated evidence tokens | 436 | 765 | +329 |
| OpenAI rename estimated evidence tokens | 390 | 631 | +241 |
| Anthropic fixture estimated evidence tokens | 333 | 531 | +198 |
| Passage characters | 0 | 450 / 365 / 217 | +450 / +365 / +217 |
| Full request characters, Stripe / OpenAI / Anthropic | 5,486 / 5,257 / 5,015 | 7,253 / 6,633 / 6,221 | +1,767 / +1,376 / +1,206 |
| Model call latency | skipped | skipped | no API key |
| API input and output tokens | skipped | skipped | no API key |
| Detect, Understand, Validate, Review | skipped | skipped | Layer 3 did not run |

Index build, 5 times, median, shared 4-passage corpus:

- Stripe: 0.630 ms
- OpenAI: 0.381 ms
- Anthropic: 0.359 ms

Retrieval over 1,000 queries drawn round-robin from the 23 labels, timed with `performance.now()` around `retrieve` only:

- p50: 0.024 ms
- p95: 0.063 ms
- max: 6.961 ms

Nearest-rank percentile: `ceil(percent / 100 * n) - 1`. The p95 target is 50 ms. This run is under that. The max is one outlier on this machine; the p95 is not.

`hyperfine` is not installed, so whole-command on/off timing was not run. Validate time was not measured. When Docker validation does run, that stage dominates total time, which is why model and retrieval time are reported separately above.

Against the goals: p95 is under 50 ms; hit@4 is 13.0%, below 80%; passage text on the three measured requests is under 6,000 characters; pass rate on versus off is unverified; the evidence-character increase is small in absolute size (under 2 KB) and large relative to these short fixtures (about 60% to 76% more evidence JSON than retrieval off).

## Bugs found

No citation gate failed, and retrieval logic was not changed.

The Layer 3 on/off comparison cannot be run through the public validation path. `proposeAiPatch` accepts `retrieval: 'disabled'`. `runPipeline` and `validateMigration` do not pass that mode, and there is no CLI flag. Adding one would be a product change, so this branch leaves it in place.

Unrelated Stripe queries can rank the charges passages first when the operation name contains `retrieve`, and unrelated Anthropic queries can rank the `max_tokens` passage first when the operation is `messages.create`. With only one page per provider, a shared token is enough to return the wrong page. The quality script counts those as misses. Ranking was not changed.

## Still unverified

- Live pass rate, repair attempts, rejected edits, unresolved findings, and cited passage IDs with retrieval on versus off. No model call and no Docker validation ran.
- Human review of five generated `pull-request.md` files. None were produced.
- Billing demo output without `--ai-patch` compared with main. The demo checkout and Docker image are not on this machine.
- The validation-attempt copy of repair retrieval inside `report.json`. The container test that asserts it was skipped.
- API-reported input and output tokens, and model latency.
- Whole-command timing with `hyperfine`.
- Hit rate after pinning the confirmation pages for the 20 misses. This run measured the current 4-passage index only.
