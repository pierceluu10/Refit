# Validating in a customer's environment

Refit validates a patch by running the repository's checks offline on dependencies installed from the committed lockfile ([Dependencies](DEPENDENCIES.md)). Its own preparation is strict: public registry only, verified integrity, install scripts off. Real repositories often fall outside that. They use a private registry, a Git or URL dependency, a workspace layout the installer does not read, or a package that needs its install script. Each of these ends in a named preparation stop ([Preparation failures](PREPARATION-FAILURES.md#named-stops)).

**Founder decision (Otabek, 2026-10-28):** customers do nothing except install Refit and approve pull requests. No `.refit.json` setting is required. No doctor or enroll message, preparation stop or draft asks a customer to set a setting, publish an image or add a key. Refit may run a customer's own install steps in its own sandbox. This supersedes the 2026-10-27 decision, which kept option 2 below as design only and required a separate decision before running customer build steps.

**Founder clarification (Otabek, 2026-10-28):** "customers do nothing except install Refit on their repository and approve the PRs Refit opens. No setting, image, key, sandbox, config file or manual step, ever."

- Refit works fully with no customer action after install. Everything it needs comes from what the repository already commits, or Refit builds it.
- The validation-workflow pull request (step 4) is an optional extra, and nothing depends on it being merged. If the customer ignores or closes it, Refit still validates with its own environment, and each draft says what Refit could not check.
- A stop names what Refit could not do, never a task for the customer. Drafts label it "What Refit could not do", where they used to say "What to do".

## What runs where

| Step                                                                                                                                  | Where                                        | Network                                                      | Secrets                     |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------ | --------------------------- |
| 1. Refit's own preparation (`pipeline/dependency-preparation.ts`), unchanged                                                          | Refit's Docker host, a preparation container | `bridge`, public registry only, scripts off                  | none                        |
| 2. The repository's own install, when 1 refuses (`pipeline/repository-environment.ts`)                                                | Refit's Docker host, a build sandbox         | An internal network whose only exit is an allowlisting proxy | none                        |
| 3. Checks, baseline then patch (`pipeline/validation.ts`), unchanged                                                                  | Refit's Docker host, the check sandbox       | `none`                                                       | none                        |
| 4. Optional: the customer's CI, when 2 needs something only the customer has and they merged the workflow (`pipeline/customer-ci.ts`) | The customer's GitHub Actions                | Whatever their CI has                                        | The customer's, in their CI |

Steps 1 and 3 are exactly as before. Step 3 runs with every gate whichever step produced the dependencies: baseline then patch, `compareTypeErrors`, evidence grades, the AI gates, `[Needs review]` publication, and the rule that a patch whose checks failed never publishes.

## Step 2: Refit builds the environment from the repository's own install

**Deriving the install** (`installPlan` in `pipeline/repository-install.ts`). Refit reads what the repository commits, in this order:

1. a root `Dockerfile`'s `RUN` lines;
2. `.devcontainer/devcontainer.json` (or `.devcontainer.json`): `onCreateCommand`, `updateContentCommand`, `postCreateCommand`;
3. every `.github/workflows/*.yml` step's `run:` at the repository root;
4. otherwise the lockfile's manager: `npm ci`, `pnpm install --frozen-lockfile`, or `yarn install --frozen-lockfile` (`--immutable` for Yarn 2+).

From the first source that has one, Refit takes the first **recognised install command**, always in its frozen form: `npm install` runs as `npm ci`, and pnpm and Yarn always get a frozen lockfile. Only the committed lockfile's versions are installed and graded. That is `npm ci` or `npm install`, `pnpm install`, or `yarn` / `yarn install`, with no package arguments and only flags that keep development dependencies (`--legacy-peer-deps`, `--frozen-lockfile`, `--ignore-scripts`, `--prefer-offline` and similar). `--omit`, `--production`, `--filter`, environment prefixes, substitutions and pipes are not recognised. Every other step the source names (`npm run build`, `prisma generate`, `curl … | sh`) is listed as `skipped` in `environment.json` and never run. **Why only the install:** the decision approves the install. A build step can do anything, and the checks Refit runs already exercise the source. Widening this to build steps needs a new decision. The package-manager tool comes from `packageManager` (exact version), else a default for its lockfile generation: pnpm 10, Yarn 1.22.22, or `@yarnpkg/cli-dist` 4. It is installed with npm and scripts off, as Refit's own preparation installs it.

**The build sandbox** (`buildRepositoryEnvironment`):

- The committed tree (`git archive HEAD`, so no submodules and no untracked files) is copied in read-only, in the same container shape as preparation: `--read-only`, user 65534, all capabilities dropped, `no-new-privileges`, the pids limit and the preparation profile's memory and workspace, `--pull never`, and the same validation image.
- **Lifecycle scripts run as the repository's install runs them.** A command with `--ignore-scripts` keeps it. `HOME`, the caches and `TMPDIR` live in the container's workspace.
- **No secrets.** The container gets no Refit, App or repository secret, and no `.npmrc` beyond what the repository commits. An `.npmrc` that reads `${NPM_TOKEN}` fails, and that is how Refit learns the install needs the customer (step 4).
- **Egress through an allowlisting proxy only.** The install container joins a fresh `docker network create --internal` network with no route out. Its only exit is a proxy container (`PROXY_SCRIPT`, Node's `http` and `net`) on that network and `bridge`. The proxy tunnels `CONNECT` and forwards plain HTTP only to allowlisted hosts on ports 80 and 443. `HTTP(S)_PROXY`, the npm proxy settings and `NODE_USE_ENV_PROXY=1` point npm, pnpm, Yarn, Git over HTTPS and Node's own `fetch` at it. Anything that ignores them has no route at all. The allowlist (`namedHosts`) holds `registry.npmjs.org`, `registry.yarnpkg.com` and `repo.yarnpkg.com`, plus the hosts the repository's install files name: registries in `.npmrc` and Yarn settings, every URL in the lockfiles, and dependency URLs in `package.json` (a `github:` shorthand names `github.com` and `codeload.github.com`). It stops at 64 hosts. URLs in scripts, workflows and Dockerfiles do not count. The proxy also resolves every name itself and refuses it when any address it has is private, loopback, link-local (the `169.254.169.254` metadata address included), shared or multicast. It then connects to the address it checked, so an allowlisted name cannot point the install at the host or the cloud. IP literals are refused. Each refused host is printed as `REFIT_DENIED=<host>` and named in the failure. The proxy and the network carry the sandbox expiry label, so a job killed mid-install leaves nothing the sweeper does not remove.
- **The snapshot.** Every `node_modules` directory the install leaves (root and workspaces, plus the manager tool as `node_modules/.refit-tools`) is written as one tar in the prepared-archive format. The archive is capped at the validation profile's size, and its SHA-256 and size go into `environment.json` (`kind: refit-repository-environment`, with the install's source, command, skipped steps, `lifecycleScripts`, `secrets: false` and the egress list). Validation copies, checks and unpacks it exactly as a prepared archive, offline.
- **When it runs** (`prepareEnvironment`). Only after Refit's own preparation refuses for a repository-side reason (`preparationFailure`). It never runs for a missing, out-of-sync or unverifiable lockfile, an npm peer conflict (the owner decisions on lockfile drift stand), the archive limit or a nested SDK package, and only when `REFIT_REPOSITORY_INSTALL` is not `0`. A patch that changes package files (the stripe-node upgrade) gets its own build from the patched tree, so SDK upgrades are checked against the upgraded SDK. If Docker cannot build the sandbox (a host without networks, for example), the original preparation refusal stands unchanged. If the install fails, the refusal and the install's failure are both kept, and the draft is published untested as before (owner decision 1).

**What it still cannot do.** It cannot reach a private registry or a host no committed file names: Prisma engines (`binaries.prisma.sh`), Puppeteer's Chrome (`storage.googleapis.com`), or a postinstall that downloads a binary. Those installs fail by design and go to step 4. It does not cache builds (shortcut: every run reinstalls; add a cache keyed by the archived tree if this becomes slow). There is no native toolchain in the validation image, so a `node-gyp` build fails.

## Step 4 (optional): the customer's own CI (behind `REFIT_HOSTED_CUSTOMER_CI=1`)

When an install needs something only the customer has, Refit does not ask for it. It publishes the draft untested and names what it could not check. Step 4 adds evidence when the customer has merged the workflow; nothing waits on it.

**The one pull request** (`proposeCustomerCi`). For each approved repository (a stored approval, never installation alone), the hosted worker opens one pull request from `refit/validation-workflow`, titled "Add the Refit validation workflow", that adds `.github/workflows/refit-validation.yml`. Merging it is the customer's only action, and closing it opts out: a pull request from that branch in any state, or the workflow already on the base branch, means Refit never opens another. Its text (`customerCiPullRequest`) says:

- what it runs: two jobs on every push to `refit/**` except the proposal branch itself, so nothing runs before the customer merges it;
- what it can do: `permissions: contents: read`, the repository's secrets used as their own CI uses them, no `pull_request_target`, no deploys, no writes;
- what Refit sees: each job's result and the last lines of its log;
- how a regression is handled.

**The workflow** (`customerCiWorkflow`):

- Two jobs, `baseline` and `patched`. `baseline` checks out the merge base with the default branch. `checkout` runs with `persist-credentials: false`, and each job has a 30-minute timeout.
- When step 2 found the install in a CI workflow, the job copies that job's `runs-on`, its job-level `env` (with its `${{ secrets.* }}` references, so the customer's own secrets do the install), its setup actions (`actions/setup-node`, `pnpm/action-setup`, and so on) and the install step. It drops each step's `if`, because a condition can name a step that is left out. Otherwise it uses `actions/setup-node` with Node 22, the manager tool and the install command.
- The check is the command Refit selected when one is given. Otherwise it is the repository's test script, its `test:ci` script when `test` is in watch mode, or `tsc --noEmit`.

**Reading the evidence** (`readCustomerCiEvidence`, `applyCustomerCiEvidence`). With `actions: read`, Refit reads the newest run of the workflow for the draft's head commit, both jobs' conclusions and the last 2,000 characters of each log. GitHub masks secret values in logs. It applies the offline gates (`customerCiOutcome`):

- `passed`: both jobs passed.
- `regression`: `patched` failed (conclusion `failure`) and `baseline` passed. Refit closes the draft, but only while its head is still the commit Refit pushed (`<!-- refit-pushed -->`). A draft a person pushed to is only commented on.
- `baseline-failed`: the base failed, so the patch's result is no evidence either way.
- `inconclusive`: a job was cancelled, skipped or timed out, which is no evidence and never closes a draft.
- `pending` or `missing`: nothing is recorded yet.

The result goes into one marked comment on the draft (`<!-- refit-customer-ci -->`), which is updated in place. The draft stays `[Needs review]` because it was published untested, and a person merges it. Refit never merges.

**Permissions this needs from the founders, not from customers.** The GitHub App needs `workflows: write`, to add a file under `.github/workflows`, and `actions: read`. The token helpers request exactly these (`authenticateGitHubWorkflow`, `authenticateGitHubActions` in `pipeline/github-app.ts`). Adding them to the App asks each installation to accept the new permissions once. That is an owner action on the live App and was not done here.

**Limits of the wiring.** Evidence is read on every hosted pass for each open Refit draft. Proposals are remembered per worker process, and both reads are idempotent (shortcut in `pipeline/hosted-customer.ts`). There is no `workflow_run` webhook yet.

## Beta metrics: every Refit pull request's outcome

`pipeline/pull-outcomes.ts`, hosted migration 13 (`refit_pull_outcomes`), always on:

- A `pull_request` `closed` webhook is recorded only for a pull request the App bot opened from a `refit/**` branch of the same repository (not the workflow branch), in an allowed installation. A draft Refit closed itself is not a customer decision and is not recorded. A recorded one is stored in the same transaction that deduplicates the delivery. It is `merged-without-edits` when the merged head is the commit Refit recorded as pushed. It is `merged-with-edits` otherwise, including a draft with no record, so the merge rate is never overstated. Otherwise it is `closed-unmerged`.
- A push to the default branch whose commits say `This reverts commit <sha>` marks the merge with that commit `reverted`.
- The reason is the customer's newest non-bot comment on the pull request. Each hosted pass reads it once per close and keeps it to 1,000 characters.
- `/status` reports `pullRequests`: the counts, the **merge rate** (merged, reverted included, over all closed) and the **wrong-fix rate** (merged with edits or reverted, over merged).

#363's inventory and the hosted job receipts already record what Refit found and what it published. This adds what the customer did with it.

## Options this replaces

- **A prebuilt image the customer publishes** (`imageNodeModules`, the first version of #364). Removed. The image had to be built and kept current by the customer, which is setup, and step 2 produces the same thing without them. Nothing else needed the setting.
- **Registry credentials held by Refit.** Not built, and no longer needed: a private registry goes to step 4, where the customer's secrets stay in their CI.

## Demo

Run on 2026-10-28 against this branch, with Docker 29.8.2 on arm64, no AI and no publication. The fork is `refit-dev/artisan-roast` at `15be9a627bfe0a96f8a6606e6016b961f2035f09`: Next.js, stripe 20.3.1, Node `>=24`, 1,377 locked packages, and **no `.refit.json`, nothing changed by the customer**. Its lockfile resolves `artisan-roast-sdk` from `git+ssh://git@github.com/yuens1002/artisan-roast-sdk.git`.

1. **Refit's own preparation refuses it** (`non-registry-dependency`). `refit doctor` generates the configuration. Its dependencies check is `review`, not `blocked`, and says Refit runs the repository's own install instead: `npm ci`, from `.github/workflows/build-safe-main.yml`. The action is "Nothing to configure". Doctor still blocks on migration coverage (13 breaking changes no rule migrates), which has nothing to do with dependencies.
2. **The build sandbox.** It ran `npm ci` with lifecycle scripts and 15 allowlisted hosts. The Git dependency installed over the proxy. Then two postinstall scripts tried hosts no committed file names, Prisma's engines (`binaries.prisma.sh`) and Puppeteer's Chrome (`storage.googleapis.com`), and the proxy refused both. The install failed as `customerOnly`, as designed: the repository's own install needs downloads its files do not declare. So validation records the patch untested (grade D, `[Needs review]`), as before this change.
3. **The customer's CI.** `proposeCustomerCi`, run with a maintainer token in place of the App's, opened [refit-dev/artisan-roast#2](https://github.com/refit-dev/artisan-roast/pull/2). Its workflow copies `build-safe-main.yml`'s `runs-on`, its job `env` with the `${{ secrets.* }}` references, `actions/setup-node` and `npm ci`, and runs `npm run test:ci`, because `test` is `jest --watch`. A demo migration branch, `refit/demo-endive` (`f2cef19`: that workflow plus the rules' patch from the earlier run, which moves the API version to `2026-09-30.endive` and upgrades stripe-node), triggered it. The run was still queued behind the organisation's Actions queue when this was written. Its result is recorded on this PR, not here.
