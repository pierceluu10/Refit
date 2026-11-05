#!/usr/bin/env node
// One repo session per repo, from a locked round file, under one dollar cap: checkout, scan, session,
// proof, grade. It runs what the product's scan path runs, with the stand-in scan until Pierce's lands.
//   APTITUDE_AI_BUDGET_USD=5 node evals/runner/session-run.ts evals/rounds/o2/lock.json out-dir
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repoTask } from '../../harness/findings.ts';
import { liveSmoke } from '../../harness/smoke.ts';
import { budgetFromEnv, runTask } from '../../harness/index.ts';
import type { HarnessDeps, HarnessRunRecord } from '../../harness/index.ts';
import { createBudget } from '../../orchestrator/budget.ts';
import { createDeps, REPO_USD } from '../../orchestrator/deps.ts';
import { runRepo, type LoopDeps } from '../../orchestrator/loop.ts';
import { loadToolPack } from '../../providers/toolkit/pack.ts';
import { gradeChange, majorUpgrades, proveLock, type RepoLock } from '../scoring/required.ts';
import { gitCheckout } from './checkout.ts';
import { standinList, standinScan } from './standin-scan.ts';

export type SessionResult = {
  repo: string;
  commit: string;
  outcome: HarnessRunRecord['outcome'] | 'clean' | 'error';
  required: { id: string; fixed: boolean; why: string }[];
  majorUpgrades?: string[];
  costUsd: number;
  durationMs: number;
  record?: HarnessRunRecord;
  error?: string;
};

// Applies the run's diff to a throwaway copy, with nothing run, and grades the locked changes.
function gradeDiff(repoDir: string, lock: RepoLock, diff: string) {
  const copy = mkdtempSync(path.join(tmpdir(), 'aptitude-grade-'));
  try {
    cpSync(repoDir, copy, { recursive: true, verbatimSymlinks: true });
    if (diff.trim()) {
      const patch = path.join(copy, '.run.patch');
      writeFileSync(patch, diff);
      execFileSync('git', ['-C', copy, 'apply', '--whitespace=nowarn', patch], { stdio: 'pipe' });
      rmSync(patch);
    }
    return lock.required.map((change) => ({ id: change.id, ...gradeChange(copy, change) }));
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

export async function runRepoLock(
  lock: RepoLock,
  outDir: string,
  extra: HarnessDeps = {},
): Promise<SessionResult> {
  const started = Date.now();
  const base = { repo: lock.repo, commit: lock.commit };
  const checkout = await gitCheckout()({ repo: lock.repo, commit: lock.commit });
  try {
    const proofCopy = mkdtempSync(path.join(tmpdir(), 'aptitude-proof-'));
    cpSync(checkout.repoDir, proofCopy, { recursive: true, verbatimSymlinks: true });
    const problems = proveLock(proofCopy, lock);
    rmSync(proofCopy, { recursive: true, force: true });
    if (problems.length) throw new Error(`lock does not hold: ${problems.join('; ')}`);

    const list = standinList();
    const scan = standinScan(checkout.repoDir, list);
    if (scan.clean) {
      const required = gradeDiff(checkout.repoDir, lock, '');
      return { ...base, outcome: 'clean', required, costUsd: 0, durationMs: Date.now() - started };
    }
    const task = repoTask(lock.repo, scan, list);
    const repoOut = path.join(outDir, lock.repo.replace('/', '__'));
    mkdirSync(repoOut, { recursive: true });
    writeFileSync(path.join(repoOut, 'task.json'), JSON.stringify(task));
    const record = await runTask(task, checkout.repoDir, {
      budgetUsd: REPO_USD,
      outDir: repoOut,
      loadToolPack: (provider) => loadToolPack(provider, {}),
      rescan: async (dir) => standinScan(dir, list),
      smoke: (task) => liveSmoke(task),
      ...extra,
    });
    return {
      ...base,
      outcome: record.outcome,
      required: gradeDiff(checkout.repoDir, lock, record.diff),
      majorUpgrades: majorUpgrades(record.diff),
      costUsd: record.costUsd,
      durationMs: Date.now() - started,
      record,
    };
  } catch (error) {
    return {
      ...base,
      outcome: 'error',
      required: [],
      costUsd: 0,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await checkout.cleanup();
  }
}

// The whole product on one locked repo: the loop's own scan, session, proof and record, with no PR.
export async function runProductRepo(lock: RepoLock, deps: LoopDeps): Promise<SessionResult> {
  const started = Date.now();
  const checkout = await gitCheckout()({ repo: lock.repo, commit: lock.commit });
  try {
    const repo = { repo: lock.repo, dir: checkout.repoDir };
    const [record] = await runRepo(repo, async () => [], deps, { dryRun: true });
    const harness = record as unknown as HarnessRunRecord;
    return {
      repo: lock.repo,
      commit: lock.commit,
      outcome: record?.outcome ?? 'error',
      required: gradeDiff(checkout.repoDir, lock, record?.diff ?? ''),
      majorUpgrades: majorUpgrades(record?.diff ?? ''),
      costUsd: record?.costUsd ?? 0,
      durationMs: Date.now() - started,
      record: harness,
    };
  } finally {
    await checkout.cleanup();
  }
}

async function main(argv: string[]) {
  const product = argv.includes('--product');
  const [lockFile, outDir] = argv.filter((arg) => arg !== '--product');
  if (!lockFile || !outDir)
    throw new Error('usage: session-run.ts <lock.json> <out-dir> [--product]');
  const capUsd = budgetFromEnv();
  const locks = JSON.parse(readFileSync(lockFile, 'utf8')) as RepoLock[];
  mkdirSync(outDir, { recursive: true });
  const list = standinList();
  const deps = product
    ? createDeps({
        budget: createBudget(capUsd),
        login: !process.env.ANTHROPIC_API_KEY,
        benchmark: true,
        scan: async (dir) => standinScan(dir, list),
        list: () => list,
      })
    : undefined;
  let spentUsd = 0;
  const results: SessionResult[] = [];
  // One at a time, so each repo's time is its own and the cap is checked between repos.
  for (const lock of locks) {
    if (spentUsd + REPO_USD > capUsd) {
      console.log(`stopped before ${lock.repo}: $${spentUsd.toFixed(2)} of $${capUsd} spent`);
      break;
    }
    const result = deps ? await runProductRepo(lock, deps) : await runRepoLock(lock, outDir);
    spentUsd += result.costUsd;
    results.push(result);
    const fixed = result.required.filter((change) => change.fixed).length;
    console.log(
      `${result.outcome.padEnd(12)} ${lock.repo} fixed ${fixed}/${lock.required.length} $${result.costUsd.toFixed(4)} ${(result.durationMs / 1000).toFixed(0)}s ${result.error ?? ''}`,
    );
    writeFileSync(path.join(outDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  }
  const required = results.flatMap((result) => result.required);
  const fixed = required.filter((change) => change.fixed).length;
  console.log(
    `total: ${fixed}/${required.length} fixed, $${spentUsd.toFixed(4)}, $${(spentUsd / Math.max(fixed, 1)).toFixed(4)} per fix`,
  );
}

if (process.argv[1] === import.meta.filename) {
  process.exitCode = await main(process.argv.slice(2)).then(
    () => 0,
    (error: unknown) => {
      console.error(error);
      return 1;
    },
  );
}
