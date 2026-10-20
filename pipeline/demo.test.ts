import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { verifyArtifacts } from './verification.ts';

const execute = promisify(execFile);
const image = process.env.REFIT_DOCKER_IMAGE;

it.each(['run', 'validate'])('rejects an empty baseline command in the %s CLI', async (command) => {
  await expect(
    execute(process.execPath, [
      resolve('bin/refit.mjs'),
      command,
      '--repository',
      '/unused',
      '--before',
      '/unused-before',
      '--after',
      '/unused-after',
      '--output',
      '/unused-output',
      '--image',
      'unused',
      '--command',
      '["node"]',
      '--baseline-command',
      '',
    ]),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('--baseline-command must be a JSON array'),
  });
});

it.skipIf(!image || !process.env.REFIT_STRIPE_SDK)(
  'runs the CLI demo from another directory and retains real SDK contract evidence',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'refit-demo-test-'));
    try {
      const output = join(root, 'evidence');
      const command = [resolve('bin/refit.mjs'), 'demo', '--image', image!, '--output', output];
      const result = await execute(process.execPath, command, { cwd: root, timeout: 180_000 });
      const summary = JSON.parse(result.stdout);
      expect(summary).toMatchObject({ sdkVersion: '10.17.0', published: false });
      expect(summary.workflow.manifest.status).toBe('validated');
      const read = async (name: string) => JSON.parse(await readFile(join(output, name), 'utf8'));
      const original = await read('contract-before-migration.json');
      expect(original.before.chargeIds).toEqual(['ch_first', 'ch_second']);
      expect(original.after).toMatchObject({
        exitCode: 1,
        stderr: expect.stringContaining('TypeError'),
      });
      const report = await read('migration/report.json');
      expect(report.validation.status).toBe('passed');
      expect(report.validation.baselineCommand.at(-1)).toBe('before');
      expect(report.validation.command.at(-1)).toBe('after');
      const before = JSON.parse(report.validation.baseline.stdout);
      const after = JSON.parse(report.validation.patched.stdout);
      expect(after.chargeIds).toEqual(before.chargeIds);
      expect(before.requests).toHaveLength(1);
      expect(after.requests).toHaveLength(2);
      expect(report.repository.dependencies[0].lock.version).toBe('10.17.0');
      expect(report.patch.unresolvedFindings).toBe(0);
      expect(await verifyArtifacts(join(output, 'migration'))).toMatchObject({
        status: 'integrity-verified',
        files: 6,
      });
      expect(await readFile(join(output, 'migration/pull-request.md'), 'utf8')).toContain(
        '`node contract.mjs ./billing.js before` passed on the original and `node contract.mjs ./billing.js after` on the migrated code',
      );
      await expect(execute(process.execPath, command, { cwd: root })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('EEXIST'),
      });
      expect(await read('demo.json')).toEqual(summary);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  240_000,
);
