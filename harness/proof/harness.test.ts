// The proof tools inside the real harness loop, driven by the scripted fake model (no AI spend).
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MigrationTask, ToolPack } from '../../shared/types.ts';
import { scriptedSession, type ScriptedTurn } from '../fake-session.ts';
import { runTask } from '../run.ts';
import { createSandbox } from '../sandbox.ts';
import { proofTools } from './index.ts';
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

const toolPack: ToolPack = { provider: 'proof', tools: proofTools, playbooks: {} };

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'refit-proof-harness-'));
  cpSync(fixture('k8s-old'), dir, { recursive: true });
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

describe('proof tools in the harness', () => {
  it('lets the fake agent prove its Kubernetes fix, and the harness grades the validator', async () => {
    const outputs: string[] = [];
    const migrate: ScriptedTurn = async (call) => {
      outputs.push(await call('proof__proof_kubernetes', { targetVersion: '1.29' }));
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
      outputs.push(await call('proof__proof_kubernetes', { targetVersion: '1.29' }));
      await call('finish', {
        verdict: 'migrated',
        summary: 'Moved the Deployment to apps/v1 and the CronJob to batch/v1',
        why: 'Kubernetes 1.29 no longer serves extensions/v1beta1 or batch/v1beta1',
        validators: [
          { name: 'proof__proof_kubernetes', passed: true, detail: 'no removed APIs for 1.29' },
        ],
        unproven: [],
        behaviourChanges: [],
      });
    };
    const record = await runTask(task, repo(), {
      session: scriptedSession([migrate]),
      createSandbox: (dir: string) => createSandbox(dir, { mode: 'local' }),
      loadToolPack: async () => toolPack,
      budgetUsd: 1,
      turnReserveUsd: 0,
      outDir: mkdtempSync(join(tmpdir(), 'refit-proof-harness-out-')),
    });
    expect(outputs[0].split('\n')[0]).toBe('kubernetes: failed');
    expect(outputs[1].split('\n')[0]).toBe('kubernetes: passed');
    expect(record.diff).toContain('+apiVersion: apps/v1');
    expect(record.outcome).toBe('verified');
    expect(record.prBody).toContain('proof__proof_kubernetes');
    expect(readFileSync(record.transcriptPath, 'utf8')).toContain('proof__proof_kubernetes');
  });
});
