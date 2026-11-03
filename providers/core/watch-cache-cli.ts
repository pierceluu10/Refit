// The day's changelog reads, by provider: what they cost and that cost per repo, or a refresh.
//   node providers/core/watch-cache-cli.ts report [--cache <dir>] [--day YYYY-MM-DD] [--json]
//   node providers/core/watch-cache-cli.ts refresh <provider|all> [--cache <dir>] [--day YYYY-MM-DD]
// Neither spends anything: refresh only drops the day's file, so the next caller reads again.
import { parseArgs } from 'node:util';
import { defaultWatchDir, dropCachedReads, watchCostReport } from './watch-cache.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cache: { type: 'string' },
    day: { type: 'string' },
    json: { type: 'boolean' },
  },
});
const [command, target] = positionals;
const dir = values.cache ?? defaultWatchDir();
const day = values.day ?? new Date().toISOString().slice(0, 10);

if (command === 'report') {
  const report = await watchCostReport(dir, day);
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Changelog reads on ${day} in ${dir}`);
    for (const row of report.rows) {
      const perRepo =
        row.costPerRepoUsd === undefined
          ? 'no repo named it'
          : `$${row.costPerRepoUsd.toFixed(4)} a repo over ${row.repos.length}`;
      console.log(
        `${row.provider}: ${row.reads} read(s), ${row.cachedReads} cached, $${row.costUsd.toFixed(4)}, served ${row.served} time(s) from the cache, ${perRepo}`,
      );
    }
    console.log(`Total $${report.totalUsd.toFixed(4)}`);
  }
} else if (command === 'refresh' && target) {
  const dropped = await dropCachedReads(dir, target, day);
  console.log(
    dropped.length
      ? `Dropped ${dropped.join(', ')}: the next caller reads again.`
      : `No cached read of ${target} on ${day} in ${dir}.`,
  );
} else {
  console.error(
    'usage: watch-cache-cli.ts report [--cache dir] [--day d] [--json] | refresh <provider|all> [--cache dir] [--day d]',
  );
  process.exitCode = 2;
}
