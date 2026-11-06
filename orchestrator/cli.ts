#!/usr/bin/env node
import { realpathSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createBudget } from './budget.ts';
import { createDeps, defaultOut } from './deps.ts';
import type { RunRecord } from '../shared/types.ts';
import { createScanRepo } from './index.ts';
import { runOrg, type RunSummary } from './loop.ts';
import type { ScanItemReport } from './scan.ts';

const USAGE = [
  'usage: refit scan --repo <path> [--repo <path> ...] [--out report.json]',
  '       refit run --repo <path> [--repo <path> ...] [--dry-run] [--out <file>]',
].join('\n');

function parse(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: 'string', multiple: true },
      'dry-run': { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });
  const command = positionals[0];
  if (positionals.length !== 1 || (command !== 'run' && command !== 'scan'))
    throw new Error('expected `scan` or `run`');
  if (command === 'scan' && values['dry-run'])
    throw new Error('--dry-run is for `run`; `scan` never opens PRs');
  if (!values.repo?.length) throw new Error('--repo is required');
  const repos = values.repo.map((path) => {
    const dir = resolve(path);
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`${dir} is not a directory`);
    }
    return { repo: basename(dir), dir };
  });
  return {
    command,
    repos,
    outGiven: values.out !== undefined,
    name: repos.length === 1 ? repos[0].repo : `${repos.length} repos`,
    dryRun: values['dry-run'],
    out: values.out ? resolve(values.out) : defaultOut,
  };
}

export function formatSummary(
  repo: string,
  summary: RunSummary,
  { dryRun, out }: { dryRun: boolean; out: string },
): string {
  const { counts } = summary;
  // Attempted work first; the not-affected verdicts, each with the match agent's reasoning, last.
  const order: RunRecord['outcome'][] = ['verified', 'needs-review', 'failed', 'not-affected'];
  return [
    `Refit run on ${repo}${dryRun ? ' (dry run: no PRs opened)' : ''}`,
    `  outcomes: ${counts.verified} verified, ${counts['needs-review']} needs-review, ${counts['not-affected']} not-affected, ${counts.failed} failed`,
    ...order.flatMap((outcome) =>
      summary.records
        .filter((r) => r.outcome === outcome)
        .map(
          (r) =>
            `  ${r.outcome.padEnd(12)} ${r.taskId}${r.pr ? `  ${r.pr}` : ''}${r.note ? `\n${' '.repeat(15)}${r.note}` : ''}`,
        ),
    ),
    `  PRs: ${summary.prs.length ? summary.prs.join(', ') : 'none'}`,
    `  cost: $${summary.costUsd.toFixed(4)}`,
    `  run records: ${out}`,
    ...summary.errors.map((e) => `  error: ${e}`),
  ].join('\n');
}

const cell = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);

// The "what's behind" table: one row per change, open ones first by deadline, then the reason for
// every not-affected verdict.
export function formatReport(report: ScanItemReport): string {
  const open = report.items.filter((i) => i.status !== 'not-affected');
  const clear = report.items.filter((i) => i.status === 'not-affected');
  const header = `  ${cell('DEADLINE', 11)} ${cell('SEVERITY', 9)} ${cell('DEPENDENCY', 22)} ${cell('VERSION → TARGET', 24)} ${cell('STATUS', 13)} CHANGE`;
  const row = (item: ScanItemReport['items'][number]) =>
    `  ${cell(item.deadline ?? '-', 11)} ${cell(item.change.severity ?? '-', 9)} ${cell(item.dependency.name, 22)} ${cell(`${item.dependency.version ?? '?'} → ${item.change.toVersion ?? '?'}`, 24)} ${cell(item.status, 13)} ${item.change.title}${item.pr ? `  ${item.pr}` : ''}`;
  return [
    `What's behind in ${report.repo} (scanned ${report.scannedAt})`,
    `  ${open.length} open, ${clear.length} not affected; scan cost $${report.costUsd.toFixed(4)}`,
    ...(open.length ? [header, ...open.map(row)] : ['  nothing open']),
    ...(clear.length
      ? [
          '  not affected:',
          ...clear.map((i) => `    ${i.change.id}: ${i.reason ?? 'no reason given'}`),
        ]
      : []),
    ...report.errors.map((e) => `  error: ${e}`),
  ].join('\n');
}

async function scan(args: ReturnType<typeof parse>): Promise<number> {
  // The run-level dollar cap is a hard limit: createBudget throws without REFIT_AI_BUDGET_USD.
  const budget = process.env.ANTHROPIC_API_KEY
    ? createBudget(undefined, (label, spentUsd) =>
        console.error(`spent $${spentUsd.toFixed(4)} on ${label}`),
      )
    : undefined;
  const scanRepo = createScanRepo(createDeps({ budget }));
  // SECURITY: a scan only reads the checkouts; nothing in them runs.
  const reports: ScanItemReport[] = [];
  for (const { repo, dir } of args.repos) reports.push((await scanRepo(repo, dir)).report);
  console.log(reports.map(formatReport).join('\n\n'));
  if (budget)
    console.log(`  run budget: $${budget.spentUsd().toFixed(4)} spent of $${budget.capUsd}`);
  if (args.outGiven) {
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(
      args.out,
      `${JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2)}\n`,
    );
    console.log(`  report: ${args.out}`);
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch (error) {
    console.error(`refit: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  try {
    if (args.command === 'scan') return await scan(args);
    // The run-level dollar cap is a hard limit: createBudget throws without REFIT_AI_BUDGET_USD.
    const budget = process.env.ANTHROPIC_API_KEY ? createBudget() : undefined;
    const deps = createDeps({ out: args.out, budget });
    // SECURITY: nothing here runs the repo's code or scripts on this host; runTask hands it to the harness sandbox.
    // One org run, so the changelogs are watched once for every repo.
    const summary = await runOrg({ name: args.name, repos: args.repos }, deps, {
      dryRun: args.dryRun,
      capUsd: budget?.capUsd,
    });
    // The loop counts match and task costs; the budget also saw inventory, watchers and memory.
    const costUsd = budget?.spentUsd() ?? summary.costUsd;
    console.log(formatSummary(args.name, { ...summary, costUsd }, args));
    return 0;
  } catch (error) {
    console.error(`refit: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
