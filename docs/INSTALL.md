# Installing Refit Agent

This page is for a customer installing the Refit Agent GitHub App on the hosted Refit service. Each statement describes what the code on `main` does today. A feature marked **off by default** does nothing unless the operator turns it on; a statement marked **planned** is not true yet. Where data lives and who processes it is in [data handling](DATA-HANDLING.md).

The service works only for the accounts its operator allows (`REFIT_HOSTED_ACCOUNTS`, by default the operator's own account). An installation on any other account is recorded as not allowed, with its account login and the names of the repositories you selected, and Refit clones nothing from it.

## Permissions the App requests

| Permission | Why |
|---|---|
| Contents: Read and write | Read: check out an approved repository at its approved branch to scan it and run its approved checks. Write: push the branch for a draft pull request. Nothing else is written. |
| Pull requests: Read and write | Open a draft pull request for a migration that passed its checks. Refit never merges. |
| Metadata: Read | Automatic for every GitHub App: repository names and visibility. |
| Installation and installation repository events | Automatic: Refit learns which repositories you selected, and when you remove a repository or uninstall. |

Each operation asks GitHub for a short-lived installation token scoped to the one repository and to exactly the permissions it needs: a checkout asks for Contents read, publishing a draft asks for Contents write and Pull requests write. Refit checks the token's scope before using it and never stores it; GitHub expires it after one hour (`pipeline/github-app.ts`).

Three features open GitHub issues and are **off by default**; each needs **Issues: Read and write**, which each installation must accept when the operator adds it:

- Approval issues (`REFIT_HOSTED_APPROVAL_ISSUES=1`): one issue on each installed repository without an approval, showing what would be approved; `/refit approve` and `/refit revoke` comments (also the **Issue comment** event) approve or revoke it.
- Deadline alerts and a weekly digest (`REFIT_HOSTED_ALERTS=1`, `REFIT_HOSTED_ALERT_DIGEST=1`), only in approved repositories ([monitoring](MONITORING.md)); re-scans after a push also need the **Push** event.
- A report issue (`REFIT_HOSTED_REPORTS=1`), only in approved repositories ([report](REPORT.md#the-hosted-report-issue)).

## What Refit reads

- **Before approval:** for an allowed account, a read-only [inventory](INVENTORY.md) of each selected repository from a fresh checkout: provider SDK packages and versions, provider hostnames, pinned Stripe API versions, OpenAI and Anthropic model calls, and the API deadlines that apply, each as a file path, line number and match count. It parses files without running them; it does not install dependencies or use AI, and it deletes the checkout afterwards (`pipeline/inventory.ts`). With approval issues on, Refit also reads the files `refit enroll` would approve, to show them in the issue.
- **After approval:** the repository at its approved branch. Refit compares the API contracts named in `.refit.json`, finds affected SDK calls and, when a supported migration applies, edits the affected files and runs the approved checks. See [what never leaves the sandbox](DATA-HANDLING.md#what-stays-inside-the-sandbox).

## What Refit stores, and for how long

All of it stays with the operator of the service, in PostgreSQL and on the worker's volume ([where](DATA-HANDLING.md#where-data-lives)):

| What | Where | Kept |
|---|---|---|
| Installation id, account login, status and whether the account is allowed; the names and GitHub ids of selected repositories | `refit_installations`, `refit_installation_repositories` | Repository rows are deleted when you remove the repository. After an uninstall they stay, and the installation row stays marked deleted. |
| Each webhook delivery's id, body hash and event name (not the body) | `refit_deliveries` | Indefinitely, to reject replays. |
| The approval: repository, branch, the hashes of the approved files and who approved it | `refit_approvals` | Indefinitely; `/refit revoke` (approval issues on) deletes it. Approvals do not follow a renamed or transferred repository. |
| Job records and their results: status, message, revision and readiness | `refit_targets`, `refit_jobs` | Indefinitely. Uninstall and repository removal cancel them but do not delete them. |
| A managed checkout of each approved repository, and each run's evidence: reports, patches and check output | `/data/state/targets/<id>/` on the worker's volume | Indefinitely, unless the operator runs with `--purge-uninstalled` (below). |
| The inventory: file paths, line numbers, match counts, package, host and model names; never source lines or file contents | `refit_inventories` | Replaced by each complete scan; deleted when you uninstall or remove the repository. |
| A daily count of jobs and inventories per installation | `refit_installation_usage` | Indefinitely. |
| AI spend per installation, if AI patches are on | `refit_ai_ledgers` | Indefinitely. |
| Issue numbers and state of approval, alert and report issues, when those are on | `refit_approval_issues`, `refit_deadline_alerts`, `refit_reports` | Until the repository's rows are deleted. |

With `--purge-uninstalled` (**off by default**), seven days after an uninstall Refit deletes that installation's repository rows, job records and checkout directories; deliveries, approvals and the installation row stay.

## How approval works

Refit runs nothing in a repository until the operator approves its configuration:

1. The repository commits a `.refit.json` that names the API contracts and the checks to run. [Repository setup](REPOSITORY-SETUP.md) explains it; `refit agents --add <ids>` writes one.
2. The operator runs `refit enroll` against the repository, reviews the settings, Docker image, commands and the exact files with their hashes, and stores the approval with `refit hosted approve` ([hosted onboarding](HOSTED-ONBOARDING.md#deploy-on-flyio)).
3. A later change to any approved file stops the next job as `needs-review` until it is approved again.

Approval is per repository and branch. It allows the checks in the approved file to run; it does not allow AI patches or draft pull requests, which are settings of the worker itself. With approval issues on, a repository admin or maintainer can also approve by commenting `/refit approve <fingerprint prefix>` on the approval issue, after Refit re-inspects the branch.

## Setup page

After you install, GitHub sends you to the service's setup page (`/github/setup`). It explains these steps and the worker's real settings (whether it opens draft pull requests and uses AI). It names your account only when GitHub confirms that the installation belongs to this App and was created or changed in the last hour; otherwise it shows the same text without your account. It runs no scripts and sets no cookies. **Needs owner decision:** the App's Setup URL must be set to this page before GitHub redirects there.

## Uninstalling and deleting your data

- **Uninstall:** GitHub settings, under **Applications** (personal account) or **GitHub Apps** (organization), then **Configure** next to Refit Agent. Uninstall removes every repository; removing a repository there affects only that one.
- **What happens:** GitHub notifies Refit. Refit cancels queued work for those repositories and stops jobs that are running in the worker, and GitHub stops issuing it tokens for them, so it cannot read them after that. Any draft pull requests it opened stay in your repository for you to close.
- **What stays:** the records in [the table above](#what-refit-stores-and-for-how-long) that are kept indefinitely; inventories are deleted at once. There is no self-service deletion. To have them deleted, write to the contact the setup page and `/.well-known/security.txt` name, once the operator configures one (`REFIT_HOSTED_CONTACT`), or else to the operator who gave you the install link. The operator deletes them by hand, or after seven days automatically if the worker runs with `--purge-uninstalled`.

GitHub has no redirect after an uninstall, so the setup page links `/github/uninstalled`, a static page that repeats what stays and how to ask for deletion. It collects nothing about your visit.
