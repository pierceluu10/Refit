import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { comparisonTable, scoreRun, summarizeRun } from './ai-patch-eval.ts';
import { PipelineInputError } from './types.ts';

const USAGE =
  'Usage: npm run eval:ai-patch -- --cases <frozen-cases.json> --run <label>=<directory> [--run <label>=<directory> ...] [--output <scores.json>]';

const { values } = parseArgs({
  options: {
    cases: { type: 'string' },
    run: { type: 'string', multiple: true },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!values.cases || !values.run?.length) throw new PipelineInputError(USAGE);
const frozen = JSON.parse(await readFile(values.cases, 'utf8')) as {
  repos: { repo: string }[];
  privateCases?: { id: string }[];
};
const ids = [
  ...frozen.repos.map((entry) => entry.repo),
  ...(frozen.privateCases ?? []).map((entry) => entry.id),
];
const runs = await Promise.all(
  values.run.map(async (argument) => {
    const separator = argument.indexOf('=');
    if (separator < 1) throw new PipelineInputError(`--run needs <label>=<directory>.\n${USAGE}`);
    const results = await scoreRun(argument.slice(separator + 1), ids);
    return { label: argument.slice(0, separator), results, summary: summarizeRun(results) };
  }),
);
for (const { label, summary } of runs) {
  const outcomes = Object.entries(summary.counts)
    .filter(([, count]) => count)
    .map(([outcome, count]) => `${outcome} ${count}`);
  console.log(
    `${label}: ${summary.reached} of ${summary.cases} cases reached AI; ${outcomes.join(', ')}; ${summary.repairsRequested} repairs; recorded cost $${summary.recordedCostUsd.toFixed(4)}`,
  );
}
console.log(`\n${comparisonTable(runs)}`);
if (values.output) await writeFile(values.output, `${JSON.stringify(runs, null, 2)}\n`);
