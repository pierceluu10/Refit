#!/usr/bin/env node
// The AI sweep on a sample of repos: what did the scan miss? Prints every miss for a person to check,
// and never counts a repo as clean for it.
//   APTITUDE_AI_BUDGET_USD=1 node evals/runner/sweep-run.ts <lock-style.json> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { budgetFromEnv } from '../../harness/index.ts';
import { agentSdk } from '../../orchestrator/agent-sdk.ts';
import { createBudget } from '../../orchestrator/budget.ts';
import { SWEEP_MODEL, sweepRepo } from '../../orchestrator/sweep.ts';
import type { RepoLock } from '../scoring/required.ts';
import { gitCheckout } from './checkout.ts';
import { evalScanner } from './session-run.ts';

async function main([listFile, out]: string[]) {
  if (!listFile || !out) throw new Error('usage: sweep-run.ts <repos.json> <out.json>');
  const budget = createBudget(budgetFromEnv());
  const ask = agentSdk({ budget, model: SWEEP_MODEL });
  const scanner = evalScanner(budget);
  const rows = [];
  for (const { repo, commit } of JSON.parse(readFileSync(listFile, 'utf8')) as RepoLock[]) {
    const checkout = await gitCheckout()({ repo, commit });
    try {
      const scan = await scanner.scan(checkout.repoDir, repo);
      const { lessons, costUsd } = await sweepRepo({
        repo,
        dir: checkout.repoDir,
        commit,
        scan,
        list: scanner.list(),
        ask,
      });
      rows.push({ repo, clean: scan.clean, costUsd, lessons });
      console.log(`${repo}: ${lessons.length} miss(es), $${costUsd.toFixed(4)}`);
      writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`);
    } finally {
      await checkout.cleanup();
    }
  }
  console.log(`spent $${budget.spentUsd().toFixed(4)}`);
}

if (process.argv[1] === import.meta.filename) await main(process.argv.slice(2));
