# Retrieval eval

This compares documentation retrieval with AI patch generation. It is not part of `npm test` and it does not run during a normal scan.

## Offline retrieval

Command:

```sh
node --import tsx eval/rag-eval.ts --runs=5
```

Run on October 13, 2026, from this checkout, with no `OPENAI_API_KEY` or `OPENAI_MODEL` set. The script printed:

```text
top-4 hit rate anthropic 1/1 (1.000)
top-4 hit rate openai 1/1 (1.000)
top-4 hit rate stripe 1/1 (1.000)
```

The labeled set is `pipeline/fixtures/docs/labeled.json`:

| Provider | Query | Expected source |
| --- | --- | --- |
| OpenAI | `models.retrieve`, field `owned_by` | Model retrieve reference |
| Stripe | `paymentIntents.retrieve`, field `charges` | Charges list reference |
| Anthropic | `messages.create`, field `max_tokens` | Messages reference |

Each expected passage was in the top 4. Retrieval did not call a model or the network. The same command exits 2 until model credentials are present, after printing these rates.

`npm test` covers the same labeled set and asserts every provider rate is 1.

## Model comparison

The same script runs the Stripe billing fixture, the OpenAI `owned_by` fixture, and the Anthropic `max_tokens` fixture. For each provider it calls the patch generator `--runs` times (default 5) with retrieval required and with retrieval disabled. It reports accepted edits, rejected edits, pass rate, and average repair attempts. Repair attempts in this harness count generator rejections, not Docker reruns.

```sh
OPENAI_API_KEY=... OPENAI_MODEL=... node --import tsx eval/rag-eval.ts --runs=5
```

No model name, pass rate, or repair count is recorded here. This environment has no `OPENAI_API_KEY`, so the live on/off comparison was not executed. Do not treat the offline hit rate as a model pass rate.

## Still unverified

- Live pass rate with retrieval on versus off. The billing demo, the OpenAI rename proof, and the Anthropic fixture have not been sent to a model from this change.
- Docker validation of an AI patch that cites a passage. The container tests are skipped unless `REFIT_DOCKER_IMAGE` is set, and Docker was not available here.
- Whether a fetched provider page, as opposed to the curated offline passages in `pipeline/fixtures/docs/`, changes the hit rate. `refit docs-snapshot` can pin a page; that pin was not fetched from the network in this run.
