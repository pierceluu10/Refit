// Merges a refit-bench Stripe or Meta Graph run's shard artifacts into what its `merge` job uploads as `merged`:
// results.json, expected.txt, present.txt, missing.txt, unexpected.txt, duplicated.txt, images.txt
// and summary.md. The workflow runs it; a laptop runs it when that job stays queued
// (docs/GITHUB-BENCHMARKS.md). The list is read at --commit, so the working tree may differ;
// summary.md uses this checkout's summaryTable.
//
//   gh run download <run-id> -R refit-dev/refit-bench -p 'shard-*' -D <shards>
//   node scripts/benchmark-merge.mjs --shards <shards> --list <list> --offset N [--end N] --commit <sha> --output <dir>
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { tsImport } from 'tsx/esm/api';

const { values } = parseArgs({
  options: {
    shards: { type: 'string' },
    list: { type: 'string' },
    offset: { type: 'string', default: '0' },
    end: { type: 'string' },
    commit: { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
const USAGE =
  'Usage: node scripts/benchmark-merge.mjs --shards <dir> --list <list under docs/benchmarks> --offset N [--end N] --commit <sha> --output <dir>';
if (values.help || !values.shards || !values.list || !values.commit || !values.output) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}
const COUNT = /^\d+$/;
if (!COUNT.test(values.offset) || (values.end !== undefined && !COUNT.test(values.end)))
  throw new Error('--offset and --end must be whole numbers.');

const refit = fileURLToPath(new URL('..', import.meta.url));
const listText = await promisify(execFile)(
  'git',
  ['-C', refit, 'show', `${values.commit}:docs/benchmarks/${values.list}`],
  { maxBuffer: 64 * 1024 * 1024 },
).then(
  (result) => result.stdout,
  (error) => {
    throw new Error(
      `Cannot read docs/benchmarks/${values.list} at ${values.commit}; run git fetch origin ${values.commit} first. ${error.message}`,
    );
  },
);
const list = JSON.parse(listText);
const repos = list.repos;
// Meta Graph lists (docs/benchmarks/subsets/meta-*.json) have their own summary table.
const meta = list.provider === 'meta-graph';
const offset = Number(values.offset);
const end = values.end ?? String(repos.length);

// The workflow's tools: `sort` and `comm` in the C locale (byte order; repository names are ASCII),
// `wc -l` on newline-terminated lines and jq's pretty printing.
const lines = (items) => items.map((item) => `${item}\n`).join('');
const sorted = (items) => [...items].sort();
function comm(left, right) {
  const only = [[], []];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (j === right.length || (i < left.length && left[i] < right[j])) only[0].push(left[i++]);
    else if (i === left.length || right[j] < left[i]) only[1].push(right[j++]);
    else (i++, j++);
  }
  return only;
}
// jq escapes DEL, which JSON.stringify leaves raw (only possible inside strings).
const jq = (value) => `${JSON.stringify(value, null, 2).replaceAll('\x7f', '\\u007f')}\n`;
// jq prints computed numbers below 1e-4 in exponent form with a two-digit exponent.
const jqNumber = (value) =>
  value !== 0 && Math.abs(value) < 1e-4
    ? value.toExponential().replace(/e([+-])(\d)$/, 'e$10$2')
    : String(value);

const shardNames = existsSync(values.shards)
  ? (await readdir(values.shards)).filter((name) => name.startsWith('shard-')).sort()
  : [];
const results = [];
const images = [];
for (const name of shardNames) {
  const file = join(values.shards, name, 'run', 'results.json');
  if (existsSync(file)) results.push(...JSON.parse(await readFile(file, 'utf8')));
  const imageFile = join(values.shards, name, 'images.txt');
  if (existsSync(imageFile))
    images.push(...(await readFile(imageFile, 'utf8')).split('\n').filter(Boolean));
}

// Every repository the plan assigned must have exactly one row.
const expected = sorted(repos.slice(offset, Number(end)).map((entry) => entry.repo));
const present = sorted(results.map((row) => String(row?.repo ?? null)));
const uniquePresent = [...new Set(present)];
const [missing, unexpected] = comm(expected, uniquePresent);
const duplicated = uniquePresent.filter(
  (repo) => present.indexOf(repo) !== present.lastIndexOf(repo),
);
const imageLines = [...new Set(sorted(images))];

const output = values.output;
await mkdir(output, { recursive: true });
await writeFile(join(output, 'results.json'), jq(results));
for (const [name, items] of Object.entries({
  expected,
  present,
  missing,
  unexpected,
  duplicated,
  images: imageLines,
}))
  await writeFile(join(output, `${name}.txt`), lines(items));

const classes = new Map();
for (const row of results) {
  const key = row?.outcomeClass ?? 'unclassified';
  classes.set(key, (classes.get(key) ?? 0) + 1);
}
// Loaded through tsx, as bin/refit.mjs does: pipeline modules use syntax type stripping rejects.
const { summaryTable } = await tsImport(
  meta ? '../pipeline/meta-benchmark.ts' : '../pipeline/stripe-benchmark.ts',
  {
    parentURL: import.meta.url,
    tsconfig: false,
  },
);
const spend = results.reduce(
  (total, row) => total + ((row?.workflow?.aiCostUsd ?? 0) + (row?.ai?.costUsd ?? 0)),
  0,
);
const incomplete = missing.length || unexpected.length || duplicated.length;
const summary = [
  `# Merged ${meta ? 'Meta Graph' : 'Stripe'} benchmark: ${results.length} of ${expected.length} repositories`,
  '',
  `Commit \`${values.commit}\`, list \`${values.list}\`, repositories ${values.offset} to ${end}. Images: ${imageLines.join(' ')}`,
  '',
  ...(incomplete
    ? [
        `**Incomplete run.** Missing ${missing.length}, unexpected ${unexpected.length}, duplicated ${duplicated.length}. Missing: ${missing.join(' ')}`,
        '',
      ]
    : []),
  '| Outcome class | Repositories |',
  '|---|---|',
  ...sorted(classes.keys()).map((key) => `| ${key} | ${classes.get(key)} |`),
  '',
  summaryTable(results),
  `AI spend: $${jqNumber(spend)}`,
];
await writeFile(join(output, 'summary.md'), lines(summary));
console.log(
  `Merged ${results.length} of ${expected.length} repositories into ${output}: missing ${missing.length}, unexpected ${unexpected.length}, duplicated ${duplicated.length}.`,
);
