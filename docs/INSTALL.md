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

## A repository with no `.refit.json`

A Stripe app on npm, pnpm or Yarn does not have to write a configuration. When the repository commits no `.refit.json`, `refit doctor` and `refit enroll` generate one from the code (`pipeline/enrollment-proposal.ts`):

- **API version:** the `apiVersion` string your `new Stripe(...)` call passes. A client that sets none sends the default of your locked stripe-node release: the API version that was newest when that release came out ([Stripe](https://docs.stripe.com/sdks/set-version)). Refit knows that default for stripe-node 12 and later.
- **Target:** the newest Stripe API version Refit has a contract for, 2026-09-30.endive today. Both contracts are Stripe's published OpenAPI files at commits Refit pins and checks by SHA-256 (`data/stripe-openapi-versions.json`).
- **Workspaces:** beside a root `package.json` that declares `stripe`, a client in a workspace package that the root lockfile installs counts like one at the root, and a client with no `apiVersion` sends the default of the stripe-node release locked for its own package. With `stripe` only in workspace packages, generation stops (`workspace-package`). Checks and dependency installation still run from the root. A project with its own lockfile beside the root is not installed; the generated configuration names it.
- **Checks:** your `test` script, run with the package manager your lockfile belongs to. Without one, `tsc --noEmit` over your `tsconfig.json`, failing only on type errors the change adds.
- **Sandbox:** `node:22-alpine`, with dependencies installed from your lockfile and no network while checks run.

Try it before installing, in a clean checkout, with the Refit CLI:

```sh
refit doctor
refit stripe-snapshot --version <your API version> --version 2026-09-30.endive
refit doctor
refit enroll --repository . --github <owner>/<repo> --base main
```

The first `refit doctor` names the exact `stripe-snapshot` command, or what stops Refit from generating a configuration. The second gives the verdict on the generated configuration. `refit enroll` prints it for review (labelled "Generated") and writes nothing. `refit doctor --json` prints the generated file as `generated.configuration`: to change a setting, commit it as `.refit.json` together with the two contracts it names, saved with their pinned hashes by `refit stripe-snapshot --version <before> --version <after> --contracts .` in the repository (they land in `refit/`, where the file expects them).

Approval covers the generated bytes and the saved before contract, as it covers a committed file. A change in your code's API version (for example after you merge Refit's draft) or a newer target in Refit needs a new approval. The stopped job says what moved: "your code now sends Stripe API version 2026-05-27.dahlia, moving to 2026-09-30.endive. Approve again to run that move", or, once the code sends the newest version, that there is nothing to move.

The hosted worker also runs an approved generated configuration (#265) and approval issues review one (#267); both are on Fly since `dd78eb7`. Approval issues still need the App's Issue comment subscription (#196).

With approval issues (**off by default**), a repository with no `.refit.json` needs two actions from you. We walked this on a local database with a simulated GitHub at #267, not on the hosted service:

1. Install the App on the repository.
2. Read the issue Refit opens, "Approve Refit for this repository". It shows the generated configuration's review and its fingerprint. Then, as an admin or maintainer, comment `/refit approve` followed by the first 12 characters of that fingerprint.

Refit replies, closes the issue and queues the first job. Nothing is committed to your repository.

### What we measured

On October 24, 2026, Refit ran on 60 Stripe repositories sampled from its four benchmark sets, with no edits ([rows](benchmarks/2026-10-24-p3-enrollment-results.json)). Nothing in the repositories ran.

- **35 got a complete configuration.** In all 35 its API version matched the one the benchmark selection had found independently. Before this change none did: each needed a hand-written `.refit.json` with an `apiVersion` and two saved contracts.
- **None was ready for validation yet.** Refit compares the full contracts, and in all 35 it found breaking changes, on operations the code calls, that no Refit rule migrates (`migration-coverage` below).
- **The other 25 stopped before a configuration:** an `apiVersion` Refit cannot trace to one version, or a request whose parameters it cannot read (6), no tests and no TypeScript (6), no lockfile (6), a tsconfig `extends` Refit does not read, which hides every client (4, and 1 more counted under no tests), no client at all (1), `stripe` declared only in a project the root lockfile does not install (1), and the scan limit (1).

On the 38 repositories Refit's operator runs on the hosted service, 29 got a configuration with no edits. The other 9 had no tests and no TypeScript (7) or no lockfile (2).

On 53 more repositories from the same sets, taken next in the same order and never used to write these changes, 31 got a configuration with no edits (the `heldOut` rows). In all 31 its API version matches what the code sends. The benchmark list names another version for 3, and each time the list is wrong: it read an `apiVersion` that is commented out, a `package.json` range rather than the release the lockfile installs, and a stripe-node release another package pulls in rather than the version the code sets.

### Why Refit stops, and what to do

Doctor gives each reason in one sentence with the place in your code, then the fix. The fixes, by the `id` that `refit doctor --json` reports:

| `id` | What it means | What to do |
|---|---|---|
| `contracts` | The two Stripe contracts are not saved on this machine. | Run the `refit stripe-snapshot` command doctor prints. |
| `no-lockfile` | Refit installs dependencies only from a committed lockfile. | Run `npm install`, `pnpm install` or `yarn install` once and commit the lockfile. |
| `no-checks` | No `test` script and no TypeScript, so nothing would show that a change still works. | Add a `test` script, or a `tsconfig.json` with `typescript` in `devDependencies`. |
| `api-version-unreadable` | An `apiVersion` or a client's options are computed, read from the environment or passed in from elsewhere, or a request passes parameters Refit cannot read. Doctor quotes the code. | Write the `apiVersion` as a string literal at the place doctor names, or commit a `.refit.json` that sets it. If a request's parameters set no `apiVersion`, commit a `.refit.json` with the version doctor names. |
| `api-version-several` | Clients or requests send more than one API version; Refit moves one at a time. | Use the same `apiVersion` everywhere. |
| `api-version-account-default`, `stripe-not-locked` | A client sets no `apiVersion`, and Refit cannot tell which default it sends: stripe-node before 12 sends your account's default, and Refit's table skips some later releases (21.x). | Set `apiVersion` at the place doctor names, or commit your lockfile. stripe-node's changelog names the version each release pins. |
| `api-version-no-contract` | Refit has no contract for your API version. | Move to the target yourself, or commit a `.refit.json` with contracts for your version. |
| `source-does-not-parse` | A file that imports `stripe` has a syntax error, so Refit cannot read its calls or API version. | Fix the syntax error in the file doctor names and commit it. |
| `no-stripe-client` | Refit found no `new Stripe(...)` client it can follow. When it sees one it cannot follow to the calls that use it, doctor names it. | If doctor names none, create the client with `new Stripe(secretKey, { apiVersion })` in your server code. If it names one, nothing in your code: Refit does not follow that client yet. |
| `source-resolution` | A `tsconfig.json` extends a package (`@tsconfig/node20/tsconfig.json`, a workspace's shared tsconfig) or a file a build writes (`.nuxt/tsconfig.json`), or references a project by a path without `./` (`tsconfig.vite.json`). Refit cannot tell how imports resolve under it. | Nothing in your code: Refit does not support this yet. A project reference written as `./tsconfig.vite.json` is read. |
| `workspace-package` | `stripe` is declared only in workspace packages the root lockfile installs. Refit does not yet generate a configuration that checks a workspace package from the root. | Commit a `.refit.json` whose checks run that package's tests from the root ([Repository setup](REPOSITORY-SETUP.md)). |
| `nested-project` | `stripe` is declared only in a `package.json` that the root lockfile does not install, or there is no root `package.json`. | Make that project a workspace of the root and commit the lockfile, or commit a `.refit.json` with a custom image. |
| `migration-coverage` | The contracts list breaking changes on operations your code calls that no Refit rule migrates. | Migrate the calls doctor names by hand; `refit run --human` lists each change. |
| `sdk-coverage` | Refit traced no Stripe call, or none it maps. | If a library calls Stripe for you, upgrade that library; otherwise check the named calls by hand. |
| `dependencies` | Conflicting lockfiles, a shrinkwrap, pnpm hooks or tracked `node_modules`. | Make the change doctor names and commit it. |
| `repository` | Uncommitted changes, or a submodule. | Commit or remove them. |

## How approval works

Refit runs nothing in a repository until the operator approves its configuration:

1. The repository commits a `.refit.json` that names the API contracts and the checks to run. [Repository setup](REPOSITORY-SETUP.md) explains it; `refit agents --add <ids>` writes one. A Stripe app can skip this step: with no `.refit.json`, `refit enroll` reviews the configuration Refit generates ([below](#a-repository-with-no-refitjson)).
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
