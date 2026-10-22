# Benchmark harness

Every benchmark run describes itself, can be checked against a schema, and can be resumed. This covers the four benchmarks that produce Refit's headline numbers:

| Benchmark | Command | Writes |
|---|---|---|
| Stripe | `npm run benchmark:stripe` | `<output>/results.json` and `<output>/harness.json` |
| Shopify | `npm run benchmark:shopify` | `<output>/results.json` and `<output>/harness.json` |
| AI applications (OpenAI, Anthropic) | `node scripts/ai-model-benchmark.mjs` | `<output>` with `harness` and `results` |
| Deadlines | `node scripts/deadline-benchmark-setup.mjs` | `<root>/<output>` with `harness` and `results` |

Stripe and Shopify keep `results.json` a bare array, because `scripts/aws-benchmark.mjs collect` merges shards by concatenating those arrays. The harness record sits beside it in `harness.json`.

## The harness record

Written when the run starts, before any repository is read. Schema: [`benchmarks/schemas/harness.schema.json`](benchmarks/schemas/harness.schema.json).

| Field | Meaning |
|---|---|
| `format` | The results format: `stripe-results`, `shopify-results`, `ai-model-results` or `deadline-results`. |
| `refit.commit` | The full Refit commit the run used. For the deadline benchmark it is the `--refit` checkout that scans, which may differ from the script's own checkout. |
| `refit.source` | `git` (read from the checkout), `archive` (a `git archive` export, such as an AWS shard: the commit is stamped into `scripts/benchmark-commit.txt` through `export-subst` in `.gitattributes`), or `unknown`. |
| `refit.dirty` | `null`, or the tracked files that differ from the commit and the SHA-256 of `git diff HEAD --binary`. |
| `refit.allowDirty` | Whether `--allow-dirty` was passed. |
| `list.path`, `list.sha256` | The frozen list as named on the command line (for Stripe, `selected.json` in `--root`) and the SHA-256 of its bytes. |
| `options` | The command-line options that can change outcomes, with keys sorted. Paths that only locate inputs and outputs (`--root`, `--output`, `--env`) and the harness's own flags are left out. Settings read from the environment are recorded under `options.environment`: `REFIT_VALIDATION_WORKSPACE` and `REFIT_DEPENDENCY_TIMEOUT_SECONDS` for Stripe and Shopify, and `OPENAI_MODEL` for Stripe `--ai` runs. Nothing else from the environment is recorded, so no secret can be. |
| `node` | `process.version`. |
| `docker` | `null` when the run does not use Docker. With `--validate`: the Docker server version, the validation image (`node:22-alpine`), its immutable image ID and its registry digests. The run stops before any repository if Docker or the image cannot be read. |
| `startedAt` | When the run started. |
| `resumes` | One entry per `--resume`, with its own start time, Node and Docker versions. |

### Dirty trees

A run refuses to start when tracked files differ from the commit, because its numbers would describe code nobody can check out. `--allow-dirty` runs anyway and records `allowDirty: true` with the changed files and the diff's digest. Untracked files are not counted, as in `git describe --dirty`: committed code cannot import a file that is not committed without a tracked change. A tree that is neither a git checkout nor a stamped `git archive` export also needs `--allow-dirty`, and then records `commit: null`. Benchmark numbers for the docs come only from runs with `allowDirty: false`.

## Infrastructure errors

Every row carries `outcomeClass`. A `repository` row is Refit's result on that repository. An `infrastructure` row is a failure of the environment that says nothing about the repository, with `infrastructure.kind` and `infrastructure.message`:

| Kind | When |
|---|---|
| `clone` | The checkout is missing, is an empty `git init` left by a failed shallow fetch, or is not at the pinned commit. Each benchmark checks `git rev-parse HEAD` against the list's commit before reading a repository. Before this check, an empty checkout scanned as a repository that uses nothing. |
| `registry` | Dependency preparation failed on the network (`ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`, `EAI_AGAIN`, `ENOTFOUND`, `ESOCKETTIMEDOUT`, `ERR_SOCKET_TIMEOUT`, `EHOSTUNREACH`, `ENETUNREACH`, `network request to … failed`, `ERR_PNPM_META_FETCH_FAIL`) or ran past its time limit (`Dependency preparation exceeded N seconds`). Validation itself is offline, so these come only from preparation. A failure that also reports `ENOSPC` is not one of these: the dependency tree filled the sandbox workspace, which is the repository's size against Refit's limit. |
| `docker` | The Docker daemon or image failed: `Cannot connect to the Docker daemon`, `Error response from daemon`, `No such image`, `spawn docker ENOENT`, or an image ID Docker could not resolve. |
| `no-manifest` | `refit run` wrote no manifest: the harness's 20-minute limit killed it, or it crashed. There is no outcome to count. |

Everything else is a repository result, including failures the repository causes: an out-of-sync or integrity-less lockfile, `ERESOLVE`, scan limits, symbolic links, oversized output, and AI-app scan time-outs at the 120-second cap.

The rules read only fields the rows already had, so rows written before the harness are classified the same way (`classifyRow` in `scripts/benchmark-harness.mjs`). On the 81 raw Stripe and Shopify runs kept on one development machine (4,703 rows, written October 14 to 20), they find 3 infrastructure errors. All 3 are 300-second preparation time-outs in one held-out run (`run-pmt`). Each of the three repositories got through preparation in other runs of the same set: all three validated at 6d4f38a, in 3 to 58 seconds of validation. A Yarn row that also said `There appears to be trouble with your network connection. Retrying...` turned out to have failed with `ENOSPC`. That is why the retry notice is not a registry rule and `ENOSPC` overrides one.

How summaries use it:

- **Stripe summary** (`summary.md`): counts repository results only, and lists infrastructure errors in their own table.
- **Stripe ground-truth score** (`npm run benchmark:stripe-score`): leaves a labelled repository with an infrastructure error out of recall and outcomes. Before, its breaking reads counted as missed. It prints them as `not scored`.
- **AI summary**: adds `infrastructureErrors` after the existing keys. `repositories` and `errors` keep their 2026-10-20 meaning and still include these rows, so subtract to count results only.
- **Deadline score**: scores scanned rows only, as before, and reports each run's `failed` rows by class.
- **`scripts/stripe-benchmark-compare.mjs`**: reports outcome changes apart from differences caused by an infrastructure error in some run, or by a repository missing from some run (`outcomeChanges`, `infrastructureChanges`, `missingChanges`; table marks `differs`, `infrastructure`, `missing`).

## Deterministic output

Rows are written in list order whatever `--concurrency` is, and fields that come from counting are written with sorted keys (`reviewReasons`, `nonLive`). One field used to depend on scheduling. A Stripe repository whose full-contract comparison reused another repository's failure on the same API version recorded `reusedFromSameVersion: true`, and which repository ran first depended on `--concurrency`. The reused failure is now recorded exactly like the first. An end-to-end test runs the Stripe benchmark with `--concurrency 1` and `3` and compares every row except `seconds`.

## Resuming a run

`--resume` continues an interrupted run in the same output:

- It refuses unless the output was started by the same run: the same format, a known Refit commit, the same uncommitted diff (if any), the same list digest and the same options. A changed commit, list or option needs a new output.
- A row is kept only when it is a finished repository result for the same repository and commit. Unfinished rows and infrastructure errors run again; for Stripe and Shopify, the repository's partial evidence under `<output>/repos/` is deleted first.
- The resume is appended to `harness.resumes`.
- Without `--resume`, Stripe and Shopify still refuse an existing `--output`. The AI-app and deadline benchmarks still overwrite theirs, and now write it after every repository instead of only at the end.

## Schemas and the validator

Each results format has a schema in [`benchmarks/schemas/`](benchmarks/schemas/). They use a small subset of JSON Schema 2020-12 (`type`, `properties`, `required`, `additionalProperties`, `propertyNames`, `items`, `enum`, `const`, `pattern`, `minimum`, `minLength`, `minItems`, `anyOf`, `$ref`, `$defs`). The validator refuses any other keyword rather than ignore it.

| Format | Written by | Committed files |
|---|---|---|
| `stripe-results` | `npm run benchmark:stripe` | none (raw runs are not committed) |
| `shopify-results` | `npm run benchmark:shopify` | none |
| `ai-model-results` | `scripts/ai-model-benchmark.mjs` | 7 |
| `deadline-results` | `scripts/deadline-benchmark-setup.mjs` (also accepts the older bare arrays) | none |
| `harness` | every run above | inside the files above |
| `stripe-rows` | the condensed Stripe rows committed by hand | 6 |
| `shopify-rows` | the condensed Shopify rows | 2 |
| `deadline-sets` | exposures on other benchmarks' sets | 1 |
| `gemini-results`, `paypal-results`, `paypal-subdirectory-results`, `meta-graph-call-results`, `meta-graph-move-results`, `shopify-tracing-results`, `agent-comparison-results`, `model-replacement-review` | other benchmarks, not run through the harness | 1 each |

A property with `x-added` (the date it was added) is new. Data that lacks only such properties is reported under `predates`, not as an error. Summaries, the score and compare accept predated data, so older runs can still be compared, and they say what it predates. The benchmark commands themselves check their own output strictly before writing the final file. `findings` in the Stripe scan summaries is marked as added on 2026-10-14 (b36fbdc), because the first runs before the ground truth lack it.

```sh
node scripts/benchmark-results.mjs --committed     # every docs/benchmarks/*-results.json
node scripts/benchmark-results.mjs <output>        # a Stripe or Shopify run directory
node scripts/benchmark-results.mjs --format ai-model-results <results.json>
```

`--committed` reads [`benchmarks/schemas/files.json`](benchmarks/schemas/files.json), which gives each committed results file its format and the fields it predates. It fails on an unlisted file, a listed file that is missing, any error, a predated field the index does not record, and a recorded one the file actually has. The index is the record of what each older file lacks; older files are never rewritten. The default test suite runs the same check.

On 2026-10-22 all 24 committed results files are valid. The 16 files from the Stripe, Shopify, deadline and AI-app benchmarks predate exactly two things: the `harness` record and each row's `outcomeClass`. The 8 files from other benchmarks predate nothing.

### Committing results

- Run from a clean, pinned checkout (`allowDirty: false` in the record).
- For a raw-format file, commit it as written. For a condensed file (`stripe-rows`, `shopify-rows`, `deadline-sets`), copy the run's harness record into `harness` and keep each row's `outcomeClass` and `infrastructure`.
- Add the file to `benchmarks/schemas/files.json` with its format and an empty `predates`, then run `node scripts/benchmark-results.mjs --committed`.
- A new results format needs its own schema.

## Not covered

- The Stripe record hashes `selected.json` only. `split.json` (for `--split`) and the contract specs are built from the same frozen list by the setup script, and are not hashed separately.
- `scripts/aws-benchmark.mjs collect` merges `results.json` arrays but not the shards' `harness.json` files, which stay under `shard-<n>/out/`. `scripts/aws-benchmark*` belongs to PP4; see the PR for the request.
- The Gemini, PayPal and Meta Graph benchmark scripts belong to other lanes and do not write a harness record yet. Their committed files are validated against schemas that describe them as they are.
