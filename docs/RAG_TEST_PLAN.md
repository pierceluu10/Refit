# Doc-Grounded Patches: Test and Benchmark Plan

This file is a brief for Claude Code. Paste it in, or commit it as `docs/RAG_TEST_PLAN.md` and tell Claude Code to read and execute it.

## Goal

Prove that doc-grounded patching (retrieval-augmented AI patches and repairs) works correctly, finds the right docs, makes fixes better than no retrieval, and adds little time or cost. Write every result into `docs/RAG_EVAL.md`.

## Ground rules

- Work on a new branch `rag/eval-bench`. Never push to main. Open a draft PR when done.
- Do not change retrieval, patch, repair or validation logic. This task only measures. If you find a bug, write it under "Bugs found" in the PR and in `RAG_EVAL.md`; do not fix it here.
- Nothing in this plan runs in `npm test` except the Layer 1 tests. Benchmarks and model evals are separate scripts.
- Model evals need `OPENAI_API_KEY` and `OPENAI_MODEL`. Record the exact model name in results.
- Never invent numbers. If a run fails or is skipped, record that.
- Put new scripts under `eval/`. Results files under `eval/results/` with a timestamp in the name.

## Layer 1: Correctness

Confirm these tests exist. Add any that are missing.

- [ ] An AI patch edit with no `passageIds` is rejected.
- [ ] An edit citing a passage ID not in the request's evidence is rejected.
- [ ] A confirmed finding with zero retrieved passages is not AI-patched and is reported unresolved with reason `no supporting docs found`.
- [ ] Repair attempts run a new retrieval using terms from the failing check output, and record it.
- [ ] `report.json` records the query, returned passage IDs with scores, and cited passage IDs for each AI-patched finding.
- [ ] Runs without `--ai-patch` produce output identical to main (compare on the Stripe replay and billing demo).
- [ ] Retrieval is deterministic: same index and query give identical results across 3 runs.
- [ ] Passage text sent per request never exceeds 6,000 characters, and total evidence stays under 64 KiB.

Run `npm test`, typecheck and format check. Record pass, fail and skip counts.

## Layer 2: Retrieval quality

1. Expand the labeled set to 20 to 30 real changes:
   - Stripe: at least 8 (include the `PaymentIntent.charges` removal)
   - OpenAI: at least 8 (include the rename from the existing rename proof)
   - Anthropic: at least 4
   Each label is a change (provider, operation, field, change kind) plus the passage ID or IDs a human would say explain it. Store as `eval/retrieval-labels.json`. Mark each label with where the explanation was confirmed (URL and heading).
2. Script `eval/retrieval-quality.ts` computes per provider and overall:
   - hit@1, hit@4 (right passage in the top 1 or top 4)
   - MRR (mean reciprocal rank)
   - count of queries with zero results
3. For every miss, print the query, the top 4 returned passages, and the expected passage, so a human can see why it missed.

## Layer 3: Fix quality, retrieval on vs off

Script `eval/patch-quality.ts`. Cases:

- Stripe billing demo (`examples/billing-demo.refit.json`)
- OpenAI rename proof
- One Anthropic case built on existing Anthropic fixtures

For each case, run the full AI patch flow with Docker validation:

- retrieval **off** (existing behavior) and retrieval **on**
- `--repair-attempts 1`
- N runs each, default 5, configurable with `--runs`

Record per run: final status, patch passed checks (yes/no), repair attempts used, rejected edits and reasons, unresolved findings and reasons, cited passage IDs.

Report per case and overall: pass rate, average repair attempts, rejected edit count, unresolved count, for on vs off.

Then pick 5 generated `pull-request.md` files from retrieval-on runs and save them under `eval/results/samples/` so a human can check that each cited passage really supports the change.

## Layer 4: Speed and cost

Script `eval/perf.ts`. Time each piece separately with `performance.now()`:

| Measurement | Method |
| --- | --- |
| Index build per provider | build 5 times, report median |
| Retrieval latency | 1,000 queries drawn from the labeled set, report p50, p95, max |
| Extra prompt size | characters and estimated tokens added per patch request, on vs off |
| Model call latency | per patch and repair request, on vs off, p50 and p95 |
| Model token usage | input and output tokens from the API response usage field, on vs off |
| Stage timings | Detect, Understand, Validate, Review per run, from Layer 3 runs |

Also run whole-command timing with `hyperfine` if it is installed:

```bash
hyperfine --warmup 1 --runs 5 '<full command with retrieval off>' '<full command with retrieval on>'
```

Note in results that Validate time is dominated by Docker, so compare model and retrieval time directly rather than total run time alone.

## Results file: `docs/RAG_EVAL.md`

Use this structure.

```markdown
# Doc-Grounded Patches: Evaluation Results

Date:
Commit:
Model:
Runs per case:
Machine: (CPU, RAM, Docker version)

## Summary
One paragraph: did retrieval raise the pass rate, by how much, and at what time and token cost.

## Layer 1: Correctness
Tests: passed / failed / skipped
Checklist results:

## Layer 2: Retrieval quality
| Provider | Labels | hit@1 | hit@4 | MRR | Zero results |
Notable misses and likely causes:

## Layer 3: Fix quality
| Case | Retrieval | Pass rate | Avg repairs | Rejected edits | Unresolved |
Sample PR review notes:

## Layer 4: Speed and cost
| Measurement | Off | On | Difference |
Index build:
Retrieval p50 / p95 / max:

## Bugs found

## Still unverified
```

## Targets

These are goals to compare against, not facts. Report actual numbers either way.

- Retrieval p95 under 50 ms per query
- hit@4 at 80% or above overall
- Passage text under the 6,000 character cap on every request
- Pass rate with retrieval on higher than off, with equal or fewer repair attempts
- Token increase per patch request small relative to the existing evidence

## Done when

- [ ] All Layer 1 checks have passing tests
- [ ] `eval/retrieval-labels.json` has 20 to 30 labels with sources
- [ ] All three eval scripts run and write results under `eval/results/`
- [ ] `docs/RAG_EVAL.md` is filled in with real numbers from at least one full run
- [ ] Draft PR opened with a short summary of the headline numbers
