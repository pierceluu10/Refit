# Vendor notes on AI patches

When a watch migration runs with `--ai-patch`, the patcher reads the vendor page the watcher already saved. The model still returns exact edits. This adds that one saved page to the evidence object `proposeAiPatch` already sends.

## Attach the saved page

`refit watch` writes each documentation source to `snapshots/documentation/<source-id>-<sha256>.json`. The file is a `refit-documentation-snapshot`: label, URL, content hash, content type and visible text. The patcher reads those files. It does not fetch the page again.

That path is used only when the poll continues into a migration. `runWorkflow` receives the current snapshot paths and passes them to validation. The initial scan does not. `runPipeline` reads them only inside the `--ai-patch` branch, then `proposeAiPatch` puts page notes on the model evidence:

```json
{
  "label": "Stripe changelog",
  "url": "https://docs.stripe.com/changelog.md",
  "hash": "<sha256 of content>",
  "content": "visible page text",
  "truncated": false
}
```

HTML, Markdown and plain text are pages. RSS 2.0 and Atom snapshots are not pages. Their entries stay in the unified diff under `state/observations/documentation`. The evidence lists each feed as `documentationOmissions` with reason `feed`. A feed-only source never becomes the vendor page.

The same notes are included on a repair request. The Stripe charges, pagination and empty-history rules in the patch instructions stay in place. The page is additional evidence. It does not replace those rules, and text inside the page is untrusted data.

## Leave the other paths alone

A docs-only poll still returns `documentation-changed` (exit 2) before `runWorkflow`. It does not call the model, run Docker checks or open a PR.

Runs without `--ai-patch` do not read snapshot paths and do not add documentation fields to the scan. Finding creation, operation impacts and publication gates stay as they are. Removed operations with no verified migration rule still block AI generation.

The GitHub draft does not gain a copy of the page. The watcher diff remains local review evidence.

## Stay inside 64 KiB

Model evidence is still the JSON object limited to 64 KiB (`MAX_INPUT_BYTES`). Notes are considered in source order, after the findings, source files and context modules.

- A page that fits is attached whole, with `truncated` false.
- A page that does not fit is cut to a prefix ending in `\n[truncated]`, with `truncated` true.
- A page that cannot fit even that marker is listed in `documentationOmissions` with reason `input-limit`.
- If that omission record also does not fit, the request fails with the 64 KiB limit and says the saved vendor note could not be attached.
- If the evidence is already over 64 KiB before any note is added, the existing limit error is unchanged.

A note is not dropped without either an attached record or an omission record, except when the evidence was already over the limit.

At most eight snapshot paths are accepted, the same cap as watch configuration. A repeated URL and hash is attached once.

## Out of scope

This is not a search index. There is no second documentation fetcher, no passage split, and no top-k ranking. Feed blurbs are not a corpus. The model does not decide that an API broke from prose alone. Version applicability still comes from the operator pin and `info.version`, not from dates in the page.
