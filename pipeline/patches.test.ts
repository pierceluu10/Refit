import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import ts from 'typescript-compiler';
import { afterEach, expect, it } from 'vitest';
import { compactPatch, renderPatch } from './patches.ts';
import { runPipeline } from './run.ts';

const execute = promisify(execFile);
const directories: string[] = [];
const options = {
  before: resolve('pipeline/fixtures/before.json'),
  after: resolve('pipeline/fixtures/after.json'),
  proposePatch: true,
};
const prefix = `import Stripe from 'stripe'; const stripe = new Stripe('test');`;

async function repository(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'refit-patch-'));
  directories.push(root);
  await writeFile(join(root, 'billing.ts'), source);
  return root;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it('emits a CLI proposal that git can apply without mutating the scanned repository', async () => {
  const source = await readFile('pipeline/fixtures/repository/billing.ts', 'utf8');
  const root = await repository(source);
  const { stdout } = await execute(process.execPath, [
    '--import',
    'tsx',
    'pipeline/cli.ts',
    '--repository',
    root,
    '--before',
    options.before,
    '--after',
    options.after,
    '--propose-patch',
  ]);
  const report = JSON.parse(stdout);
  expect(report.patch.status).toBe('proposed');
  expect(report.patch.validation).toBe('not-run');
  expect(report.patch.unresolvedFindings).toBe(0);
  expect(await readFile(join(root, 'billing.ts'), 'utf8')).toBe(source);
  const patch = join(root, 'migration.patch');
  await writeFile(patch, report.patch.diff);
  await execute('git', ['apply', '--check', patch], { cwd: root });
  await execute('git', ['apply', patch], { cwd: root });
  expect(await readFile(join(root, 'billing.ts'), 'utf8')).toContain(
    'return (await stripe.charges.list({ payment_intent: intent.id })).data;',
  );
  const calls: unknown[] = [];
  const charges = [{ id: 'ch_first' }, { id: 'ch_second' }];
  class Stripe {
    paymentIntents = {
      retrieve: async (id: string) => ({ id }),
    };
    charges = {
      list: async (parameters: unknown) => {
        calls.push(parameters);
        return { data: charges };
      },
    };
  }
  const compiled = ts.transpileModule(await readFile(join(root, 'billing.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports: { chargeHistory?: (id: string) => Promise<unknown> } = {};
  runInNewContext(compiled.outputText, {
    exports,
    require: (name: string) => {
      if (name !== 'stripe') throw new Error(`Unexpected fixture import: ${name}`);
      return { default: Stripe };
    },
    process: { env: {} },
  });
  expect(await exports.chargeHistory!('pi_example')).toEqual(charges);
  expect(calls).toEqual([{ payment_intent: 'pi_example' }]);
});

it.each([
  `async function read() { const intent = await stripe.paymentIntents.retrieve('pi', {}, {stripeAccount: 'acct'}); return intent.charges.data; }`,
  `async function read() { const intent = await stripe.paymentIntents.retrieve('pi'); function nested() { return intent.charges.data; } }`,
  `async function read() { const intent = await stripe.paymentIntents.retrieve('pi'); return intent.charges; }`,
  `async function read() { const intent = await stripe.paymentIntents.retrieve('pi'); return intent.charges?.data; }`,
  `async function read() { const intent = await stripe.paymentIntents.retrieve('pi'); return intent.charges.data.map(x => x.id); }`,
])('declines unsupported migration shape: %s', async (body) => {
  const root = await repository(`${prefix}\n${body}`);
  const report = await runPipeline({ ...options, repository: root });
  expect(report.patch).toMatchObject({ status: 'unsupported', diff: '', edits: 0 });
});

it('supports missing final newlines and reports remaining unsupported findings', async () => {
  const root = await repository(`${prefix}\nasync function read() {
    const intent = await stripe.paymentIntents.retrieve('pi');
    const history = intent.charges;
    return intent.charges.data;
  }`);
  const report = await runPipeline({ ...options, repository: root });
  expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 1 });
  if (!('diff' in report.patch)) throw new Error('Expected patch diff');
  const patch = join(root, 'migration.patch');
  await writeFile(patch, report.patch.diff);
  await execute('git', ['apply', '--check', patch], { cwd: root });
});

it('compacts whole-file patches to the changed lines for repair evidence', () => {
  const content = Array.from({ length: 40 }, (_, index) => `const line${index} = ${index};`).join(
    '\n',
  );
  const start = content.indexOf('const line20');
  const last = content.indexOf('const line39');
  const diff = renderPatch(
    { root: '/repo', files: [{ path: 'src/a.ts', content }] } as never,
    [
      { file: 'src/a.ts', start, end: start + 'const line20'.length, replacement: 'let line20' },
      {
        file: 'src/a.ts',
        start: last,
        end: last + 'const line39'.length,
        replacement: 'let line39',
      },
      { file: 'src/new.ts', start: 0, end: 0, replacement: 'export {};\n' },
    ] as never,
  );
  const compact = compactPatch(diff);
  expect(compact).toContain('-const line20 = 20;');
  expect(compact).toContain('+let line20 = 20;');
  expect(compact).toContain(' const line17 = 17;');
  expect(compact).not.toContain('line10');
  expect(compact).toContain('+let line39 = 39;\n\\ No newline at end of file');
  expect(compact).toContain('+export {};');
  expect(compact.length).toBeLessThan(diff.length / 3);
});
