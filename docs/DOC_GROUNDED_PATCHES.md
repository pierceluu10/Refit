# Doc-grounded AI patches

October 13, 2026.

When Refit asks a model to fix code after an API change, the model used to see the affected code and a short note about the change. This work lets it read pinned provider documentation first.

- Refit keeps a pinned, searchable copy of provider docs and specification descriptions, split into passages.
- Before the model writes a fix, Refit pulls the passages about that change and sends them with the code.
- Every AI edit must cite a passage that was supplied in that request. Uncited edits are rejected.
- If the fix fails checks, Refit looks up the docs again using terms from the error and retries.
- The draft text links each cited passage in a short Sources section.
- `eval/rag-eval.ts` compares retrieval on and off. It is not part of `npm test`.

Retrieval is deterministic keyword ranking. Embeddings are out of scope. The network is used only by `refit docs-snapshot` while pinning a page. Scan, retrieval, and the offline fixtures read the pin.

Deterministic Stripe rules do not use retrieval. This affects `--ai-patch`, `--repair-attempts`, and the review text for AI-patched runs. Runs without `--ai-patch` keep the previous proposal path.

## Stages

| Stage | With retrieval |
| --- | --- |
| Detect | Unchanged. A docs snapshot can be pinned beside the specification. |
| Understand | Unchanged. Passages are evidence for the fix, not proof that code is affected. |
| Validate | Patch and repair prompts include retrieved passages. Every edit must cite one. |
| Review | The draft adds one paraphrased sentence and the source link per cited passage. |

## Passage

```ts
type DocPassage = {
  id: string; // sha256(pageHash + headingPath + index), first 16 hex chars
  provider: string;
  sourceUrl: string;
  pageSha256: string;
  headingPath: string[];
  kind: 'doc' | 'spec-description' | 'changelog';
  text: string; // at most 1,500 characters
};
```

The index is `passages.json` in an AI workflow run. Its bytes are hashed in `manifest.json` with the other artifacts.

## Retrieval

```ts
retrieve(query: RetrievalQuery, index: PassageIndex, k = 4): RankedPassage[]

type RetrievalQuery = {
  provider: string;
  operation?: string;
  fields: string[];
  extraTerms?: string[];
};
```

The same input returns the same passages in the same order. Passage text sent to the model is capped at 6,000 characters and counts toward the existing 64 KiB evidence limit.

## Citation

An AI edit must include `passageIds` with at least one id from that request. Any other id is rejected the same way an out-of-scope finding is rejected. If a confirmed finding has no retrieved passage, it is not patched and stays unresolved with the reason `no supporting docs found`.

`report.json` records, per finding, the query, the returned passage ids and scores, and the passages the final patch cited. Each repair attempt records its own query and passages.

## Ground rules kept

- This branch is not `main`.
- Existing checks, gates, and `needs-review` paths stay in place.
- Retrieval does not change what counts as a confirmed finding.
- No model is called to retrieve passages.
- Draft text paraphrases a cited passage and links the source instead of quoting the page.
- No new runtime dependency.

See [recon notes](DOC_GROUNDED_NOTES.md) and [eval results](RAG_EVAL.md).
