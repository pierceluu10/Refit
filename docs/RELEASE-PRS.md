# Stripe release PRs

When `stripe/openapi` publishes a release tag newer than the one Refit's SDK map was generated from, a workflow in `refit-dev/refit-bench` prepares a pull request to this repository with the regenerated SDK map, the release's breaking changelog pages, their AI classification when the tag brings a new API version, and a generated test. A person reviews and merges it. Nothing merges automatically, and no prediction becomes a rule-pack entry without a separate, reviewed change.

## What the generator does

`node scripts/stripe-release-pr.mjs --tag <vN>` (pure parts in `pipeline/stripe-release.ts`, tested by `pipeline/stripe-release.test.ts`, no network):

1. **Tag.** Reads the recorded tag from `source` in `pipeline/stripe-sdk-metadata.json`. An older tag is refused; with `--if-newer` the recorded tag itself ends as `up-to-date`. Tags compare by number (`v999` is older than `v2591`).
2. **SDK map.** Downloads `openapi/spec3.sdk.json` at the tag's commit, and at the commit of every contract in `data/stripe-openapi-versions.json` plus the previously recorded tag, into a fresh temporary directory (`--specs <dir>` reuses a cache). It then runs `scripts/stripe-sdk-metadata.mjs` with `SOURCE_DATE_EPOCH` set to the tag's commit date, so `generated` is that date and a rerun on the same tag writes the same bytes. Regenerating `v2526` this way reproduces the committed map except for `generated`.
3. **New API version.** When the tag's `info.version` is not in the map's `operationVersions`, it reads `docs.stripe.com/changelog/<name>.md` and takes the rows marked Breaking under that version's heading. For basil, clover, dahlia and endive this yields exactly the 79 pages of the hand catalog. Each page is saved as a documentation snapshot under `docs/benchmarks/stripe-changelog/pages/<version>/`, in the format `scripts/stripe-changelog-pages.mjs` writes. That script only saves pages the hand catalog cites, and a new release has no catalog, so the generator calls the same `captureDocumentation`.
4. **Classification.** This step runs `refit classify-release --release <version> --statements none` (pages only, since there is no catalog to take statements from) and copies `results.json` and `audit.json` to `docs/benchmarks/stripe-changelog/classification/<version>/`. It then writes `review.json` there, listing every `rule` and `ai` prediction with `"decision": "pending"`. It runs only when `REFIT_AI_BUDGET_USD`, from the environment or `--env <file>`, is above 0, and `--no-ai` is absent. An existing `audit.json` is reused, so a rerun spends nothing. If the checked-out `refit classify-release` has no `--statements` option, the step is skipped and the PR body says so.
5. **Test.** Overwrites `pipeline/stripe-sdk-release.test.ts`. It pins the map's tag, version and counts, checks that the classes, events and operations the tracer and its tests rely on still resolve (`CORE_SDK_NAMES`), and, when there is a classification, checks `audit.json` against the classifier's schema and `review.json` against its `rule` and `ai` predictions.
6. **Body and summary.** `--body <file>` gets the PR body: the added and removed versions, classes, events and operations; the classification table with [the measured accuracy](RELEASE-CLASSIFICATION.md) caveat and the rows needing review; and a review checklist. `--summary <file>` gets the status: `changed`, `unchanged` (only the recorded tag moved) or `up-to-date`.

Run it locally the same way (`GH_TOKEN` avoids the anonymous GitHub API limit):

```sh
GH_TOKEN=$(gh auth token) node scripts/stripe-release-pr.mjs --tag v2591 --no-ai --body /tmp/body.md
git diff --stat
```

## The workflow

`.github/workflows/stripe-release.yml` in `refit-dev/refit-bench` runs daily and on `workflow_dispatch`:

| Input       | Meaning                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `tag`       | A `stripe/openapi` tag. Blank takes `releases/latest` and stops as `up-to-date` unless it is newer than the recorded tag. |
| `ref`       | Refit branch or full commit SHA to run (default `main`).                                                                  |
| `ai_budget` | USD cap for classifying a new API version with `gpt-6.1-sol`, at most $1 (default $1). `0` passes `--no-ai`.              |
| `force`     | Open the PR even when the status is `unchanged`.                                                                          |

It checks out Refit with `REFIT_READ_TOKEN`, runs the generator (the OpenAI key reaches it only through an env file removed after the run), commits the result on `release/stripe-<tag>` and uploads the artifact `stripe-release`: `body.md`, `summary.json`, `diffstat.txt`, `release.patch`, `release.bundle` and `base.txt`. For a `changed` status it opens `chore(stripe): release <tag>` against `main` with `REFIT_PR_TOKEN`, unless a PR from that branch is already open. An `unchanged` tag opens nothing, so the next day's run checks again.

```sh
gh workflow run stripe-release.yml -R refit-dev/refit-bench -f ref=main -f ai_budget=1
```

To apply an artifact by hand: `git fetch release.bundle HEAD && git switch -c release/stripe-<tag> FETCH_HEAD`, from a checkout at the commit in `base.txt`.

## Required secret (owner)

The workflow cannot open PRs until the owner adds `REFIT_PR_TOKEN`. Until then the PR step fails with an error naming the secret, after the artifact is uploaded.

1. GitHub, Settings, Developer settings, Fine-grained personal access tokens, Generate new token.
2. Resource owner: `pierceluu10`. Repository access: Only select repositories, `pierceluu10/Refit`.
3. Repository permissions: **Contents: Read and write** and **Pull requests: Read and write**. Metadata: Read-only is added automatically. Nothing else.
4. Choose an expiry, then add the token as a repository secret: `gh secret set REFIT_PR_TOKEN -R refit-dev/refit-bench` (paste the token at the prompt).

The token can push branches and open PRs on Refit, so keep it out of every other repository. The workflow never merges and never force-pushes.

## What a reviewer checks

- **Removed classes, events or operations.** Stripe may have dropped them, or an older spec may no longer be included because its tag is neither in `data/stripe-openapi-versions.json` nor the previously recorded tag. Either way, a traced application may lose a mapping.
- **Changelog pages.** Each saved page should match docs.stripe.com.
- **Every `rule` and `ai` prediction in `review.json`.** Set `decision` to `accepted` or `rejected`. An accepted one becomes a hand catalog entry or rule-pack change in a separate PR. On the hand catalog, 8 of 30 such predictions were dangerous.
- **`stop`, `generic` and `none` predictions.** Sample-check them. They edit nothing, but they are often wrong.
- **`npm test`.** It must pass, including the regenerated `pipeline/stripe-sdk-release.test.ts`.

Moving Refit's target contract to the new version (`data/stripe-openapi-versions.json`, `refit stripe-snapshot`) is a separate owner decision that this PR does not make.

## Limits

- The classification step needs `refit classify-release --statements none` (pages-only mode). Until that lands, a new version's PR carries the saved pages and says it was not classified.
- Each run downloads about 32 SDK specs (about 300 MB). An `unchanged` tag repeats this daily until the map changes.
- Only the newest spec's classes and events are kept, as before. Operations are the union of the specs listed above.
