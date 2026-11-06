// The proof tools inside the real harness loop, driven by the scripted fake model (no AI spend).
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MigrationTask } from '../../shared/types.ts';
import { scriptedSession, type ScriptedTurn } from '../fake-session.ts';
import { runTask } from '../run.ts';
import { createSandbox } from '../sandbox.ts';
import { fixture } from './test-helpers.ts';

// Illustrative task: the fixture repo and change are made up for this test.
const task: MigrationTask = {
  id: 'fixture-k8s-1-29',
  repo: 'example/fixture-cluster',
  change: {
    provider: 'kubernetes',
    id: 'k8s-1.29-removals',
    kind: 'other',
    title: 'Kubernetes 1.29 no longer serves removed beta APIs',
    source: {
      url: 'https://kubernetes.io/docs/reference/using-api/deprecation-guide/',
      quote: 'The batch/v1beta1 API version of CronJob is no longer served as of v1.25.',
    },
    affects: { versions: ['1.29'] },
  },
  usages: [],
  priority: 1,
};

function repo(from = 'k8s-old'): string {
  const dir = mkdtempSync(join(tmpdir(), 'refit-proof-harness-'));
  cpSync(fixture(from), dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      scripts: { test: 'node -e "process.exit(0)"' },
    }),
  );
  return dir;
}

const run = (turn: ScriptedTurn, from?: string) =>
  runTask(task, repo(from), {
    session: scriptedSession([turn]),
    createSandbox: (dir: string) => createSandbox(dir, { mode: 'local' }),
    budgetUsd: 1,
    turnReserveUsd: 0,
    outDir: mkdtempSync(join(tmpdir(), 'refit-proof-harness-out-')),
  });

const finish = (call: Parameters<ScriptedTurn>[0], validators: unknown[] = []) =>
  call('finish', {
    verdict: 'migrated',
    summary: 'Illustrative summary',
    why: 'Illustrative reason',
    validators,
    unproven: [],
    behaviourChanges: [],
  });

describe('proof tools in the harness', () => {
  it('lets the fake agent prove its Kubernetes fix, and the harness grades the validator', async () => {
    const outputs: string[] = [];
    const migrate: ScriptedTurn = async (call) => {
      outputs.push(await call('proof_check__proof_kubernetes', { targetVersion: '1.29' }));
      const file = 'deploy/app.yaml';
      const text = await call('read_file', { path: file });
      expect(text).toContain('extensions/v1beta1');
      await call('edit_file', {
        path: file,
        old: 'apiVersion: extensions/v1beta1',
        new: 'apiVersion: apps/v1',
      });
      await call('edit_file', {
        path: file,
        old: 'apiVersion: batch/v1beta1',
        new: 'apiVersion: batch/v1',
      });
      outputs.push(await call('proof_check__proof_kubernetes', { targetVersion: '1.29' }));
      await finish(call, [
        { name: 'proof_kubernetes', passed: true, detail: 'no removed APIs for 1.29' },
      ]);
    };
    const record = await run(migrate);
    expect(outputs[0].split('\n')[0]).toBe('kubernetes: failed');
    expect(outputs[1].split('\n')[0]).toBe('kubernetes: passed');
    expect(record.diff).toContain('+apiVersion: apps/v1');
    expect(record.outcome).toBe('verified');
    expect(record.prBody).toContain('proof_check__proof_kubernetes');
    expect(readFileSync(record.transcriptPath, 'utf8')).toContain('proof_check__proof_kubernetes');
  });

  it("compares a before/after proof with the untouched checkout, not the agent's copy", async () => {
    const outputs: string[] = [];
    const addScript: ScriptedTurn = async (call) => {
      outputs.push(await call('proof_check__proof_payment_scripts', {}));
      await call('edit_file', {
        path: 'checkout/index.html',
        old: '</body>',
        new: '<script src="https://cdn.example.test/analytics.js"></script></body>',
      });
      outputs.push(await call('proof_check__proof_payment_scripts', {}));
      await finish(call);
    };
    const record = await run(addScript, 'web');
    expect(outputs[0]).toContain('compared with the untouched copy of the repo');
    expect(outputs[0].split('\n')[0]).toBe('payment-scripts: passed');
    expect(outputs[1].split('\n')[0]).toBe('payment-scripts: failed');
    expect(outputs[1]).toContain('new script on a payment page');
    expect(record.outcome).toBe('needs-review');
  });
});
