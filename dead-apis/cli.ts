// Keeps the list current.
//   node dead-apis/cli.ts refresh [--provider a,b] [--queue N] [--store dir] [--cache dir] [--dry-run]
//   node dead-apis/cli.ts queue [--store dir]
//   node dead-apis/cli.ts proposals [--store dir]
//   node dead-apis/cli.ts refuse <id> --reason why [--store dir]
// Only refresh can spend, and it refuses without APTITUDE_AI_BUDGET_USD. A dry run never goes live.
// A proposal that goes live rewrites its data file, and so does a refusal: run
// `npx prettier --write dead-apis` after either. Refused entries stay off the list for good.
import { parseArgs } from 'node:util';
import { PROPOSED_DIR, readProposals, refuseEntry } from './proposals.ts';
import { readQueue } from './queue.ts';
import { refresh, refreshFinished, type RefreshReport } from './refresh.ts';

const USAGE =
  'usage: cli.ts refresh [--provider a,b] [--queue N] [--store dir] [--cache dir] [--dry-run] | queue [--store dir] | proposals [--store dir] | refuse <id> --reason why [--store dir]';

function printReport(report: RefreshReport): void {
  console.log(
    `Refresh on ${report.day}, $${report.spentUsd.toFixed(4)} of the $${report.capUsd} cap`,
  );
  for (const row of report.providers) {
    console.log(
      `${row.provider}: ${row.outcome}, $${row.costUsd.toFixed(4)} today, ${row.proposed} proposed, ${row.live.length} live, ${row.pending.length} pending, ${row.rejected.length} rejected, ${row.noted.length} noted${row.note ? ` (${row.note})` : ''}`,
    );
    for (const id of row.live) console.log(`  live ${id}`);
    for (const one of row.pending) console.log(`  pending ${one.id}: ${one.reason}`);
    for (const one of row.rejected) console.log(`  rejected ${one.id}: ${one.reason}`);
    for (const one of row.noted) console.log(`  noted ${one.id}: ${one.reason}`);
  }
  console.log(`All reads today in this cache: $${report.totalTodayUsd.toFixed(4)}`);
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      provider: { type: 'string' },
      queue: { type: 'string' },
      store: { type: 'string' },
      cache: { type: 'string' },
      reason: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
  });
  const [command, id] = positionals;
  const storeDir = values.store ?? PROPOSED_DIR;

  if (command === 'queue') {
    for (const item of await readQueue(storeDir)) {
      const last = item.lastRead ? `, read ${item.lastRead.day}: ${item.lastRead.outcome}` : '';
      console.log(`${item.provider}: ${item.repos.length} repo(s)${last}`);
    }
    return 0;
  }
  if (command === 'proposals') {
    for (const one of await readProposals(storeDir)) {
      console.log(`${one.status} ${one.id} (${one.provider}): ${one.reason}`);
    }
    return 0;
  }
  if (command === 'refuse') {
    if (!id || !values.reason?.trim()) {
      console.error(USAGE);
      return 2;
    }
    const refused = await refuseEntry({ id, reason: values.reason, storeDir });
    console.log(`refused ${refused.id} (${refused.provider}): ${refused.reason}`);
    return 0;
  }
  const providers = values.provider?.split(',').filter(Boolean) ?? [];
  const queue = Number(values.queue ?? 0);
  if (
    command !== 'refresh' ||
    !Number.isInteger(queue) ||
    queue < 0 ||
    (!providers.length && queue === 0)
  ) {
    console.error(USAGE);
    return 2;
  }
  const report = await refresh({
    providers,
    queue,
    storeDir,
    cacheDir: values.cache,
    dryRun: values['dry-run'],
  });
  printReport(report);
  return refreshFinished(report) ? 0 : 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
