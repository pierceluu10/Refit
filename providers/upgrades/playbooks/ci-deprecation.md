---
provider: upgrades
kind: ci-deprecation
reviewed: false
drafted: 2026-11-06
sources:
  - https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/
  - https://github.blog/changelog/2024-04-16-deprecation-notice-v3-of-the-artifact-actions/
  - https://github.blog/changelog/2026-11-02-pull_request_target-blocked-by-default-december-2
  - https://docs.github.com/en/actions/reference/runners/github-hosted-runners
  - https://docs.github.com/en/actions/reference/security/secure-use
  - https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax
---

CI deprecations fail loudly, but only when the workflow runs. Tags usually stay in place, yet GitHub's notice for the old artifact actions said using them after the date [results in a workflow failure](https://github.blog/changelog/2024-04-16-deprecation-notice-v3-of-the-artifact-actions/). A green pull request can also hide a workflow that only runs on `schedule`, `release` or `workflow_dispatch`.

**What usually breaks.** Old action majors, the Node version an action runs on, and retired runner images. GitHub set Node 24 as the default on runners and scheduled [Node 20's removal for September 23, 2026](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/); that notice also says Node 24 is incompatible with macOS 13.4 and lower, and has no official ARM32 support, which matters for self-hosted runners. An action's `runs.using` [declares its Node version](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax). New majors also change inputs and outputs, and artifact actions in particular have changed how they behave between majors.

**How to spot it in code.** Read every file in `.github/workflows/`, plus local composite actions under `.github/actions/` and any reusable workflows. Search for `uses:`, `runs-on:`, matrix values, and `container:`. Runner labels are often in a matrix or an `env`.

**What to check.**

- `action_versions` gives current and older versions of an action, and which Node each major runs on where it can tell.
- Read the action's release notes for input and output changes between majors; `migration_guide` can help when the action has a package.
- Compare `runs-on` against the [list of GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). A `-latest` label can move to a new OS underneath you.
- Parse each edited workflow. You usually can't run it from here, so say in the PR that it hasn't run on GitHub.

**Common pitfalls.**

- Pinned SHAs. GitHub [recommends full-length commit SHAs](https://docs.github.com/en/actions/reference/security/secure-use) for third-party actions, so if the repo pins them, keep doing that and update the version comment beside each one. Don't invent a SHA: look it up.
- Moving one artifact action without its partner. Upload and download usually need to change together.
- Runner image changes that remove preinstalled tools. A build may have been relying on something now gone.
- Security-related workflow changes. From December 2, 2026, GitHub [blocks `pull_request_target` by default in public repositories](https://github.blog/changelog/2026-11-02-pull_request_target-blocked-by-default-december-2) unless a policy allows it; read the notice if a workflow uses that trigger, and keep the workflow's permissions as narrow as they were.
- Runtime versions in `setup-node` or `setup-python` can be a separate task. Mention them in the PR if they're also behind.

**When you're unsure.** Move to the newest major with the smallest edit, and list every workflow you changed and how it would be triggered, so a person knows what to watch on the next run.
