// node providers/platforms/cli.ts <command>
//   sources    fetch every starting page and save it under fixtures/sources (no AI)
//   read       one live read (spends AI, capped by REFIT_AI_BUDGET_USD, which must be set):
//              read <name> --kind <platform|infrastructure|security-standard> [--version v]
//                   [--ecosystem e] [--notes text] [--since YYYY-MM-DD] [--save dir] [--no-search]
//                   [--max-turns n] [--max-usd n]
//              --max-usd lowers the cap for this read. --save writes dependency.json, pages/ and live-run.json.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { DependencyUsage } from '../../shared/types.ts';
import { DEFAULT_WEB_SEARCH } from '../core/any-watcher.ts';
import { httpFetcher, recordSnapshot } from '../core/fetch.ts';
import { BudgetLedger, budgetFromEnv } from '../core/model.ts';
import { savePages, type PageReader } from '../core/page-tools.ts';
import { PLATFORM_WATCH_PROMPT_VERSION } from './prompt.ts';
import { PLATFORM_SOURCES } from './sources.ts';
import { runPlatformWatch } from './watcher.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const [command, ...rest] = process.argv.slice(2);

if (command === 'sources') {
  const manifest = await recordSnapshot(
    { id: 'platforms', sources: PLATFORM_SOURCES },
    join(HERE, 'fixtures', 'sources'),
    {
      fetcher: httpFetcher({ timeoutMs: 30_000 }),
      snapshotChars: 12_000,
    },
  );
  for (const source of manifest.sources)
    console.log(
      `${source.id}: ${source.ok ? 'ok' : 'FAILED'} ${source.status} ${source.chars} chars${source.error ? ` (${source.error})` : ''}`,
    );
} else if (command === 'read') {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      kind: { type: 'string' },
      version: { type: 'string' },
      ecosystem: { type: 'string' },
      notes: { type: 'string' },
      since: { type: 'string' },
      save: { type: 'string' },
      'no-search': { type: 'boolean' },
      'max-turns': { type: 'string' },
      'max-usd': { type: 'string' },
    },
  });
  if (!positionals[0] || !values.kind) {
    console.error('usage: cli.ts read <name> --kind <DependencyKind> [--version v] [--save dir]');
    process.exit(2);
  }
  const dependency: DependencyUsage = {
    repo: 'cli',
    kind: values.kind as DependencyUsage['kind'],
    name: positionals[0],
    ...(values.version ? { version: values.version } : {}),
    ...(values.ecosystem ? { ecosystem: values.ecosystem } : {}),
    ...(values.notes ? { notes: values.notes } : {}),
    declaredIn: [],
  };
  const capUsd = budgetFromEnv().capUsd;
  const budget = new BudgetLedger(
    Math.min(capUsd, values['max-usd'] ? Number(values['max-usd']) : capUsd),
  );
  let reader: PageReader | undefined;
  const runAt = new Date().toISOString();
  const report = await runPlatformWatch(dependency, values.since, {
    budget,
    webSearch: values['no-search'] ? false : undefined,
    maxTurns: values['max-turns'] ? Number(values['max-turns']) : undefined,
    onPages: (pages) => (reader = pages),
  });
  console.log(JSON.stringify(report, null, 2));
  if (values.save && reader) {
    const dir = resolve(values.save);
    mkdirSync(dir, { recursive: true });
    savePages(reader, join(dir, 'pages'), { provider: report.provider });
    writeFileSync(join(dir, 'dependency.json'), `${JSON.stringify(dependency, null, 2)}\n`);
    const record = {
      note: `Live run: ${report.model} through the Messages API on ${runAt.slice(0, 10)}, reading live pages. pages/ keeps what the agent was shown. Output recorded as returned, not edited.`,
      runAt,
      model: report.model,
      promptVersion: PLATFORM_WATCH_PROMPT_VERSION,
      input: {
        dependency,
        ...(values.since ? { since: values.since } : {}),
        webSearch: values['no-search'] ? false : DEFAULT_WEB_SEARCH,
        capUsd: budget.capUsd,
      },
      report,
    };
    writeFileSync(join(dir, 'live-run.json'), `${JSON.stringify(record, null, 2)}\n`);
    console.error(`saved ${dir}`);
  }
  console.error(
    `${report.provider}: ${report.changes.length} changes, ${report.unverifiedQuotes.length} unverified quotes, ${report.issues.length} issues, ${report.errors.length} read errors, ${report.turns} turns`,
  );
  console.error(`AI spend: $${budget.spentUsd.toFixed(4)} of $${budget.capUsd}`);
  if (report.failed) process.exitCode = 1;
} else {
  console.error('usage: cli.ts <sources|read> ...');
  process.exit(2);
}
