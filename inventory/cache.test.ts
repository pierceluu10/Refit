import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BudgetLedger } from './budget.ts';
import { runDependencyInventory } from './dependencies.ts';
import { fakeModel, fakeResult, makeRepo } from './test-fixtures.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function gitRepo() {
  const repoDir = await makeRepo({ 'package.json': '{"engines":{"node":"18.x"}}\n' });
  dirs.push(repoDir);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repoDir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  return repoDir;
}

const record = {
  tool: 'record_dependencies',
  input: {
    dependencies: [
      {
        kind: 'runtime',
        name: 'node',
        version: '18',
        declaredIn: [{ file: 'package.json', line: 1 }],
      },
    ],
  },
};

describe('the inventory cache', () => {
  it('reads a clean commit once, and again after an uncommitted edit', async () => {
    const repoDir = await gitRepo();
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'inventory-cache-'));
    dirs.push(cacheDir);
    const model = fakeModel([record], fakeResult({ total_cost_usd: 0.2 }));
    const run = () =>
      runDependencyInventory(repoDir, 'o/r', {
        ledger: new BudgetLedger({ capUsd: 5 }),
        surfaces: async () => [],
        runner: model.runner,
        cacheDir,
      });

    const first = await run();
    const second = await run();
    expect(model.requests).toHaveLength(1);
    expect(second.costUsd).toBe(0);
    expect(second.dependencies).toEqual(first.dependencies);

    await writeFile(path.join(repoDir, 'package.json'), '{"engines":{"node":"20.x"}}\n');
    await run();
    expect(model.requests).toHaveLength(2);
  });

  it('keeps nothing from a read that ended early', async () => {
    const repoDir = await gitRepo();
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'inventory-cache-'));
    dirs.push(cacheDir);
    const model = fakeModel(
      [record],
      fakeResult({ subtype: 'error_max_budget_usd', errors: ['cap reached'] } as never),
    );
    const options = {
      ledger: new BudgetLedger({ capUsd: 5 }),
      surfaces: async () => [],
      runner: model.runner,
      cacheDir,
    };
    await runDependencyInventory(repoDir, 'o/r', options);
    await runDependencyInventory(repoDir, 'o/r', options);
    expect(model.requests).toHaveLength(2);
  });
});
