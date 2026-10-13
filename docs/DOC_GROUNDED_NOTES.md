# Recon notes for doc-grounded patches

October 13, 2026. Retrieval was not already built. Patch and repair prompts did not include provider documentation. The work below was implemented on this branch after these notes.

## 1. Where the patch path lives

| Piece | Location |
| --- | --- |
| AI patch prompt and edit schema | `proposeAiPatch` in `pipeline/ai-patches.ts`. Instructions are the `INSTRUCTIONS` constant. The model schema is `SCHEMA` / `GROUNDED_SCHEMA`. |
| Edit validation | The loop inside `proposeAiPatch` rejects unknown files, unconfirmed findings, inexact matches, overlaps, and now missing or unknown passage ids. |
| Repair loop | `validateMigration` in `pipeline/validation.ts`. It calls `proposeAiPatch` again with `RepairFeedback` while `repair.requested` is below the limit from `validateRepairAttempts` in `pipeline/validation-options.ts`. |
| Evidence size limit | `MAX_INPUT_BYTES` in `pipeline/openai.ts` (`requestStructuredOutput`). The limit is 64 KiB of JSON evidence. |
| `pull-request.md` writer | `createReviewArtifacts` in `pipeline/review.ts`. |
| Human CLI summary | `renderWorkflowResult` in `pipeline/workflow-presentation.ts`. JSON is selected in `pipeline/workflow-cli.ts` with `--json` or when stdout is not a terminal. |
| Workflow manifest | `runWorkflow` in `pipeline/workflow.ts`. `save` records each artifact hash in `manifest.json`. |

## 2. Existing documentation and snapshots

`provider-documentation-signals` and `rss-atom-changelog-sources` are not in this checkout. What exists:

- `pipeline/snapshots.ts` and `pipeline/openapi-sources.ts` store OpenAPI bytes, a SHA-256, a URL, and provenance. That is specification text, not documentation pages, and it is not copied into the AI prompt.
- `pipeline/source-snapshot-cli.ts` pins an OpenAPI document for any provider. `readSpecification` checks the hash before parsing.
- `pipeline/openapi-diff.ts` records that documentation-only spec edits are not code migrations. `pipeline/watch.test.ts` ignores a documentation-only revision when it does not change the contract identity.
- Deterministic Stripe patches link `https://docs.stripe.com/api/charges/list` from `proposePatch` in `pipeline/patches.ts`. That URL is a reviewer hint. The page text is not retrieved or sent to a model.

No stored page text was available to reuse. `refit docs-snapshot` (`pipeline/doc-snapshots.ts`, `pipeline/docs-snapshot-cli.ts`) now pins raw page bytes with the same size cap, timeout, and public-HTTPS rules as specification snapshots.

## 3. Prompts before this change

`proposeAiPatch` sent assessment evidence, affected files, import context, and optional repair logs. It did not send documentation passages. Assessment (`pipeline/assessment.ts`) is a separate optional call and also had no doc text. This change is limited to `--ai-patch`, repair, and the review text for those runs.

## 4. Contract adjustments that match the code

- Passage ids are `sha256(pageSha256 + headingPath joined by a unit separator + index)`, first 16 hex characters. Heading order is the markdown heading stack.
- `retrieve` filters by `provider`, then ranks with BM25. Exact field tokens weigh 8, operation tokens weigh 5, and repair terms weigh 1. Ties break by passage id. The default `k` is 4 and the combined passage text cap is 6,000 characters.
- Spec descriptions become `spec-description` passages only when the specification already has description text. Missing descriptions are not invented.
- Curated offline pages for Stripe, OpenAI, and Anthropic live in `pipeline/fixtures/docs/`. They are original short passages with the public source URL, not scraped copies of provider manuals. The OpenAI and Anthropic pages say their fixture renames are synthetic.
- A finding with no passage is omitted from the model request and recorded with `unresolvedReason: "no supporting docs found"`. Confirmed status on the finding is unchanged. An empty proposal in that case does not throw out of validation; publication stays blocked because the patch does not pass checks.
- Cited passage ids are stored on `patch.retrieval` and on each validation attempt. `pull-request.md` gets a Sources section only when an AI patch cited a passage. Deterministic runs do not gain that section.
- `watch` and `serve` do not accept `--docs`. An AI run they start still uses the curated pages and specification descriptions.

## 5. Files this change touches

- New: `pipeline/passages.ts`, `pipeline/retrieval.ts`, `pipeline/doc-snapshots.ts`, `pipeline/docs-snapshot-cli.ts`, fixtures under `pipeline/fixtures/docs/` and `pipeline/fixtures/anthropic/`, `eval/rag-eval.ts`, and these docs.
- Patch and repair: `pipeline/ai-patches.ts`, `pipeline/run.ts`, `pipeline/validation.ts`, `pipeline/openai.ts` (exported the existing 64 KiB constant).
- Review and CLI: `pipeline/review.ts`, `pipeline/workflow.ts`, `pipeline/workflow-presentation.ts`, `pipeline/workflow-cli.ts`, `pipeline/validation-cli.ts`, `bin/refit.mjs`.
- Tests that already mocked AI edits now cite a passage id from the evidence the generator actually sent.

No runtime dependency was added.
