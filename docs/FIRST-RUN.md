# First run

What a new user meets between installing Refit and a clear `refit doctor` verdict, on five real repositories, before and after this change. Recorded on October 22, 2026 with the CLI installed from `npm run package:cli`'s tarball into an empty directory (`npm install refit-0.39.0.tgz`), as a customer would install it. Before is Refit `7b2c86a` (`main`); after is this branch. The after transcripts predate a review fix: doctor's closing caveat now also says that only bounded client patterns and configured SDK mappings are inspected, and that SDK/API-version rollout still needs review. No application code ran: doctor and `agents` only read files, and `refit run` stopped at its scan.

Since #255, a Stripe repository with no `.refit.json` gets a configuration Refit generates instead of the referral to `refit agents` shown below. See [installing Refit](INSTALL.md#a-repository-with-no-refitjson) and the October 24 measurement in [P3](overnight/P3.md). The transcripts below predate it.

## Repositories

Private copies at the commits pinned in the frozen benchmark lists, so nothing in them changed except what the steps below wrote.

| Scenario                               | Repository                                  | Commit    | Frozen list                          |
| -------------------------------------- | ------------------------------------------- | --------- | ------------------------------------ |
| A clean affected Stripe app            | `Hombre2014/Genius`                         | `375bbe7` | `2026-10-16-stripe-fresh-repos.json` |
| A pnpm monorepo (Stripe in `apps/web`) | `manucoffin/faster-fixes`                   | `0c26240` | `2026-10-14-stripe-repos.json`       |
| An app with no tests                   | `pra9711/lexinote`                          | `f019a51` | `2026-10-16-stripe-fresh-repos.json` |
| A Shopify app                          | `Shopify/shopify-app-template-react-router` | `48b841a` | `2026-10-16-shopify-repos.json`      |
| An OpenAI app                          | `JohnRiceML/clawport-ui`                    | `40db84d` | `2026-10-21-openai-app-repos.json`   |

Each followed the same path: `refit doctor` in the fresh checkout, `refit agents`, `refit agents --add <id>` for the scenario's provider, then `refit doctor` again. The Stripe app went further: it saved both contracts (the October 16 benchmark's 2023-08-16 contract, which matches its pinned API version, and `refit stripe-snapshot --latest`), committed them with `.refit.json`, and ran `refit doctor` and `refit run --human`.

## What was confusing, and what changed

|   # | Where                                              | Before                                                                                                                                                   | Now                                                                                                                             |
| --: | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
|   1 | `refit --help`                                     | 21 commands, no starting point                                                                                                                           | Opens with `refit agents`, `refit agents --add <id>`, `refit doctor`, `refit run`, in order                                     |
|   2 | `refit doctor`, no `.refit.json`                   | "Workflow configuration could not access a required file or executable." Next: "Supply --config … or commit .refit.json"                                 | "No .refit.json in … yet." Next: `refit agents`, then `refit agents --add <id>`                                                 |
|   3 | `refit doctor` after `agents --add`                | "Choose --integration from: stripe." with only one integration; `refit run` failed the same way                                                          | The sole integration is used; with several, doctor names the `--integration` to run                                             |
|   4 | Every blocked check                                | The verdict line, then a block per check, then four lines of caveats                                                                                     | Verdict with the blocked count, then **Next:** with the first thing to do (committing last), one line of caveats                |
|   5 | Uncommitted `.refit.json`                          | "Validation requires a clean committed repository"                                                                                                       | Names the uncommitted paths                                                                                                     |
|   6 | Missing contracts                                  | "Contracts and adapter could not access a required file or executable."                                                                                  | "Missing contracts: refit/stripe-before.json, refit/stripe-after.json." with the snapshot command for each                      |
|   7 | `refit agents --add` next steps                    | `refit stripe-snapshot --revision <sha> --output …`, `refit source-snapshot …`, and "Nothing runs until you approve the configuration with refit enroll" | The same exact commands doctor gives, then "commit, then run refit doctor"; enroll is described as the App's approval           |
|   8 | Expected errors                                    | `PipelineInputError: …`, `TypeError: Unknown option '--bogus'`, `Error: ENOENT: no such file or directory, realpath '/nonexistent'`                      | `refit <command>: …`; an unknown option names `refit <command> --help`; a missing path says it does not exist                   |
|   9 | `refit run` without `.refit.json`                  | Pointed to `refit doctor`, which did not say how to create one                                                                                           | Points to `refit agents` and `refit agents --add <id>`                                                                          |
|  10 | `refit stripe-snapshot`                            | Printed its usage line only; nothing on choosing a revision                                                                                              | Says which argument is missing; help explains `--latest` and `--revision`                                                       |
|  11 | `refit doctor --repository <typo>`                 | "No .refit.json … yet", suggesting `refit agents`                                                                                                        | Says the path does not exist                                                                                                    |
|  12 | Removed request parameter (Stripe app, configured) | Next: "Repair skipped sources and establish SDK or incoming-event provenance"; `refit run --human` said only "Found 4 confirmed usages in 2 files"       | Next: run `refit run --human`, which now prints `Removed     payment_method_types is still sent at app/api/stripe/route.ts:37`  |
|  13 | No API-version pin                                 | "configure an exact before-contract API-version pin"                                                                                                     | `Confirm your client and account use 2023-08-16, then add "apiVersion": "2023-08-16" to the stripe integration in .refit.json.` |
|  14 | Unsupported breaking changes                       | "define a reviewed adapter migration rule", which is work for Refit's developers                                                                         | Lists them through `refit run --human` and says they need a manual migration or a reviewed rule                                 |

Listed, not fixed:

- **The Stripe "before" revision.** Saving the contract a repository starts from needs the `stripe/openapi` commit whose spec carries that repository's pinned API version. Refit has no lookup from an API version to that commit, so doctor and `agents --add` keep one named placeholder (`<stripe/openapi commit for the API version your code pins>`) and `stripe-snapshot --help` says how to choose it.
- **Shopify versions and OpenAI's spec URL.** The commands name what to fill in (`<the Admin API version your code pins>`, `<the provider's public OpenAPI URL>`); Refit does not know them for a repository.
- **`refit hosted` errors** still print the class name: `pipeline/hosted-cli.ts` belongs to another lane, which is asked to use the same formatter.
- **The "needs attention" exit code** stays 2 and the JSON (`refit doctor --json`) keeps every field, including the full scope list, for scripts.

## Verdicts

Every repository now reaches a clear verdict with the next command to run. After `refit agents --add`:

| Repository                                   | Doctor's first two lines                                                                                                                                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stripe app, pnpm monorepo, app with no tests | `Refit setup needs attention: 2 of 4 checks blocked` / `Next: Save the contracts: refit stripe-snapshot --revision <…> --output refit/stripe-before.json and refit stripe-snapshot --latest --output refit/stripe-after.json. Then run refit doctor again.` |
| Shopify app                                  | `… 2 of 5 checks blocked` / `Next: Save the contracts: refit shopify-snapshot --version <the Admin API version your code pins> --output refit/shopify-before.json and …`                                                                                    |
| OpenAI app                                   | `… 2 of 4 checks blocked` / `Next: Save the contracts: refit source-snapshot --provider openai --url <the provider's public OpenAPI URL> --output refit/openai-before.json and …`                                                                           |
| Stripe app, configured and committed         | `… 3 of 10 checks blocked` / `Next: Run refit run --human to see where each removed parameter is still sent, and change those calls yourself: Refit has no reviewed replacement for them.`                                                                  |

Before, all five stopped at "could not access a required file or executable", and after `agents --add` at "Choose --integration from: …". The configured Stripe app never got past that line, and its `refit run` failed with exit code 1.

## `refit deadlines` (keep going)

| Scenario                      | Repository                                                                                  | Before                                                                                                                                               | Now                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| No deadlines                  | `manucoffin/faster-fixes`                                                                   | "No API version or model this repository uses in live code has a deadline in the registry."                                                          | Unchanged; already clear                                                                                                                            |
| An expired one                | `Hujjat/easy-product-recommendations` at `e59b2fc` (Shopify Admin API 2025-10, 6 days past) | The registry summary, which reads as a future change, and "(passed 6 days ago)"                                                                      | `Past due: …` and `(passed 6 days ago; already in effect)`                                                                                          |
| Only test-file hits           | `StretchShop/StretchShop` at `64e4944` (`gpt-4` in `test/unit/…spec.js`)                    | No live exposure, then the test hits under "Named only outside live code"                                                                            | Unchanged; already clear                                                                                                                            |
| A retiring model (Stripe app) | `Hombre2014/Genius` (`gpt-3.5-turbo`)                                                       | Migration: "Add it with `refit agents --add openai`, save reviewed contracts, then approve … with `refit enroll`", the path for API contract changes | Migration: `refit deadlines --propose-model-fixes` shows the patch to `gpt-5.6-terra`; `refit serve --model-fixes` can validate it and open a draft |

The deadline alert issues `refit serve --deadline-alerts` opens use the same migration note (`pipeline/deadline-alerts.ts`); that file is shared with the hosted monitoring lane, which is asked to make the same change.

## Transcripts

Paths are shortened to `<repos>/…` and temporary evidence directories to `<tmp>`.

<details>
<summary>First run, before</summary>

```text
## stripe-app

$ refit doctor
Refit setup needs attention

Configuration  <repos>/stripe-app/.refit.json

BLOCKED  Workflow configuration
  Workflow configuration could not access a required file or executable.
  Next: Supply --config with a valid workflow file, or commit .refit.json in the repository root.

Readiness permits an attempt at validation; it does not prove migration correctness or test quality.
No application code, dependency installation, model request, source download, GitHub request or publication is performed.
Only bounded ESM/CommonJS client patterns, supported repository aliases and configured SDK mappings are inspected; other usage can remain undetected.
The configuration is not approved or activated by this command. SDK/API-version rollout and effective account versions still need review.
[exit 2]

$ refit agents
Providers detected in <repos>/stripe-app

Stripe          agent available: refit agents --add stripe
  stripe ^13.10.0 (locked 13.10.0) in package.json
OpenAI          agent available: refit agents --add openai
  openai ^4.14.0 (locked 4.14.0) in package.json
[exit 0]

$ refit agents --add stripe
Providers detected in <repos>/stripe-app

Stripe          configured
  stripe ^13.10.0 (locked 13.10.0) in package.json
OpenAI          agent available: refit agents --add openai
  openai ^4.14.0 (locked 4.14.0) in package.json

Added to .refit.json: stripe
- Save reviewed Stripe contracts at refit/stripe-before.json and refit/stripe-after.json (refit stripe-snapshot --revision <sha> --output …).
- Review the check command, then run refit doctor. Nothing runs until you approve the configuration with refit enroll.
[exit 0]

$ refit doctor
Refit setup needs attention

Configuration  <repos>/stripe-app/.refit.json

BLOCKED  Workflow configuration
  Choose --integration from: stripe.
  Next: Supply --config with a valid workflow file, or commit .refit.json in the repository root.

Readiness permits an attempt at validation; it does not prove migration correctness or test quality.
No application code, dependency installation, model request, source download, GitHub request or publication is performed.
Only bounded ESM/CommonJS client patterns, supported repository aliases and configured SDK mappings are inspected; other usage can remain undetected.
The configuration is not approved or activated by this command. SDK/API-version rollout and effective account versions still need review.
[exit 2]

## pnpm-monorepo

$ refit doctor
Refit setup needs attention

Configuration  <repos>/pnpm-monorepo/.refit.json

BLOCKED  Workflow configuration
  Workflow configuration could not access a required file or executable.
  Next: Supply --config with a valid workflow file, or commit .refit.json in the repository root.

Readiness permits an attempt at validation; it does not prove migration correctness or test quality.
No application code, dependency installation, model request, source download, GitHub request or publication is performed.
Only bounded ESM/CommonJS client patterns, supported repository aliases and configured SDK mappings are inspected; other usage can remain undetected.
The configuration is not approved or activated by this command. SDK/API-version rollout and effective account versions still need review.
[exit 2]

$ refit agents
Providers detected in <repos>/pnpm-monorepo

Stripe          agent available: refit agents --add stripe
  stripe ^20.2.0 (locked 20.2.0) in apps/web/package.json
Resend          no agent yet
  resend ^6.9.3 (locked 6.9.3) in apps/web/package.json
[exit 0]

$ refit agents --add stripe
Providers detected in <repos>/pnpm-monorepo

Stripe          configured
  stripe ^20.2.0 (locked 20.2.0) in apps/web/package.json
Resend          no agent yet
  resend ^6.9.3 (locked 6.9.3) in apps/web/package.json

Added to .refit.json: stripe
- Save reviewed Stripe contracts at refit/stripe-before.json and refit/stripe-after.json (refit stripe-snapshot --revision <sha> --output …).
- Review the check command, then run refit doctor. Nothing runs until you approve the configuration with refit enroll.
[exit 0]

$ refit doctor
Refit setup needs attention

Configuration  <repos>/pnpm-monorepo/.refit.json

BLOCKED  Workflow configuration
  Choose --integration from: stripe.
  Next: Supply --config with a valid workflow file, or commit .refit.json in the repository root.

Readiness permits an attempt at validation; it does not prove migration correctness or test quality.
No application code, dependency installation, model request, source download, GitHub request or publication is performed.
Only bounded ESM/CommonJS client patterns, supported repository aliases and configured SDK mappings are inspected; other usage can remain undetected.
The configuration is not approved or activated by this command. SDK/API-version rollout and effective account versions still need review.
[exit 2]

## no-tests

$ refit doctor
Refit setup needs attention

Configuration  <repos>/no-tests/.refit.json

BLOCKED  Workflow configuration
  Workflow configuration could not access a required file or executable.
  Next: Supply --config with a valid workflow file, or commit .refit.json in the repository root.

Readiness permits an attempt at validation; it does not prove migration correctness or test quality.
No application code, dependency installation, model request, source download, GitHub request or publication is performed.
Only bounded ESM/CommonJS client patterns, supported repository aliases and configured SDK mappings are inspected; other usage can remain undetected.
The configuration is not approved or activated by this command. SDK/API-version rollout and effective account versions still need review.
[exit 2]

$ refit agents
Providers detected in <repos>/no-tests

Stripe          agent available: refit agents --add stripe
  stripe ^14.25.0 (locked 14.25.0) in package.json
OpenAI          agent available: refit agents --add openai
  openai ^4.26.1 (locked 4.104.0) in package.json
Gemini          no agent yet
  generativelanguage.googleapis.com at src/app/api/message/route.ts:139
[exit 0]

$ refit agents --add stripe
Providers detected in <repos>/no-tests

Stripe          configured
  stripe ^14.25.0 (locked 14.25.0) in package.json
OpenAI          agent available: refit agents --add openai
  openai ^4.26.1 (locked 4.104.0) in package.json
Gemini          no agent yet
  generativelanguage.googleapis.com at src/app/api/message/route.ts:139

Added to .refit.json: stripe
- Save reviewed Stripe contracts at refit/stripe-before.json and refit/stripe-after.json (refit stripe-snapshot --revision <sha> --output …).
- Review the check command, then run refit doctor. Nothing runs until you approve the configuration with refit enroll.
[exit 0]

$ refit doctor
Refit setup needs attention

Configuration  <repos>/no-tests/.refit.json

BLOCKED  Workflow configuration
  Choose --integration from: stripe.
  Next: Supply --config with a valid workflow file, or commit .refit.json in the repository root.

Readiness permits an attempt at validation; it does not prove migration correctness or test quality.
No application code, dependency installation, model request, source download, GitHub request or publication is performed.
Only bounded ESM/CommonJS client patterns, supported repository aliases and configured SDK mappings are inspected; other usage can remain undetected.
The configuration is not approved or activated by this command. SDK/API-version rollout and effective account versions still need review.
[exit 2]

## shopify-app

$ refit doctor
Refit setup needs attention

Configuration  <repos>/shopify-app/.refit.json

BLOCKED  Workflow configuration
  Workflow configuration could not access a required file or executable.
  Next: Supply --config with a valid workflow file, or commit .refit.json in the repository root.

Readiness permits an attempt at validation; it does not prove migration correctness or test quality.
No application code, dependency installation, model request, source download, GitHub request or publication is performed.
Only bounded ESM/CommonJS client patterns, supported repository aliases and configured SDK mappings are inspected; other usage can remain undetected.
The configuration is not approved or activated by this command. SDK/API-version rollout and effective account versions still need review.
[exit 2]

$ refit agents
Providers detected in <repos>/shopify-app

Shopify         agent available: refit agents --add shopify
  @shopify/shopify-app-react-router ^3.0.1 in package.json
[exit 0]

$ refit agents --add shopify
Providers detected in <repos>/shopify-app

Shopify         configured
  @shopify/shopify-app-react-router ^3.0.1 in package.json

Added to .refit.json: shopify
- Save reviewed Shopify contracts at refit/shopify-before.json and refit/shopify-after.json (refit shopify-snapshot --version <pinned version, or 2026-01 if older> --output … and --version <target>).
- Review the check command, then run refit doctor. Nothing runs until you approve the configuration with refit enroll.
[exit 0]

$ refit doctor
Refit setup needs attention

Configuration  <repos>/shopify-app/.refit.json

BLOCKED  Workflow configuration
  Choose --integration from: shopify.
  Next: Supply --config with a valid workflow file, or commit .refit.json in the repository root.

Readiness permits an attempt at validation; it does not prove migration correctness or test quality.
No application code, dependency installation, model request, source download, GitHub request or publication is performed.
Only bounded ESM/CommonJS client patterns, supported repository aliases and configured SDK mappings are inspected; other usage can remain undetected.
The configuration is not approved or activated by this command. SDK/API-version rollout and effective account versions still need review.
[exit 2]

## openai-app

$ refit doctor
Refit setup needs attention

Configuration  <repos>/openai-app/.refit.json

BLOCKED  Workflow configuration
  Workflow configuration could not access a required file or executable.
  Next: Supply --config with a valid workflow file, or commit .refit.json in the repository root.

Readiness permits an attempt at validation; it does not prove migration correctness or test quality.
No application code, dependency installation, model request, source download, GitHub request or publication is performed.
Only bounded ESM/CommonJS client patterns, supported repository aliases and configured SDK mappings are inspected; other usage can remain undetected.
The configuration is not approved or activated by this command. SDK/API-version rollout and effective account versions still need review.
[exit 2]

$ refit agents
Providers detected in <repos>/openai-app

OpenAI          agent available: refit agents --add openai
  openai ^6.25.0 (locked 6.25.0) in package.json
Anthropic       no agent yet
  api.anthropic.com at lib/claude-usage.test.ts:94
  api.anthropic.com at lib/claude-usage.ts:6
[exit 0]

$ refit agents --add openai
Providers detected in <repos>/openai-app

OpenAI          configured
  openai ^6.25.0 (locked 6.25.0) in package.json
Anthropic       no agent yet
  api.anthropic.com at lib/claude-usage.test.ts:94
  api.anthropic.com at lib/claude-usage.ts:6

Added to .refit.json: openai
- Save reviewed OpenAI contracts at refit/openai-before.json and refit/openai-after.json (refit source-snapshot …).
- Review the check command, then run refit doctor. Nothing runs until you approve the configuration with refit enroll.
[exit 0]

$ refit doctor
Refit setup needs attention

Configuration  <repos>/openai-app/.refit.json

BLOCKED  Workflow configuration
  Choose --integration from: openai.
  Next: Supply --config with a valid workflow file, or commit .refit.json in the repository root.

Readiness permits an attempt at validation; it does not prove migration correctness or test quality.
No application code, dependency installation, model request, source download, GitHub request or publication is performed.
Only bounded ESM/CommonJS client patterns, supported repository aliases and configured SDK mappings are inspected; other usage can remain undetected.
The configuration is not approved or activated by this command. SDK/API-version rollout and effective account versions still need review.
[exit 2]

## stripe-app, continued

(saved refit/stripe-before.json for API version 2023-08-16 and refit/stripe-after.json from refit stripe-snapshot --latest)

$ git add .refit.json refit
[exit 0]

$ git -c user.name=New -c user.email=new@example.invalid commit -qm Configure Refit
[exit 0]

$ refit doctor
Refit setup needs attention

Configuration  <repos>/stripe-app/.refit.json

BLOCKED  Workflow configuration
  Choose --integration from: stripe.
  Next: Supply --config with a valid workflow file, or commit .refit.json in the repository root.

Readiness permits an attempt at validation; it does not prove migration correctness or test quality.
No application code, dependency installation, model request, source download, GitHub request or publication is performed.
Only bounded ESM/CommonJS client patterns, supported repository aliases and configured SDK mappings are inspected; other usage can remain undetected.
The configuration is not approved or activated by this command. SDK/API-version rollout and effective account versions still need review.
[exit 2]

$ refit run --human
PipelineInputError: Choose --integration from: stripe.
[exit 1]
```

</details>

<details>
<summary>First run, after</summary>

```text
## stripe-app

$ refit doctor
Refit setup needs attention: 1 of 1 check blocked
Next: Run refit agents to see which provider agents apply, then refit agents --add <id> to write .refit.json.

Configuration  <repos>/stripe-app/.refit.json

BLOCKED  Workflow configuration
  No .refit.json in <repos>/stripe-app yet.
  Next: Run refit agents to see which provider agents apply, then refit agents --add <id> to write .refit.json.

Doctor only reads files: it runs no code, installs and downloads nothing, and the configuration is not approved or activated. Passing checks permit a validation attempt, not proof the migration is correct.
[exit 2]

$ refit agents
Providers detected in <repos>/stripe-app

Stripe          agent available: refit agents --add stripe
  stripe ^13.10.0 (locked 13.10.0) in package.json
OpenAI          agent available: refit agents --add openai
  openai ^4.14.0 (locked 4.14.0) in package.json
[exit 0]

$ refit agents --add stripe
Providers detected in <repos>/stripe-app

Stripe          configured
  stripe ^13.10.0 (locked 13.10.0) in package.json
OpenAI          agent available: refit agents --add openai
  openai ^4.14.0 (locked 4.14.0) in package.json

Added to .refit.json: stripe
- Save reviewed Stripe contracts: refit stripe-snapshot --revision <stripe/openapi commit for the API version your code pins> --output refit/stripe-before.json and refit stripe-snapshot --latest --output refit/stripe-after.json.
- Review the check command in .refit.json, commit .refit.json and the contracts, then run refit doctor. The GitHub App runs nothing until you approve the configuration with refit enroll.
[exit 0]

$ refit doctor
Refit setup needs attention: 2 of 4 checks blocked
Next: Save the contracts: refit stripe-snapshot --revision <stripe/openapi commit for the API version your code pins> --output refit/stripe-before.json and refit stripe-snapshot --latest --output refit/stripe-after.json. Then run refit doctor again.

Configuration  <repos>/stripe-app/.refit.json
Integration    stripe
Repository     <repos>/stripe-app

PASS  Workflow configuration
  Workflow fields and check command arrays are valid.
BLOCKED  Committed repository
  Validation requires a clean committed repository, including untracked files; not committed: .refit.json.
  Next: Commit or stash the files it names, then run refit doctor again. Doctor needs the Git repository root with a committed HEAD; submodules and symlinks that resolve outside the repository are unsupported.
BLOCKED  Contracts and adapter
  Missing contracts: refit/stripe-before.json, refit/stripe-after.json.
  Next: Save the contracts: refit stripe-snapshot --revision <stripe/openapi commit for the API version your code pins> --output refit/stripe-before.json and refit stripe-snapshot --latest --output refit/stripe-after.json. Then run refit doctor again.
PASS  Local Docker image
  Existing image resolved to sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402. No container was started.

Doctor only reads files: it runs no code, installs and downloads nothing, and the configuration is not approved or activated. Passing checks permit a validation attempt, not proof the migration is correct.
[exit 2]

## pnpm-monorepo

$ refit doctor
Refit setup needs attention: 1 of 1 check blocked
Next: Run refit agents to see which provider agents apply, then refit agents --add <id> to write .refit.json.

Configuration  <repos>/pnpm-monorepo/.refit.json

BLOCKED  Workflow configuration
  No .refit.json in <repos>/pnpm-monorepo yet.
  Next: Run refit agents to see which provider agents apply, then refit agents --add <id> to write .refit.json.

Doctor only reads files: it runs no code, installs and downloads nothing, and the configuration is not approved or activated. Passing checks permit a validation attempt, not proof the migration is correct.
[exit 2]

$ refit agents
Providers detected in <repos>/pnpm-monorepo

Stripe          agent available: refit agents --add stripe
  stripe ^20.2.0 (locked 20.2.0) in apps/web/package.json
Resend          no agent yet
  resend ^6.9.3 (locked 6.9.3) in apps/web/package.json
[exit 0]

$ refit agents --add stripe
Providers detected in <repos>/pnpm-monorepo

Stripe          configured
  stripe ^20.2.0 (locked 20.2.0) in apps/web/package.json
Resend          no agent yet
  resend ^6.9.3 (locked 6.9.3) in apps/web/package.json

Added to .refit.json: stripe
- Save reviewed Stripe contracts: refit stripe-snapshot --revision <stripe/openapi commit for the API version your code pins> --output refit/stripe-before.json and refit stripe-snapshot --latest --output refit/stripe-after.json.
- Review the check command in .refit.json, commit .refit.json and the contracts, then run refit doctor. The GitHub App runs nothing until you approve the configuration with refit enroll.
[exit 0]

$ refit doctor
Refit setup needs attention: 2 of 4 checks blocked
Next: Save the contracts: refit stripe-snapshot --revision <stripe/openapi commit for the API version your code pins> --output refit/stripe-before.json and refit stripe-snapshot --latest --output refit/stripe-after.json. Then run refit doctor again.

Configuration  <repos>/pnpm-monorepo/.refit.json
Integration    stripe
Repository     <repos>/pnpm-monorepo

PASS  Workflow configuration
  Workflow fields and check command arrays are valid.
BLOCKED  Committed repository
  Validation requires a clean committed repository, including untracked files; not committed: .refit.json.
  Next: Commit or stash the files it names, then run refit doctor again. Doctor needs the Git repository root with a committed HEAD; submodules and symlinks that resolve outside the repository are unsupported.
BLOCKED  Contracts and adapter
  Missing contracts: refit/stripe-before.json, refit/stripe-after.json.
  Next: Save the contracts: refit stripe-snapshot --revision <stripe/openapi commit for the API version your code pins> --output refit/stripe-before.json and refit stripe-snapshot --latest --output refit/stripe-after.json. Then run refit doctor again.
PASS  Local Docker image
  Existing image resolved to sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402. No container was started.

Doctor only reads files: it runs no code, installs and downloads nothing, and the configuration is not approved or activated. Passing checks permit a validation attempt, not proof the migration is correct.
[exit 2]

## no-tests

$ refit doctor
Refit setup needs attention: 1 of 1 check blocked
Next: Run refit agents to see which provider agents apply, then refit agents --add <id> to write .refit.json.

Configuration  <repos>/no-tests/.refit.json

BLOCKED  Workflow configuration
  No .refit.json in <repos>/no-tests yet.
  Next: Run refit agents to see which provider agents apply, then refit agents --add <id> to write .refit.json.

Doctor only reads files: it runs no code, installs and downloads nothing, and the configuration is not approved or activated. Passing checks permit a validation attempt, not proof the migration is correct.
[exit 2]

$ refit agents
Providers detected in <repos>/no-tests

Stripe          agent available: refit agents --add stripe
  stripe ^14.25.0 (locked 14.25.0) in package.json
OpenAI          agent available: refit agents --add openai
  openai ^4.26.1 (locked 4.104.0) in package.json
Gemini          no agent yet
  generativelanguage.googleapis.com at src/app/api/message/route.ts:139
[exit 0]

$ refit agents --add stripe
Providers detected in <repos>/no-tests

Stripe          configured
  stripe ^14.25.0 (locked 14.25.0) in package.json
OpenAI          agent available: refit agents --add openai
  openai ^4.26.1 (locked 4.104.0) in package.json
Gemini          no agent yet
  generativelanguage.googleapis.com at src/app/api/message/route.ts:139

Added to .refit.json: stripe
- Save reviewed Stripe contracts: refit stripe-snapshot --revision <stripe/openapi commit for the API version your code pins> --output refit/stripe-before.json and refit stripe-snapshot --latest --output refit/stripe-after.json.
- Review the check command in .refit.json, commit .refit.json and the contracts, then run refit doctor. The GitHub App runs nothing until you approve the configuration with refit enroll.
[exit 0]

$ refit doctor
Refit setup needs attention: 2 of 4 checks blocked
Next: Save the contracts: refit stripe-snapshot --revision <stripe/openapi commit for the API version your code pins> --output refit/stripe-before.json and refit stripe-snapshot --latest --output refit/stripe-after.json. Then run refit doctor again.

Configuration  <repos>/no-tests/.refit.json
Integration    stripe
Repository     <repos>/no-tests

PASS  Workflow configuration
  Workflow fields and check command arrays are valid.
BLOCKED  Committed repository
  Validation requires a clean committed repository, including untracked files; not committed: .refit.json.
  Next: Commit or stash the files it names, then run refit doctor again. Doctor needs the Git repository root with a committed HEAD; submodules and symlinks that resolve outside the repository are unsupported.
BLOCKED  Contracts and adapter
  Missing contracts: refit/stripe-before.json, refit/stripe-after.json.
  Next: Save the contracts: refit stripe-snapshot --revision <stripe/openapi commit for the API version your code pins> --output refit/stripe-before.json and refit stripe-snapshot --latest --output refit/stripe-after.json. Then run refit doctor again.
PASS  Local Docker image
  Existing image resolved to sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402. No container was started.

Doctor only reads files: it runs no code, installs and downloads nothing, and the configuration is not approved or activated. Passing checks permit a validation attempt, not proof the migration is correct.
[exit 2]

## shopify-app

$ refit doctor
Refit setup needs attention: 1 of 1 check blocked
Next: Run refit agents to see which provider agents apply, then refit agents --add <id> to write .refit.json.

Configuration  <repos>/shopify-app/.refit.json

BLOCKED  Workflow configuration
  No .refit.json in <repos>/shopify-app yet.
  Next: Run refit agents to see which provider agents apply, then refit agents --add <id> to write .refit.json.

Doctor only reads files: it runs no code, installs and downloads nothing, and the configuration is not approved or activated. Passing checks permit a validation attempt, not proof the migration is correct.
[exit 2]

$ refit agents
Providers detected in <repos>/shopify-app

Shopify         agent available: refit agents --add shopify
  @shopify/shopify-app-react-router ^3.0.1 in package.json
[exit 0]

$ refit agents --add shopify
Providers detected in <repos>/shopify-app

Shopify         configured
  @shopify/shopify-app-react-router ^3.0.1 in package.json

Added to .refit.json: shopify
- Save reviewed Shopify contracts: refit shopify-snapshot --version <the Admin API version your code pins> --output refit/shopify-before.json and refit shopify-snapshot --version <the version to move to> --output refit/shopify-after.json.
- Review the check command in .refit.json, commit .refit.json and the contracts, then run refit doctor. The GitHub App runs nothing until you approve the configuration with refit enroll.
[exit 0]

$ refit doctor
Refit setup needs attention: 2 of 5 checks blocked
Next: Save the contracts: refit shopify-snapshot --version <the Admin API version your code pins> --output refit/shopify-before.json and refit shopify-snapshot --version <the version to move to> --output refit/shopify-after.json. Then run refit doctor again.

Configuration  <repos>/shopify-app/.refit.json
Integration    shopify
Repository     <repos>/shopify-app

PASS  Workflow configuration
  Workflow fields and check command arrays are valid.
BLOCKED  Committed repository
  Validation requires a clean committed repository, including untracked files; not committed: .refit.json.
  Next: Commit or stash the files it names, then run refit doctor again. Doctor needs the Git repository root with a committed HEAD; submodules and symlinks that resolve outside the repository are unsupported.
BLOCKED  Contracts and adapter
  Missing contracts: refit/shopify-before.json, refit/shopify-after.json.
  Next: Save the contracts: refit shopify-snapshot --version <the Admin API version your code pins> --output refit/shopify-before.json and refit shopify-snapshot --version <the version to move to> --output refit/shopify-after.json. Then run refit doctor again.
REVIEW  Validation dependencies
  A custom validation image must supply the dependencies used by the check commands.
  Next: Run baseline validation to verify that the image contains the required runtime and dependencies.
PASS  Local Docker image
  Existing image resolved to sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402. No container was started.

Doctor only reads files: it runs no code, installs and downloads nothing, and the configuration is not approved or activated. Passing checks permit a validation attempt, not proof the migration is correct.
[exit 2]

## openai-app

$ refit doctor
Refit setup needs attention: 1 of 1 check blocked
Next: Run refit agents to see which provider agents apply, then refit agents --add <id> to write .refit.json.

Configuration  <repos>/openai-app/.refit.json

BLOCKED  Workflow configuration
  No .refit.json in <repos>/openai-app yet.
  Next: Run refit agents to see which provider agents apply, then refit agents --add <id> to write .refit.json.

Doctor only reads files: it runs no code, installs and downloads nothing, and the configuration is not approved or activated. Passing checks permit a validation attempt, not proof the migration is correct.
[exit 2]

$ refit agents
Providers detected in <repos>/openai-app

OpenAI          agent available: refit agents --add openai
  openai ^6.25.0 (locked 6.25.0) in package.json
Anthropic       no agent yet
  api.anthropic.com at lib/claude-usage.test.ts:94
  api.anthropic.com at lib/claude-usage.ts:6
[exit 0]

$ refit agents --add openai
Providers detected in <repos>/openai-app

OpenAI          configured
  openai ^6.25.0 (locked 6.25.0) in package.json
Anthropic       no agent yet
  api.anthropic.com at lib/claude-usage.test.ts:94
  api.anthropic.com at lib/claude-usage.ts:6

Added to .refit.json: openai
- Save reviewed OpenAI contracts: refit source-snapshot --provider openai --url <the provider's public OpenAPI URL> --output refit/openai-before.json and refit source-snapshot --provider openai --url <the provider's public OpenAPI URL> --output refit/openai-after.json.
- Review the check command in .refit.json, commit .refit.json and the contracts, then run refit doctor. The GitHub App runs nothing until you approve the configuration with refit enroll.
[exit 0]

$ refit doctor
Refit setup needs attention: 2 of 4 checks blocked
Next: Save the contracts: refit source-snapshot --provider openai --url <the provider's public OpenAPI URL> --output refit/openai-before.json and refit source-snapshot --provider openai --url <the provider's public OpenAPI URL> --output refit/openai-after.json. Then run refit doctor again.

Configuration  <repos>/openai-app/.refit.json
Integration    openai
Repository     <repos>/openai-app

PASS  Workflow configuration
  Workflow fields and check command arrays are valid.
BLOCKED  Committed repository
  Validation requires a clean committed repository, including untracked files; not committed: .refit.json, refit/openai.provider.json.
  Next: Commit or stash the files it names, then run refit doctor again. Doctor needs the Git repository root with a committed HEAD; submodules and symlinks that resolve outside the repository are unsupported.
BLOCKED  Contracts and adapter
  Missing contracts: refit/openai-before.json, refit/openai-after.json.
  Next: Save the contracts: refit source-snapshot --provider openai --url <the provider's public OpenAPI URL> --output refit/openai-before.json and refit source-snapshot --provider openai --url <the provider's public OpenAPI URL> --output refit/openai-after.json. Then run refit doctor again.
PASS  Local Docker image
  Existing image resolved to sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402. No container was started.

Doctor only reads files: it runs no code, installs and downloads nothing, and the configuration is not approved or activated. Passing checks permit a validation attempt, not proof the migration is correct.
[exit 2]

## stripe-app, continued

(saved refit/stripe-before.json for API version 2023-08-16 and refit/stripe-after.json from refit stripe-snapshot --latest)

$ git add .refit.json refit
[exit 0]

$ git -c user.name=New -c user.email=new@example.invalid commit -qm Configure Refit
[exit 0]

$ refit doctor
Refit setup needs attention: 3 of 10 checks blocked
Next: Run refit run --human to see where each removed parameter is still sent, and change those calls yourself: Refit has no reviewed replacement for them.

Configuration  <repos>/stripe-app/.refit.json
Integration    stripe
Repository     <repos>/stripe-app
Provider       stripe

PASS  Workflow configuration
  Workflow fields and check command arrays are valid.
PASS  Committed repository
  Clean committed root at 9f60e47e7b48.
PASS  Contracts and adapter
  66 source files inspected; adapter contracts resolved. Both supplied contracts were inspected.
BLOCKED  Migration source evidence
  A traced SDK request sends a parameter the target API version removed. No reviewed replacement exists, and dropping or replacing it changes request behavior; automatic migration, AI and publication stop for review.
  Next: Run refit run --human to see where each removed parameter is still sent, and change those calls yourself: Refit has no reviewed replacement for them.
PASS  Webhook payload migration
  Webhook subscription-period reads accept both the old and the new payload shape, so the endpoint version can change separately. Items on different billing periods use the item the application already selects or the configured price policy. Runtime checks have not run.
BLOCKED  Application API version
  Application API version is not configured; automated migration requires an exact match to the before contract version. SDK API-version declarations are missing, dynamic or unsafe to resolve statically; the operator pin is not verified in source. Policy: operator-pin.
  Next: Confirm your client and account use 2023-08-16, then add "apiVersion": "2023-08-16" to the stripe integration in .refit.json.
BLOCKED  Supported migration coverage
  The supplied contracts contain unresolved breaking changes without a supported migration rule.
  Next: Run refit run --human to list them. Refit has no automatic migration for these changes, so they need a manual migration or a reviewed adapter rule before validation.
PASS  SDK call mapping
  4 of 4 observed SDK API calls have configured mappings. 1 local webhook signature constructor recognized; incoming version and policy require separate review. This count does not prove complete code coverage.
PASS  Dependency preparation inputs
  546 locked package records passed preparation input checks. Installation and engine compatibility were not tested.
PASS  Local Docker image
  Existing image resolved to sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402. No container was started.

Doctor only reads files: it runs no code, installs and downloads nothing, and the configuration is not approved or activated. Passing checks permit a validation attempt, not proof the migration is correct.
[exit 2]

$ refit run --human
[refit] Selected integration: stripe.
[refit] Preparing API specifications...
[refit] Scanning repository for affected API usage...
[refit] needs-review: A traced SDK request sends a parameter the target API version removed. No reviewed replacement exists, and dropping or replacing it changes request behavior; automatic migration, AI and publication stop for review.
[refit] Evidence: <tmp>
Refit needs review

Integration stripe
API change  Stripe removes invoice.subscription, subscription.current_period_end
API version Current: unknown; before contract: 2023-08-16; after contract: 2026-09-30.endive
Webhooks    1 affected payload read; incoming API version requires review
Events      invoice.payment_succeeded
Found       4 confirmed usages in 2 files
Removed     payment_method_types is still sent at app/api/stripe/route.ts:37
Evidence    <tmp>

A traced SDK request sends a parameter the target API version removed. No reviewed replacement exists, and dropping or replacing it changes request behavior; automatic migration, AI and publication stop for review.
[exit 2]
```

</details>

<details>
<summary>Errors, before</summary>

```text
$ refit run
PipelineInputError: No .refit.json at <repos>/stripe-app. Run refit doctor for setup diagnostics, or supply --config with an existing workflow.
[exit 1]

$ refit doctor --repository /nonexistent
Refit setup needs attention

Configuration  /nonexistent/.refit.json
Repository     /nonexistent

BLOCKED  Workflow configuration
  Workflow configuration could not access a required file or executable.
  Next: Supply --config with a valid workflow file, or commit .refit.json in the repository root.
[exit 2]

$ refit doctor --config missing.json
Refit setup needs attention

Configuration  <repos>/stripe-app/missing.json

BLOCKED  Workflow configuration
  Workflow configuration could not access a required file or executable.
  Next: Supply --config with a valid workflow file, or commit .refit.json in the repository root.

[exit 2]

$ refit agents --add paypal
PipelineInputError: paypal was not detected in this repository; only detected agents can be added.
[exit 1]

$ refit stripe-snapshot --latest
Usage: refit stripe-snapshot (--revision <full-commit-sha> | --latest) --output <new-snapshot.json>
[exit 1]

$ refit deadlines --repository /nonexistent
Error: ENOENT: no such file or directory, realpath '/nonexistent'
[exit 1]

$ refit doctor --bogus
TypeError: Unknown option '--bogus'
[exit 1]
```

</details>

<details>
<summary>Errors, after</summary>

```text
$ refit run
refit run: No .refit.json at <repos>/stripe-app. Run refit agents to see which provider agents apply and refit agents --add <id> to write one, or supply --config with an existing workflow.
[exit 1]

$ refit doctor --repository /nonexistent
Refit setup needs attention: 1 of 1 check blocked
Next: Check the --repository path, or run refit doctor from inside the repository.

Configuration  /nonexistent/.refit.json
Repository     /nonexistent

BLOCKED  Workflow configuration
  /nonexistent does not exist.
[exit 2]

$ refit doctor --config missing.json
Refit setup needs attention: 1 of 1 check blocked
Next: Check the --config path, or omit --config to use the repository's .refit.json.

Configuration  <repos>/stripe-app/missing.json

BLOCKED  Workflow configuration
  <repos>/stripe-app/missing.json does not exist.
  Next: Check the --config path, or omit --config to use the repository's .refit.json.
[exit 2]

$ refit agents --add paypal
refit agents: paypal was not detected in this repository; only detected agents can be added.
[exit 1]

$ refit stripe-snapshot --latest
refit stripe-snapshot: --output <new-snapshot.json> is required.
Usage: refit stripe-snapshot (--revision <full-commit-sha> | --latest) --output <new-snapshot.json>
Saves Stripe's published OpenAPI document from github.com/stripe/openapi as a pinned snapshot. Use --latest for the contract to move to, and --revision with the stripe/openapi commit whose spec has your code's pinned API version for the contract you start from.
[exit 1]

$ refit deadlines --repository /nonexistent
refit deadlines: /nonexistent does not exist.
[exit 1]

$ refit doctor --bogus
refit doctor: Unknown option '--bogus'. Run refit doctor --help for its options.
[exit 1]
```

</details>

<details>
<summary>refit deadlines, before</summary>

```text
## pnpm-monorepo

$ refit deadlines
Refit deadlines  <repos>/pnpm-monorepo

No API version or model this repository uses in live code has a deadline in the registry.
[exit 0]

## deadlines-Hujjat__easy-product-recommendations

$ refit deadlines
Refit deadlines  <repos>/deadlines-Hujjat__easy-product-recommendations

Shopify API version 2025-10 stops being accessible at 15:00 UTC. Requests fall forward to the oldest accessible stable version.
  Deadline     2026-10-16 (passed 6 days ago)
  Replacement  A supported stable version
  Source       https://shopify.dev/docs/api/usage/versioning (checked 2026-10-15)
  .graphqlrc.js:9  apiVersion: ApiVersion.October25,
  app/shopify.server.js:17  apiVersion: ApiVersion.October25,
  app/shopify.server.js:52  export const apiVersion = ApiVersion.October25;
  Migration    Refit has a Shopify agent. Add it with `refit agents --add shopify`, save reviewed contracts, then approve the configuration with `refit enroll`. Migrations then run through the normal approval, validation and draft pull request gates.
[exit 0]

## deadlines-StretchShop__StretchShop

$ refit deadlines
Refit deadlines  <repos>/deadlines-StretchShop__StretchShop

No API version or model this repository uses in live code has a deadline in the registry.

Named only outside live code (not counted as exposure):

OpenAI shuts down gpt-4, gpt-4-0613, gpt-4-turbo, gpt-4-turbo-2024-04-09, gpt-4o-2024-05-13, o1, o1-2024-12-17, o1-pro, o3-mini. 2026-10-23 (1 day left)
  Not live     test       2  test/unit/services/orders-helpers-models.spec.js:85,90
[exit 0]

## stripe-app

$ refit deadlines
Refit deadlines  <repos>/stripe-app

OpenAI shuts down gpt-3.5-turbo, gpt-3.5-turbo-0125, o4-mini.
  Deadline     2026-10-23 (1 day left)
  Replacement  gpt-5.6-terra
  Source       https://developers.openai.com/api/docs/deprecations (checked 2026-10-15)
  app/api/code/route.ts:47  model: 'gpt-3.5-turbo',
  app/api/conversation/route.ts:36  model: 'gpt-3.5-turbo',
  Migration    Refit has an OpenAI agent. Add it with `refit agents --add openai`, save reviewed contracts, then approve the configuration with `refit enroll`. Migrations then run through the normal approval, validation and draft pull request gates.
[exit 0]
```

</details>

<details>
<summary>refit deadlines, after</summary>

```text
## pnpm-monorepo

$ refit deadlines
Refit deadlines  <repos>/pnpm-monorepo

No API version or model this repository uses in live code has a deadline in the registry.
[exit 0]

## deadlines-Hujjat__easy-product-recommendations

$ refit deadlines
Refit deadlines  <repos>/deadlines-Hujjat__easy-product-recommendations

Past due: Shopify API version 2025-10 stops being accessible at 15:00 UTC. Requests fall forward to the oldest accessible stable version.
  Deadline     2026-10-16 (passed 6 days ago; already in effect)
  Replacement  A supported stable version
  Source       https://shopify.dev/docs/api/usage/versioning (checked 2026-10-15)
  .graphqlrc.js:9  apiVersion: ApiVersion.October25,
  app/shopify.server.js:17  apiVersion: ApiVersion.October25,
  app/shopify.server.js:52  export const apiVersion = ApiVersion.October25;
  Migration    Refit has a Shopify agent. Add it with `refit agents --add shopify`, save reviewed contracts, then approve the configuration with `refit enroll`. Migrations then run through the normal approval, validation and draft pull request gates.
[exit 0]

## deadlines-StretchShop__StretchShop

$ refit deadlines
Refit deadlines  <repos>/deadlines-StretchShop__StretchShop

No API version or model this repository uses in live code has a deadline in the registry.

Named only outside live code (not counted as exposure):

OpenAI shuts down gpt-4, gpt-4-0613, gpt-4-turbo, gpt-4-turbo-2024-04-09, gpt-4o-2024-05-13, o1, o1-2024-12-17, o1-pro, o3-mini. 2026-10-23 (1 day left)
  Not live     test       2  test/unit/services/orders-helpers-models.spec.js:85,90
[exit 0]

## stripe-app

$ refit deadlines
Refit deadlines  <repos>/stripe-app

OpenAI shuts down gpt-3.5-turbo, gpt-3.5-turbo-0125, o4-mini.
  Deadline     2026-10-23 (1 day left)
  Replacement  gpt-5.6-terra
  Source       https://developers.openai.com/api/docs/deprecations (checked 2026-10-15)
  app/api/code/route.ts:47  model: 'gpt-3.5-turbo',
  app/api/conversation/route.ts:36  model: 'gpt-3.5-turbo',
  Migration    Run `refit deadlines --propose-model-fixes` to see a patch that moves each traced call to gpt-5.6-terra; it applies nothing. `refit serve --model-fixes` can validate it and open a draft pull request.
[exit 0]
```

</details>
