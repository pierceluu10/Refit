import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { runPipeline } from './run.ts';

const execute = promisify(execFile);
const PROCESS_TIMEOUT_MS = 120_000;

it.skipIf(!process.env.REFIT_BILLING_REPOSITORY)(
  'migrates the independent billing app without changing its tests and preserves multi-page history',
  async () => {
    const original = resolve(process.env.REFIT_BILLING_REPOSITORY!);
    const root = await mkdtemp(join(tmpdir(), 'refit-billing-evaluation-'));
    try {
      const report = await runPipeline({
        repository: original,
        before: join(original, 'docs/contracts/before.json'),
        after: join(original, 'docs/contracts/after.json'),
        apiVersion: '2022-08-01',
        proposePatch: true,
      });
      expect(report.status).toBe('affected');
      expect(report.apiVersion.applicability).toBe('matches-before');
      expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 0 });
      if (!('diff' in report.patch)) throw new Error('Expected migration patch.');
      const repository = join(root, 'application');
      await cp(original, repository, {
        recursive: true,
        filter: (path) => !path.split(/[\\/]/).includes('.git'),
      });
      const options = { cwd: repository, timeout: PROCESS_TIMEOUT_MS };
      expect((await execute('npm', ['test'], options)).stdout).toContain('pass 14');
      await expect(execute('npm', ['run', 'test:after'], options)).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining('fail 3'),
      });
      const patch = join(root, 'migration.patch');
      const suppliedPatch = process.env.REFIT_BILLING_PATCH;
      await writeFile(
        patch,
        suppliedPatch ? await readFile(resolve(suppliedPatch), 'utf8') : report.patch.diff,
      );
      await execute('git', ['apply', '--check', patch], options);
      await execute('git', ['apply', patch], options);
      for (const command of [['test'], ['run', 'test:after'], ['run', 'typecheck']]) {
        const result = await execute('npm', command, options);
        if (command.at(-1) !== 'typecheck') expect(result.stdout).toContain('pass 14');
      }
      const originalTests = await readFile(join(original, 'test/billing.test.ts'), 'utf8');
      expect(await readFile(join(repository, 'test/billing.test.ts'), 'utf8')).toBe(originalTests);
      await cp(
        resolve('pipeline/fixtures/billing-pagination.mjs'),
        join(repository, 'pagination-check.mjs'),
      );
      expect(
        (await execute(process.execPath, ['--import', 'tsx', 'pagination-check.mjs'], options))
          .stdout,
      ).toContain('Multi-page history passed: 103 attempts');
      expect(await readFile(join(original, 'src/billing/history.ts'), 'utf8')).toContain(
        'payment.charges.data',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  PROCESS_TIMEOUT_MS,
);
