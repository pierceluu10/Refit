# Approve a repository from GitHub

Status: **implemented, off by default, not deployed.** It needs App permission changes the owner has not made (see [Needs owner decision](#needs-owner-decision)). Until then, approval works only through `refit enroll` and `refit hosted approve` ([hosted onboarding](HOSTED-ONBOARDING.md#implemented-single-tenant-hosted-worker)).

With `REFIT_HOSTED_APPROVAL_ISSUES=1`, `refit hosted serve` lets a repository's admin or maintainer approve Refit from an issue, without the CLI or database access. The approval stored is the same record `refit hosted approve` stores, and the same gates apply afterwards.

## The flow

1. **Install.** The App is installed on a repository of an [allowed account](HOSTED-TENANCY.md#allowed-accounts). The repository has no stored approval.
2. **Issue.** The worker checks out the default branch with a read-only installation token and opens one issue:
   - With a committed root `.refit.json`, the issue shows exactly the review `refit enroll` prints: target, reviewed revision, fingerprint, API versions, each committed input with its size and SHA-256, and the settings, including the validation image and commands. The text comes from the same function as the CLI (`pipeline/enrollment-review.ts`), and the fingerprint from the same inspection (`inspectRepositoryEnrollment`). Repository content is shown inside a code fence that it cannot close.
   - Without `.refit.json`, when Refit can generate the Stripe configuration (it can tell which API version the code sends, from a literal pin or the locked stripe-node default, and that version is in the pinned contract table), the issue shows the review `refit enroll` prints for that generated configuration, with its fingerprint, and can be approved like a committed one. The worker first downloads the two pinned Stripe contracts it compares into `contracts/` under the state directory, where jobs read them; a failed download records the issue as `failed`, and the worker tries again an hour later.
   - Without `.refit.json`, when no configuration can be generated (including when a file that imports `stripe` does not parse), the issue shows the configuration `refit agents --add <ids>` would write for the provider SDKs Refit detects, with that command's next steps. Nothing is committed for the user. (`refit prepare` only installs dependencies; the existing generator is `refit agents --add`, so the proposal reuses it.)
   - With a `.refit.json` that cannot be reviewed, the issue shows the reason.
   - If no detected provider has an agent, no issue is opened.
3. **Approve.** Someone with the **admin** or **maintain** role comments `/refit approve <prefix>`, where the prefix is at least 12 characters of the fingerprint the issue shows (any case). The comment must contain only the command.
4. **Check.** The worker confirms the commenter's role through `GET /repos/{owner}/{repo}/collaborators/{user}/permission` (`role_name`), checks the prefix, and inspects the branch again. Only if the current fingerprint still equals the one the issue shows does it build the approval with `repositoryApproval` (the function `refit enroll --approve` uses) and store it, recording the commenter's login as the approver.
5. **Enroll.** Storing the approval enrolls the repository and queues its first job, exactly as `refit hosted approve` does. Refit replies, marks the issue approved and closes it. AI patches and draft publication stay separate worker settings; approval never turns them on.

Without a `.refit.json`, `/refit approve` (with or without a prefix) only checks the branch again: after the proposed file is committed, the issue is replaced with the review, and a second comment with its fingerprint approves.

## Refusals

Every refused command gets a reply that names the reason. Nothing is stored.

| Situation                                                                           | Outcome                     | Reply                                                               |
| ----------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------- |
| Commenter's role is not admin or maintain, or they are not a collaborator           | `no-permission`             | Names the commenter's role, or that they have none                  |
| Prefix shorter than 12 hex characters, or not part of the fingerprint shown         | `wrong-prefix`              | The value does not match the fingerprint this issue shows           |
| Prefix of a fingerprint an earlier version of the issue showed                      | `stale-prefix`              | The configuration changed since; approve what the issue shows now   |
| Prefix matches, but the committed configuration changed after the issue was written | `configuration-changed`     | Refit did not approve and updated the issue with the current review |
| The issue showed no reviewed configuration (proposal or invalid)                    | `no-reviewed-configuration` | Refit checked again and updated the issue                           |
| The command comment was edited                                                      | `edited-comment`            | Refit never acts on edited comments; post a new one                 |

Deliveries are refused before any command exists, so they are answered in the HTTP response, never with an issue comment:

- **Forged** (bad or missing `X-Hub-Signature-256`): `401`. Nothing in the payload is trusted, and replying would let anyone make Refit post.
- **Replayed**: a repeated delivery GUID answers `duplicate` (`409` if the GUID carries another payload). The signature covers only the body, so a captured comment could be resent under a new GUID. Commands are therefore unique per comment ID, and a resent comment also answers `duplicate`. Replays never produce a second reply, so they cannot be used to spam the issue.

Ignored without a reply: comments that are not exactly a command, comments on pull requests or on any issue other than the repository's approval issue, comments from bots (including Refit's own replies), comments from an installation that is not allowed, suspended or no longer has the repository, and deleted or pinned comments.

## When the configuration changes after approval

A job always verifies the approved fingerprint on its fresh checkout (`loadApprovedRepository`). If `.refit.json`, a baseline or an adapter changed, the job stops with `needs-review` and nothing runs. With approval issues on, the worker then reopens the issue with the current review and comments that the approved configuration changed. The old prefix is refused as stale. Approving the new fingerprint replaces the stored approval and resumes jobs.

## Revoke

`/refit revoke` on the approval issue, from an admin or maintainer, deletes the repository's stored approval and cancels its targets and open jobs with "Approval revoked by `<login>`." Commands are handled between jobs, so a job already running finishes first; its cancelled target gets no further jobs. The issue reopens with the current review, so the repository can be approved again. A repository with no stored approval answers `not-approved`. An approval stored with `refit hosted approve` before any issue was opened has no approval issue; removing it needs database access.

## Operation

- Commands are handled in the worker loop, before jobs are claimed, and a comment delivery wakes the loop. A job already running delays the reply until it finishes.
- `/status` adds `approvals` (each issue's state, shown fingerprints and last error, and each command with its outcome) when the flag is on.
- Each issue inspection (opening or refreshing an issue) counts as one inventory against the installation's [daily inventory cap](HOSTED-TENANCY.md#guardrails-per-installation). Once the cap is reached, further issues wait for the next UTC day. Inspections that a `/refit approve` from an admin or maintainer triggers are not counted.
- If GitHub refuses to open an issue, for example because the App lacks Issues permission, the error is recorded on the issue row and retried hourly.
- Inspection reads committed files and package manifests only. It never runs repository code, installs dependencies or calls AI. Checkouts for inspection live under the state directory in `approvals/`, separately from job checkouts.
- Tables: `refit_approval_issues` (one row per repository) and `refit_approval_commands` (one row per command comment), with row-level security and no policies, like the other `refit_*` tables.

## Evidence

`pipeline/hosted-approval.test.ts` runs against PostgreSQL (`REFIT_POSTGRES_URL`) with a simulated GitHub that serves issues, comments and collaborator roles, and a local Git repository served through the App checkout path. It covers approval, each refusal above, replays, forged signatures, the no-config proposal (compared with what `refit agents --add` writes, and shown when a Stripe-importing file does not parse), the review and approval of a generated configuration (with `REFIT_STRIPE_CONTRACTS` serving the saved contracts), a configuration change after approval through a real hosted job, revoke and the flag being off. It also checks that the issue contains exactly what `refit enroll` prints. No live GitHub API call or real App installation was exercised.

## Needs owner decision

The [Refit Agent App](GITHUB-APP.md) has **Contents: Read and write** and **Pull requests: Read and write** (plus automatic Metadata read). It receives `installation` and `installation_repositories` events automatically, and the local service also subscribes to **Pull request**. Approval issues need:

- **Issues: Read and write** (repository permission) to open, update and close the issue and to reply. Each installation must accept the updated permissions. [Deadline alerts](DEADLINES.md#alerts-from-the-service) need the same permission.
- The **Issue comment** event subscription, which requires Issues read.
- Metadata read, which every App already has, for the collaborator permission check.

Also for the owner: whether a repository's admins and maintainers should be able to approve at all. This moves approval from whoever holds the database to the customer, while AI patches and draft publication stay behind the worker's own flags.
