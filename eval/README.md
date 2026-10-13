# OpenAI deprecation detector evaluation

This folder measures the bundled OpenAI deprecation detector against public repositories. The
runner is offline after cloning: it uses Refit's bundled OpenAI adapter and pinned synthetic
snapshot and does not call an AI API.

## Run

Add one public HTTPS GitHub repository URL per line to `repos.txt`, then run:

```sh
npx tsx eval/runner.ts
```

The runner shallow-clones each repository once into a unique operating-system temporary directory,
records its commit SHA, scans it, and always removes the clone. Clone and scan failures are logged,
recorded, and skipped without retrying.

By default it writes:

- `eval/results.csv`: one row per finding, with `label` and `notes` left empty.
- `eval/results.runs.csv`: the run ledger used to identify successful scans with no findings.
- `eval/reports/*.json`: the detector's full report for each successful scan.

Paths can be changed with `--repos`, `--output`, `--runs-output`, and `--reports-directory`. Use
`npx tsx eval/runner.ts --help` for the complete command.

## Label and summarize

Fill `label` with `correct` or `wrong` for each reviewed finding. Leave it empty while unreviewed;
free-form notes may contain commas, quotes, and line breaks when properly CSV-quoted. Do not change
the header:

```text
repo,commit,file,line,modelId,confidence,label,notes
```

Print the confirmed precision, the number of needs-review findings, and successfully scanned
repositories with no findings:

```sh
npx tsx eval/summary.ts eval/results.csv
```

The summary automatically reads the adjacent `results.runs.csv`. Pass `--runs <path>` if the run
ledger has another name.

## Tests

```sh
npx vitest run --config eval/vitest.config.ts
npx tsc -p eval/tsconfig.json
```

The tests create local Git repositories and clone them through `file://` URLs. They require no
network access.
