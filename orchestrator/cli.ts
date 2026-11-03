#!/usr/bin/env node
import { realpathSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createBudget } from './budget.ts';
import { createDeps, defaultOut } from './deps.ts';
import type { RunRecord } from '../shared/types.ts';
import { runOrg, type RunSummary } from './loop.ts';

const USAGE = 'usage: aptitude run --repo <path> [--repo <path> ...] [--dry-run] [--out <file>]';

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
  if (positionals.length !== 1 || positionals[0] !== 'run') throw new Error('expected `run`');
  if (!values.repo?.length) throw new Error('--repo is required');
  const repos = values.repo.map((path) => {
    const dir = resolve(path);
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`${dir} is not a directory`);
    }
    return { repo: basename(dir), dir };
  });
  return {
    repos,
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
    `Aptitude run on ${repo}${dryRun ? ' (dry run: no PRs opened)' : ''}`,
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

export async function main(argv: string[]): Promise<number> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch (error) {
    console.error(`aptitude: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  try {
    // The run-level dollar cap is a hard limit: createBudget throws without APTITUDE_AI_BUDGET_USD.
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
    console.error(`aptitude: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
