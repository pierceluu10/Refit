# Continuous integration

Two workflows test Refit. Neither uses a repository secret or calls a paid API.

| Workflow       | Runs on                                                                                       | Jobs                                                                              |
| -------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `ci.yml`       | every pull request and push to `main`                                                         | `Typecheck, format, test and build`, on Node 22 and 24; `Benchmark results files` |
| `ci-gated.yml` | pushes to `main`, nightly at 06:41 UTC, manual dispatch, and pull requests labelled `full-ci` | oasdiff, Docker, PostgreSQL, real SDK, package (Node 22 and 24)                   |

The first `ci.yml` job is the check every pull request waits for before merge (`main` has no branch protection, so GitHub does not enforce it). It runs the default suite, where every test that needs Docker, PostgreSQL, oasdiff, a real SDK or the packed CLI is skipped. `ci-gated.yml` runs those tests. On a pull request without the `full-ci` label its jobs are skipped, so pull requests wait no longer than before. Add the label to run them on a pull request; the label triggers a run, and every later push reruns them while the label stays.

`Benchmark results files` runs `node scripts/benchmark-results.mjs --committed`, which checks every committed `docs/benchmarks/*-results.json` against the schema `docs/benchmarks/schemas/files.json` assigns it and exits 1 on any error or unlisted file (see [benchmark harness](BENCHMARK-HARNESS.md)). It uses only Node built-ins, so it skips `npm ci` and finishes in seconds. The default suite runs the same check.

`deadlines-sync.yml` is the daily registry sync. It is described in [API deadlines](DEADLINES.md) and is not a test workflow.

## Gated jobs

Each job runs `.github/scripts/run-gated.sh <variables>`. The script runs every `pipeline/*.test.ts` file that reads one of the variables as `process.env.<NAME>`, so a new gated test runs in CI without a workflow change, as long as its file reads its variable directly. The script fails if no file matches. Tests in the selected files that need a variable the job does not set stay skipped.

| Job                         | Test files reading                        | Variables set                                                                 | Also provides                                             | Timeout |
| --------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- | ------- |
| `oasdiff suites`            | `REFIT_OASDIFF`                           | `REFIT_OASDIFF=1`                                                             | oasdiff                                                   | 20 min  |
| `Docker suites`             | `REFIT_DOCKER_IMAGE`, `REFIT_NPM_PREPARE` | `REFIT_DOCKER_IMAGE=node:22-alpine`, `REFIT_NPM_PREPARE=1`, `REFIT_OASDIFF=1` | Docker, the pinned image, oasdiff                         | 45 min  |
| `PostgreSQL suites`         | `REFIT_POSTGRES_URL`                      | `REFIT_POSTGRES_URL`, `REFIT_DOCKER_IMAGE`, `REFIT_OASDIFF=1`                 | a `postgres:17-alpine` service container, Docker, oasdiff | 30 min  |
| `Real SDK suites`           | `REFIT_STRIPE_SDK`, `REFIT_OPENAI_SDK`    | both, plus the Docker job's three                                             | Docker, oasdiff                                           | 45 min  |
| `Package and smoke install` | `REFIT_PACKAGE_INSTALL`                   | `REFIT_PACKAGE_INSTALL=1`                                                     | nothing extra                                             | 15 min  |

- **Docker** runs the offline validation and dependency-preparation tests. Preparation containers reach the npm registry with lifecycle scripts off; validation containers have no network.
- **PostgreSQL** runs the hosted-worker tests. Each test creates its own schema and drops it afterwards. The end-to-end hosted test also validates in Docker, so this job has Docker and oasdiff too.
- **Real SDK** installs the Stripe and OpenAI SDK versions the tests name from the npm registry. Their HTTP goes only to local simulators, and the OpenAI fixture refuses any non-loopback URL.
- **Package** runs `npm run package:cli`, installs the tarball with `npm install --ignore-scripts --omit=dev` into an empty directory, runs `refit --help` and `refit doctor --help` from it, then runs the packaging test that installs the archive and runs `replay` and `run` from it.

The tests that read `REFIT_BILLING_REPOSITORY` stay out of CI: they need a local checkout of the private billing demo application.

## Pinning

- Actions are pinned to full commit SHAs, with the release tag in a comment: `actions/checkout` v7.0.1 and `actions/setup-node` v7.1.0. To update one, resolve the new tag with `gh api repos/<owner>/<action>/git/ref/tags/<tag>` (and `git/tags/<sha>` if that returns an annotated tag), then replace the SHA and the comment together.
- Checkouts keep no credentials (`persist-credentials: false`). Workflows default to no token permissions; each job asks only for `contents: read`.
- oasdiff is downloaded from its GitHub release and checked with `sha256sum --check` against `OASDIFF_SHA256` before it is installed (`.github/scripts/install-oasdiff.sh`). The version matches the hosted `Dockerfile`. The checksum comes from the release's `checksums.txt`.
- The validation image and the PostgreSQL service image are pinned by registry digest (`docker buildx imagetools inspect <image>`). Validation runs with `--pull never`, so the job pulls `node@<digest>` and tags it `node:22-alpine`.

## Reproduce a job locally

From the repository root, after `npm ci`. Docker must be running for the Docker, PostgreSQL and SDK jobs. On macOS, install oasdiff 1.33.0 from its release page or with Homebrew instead of running `install-oasdiff.sh`, which installs the Linux binary.

```sh
# oasdiff suites
REFIT_OASDIFF=1 .github/scripts/run-gated.sh REFIT_OASDIFF

# Docker suites
REFIT_DOCKER_IMAGE=node:22-alpine REFIT_NPM_PREPARE=1 REFIT_OASDIFF=1 \
  .github/scripts/run-gated.sh REFIT_DOCKER_IMAGE REFIT_NPM_PREPARE

# PostgreSQL suites, with the disposable database from Hosted onboarding
docker run -d --name refit-hosted-pg -e POSTGRES_USER=refit -e POSTGRES_PASSWORD=refit-local-test \
  -e POSTGRES_DB=refit -p 127.0.0.1:55432:5432 postgres:17-alpine
REFIT_POSTGRES_URL=postgres://refit:refit-local-test@127.0.0.1:55432/refit \
  REFIT_DOCKER_IMAGE=node:22-alpine REFIT_OASDIFF=1 .github/scripts/run-gated.sh REFIT_POSTGRES_URL

# Real SDK suites
REFIT_STRIPE_SDK=1 REFIT_OPENAI_SDK=1 REFIT_DOCKER_IMAGE=node:22-alpine REFIT_NPM_PREPARE=1 \
  REFIT_OASDIFF=1 .github/scripts/run-gated.sh REFIT_STRIPE_SDK REFIT_OPENAI_SDK

# Package and smoke install
out="$(mktemp -d)"
npm run package:cli -- --output "$out/package"
mkdir "$out/smoke" && npm install --prefix "$out/smoke" --ignore-scripts --no-audit --no-fund \
  --omit=dev "$out"/package/refit-*.tgz
"$out/smoke/node_modules/.bin/refit" --help && "$out/smoke/node_modules/.bin/refit" doctor --help
REFIT_PACKAGE_INSTALL=1 .github/scripts/run-gated.sh REFIT_PACKAGE_INSTALL
```

Lint the workflows with [actionlint](https://github.com/rhysd/actionlint) before pushing a change to them.

## Tests that leave something behind

Both vitest projects load `pipeline/test/setup.ts`. It fails a test, or a test file's hooks, that leave a running child process, a listening server, a pending referenced timer or an added process listener. The message names what was left. Await the process, close the server, clear the timer or remove the listener in the test's own cleanup.
