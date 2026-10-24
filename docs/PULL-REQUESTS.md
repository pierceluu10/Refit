# Pull request descriptions

Every Refit PR, whether a local `pull-request.md` or a published draft, follows one fixed template, [the agent PR template](PR-TEMPLATE.md). It's built by `createReviewArtifacts()` in `pipeline/review.ts` from Refit's recorded report and states only what Refit recorded or can check. There are no emojis, and each bullet is one sentence. Full evidence (commands, hashes, findings, warnings, coverage and check logs) stays in the local `report.json`.

## Title

Conventional Commits, under 70 characters, with no trailing punctuation: `fix(<scope>): <description>`. The scope is the integration ID, or the SDK package name without its npm scope, for example `fix(stripe): migrate removed Stripe API fields`.

## Body

| Section | Contents |
|---|---|
| **Overview** | What the provider changed that this code uses (removed fields it reads, removed request fields it sends, retired endpoints it calls), and whether a deterministic rule or AI (with its model) migrated how many usages in how many files, with links to the provider pages that document the change |
| **API Impact & Spec Changes** | Breaking changes: removed response fields the code reads, replacements, request-field renames, the `payment_method_types` card rule and retired calls with their endpoints. Database migrations and environment variables are always None |
| **Key Changes** | One line per changed file: the removed fields whose reads it migrates, the card rule's `allowed_payment_method_types`, the pinned API version it moves, or the SDK upgrade. Review lines follow: why each replacement was chosen (see below), item selection for subscription periods, and reads left unchanged |
| **Code Changes** | The changed lines with two lines of context, each labelled `file:line` and its enclosing function, up to 80 lines. New files, such as the generated helper, are named with a pointer to Files changed. Lockfiles are named, not shown |
| **Automated Verification Gates** | The check command and its result on the original and migrated code in offline Docker, generated stripe-mock checks, the type check when it is the command, remaining usages of the breaking changes. Security scans: Not run |
| **Left Unchanged** | Only with untraced reads: each one as `file:line` and the field it reads |
| **Not Verified** | What the checks do not establish: no request reached the provider, webhook endpoint versions, AI-written lines, SDK-internal requests, and reads or calls still unmigrated |
| **Rollback** | Revert, with the pinned API version, SDK version and generated files the revert restores or removes |
| **Reviewer Checklist** | Unchecked boxes for each action the patch leaves to the reviewer |
| **Related Telemetry** | No linked issue; the short Refit run ID and the integration |

The body stays under 16,000 characters. Site lists show 25 entries and say how many more are in `report.json`. When a body is still too long, Refit cuts the code changes to 40 lines, then to 20 lines with 10 sites per list, then leaves them out, and says so under Code Changes. Model-fix drafts follow the same budget. [PR body examples](PR-BODY-EXAMPLES.md) shows each shape regenerated from stored results.

Two hidden comments follow: the migration identity Refit uses to find its own open draft, and the run ID and patch hash.

## One draft per target version

Refit keeps one draft per repository, base branch, integration and target API version (`draftKey()` and `publishFiles()` in `pipeline/publication.ts`). A provider whose contract keeps the same version is keyed by the contract's snapshot instead. The branch name is derived from those alone, not from the commit, the run or the patch bytes, so a rerun, a retry or a push to the base finds the same draft. With the GitHub App, Refit then does one of these:

| What GitHub holds | What Refit does |
|---|---|
| No draft for this target | Opens one: a single commit on the validated base, as Refit Agent |
| Its open draft, same base and patch | Nothing. Before generation, a matching draft also skips AI and validation |
| Its open draft on an older base, or with an older patch | Validates the current base and replaces its own commit with one on the new base. It moves the branch only while the branch still points at the commit Refit last pushed (a lease, like `git push --force-with-lease`), then refreshes the title and description. Same pull request number. If a person reviewed the old commit, a comment names the old and new commits and why |
| A draft with commits a person added (or a merge or rebase of the base) | Leaves the branch and description as they are and reports it, before generation. If the base has moved under the branch, one comment on the draft says so, names the files Refit's current patch changes, and asks for the base to be merged in; Refit edits that comment when the base moves again. A push that lands while Refit is updating the branch loses Refit the lease and ends the same way |
| A pull request someone else opened from the Refit branch | Leaves it to them |
| A draft a person closed without merging | Nothing: no reopen, no new draft for that target. Reopening it lets Refit update it again. A draft Refit closed itself as superseded is not a decline: if its target comes back, Refit opens a new draft |
| A merged draft | Nothing for that target |
| Another open Refit draft for this provider and integration on the same base, from an older target version | Nothing by default. With `--supersede-drafts` (owner decision, 2026-10-24), comments `Superseded by #N` with the reason and closes it, once the new draft is up to date. A draft with commits a person added stays open, and so does one a person reopened after Refit closed it, or one from an earlier release that names no provider |

Refit recognizes its own commit by the draft's record of the last commit it pushed (`<!-- refit-pushed: <sha> -->`; while a move is in flight it names both commits, so an interrupted run still recognizes the branch). A draft from an earlier release has no record; there Refit falls back to one parent and the App bot as both author and committer. It never merges, never marks a draft ready, and never writes to a draft a person closed. A run with a personal token cannot tell its own commit from a person's, so it reports an existing draft as it is and refuses to overwrite a branch without one. Other integrations in the same repository have their own drafts. Tests: `pipeline/draft-lifecycle.test.ts` runs each row against simulated GitHub with real Git objects.

## Commit message

The draft's single commit uses the PR title without `[Needs review]` as its subject. The body is plain text wrapped at 72 columns: the overview sentence, one line per changed file (up to 25), the check command and its result, `Needs review` when the draft needs it, each provider page as `Source: <url>`, and `Refit-Run:` with the short run ID (and `Refit-Integration:` for a collection). Model-fix commits list each edited line with the old and new model and the retirement date. Check logs never go into a commit.

## How "why this replacement" is decided

For each removed field, Refit names the replacement only if the patch actually reads it, and states the strongest evidence it holds, in this order:

1. **A configured rename rule** in the provider adapter (`propertyRenames`).
2. **The after contract's description** of the added field mentions the removed field. The description is quoted.
3. **An attached vendor note** mentions both fields. The sentence is quoted with the note's label and URL.
4. **Otherwise only the name and type:** "Nothing documents it as the replacement, so confirm it carries the same meaning."

Refit never states a reason it can't trace to one of these sources. Quotes are trimmed to 300 characters, and Markdown in them is escaped.
