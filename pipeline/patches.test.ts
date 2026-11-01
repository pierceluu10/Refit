import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { compactPatch, renderPatch } from './patches.ts';
import { readRepository } from './repository.ts';
import { runPipeline } from './run.ts';
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

it('scans UTF-16 files with a byte-order mark as text but refuses to edit them', async () => {
  const root = await repository(`${prefix}\nexport const ok = 1;\n`);
  const types = 'export type Json = string | number;\n';
  await writeFile(
    join(root, 'types_db.ts'),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(types, 'utf16le')]),
  );
  await writeFile(
    join(root, 'big_endian.ts'),
    Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(types, 'utf16le').swap16()]),
  );
  const scanned = await readRepository(root, 'stripe');
  const decoded = scanned.files.filter((file) => file.encoding === 'utf-16');
  expect(decoded.map((file) => [file.path, file.content])).toEqual([
    ['big_endian.ts', types],
    ['types_db.ts', types],
  ]);
  expect(scanned.files.find((file) => file.path === 'billing.ts')?.encoding).toBeUndefined();
  expect(() =>
    renderPatch(scanned, [
      { file: 'types_db.ts', start: 0, end: 6, replacement: 'export', changeId: 'change' },
    ]),
  ).toThrow(/UTF-16; Refit only edits UTF-8/);
  expect((await runPipeline({ ...options, repository: root })).warnings.join('\n')).not.toContain(
    'types_db.ts',
  );
});
