// Measures the owner decision of 2026-10-22: live deadline matches on docs, example, test-fixture
// and build-output paths are listed but no longer counted as exposures. Runs scanDeadlines on every
// repository the exclusion scan (docs/benchmarks/2026-10-22-workspace-exclusions.json) found an
// excluded finding in, and records, per repository, the deadlines counted before the decision
// (any live match) and after it (a live match in application code), with each uncounted match.
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
    // Before the decision every live match counted, wherever it was.
    result.countedBefore = all
      .filter((item) => item.evidence.length || item.outside.some((match) => match.use === 'live'))
      .map((item) => item.deadline.id)
      .sort();
    result.countedAfter = exposures.map((item) => item.deadline.id).sort();
    result.outside = all.flatMap((item) =>
      item.outside.map((match) => ({
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
