// Scores a run of the open-source Stripe benchmark from its merged results and the hand reviews.
// Usage: node scripts/stripe-oss-score.mjs --results <merged results.json> [--results …]
//          --run <refit-bench run id> [--run …] [--shards <dir of shard-* artifacts>]
//          [--history docs/benchmarks/<cases.json>] [--output <score.json>]
// Precision counts wrong patches among the hand-reviewed published ones (target 0). Coverage is
// validated patches reviewed correct over repositories that need a change and have runnable
// checks. Every repository that does not end validated is listed with its stop reason.
// Historical cases also compare the files Refit's patch changes with the maintainers' diff.
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const REVIEWS = 'docs/benchmarks/fix-reviews.json';
// Paths a stripe-node upgrade changes in every patch, which say nothing about the code change.
const UPGRADE_FILE = /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;
// Production-mode outcomes whose patch a hosted worker opens as a draft (owner decision 1).
const PUBLISHED = new Set(['validated', 'needs-review']);

// Files a unified diff changes, from its `+++ b/` headers.
export function diffFiles(patch) {
  return [
    ...new Set([...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]).filter(Boolean)),
  ].sort();
}

// The review of a repository from this run, matched by repository and run id in its `run` text.
export function reviewFor(reviews, repo, runs) {
  return reviews.find(
    (review) => review.repo === repo && runs.some((run) => review.run?.includes(String(run))),
  );
}

// One repository's score row. `human` is the historical case, or undefined in forward mode.
export function scoreRow(row, { review, patchFiles, human }) {
  const status = row.production?.status ?? row.workflow?.status ?? 'error';
  const workflow = row.workflow ?? {};
  const patch = workflow.patch === 'proposed';
  const affected = row.productionMode?.status === 'affected' || Boolean(human?.codeFiles?.length);
  const runnable = workflow.baseline === 'passed';
  const code = (patchFiles ?? []).filter((path) => !UPGRADE_FILE.test(path));
  return {
    repo: row.repo,
    commit: row.commit,
    before: row.before,
    after: row.after,
    status,
    reason: row.production?.reason ?? workflow.reason ?? row.read ?? row.infrastructure?.message,
    published: PUBLISHED.has(status) && patch,
    needsChange: affected,
    runnableChecks: runnable,
    grade: workflow.grade?.letter,
    verdict: review?.verdict ?? null,
    ...(human
      ? {
          fix: human.fix,
          humanCodeFiles: human.codeFiles,
          refitCodeFiles: code,
          sharedFiles: code.filter((path) => human.codeFiles.includes(path)),
        }
      : {}),
  };
}

export function summarize(rows) {
  const published = rows.filter((row) => row.published);
  const reviewed = published.filter((row) => row.verdict);
  const denominator = rows.filter((row) => row.needsChange && row.runnableChecks);
  const covered = denominator.filter(
    (row) => row.status === 'validated' && row.published && row.verdict === 'correct',
  );
  const stops = {};
  for (const row of rows.filter((entry) => entry.status !== 'validated'))
    (stops[row.status] ??= []).push({ repo: row.repo, reason: row.reason });
  return {
    repositories: rows.length,
    validated: rows.filter((row) => row.status === 'validated').length,
    published: published.length,
    reviewed: reviewed.length,
    unreviewed: published.filter((row) => !row.verdict).map((row) => row.repo),
    verdicts: Object.fromEntries(
      ['correct', 'correct-partial', 'wrong', 'unsure'].map((verdict) => [
        verdict,
        reviewed.filter((row) => row.verdict === verdict).length,
      ]),
    ),
    wrong: reviewed.filter((row) => row.verdict === 'wrong').map((row) => row.repo),
    coverage: { covered: covered.length, needsChangeWithChecks: denominator.length },
    stops,
  };
}

async function patchFilesIn(shards) {
  const files = new Map();
  if (!shards || !existsSync(shards)) return files;
  for (const shard of await readdir(shards)) {
    const repos = join(shards, shard, 'run', 'repos');
    if (!existsSync(repos)) continue;
    for (const directory of await readdir(repos)) {
      const patch = join(repos, directory, 'run', 'migration.patch');
      if (existsSync(patch))
        files.set(directory.replace('__', '/'), diffFiles(await readFile(patch, 'utf8')));
    }
  }
  return files;
}

async function main() {
  const { values } = parseArgs({
    options: {
      results: { type: 'string', multiple: true },
      run: { type: 'string', multiple: true },
      shards: { type: 'string' },
      history: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !values.results?.length || !values.run?.length) {
    console.log(
      'Usage: node scripts/stripe-oss-score.mjs --results <results.json> … --run <id> … [--shards <dir>] [--history <cases.json>] [--output <score.json>]',
    );
    process.exit(values.help ? 0 : 1);
  }
  const reviews = JSON.parse(await readFile(REVIEWS, 'utf8')).reviews;
  const history = values.history ? JSON.parse(await readFile(values.history, 'utf8')).cases : [];
  const patches = await patchFilesIn(values.shards && resolve(values.shards));
  const rows = [];
  for (const path of values.results)
    for (const row of JSON.parse(await readFile(path, 'utf8')))
      rows.push(
        scoreRow(row, {
          review: reviewFor(reviews, row.repo, values.run),
          patchFiles: patches.get(row.repo),
          human: history.find(
            (record) => record.repo === row.repo && record.parent === row.commit && !record.skipped,
          ),
        }),
      );
  const score = { runs: values.run, ...summarize(rows), rows };
  if (values.output) await writeFile(values.output, `${JSON.stringify(score, null, 2)}\n`);
  const { rows: _rows, ...headline } = score;
  console.log(JSON.stringify(headline, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
