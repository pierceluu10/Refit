# Installing Refit Agent

This page is for a customer installing the Refit Agent GitHub App on the hosted Refit service. Each statement describes what the code on `main` does today, plus the setup, uninstall and `security.txt` pages that ship with this page (PP8). A statement marked **planned (lane)** describes a change that is open as a pull request and not yet merged; it is not true until that lane lands. Where data lives and who processes it is in [data handling](DATA-HANDLING.md).

The hosted service is single tenant today: it works only for the installations of the account that runs it (`REFIT_HOSTED_OWNER`). Installations on any other account are ignored. **Planned (PG10, #177):** an operator allowlist of customer accounts; installations on other accounts are recorded as not allowed and Refit clones nothing from them.

## Permissions the App requests

| Permission | Why |
|---|---|
| Contents: Read and write | Read: check out an approved repository at its default branch to scan it and run its approved checks. Write: push the branch for a draft pull request. Nothing else is written. |
| Pull requests: Read and write | Open a draft pull request for a migration that passed its checks. Refit never merges. |
| Metadata: Read | Automatic for every GitHub App: repository names and visibility. |
| Installation and installation repository events | Automatic: Refit learns which repositories you selected, and when you remove a repository or uninstall. |

Each operation asks GitHub for a short-lived installation token scoped to the one repository and to exactly the permissions it needs: a checkout asks for Contents read, publishing a draft asks for Contents write and Pull requests write. Refit checks the token's scope before using it and never stores it; GitHub expires it after one hour (`pipeline/github-app.ts`).

**Planned (PG2, #196):** approving from a GitHub issue needs **Issues: Read and write** and the **Issue comment** event, so Refit can open an approval issue and read `/refit approve` comments. **Planned (PG5):** an inventory report issue would use the same permission. Until those land, the App does not need Issues access, and each installation would have to accept the added permission when it does.

## What Refit reads

- **Before approval:** nothing on `main`; the repository is listed but not cloned. **Planned (PG1, #170):** a read-only inventory of each selected repository from a fresh checkout: provider SDK packages and versions, provider hostnames, pinned Stripe API versions, OpenAI and Anthropic model calls, and the API deadlines that apply, each with its file and line. It reads files only; it does not run code, install dependencies or use AI, and it deletes the checkout afterwards (`pipeline/inventory.ts`).
- **After approval:** the repository at its default branch. Refit compares the API contracts named in `.refit.json`, finds affected SDK calls and, when a supported migration applies, edits the affected files and runs the approved checks. See [what never leaves the sandbox](DATA-HANDLING.md#what-stays-inside-the-sandbox).

## What Refit stores, and for how long

All of it stays with the operator of the service, in PostgreSQL and on the worker's volume ([where](DATA-HANDLING.md#where-data-lives)):

| What | Where | Kept |
|---|---|---|
| Installation id, account login and status; the names and GitHub ids of selected repositories | `refit_installations`, `refit_installation_repositories` | Repository rows are deleted when you remove the repository. The installation row stays, marked deleted, after an uninstall. |
| Each webhook delivery's id, body hash and event name (not the body) | `refit_deliveries` | Indefinitely, to reject replays. |
| The approval: repository, branch, the hashes of the approved files and who approved it | `refit_approvals` | Indefinitely, until the operator removes it. |
| Job records and their results: status, message, revision and readiness | `refit_targets`, `refit_jobs` | Indefinitely. Uninstall and repository removal cancel them but do not delete them. |
| A managed checkout of each approved repository, and each run's evidence: reports, patches and check output | `/data/state/targets/<id>/` on the worker's volume | Indefinitely; there is no automatic deletion yet. |
| AI spend per installation, if AI patches are on | A file under `/data/ai-budget` (**planned, PG10:** `refit_ai_ledgers`) | Indefinitely. |

**Planned (PG1, #170):** the inventory (the file paths, line numbers, package names and model names above, not file contents) is stored in `refit_inventories` and deleted when you remove the repository or uninstall. **Planned (PP7, #194):** seven days after an uninstall, Refit deletes that installation's repository rows, job records and checkout directories; deliveries, approvals and the installation row stay. **Planned (PG10, #177):** a daily count of jobs and inventories per installation, in `refit_installation_usage`.

## How approval works

Refit runs nothing in a repository until the operator approves its configuration:

1. The repository commits a `.refit.json` that names the API contracts and the checks to run. [Repository setup](REPOSITORY-SETUP.md) explains it; `refit agents --add <ids>` writes one.
2. The operator runs `refit enroll` against the repository, reviews the settings, Docker image, commands and the exact files with their hashes, and stores the approval with `refit hosted approve` ([hosted onboarding](HOSTED-ONBOARDING.md#deploy-on-flyio)).
3. A later change to any approved file stops the next job as `needs-review` until it is approved again.

Approval is per repository and branch. It allows the checks in the approved file to run; it does not allow AI patches or draft pull requests, which are settings of the worker itself. **Planned (PG2, #196):** a repository admin or maintainer can approve by commenting `/refit approve <fingerprint prefix>` on the approval issue, after Refit re-inspects the branch.

## Setup page

After you install, GitHub sends you to the service's setup page (`/github/setup`). It explains these steps and the worker's real settings (whether it opens draft pull requests and uses AI). It names your account only when GitHub confirms that the installation belongs to this App and was created or changed in the last hour; otherwise it shows the same text without your account. It runs no scripts and sets no cookies. **Needs owner decision:** the App's Setup URL must be set to this page before GitHub redirects there.

## Uninstalling and deleting your data

- **Uninstall:** GitHub settings, under **Applications** (personal account) or **GitHub Apps** (organization), then **Configure** next to Refit Agent. Uninstall removes every repository; removing a repository there affects only that one.
- **What happens:** GitHub notifies Refit. Refit cancels queued work for those repositories and stops jobs that are running in the worker, and GitHub stops issuing it tokens for them, so it cannot read them after that. Any draft pull requests it opened stay in your repository for you to close.
- **What stays:** the records in [the table above](#what-refit-stores-and-for-how-long) that are kept indefinitely. There is no self-service deletion. To have them deleted, write to the contact the setup page and `/.well-known/security.txt` name, once the operator configures one (`REFIT_HOSTED_CONTACT`), or else to the operator who gave you the install link. The operator deletes them by hand. **Planned (PP7, #194):** automatic deletion seven days after an uninstall.

GitHub has no redirect after an uninstall, so the setup page links `/github/uninstalled`, a static page that repeats what stays and how to ask for deletion. It collects nothing about your visit.
