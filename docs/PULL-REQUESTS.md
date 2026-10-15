# Pull request descriptions

Every Refit PR, whether a local `pull-request.md` or a published draft, is one paragraph followed by the change itself. It's built by `createReviewArtifacts()` in `pipeline/review.ts` from Refit's recorded report and states only what Refit recorded or can check. Full evidence (commands, hashes, findings, warnings, coverage and check logs) stays in the local `report.json`.

## The paragraph

In order, each part only when it applies:

1. **What and why:** what the provider removed, whether AI (with its model) or a deterministic rule updated the code, how many usages in how many files, and which field replaced which.
2. **Why each replacement:** see below.
3. **Rare cases:** the subscription item policy, the item chosen for items on different billing periods, request-field and endpoint replacements.
4. **Evidence:** the check command that passed on the original and the migrated code in an offline Docker container, whether generated stripe-mock checks ran, and what that does not show. If validation failed, it says so in bold instead.
5. **Not changed:** reads of removed field names Refit could not trace to a provider object, and subscription-period reads it could not resolve.

## The change

The changed lines with two lines of context, each labelled `file:line` and its enclosing function. New files, such as the generated helper, are named with a pointer to Files changed. Two hidden comments follow: the migration identity Refit uses to find its own open draft, and the run ID and patch hash.

## How "why this replacement" is decided

For each removed field, Refit names the replacement only if the patch actually reads it, and states the strongest evidence it holds, in this order:

1. **A configured rename rule** in the provider adapter (`propertyRenames`): *"An operator-configured rename rule maps `Model.owned_by` to `Model.owner_name`."*
2. **The after contract's description** of the added field mentions the removed field. The description is quoted.
3. **An attached vendor note** mentions both fields. The sentence is quoted with the note's label and URL.
4. **Otherwise only the name and type:** *"⚠️ Nothing documents it as the replacement for `owned_by`, so confirm it carries the same meaning."*

Refit never states a reason it can't trace to one of these sources.

## Limits

- At most 80 diff lines are shown inline. Longer patches point to Files changed and `migration.patch`.
- The enclosing function name comes from the nearest preceding `function` declaration, so it's omitted for arrow functions and methods.
- Quotes are trimmed to 300 characters, and Markdown in them is escaped.
