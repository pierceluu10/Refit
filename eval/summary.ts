import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { defaultRunLedgerPath } from './runner.ts';
import { RESULT_COLUMNS, RUN_COLUMNS, type ResultRow, type RunRow, readCsv } from './results.ts';

export type EvaluationSummary = {
  confirmedCorrect: number;
  confirmedLabeled: number;
  confirmedUnlabeled: number;
  needsReview: number;
  repositoriesWithNoFindings: string[];
};

export async function summarize(resultsPath: string, runsPath = defaultRunLedgerPath(resultsPath)) {
  const [results, runs] = await Promise.all([
    readCsv<ResultRow>(resultsPath, RESULT_COLUMNS),
    readCsv<RunRow>(runsPath, RUN_COLUMNS),
  ]);
  for (const [index, row] of results.entries()) {
    if (!['confirmed', 'needs-review'].includes(row.confidence))
      throw new Error(`${resultsPath}:${index + 2} has invalid confidence "${row.confidence}".`);
    if (!['', 'correct', 'wrong'].includes(row.label))
      throw new Error(`${resultsPath}:${index + 2} has invalid label "${row.label}".`);
  }
  const confirmed = results.filter((row) => row.confidence === 'confirmed');
  const labeled = confirmed.filter((row) => row.label !== '');
  return {
    confirmedCorrect: labeled.filter((row) => row.label === 'correct').length,
    confirmedLabeled: labeled.length,
    confirmedUnlabeled: confirmed.length - labeled.length,
    needsReview: results.filter((row) => row.confidence === 'needs-review').length,
    repositoriesWithNoFindings: runs
      .filter((run) => run.status === 'scanned' && run.findingCount === '0')
      .map((run) => run.repo),
  } satisfies EvaluationSummary;
}

export function renderSummary(summary: EvaluationSummary) {
  const precision =
    summary.confirmedLabeled === 0
      ? 'n/a (no labeled confirmed findings)'
      : `${summary.confirmedCorrect}/${summary.confirmedLabeled} (${(
          (summary.confirmedCorrect / summary.confirmedLabeled) *
          100
        ).toFixed(1)}%)`;
  const noFindings = summary.repositoriesWithNoFindings.length
    ? summary.repositoriesWithNoFindings.map((repo) => `  - ${repo}`).join('\n')
    : '  (none)';
  return [
    `Confirmed precision: ${precision}`,
    `Unlabeled confirmed findings: ${summary.confirmedUnlabeled}`,
    `Needs-review count: ${summary.needsReview}`,
    'Repositories with no findings:',
    noFindings,
  ].join('\n');
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      runs: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log('Usage: npx tsx eval/summary.ts <labeled-results.csv> [--runs <runs.csv>]');
    if (!values.help) process.exitCode = 1;
    return;
  }
  const resultsPath = resolve(positionals[0]);
  console.log(renderSummary(await summarize(resultsPath, values.runs && resolve(values.runs))));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
