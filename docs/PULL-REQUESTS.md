# Pull request descriptions

Every Refit PR, whether a local `pull-request.md` or a published draft, is one reviewable page: the provider change, the affected code and the validation evidence. It's built by `createReviewArtifacts()` in `pipeline/review.ts` from Refit's recorded report. The visible text states only what Refit recorded or can check. The AI's own wording is labelled as the model's note.

## Sections

| Section | Contents | Source |
|---|---|---|
| **Summary** | What the provider removed, how many usages in which files, which field replaced which, and whether the checks passed | Contract diff, scanner findings, validation result |
| **Why: the provider change** | A table of removed and added fields with type and endpoint, then **why each replacement was chosen** | Contract diff, oasdiff changelog, AI evidence, adapter rules |
| | Contract hashes and source URLs, the API-version comparison and SDK version declarations | Snapshots and provenance, API-version check |
| **What changed** | The real changed lines with two lines of context, each labelled `file:line` and its enclosing function | The validated patch |
| **Validation** | Baseline and migration checks: which code, which command, and the result. The isolation used, attempts, repairs and remaining reads of removed fields. What the checks show and don't show | Docker validation record |
| **How this patch was made** | AI (with the model and the checks Refit applied) or a deterministic rule, then the model's or rule's own summary | Patch metadata |
| **Before merging** | A checklist. It adds a meaning check whenever a replacement isn't documented, and request, pagination and error-handling review for Stripe, endpoint and request-field migrations | Derived from the sections above |
| **Technical evidence** (collapsed) | Exact commands, hashes, the oasdiff changelog, findings, warnings and coverage as JSON | Full report |

## How "why this replacement" is decided

For each removed field, Refit names the replacement only if the patch actually reads it, and states the strongest evidence it holds, in this order:

1. **A configured rename rule** in the provider adapter (`propertyRenames`): *"an operator-configured rename rule maps `Model.owned_by` to `Model.owner_name`."*
2. **The after contract's description** of the added field mentions the removed field. The description is quoted.
3. **An attached vendor note** mentions both fields. The sentence is quoted with the note's label and URL.
4. **Otherwise only the name and type:** *"it was added to the same response with the same type. ⚠️ The contract does not document it as a replacement…"*. The checklist then asks the reviewer to confirm the meaning.

Refit never states a reason it can't trace to one of these sources. When a migration uses a different call rather than a replacement field, as in the Stripe charge-history rule, the reasoning appears under **How this patch was made**.

## Limits

- At most 80 diff lines are shown inline. Longer patches point to Files changed and `migration.patch`.
- The enclosing function name comes from the nearest preceding `function` declaration, so it's omitted for arrow functions and methods.
- Quotes are trimmed to 300 characters, and Markdown in them is escaped.
