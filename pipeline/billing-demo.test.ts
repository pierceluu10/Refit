import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { runPipeline } from './run.ts';

const execute = promisify(execFile);
const PROCESS_TIMEOUT_MS = 120_000;
const ATTEMPTS = 12;

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
        proposePatch: true,
      });
      expect(report.status).toBe('affected');
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
      await writeFile(patch, report.patch.diff);
      await execute('git', ['apply', '--check', patch], options);
      await execute('git', ['apply', patch], options);
      for (const command of [['test'], ['run', 'test:after'], ['run', 'typecheck']]) {
        const result = await execute('npm', command, options);
        if (command.at(-1) !== 'typecheck') expect(result.stdout).toContain('pass 14');
      }
      const originalTests = await readFile(join(original, 'test/billing.test.ts'), 'utf8');
      expect(await readFile(join(repository, 'test/billing.test.ts'), 'utf8')).toBe(originalTests);
      await writeFile(
        join(repository, 'pagination-check.ts'),
        `
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { startSimulator } from './simulator/server.ts';
const server = await startSimulator('after');
process.env.BILLING_MODE = 'simulator';
process.env.STRIPE_SIMULATOR_MODE = 'after';
process.env.STRIPE_SIMULATOR_URL = server.url;
try {
  const { createCustomer } = await import('./src/billing/customers.ts');
  const { createPayment, retryPayment } = await import('./src/billing/payments.ts');
  const { getChargeHistory } = await import('./src/billing/history.ts');
  const { createRefund } = await import('./src/billing/refunds.ts');
  const customer = await createCustomer('pagination@example.com', 'Pagination');
  let id;
  try { await createPayment(customer.id, 2000, 'pm_card_chargeDeclined'); }
  catch (error) { assert.ok(error instanceof Stripe.errors.StripeCardError); id = error.payment_intent.id; }
  assert.ok(id);
  for (let index = 1; index < ${ATTEMPTS}; index++) {
    await assert.rejects(retryPayment(id, 'pm_card_chargeDeclined'), Stripe.errors.StripeCardError);
  }
  await retryPayment(id, 'pm_card_visa');
  await createRefund(id, 500);
  const history = await getChargeHistory(id);
  assert.equal(history.length, ${ATTEMPTS + 1});
  assert.equal(new Set(history.map(charge => charge.id)).size, history.length);
  assert.equal(history[0].status, 'succeeded');
  assert.equal(history[0].amount_refunded, 500);
  assert.ok(history.every(charge => charge.payment_intent === id));
  assert.ok(history.slice(1).every(charge => charge.status === 'failed'));
  console.log('Multi-page history passed: ' + history.length + ' attempts');
} finally { await server.close(); }
`,
      );
      expect(
        (await execute(process.execPath, ['--import', 'tsx', 'pagination-check.ts'], options))
          .stdout,
      ).toContain('Multi-page history passed: 13 attempts');
      expect(await readFile(join(original, 'src/billing/history.ts'), 'utf8')).toContain(
        'payment.charges.data',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  PROCESS_TIMEOUT_MS,
);
