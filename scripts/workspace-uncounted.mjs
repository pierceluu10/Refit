// Measures how matches on docs, example, test-fixture and build-output paths are counted. Runs
// scanDeadlines on every repository the exclusion scan
// (docs/benchmarks/2026-10-22-workspace-exclusions.json) found an excluded finding in, and records,
// per repository, the deadlines any live match names (`countedBefore`), the deadlines counted as
// exposures (`countedAfter`), and each live match outside application code (`outside`, with its
// reason). Under owner decision 22 those matches count, labelled, so the two lists differ only by
// paths a repository opts out in .refit-ignore-paths.json. The committed 2026-10-22 results were
// written at d7621ae, when such matches were listed but not counted.
// Checkouts must sit at their frozen commits under --root/<owner>__<name>@<commit prefix>. Files
// are read only: nothing is installed or run.
//
//   node scripts/workspace-uncounted.mjs --scan <exclusions.json> --root <dir> --output <out.json>
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { scanDeadlines } from '../pipeline/deadline-exposure.ts';
import { loadDeadlineRegistry } from '../pipeline/deadline-registry.ts';
import { OUTSIDE_APPLICATION_CODE } from '../pipeline/workspace-attribution.ts';

const execute = promisify(execFile);
const { values } = parseArgs({
  options: { scan: { type: 'string' }, root: { type: 'string' }, output: { type: 'string' } },
});
const NOW = new Date('2026-10-22T00:00:00Z');
const scan = JSON.parse(await readFile(values.scan, 'utf8'));
const registry = await loadDeadlineRegistry();
const { stdout: refitCommit } = await execute('git', ['rev-parse', 'HEAD']);
const { stdout: dirty } = await execute('git', ['status', '--porcelain']);
const results = [];
for (const entry of scan.results.filter((item) => item.excluded.length)) {
  const directory = join(
    values.root,
    `${entry.repository.replace('/', '__')}@${entry.commit.slice(0, 12)}`,
  );
  const result = { repository: entry.repository, commit: entry.commit };
  try {
    const { stdout } = await execute('git', ['-C', directory, 'rev-parse', 'HEAD']);
    if (stdout.trim() !== entry.commit) throw new Error(`checkout is at ${stdout.trim()}`);
    const { exposures, mentions } = await scanDeadlines(directory, registry, NOW);
    const all = [...exposures, ...mentions];
    // Every deadline a live match names, wherever it is, including opted-out paths.
    result.countedBefore = all
      .filter(
        (item) => item.evidence.length || item.ignoredPaths.some((match) => match.use === 'live'),
      )
      .map((item) => item.deadline.id)
      .sort();
    result.countedAfter = exposures.map((item) => item.deadline.id).sort();
    result.outside = exposures.flatMap((item) =>
      item.evidence
        .filter((match) => OUTSIDE_APPLICATION_CODE.has(match.excluded))
        .map((match) => ({
          deadline: item.deadline.id,
          file: match.file,
          line: match.line,
          use: match.use,
          reason: match.excluded,
        })),
    );
  } catch (error) {
    result.error = String(error.message).split('\n')[0];
  }
  results.push(result);
}
const sum = (key) => results.reduce((total, item) => total + (item[key]?.length ?? 0), 0);
await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      refitCommit: refitCommit.trim(),
      dirty: Boolean(dirty.trim()),
      now: NOW.toISOString(),
      repositories: results.length,
      errors: results.filter((item) => item.error).length,
      countedBefore: sum('countedBefore'),
      countedAfter: sum('countedAfter'),
      outside: sum('outside'),
      results,
    },
    null,
    2,
  )}\n`,
);
