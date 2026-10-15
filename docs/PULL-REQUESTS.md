# Pull request descriptions

Every Refit PR, whether a local `pull-request.md` or a published draft, follows one fixed template. It's built by `createReviewArtifacts()` in `pipeline/review.ts` from Refit's recorded report and states only what Refit recorded or can check. There are no emojis, and each bullet is one sentence. Full evidence (commands, hashes, findings, warnings, coverage and check logs) stays in the local `report.json`, and the diff is in Files changed.

## Title

Conventional Commits, under 70 characters, with no trailing punctuation: `fix(<scope>): <description>`. The scope is the integration ID, or the SDK package name without its npm scope, for example `fix(stripe): migrate removed Stripe API fields`.

## Body

| Section | Contents |
|---|---|
| **Overview** | What the provider removed, and whether a deterministic rule or AI (with its model) migrated how many usages in how many files |
| **API Impact & Spec Changes** | Breaking changes: removed response fields, replacements, request-field renames and retired calls. Database migrations and environment variables are always None |
| **Key Changes** | One line per changed file. Review lines follow: why each replacement was chosen (see below), item selection for subscription periods, and reads left unchanged |
| **Automated Verification Gates** | The check command and its result on the original and migrated code in offline Docker, generated stripe-mock checks, the type check when it is the command, remaining reads of removed fields. Security scans: Not run |
| **Related Telemetry** | No linked issue; the short Refit run ID and the integration |

Two hidden comments follow: the migration identity Refit uses to find its own open draft, and the run ID and patch hash.

## How "why this replacement" is decided

For each removed field, Refit names the replacement only if the patch actually reads it, and states the strongest evidence it holds, in this order:

1. **A configured rename rule** in the provider adapter (`propertyRenames`).
2. **The after contract's description** of the added field mentions the removed field. The description is quoted.
3. **An attached vendor note** mentions both fields. The sentence is quoted with the note's label and URL.
4. **Otherwise only the name and type:** "Nothing documents it as the replacement, so confirm it carries the same meaning."

Refit never states a reason it can't trace to one of these sources. Quotes are trimmed to 300 characters, and Markdown in them is escaped.
