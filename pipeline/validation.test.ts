import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { validateMigration } from './validation.ts';

const execute = promisify(execFile);
const directories: string[] = [];
const IMAGE = process.env.REFIT_DOCKER_IMAGE;
const options = {
  before: resolve('pipeline/fixtures/before.json'),
  after: resolve('pipeline/fixtures/after.json'),
  image: IMAGE ?? 'node:22-alpine',
};
const SOURCE = `import Stripe from 'stripe';
const stripe = new Stripe();
export async function history(id) {
  const intent = await stripe.paymentIntents.retrieve(id);
  return intent.charges.data;
}
`;

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'refit-container-test-'));
  directories.push(root);
  await mkdir(join(root, 'node_modules/stripe'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module","dependencies":{"stripe":"test"}}');
  await writeFile(join(root, 'billing.js'), SOURCE);
  await writeFile(
    join(root, 'node_modules/stripe/package.json'),
    '{"type":"module","exports":"./index.js"}',
  );
  await writeFile(
    join(root, 'node_modules/stripe/index.js'),
    `
    const data = [{ id: 'ch_1' }, { id: 'ch_2' }];
    export default class Stripe {
      paymentIntents = { retrieve: async id => ({ id, charges: { data } }) };
      charges = { list: async ({ payment_intent }) => {
        if (payment_intent !== 'pi_test') throw new Error('Incorrect PaymentIntent');
        return { data };
      } };
    }
  `,
  );
  await execute('git', ['init', root]);
  await execute('git', ['-C', root, 'add', '--force', '.']);
  await execute('git', [
    '-C',
    root,
    '-c',
    'user.name=Refit Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'test: seed validation repository',
  ]);
  return root;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it('rejects dirty repositories before attempting Docker execution', async () => {
  const root = await repository();
  await writeFile(join(root, 'billing.js'), `${SOURCE}\n// changed`);
  await expect(
    validateMigration({ ...options, repository: root, command: ['node', '--version'] }),
  ).rejects.toThrow(/clean committed repository/);
});

it('rejects malformed command arrays before starting any processes', async () => {
  await expect(
    validateMigration({ ...options, repository: '/unused', command: [] }),
  ).rejects.toThrow(/nonempty JSON array/);
});

it.skipIf(!IMAGE)(
  'runs baseline and migration in restricted containers without changing the repository',
  async () => {
    const root = await repository();
    vi.stubEnv('REFIT_HOST_SECRET', 'must-not-enter-container');
    const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    assert.equal(process.getuid(), 65534);
    assert.throws(() => fs.writeFileSync('/input/changed', 'x'));
    assert.equal(process.env.REFIT_HOST_SECRET, undefined);
    assert.deepEqual(Object.keys(require('node:os').networkInterfaces()), ['lo']);
    import('./billing.js').then(async ({ history }) => {
      assert.deepEqual(await history('pi_test'), [{id:'ch_1'}, {id:'ch_2'}]);
      console.log('charge history passed');
    });
  `;
    const result = await execute(process.execPath, [
      '--import',
      'tsx',
      'pipeline/validation-cli.ts',
      '--repository',
      root,
      '--before',
      options.before,
      '--after',
      options.after,
      '--image',
      options.image,
      '--command',
      JSON.stringify(['node', '-e', script]),
    ]);
    const report = JSON.parse(result.stdout);
    expect(report.validation.status).toBe('passed');
    expect(report.validation.baseline.stdout).toContain('charge history passed');
    expect(report.validation.patched.stdout).toContain('charge history passed');
    expect(report.validation.image).toMatch(/^sha256:/);
    expect(report.validation.publishable).toBe(false);
    expect(report.patch.validation).toBe('passed');
    expect(await readFile(join(root, 'billing.js'), 'utf8')).toBe(SOURCE);
    expect((await execute('git', ['-C', root, 'status', '--porcelain'])).stdout).toBe('');
  },
  60_000,
);

it.skipIf(!IMAGE)(
  'distinguishes migration regressions from pre-existing baseline failures',
  async () => {
    const root = await repository();
    const regression = await validateMigration({
      ...options,
      repository: root,
      command: [
        'node',
        '-e',
        "process.exit(require('fs').readFileSync('billing.js','utf8').includes('return intent.charges.data') ? 0 : 7)",
      ],
    });
    expect(regression.validation.status).toBe('regression');
    expect(regression.validation.baseline.exitCode).toBe(0);
    expect(regression.validation.patched.exitCode).toBe(7);
    const baseline = await validateMigration({
      ...options,
      repository: root,
      command: ['node', '-e', 'process.exit(8)'],
    });
    expect(baseline.validation.status).toBe('baseline-failed');
  },
  60_000,
);

it.skipIf(!IMAGE)(
  'records excessive output as an execution error instead of a passing check',
  async () => {
    const root = await repository();
    const report = await validateMigration({
      ...options,
      repository: root,
      command: ['node', '-e', "process.stdout.write('x'.repeat(2 * 1024 * 1024))"],
    });
    expect(report.validation.status).toBe('error');
    expect(report.validation.baseline.status).toBe('error');
    expect(report.validation.patched.status).toBe('error');
    expect(Buffer.byteLength(report.validation.patched.stdout)).toBeLessThanOrEqual(
      report.validation.limits.outputBytes,
    );
    expect(report.validation.publishable).toBe(false);
  },
  60_000,
);
