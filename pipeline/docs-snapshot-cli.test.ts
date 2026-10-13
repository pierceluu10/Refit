import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { digest } from './specifications.ts';

const execute = promisify(execFile);
const roots: string[] = [];
const bin = resolve('bin/refit.mjs');
const PAGE = '# Charges\n\nPaymentIntent.charges was removed.\n';

async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'refit-docs-snapshot-'));
  roots.push(root);
  return root;
}

async function run(root: string, ...arguments_: string[]) {
  return execute(process.execPath, [bin, 'docs-snapshot', ...arguments_], { cwd: root });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('pins a local documentation page with its hash and fetch time', async () => {
  const root = await directory();
  const source = join(root, 'charges.md');
  const output = join(root, 'docs.json');
  await writeFile(source, PAGE);
  const { stdout } = await run(root, '--provider', 'stripe', '--file', source, '--output', output);
  const snapshot = JSON.parse(await readFile(output, 'utf8'));
  expect(snapshot).toMatchObject({
    formatVersion: 1,
    kind: 'refit-docs-snapshot',
    provider: 'stripe',
    content: PAGE,
    hash: digest(PAGE),
  });
  expect(snapshot.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(snapshot.url).toMatch(/^file:/);
  expect(stdout).toContain('Saved stripe documentation snapshot');
  expect(stdout).toContain(snapshot.hash);
});

it('refuses to overwrite a snapshot and requires one valid source', async () => {
  const root = await directory();
  const source = join(root, 'charges.md');
  const output = join(root, 'docs.json');
  await writeFile(source, PAGE);
  await writeFile(output, 'keep');
  await expect(
    run(root, '--provider', 'stripe', '--file', source, '--output', output),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('EEXIST') });
  expect(await readFile(output, 'utf8')).toBe('keep');
  await expect(
    run(root, '--provider', 'Stripe', '--file', source, '--output', join(root, 'other.json')),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Provider ID') });
  await expect(
    run(root, '--provider', 'stripe', '--output', join(root, 'other.json')),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('exactly one source') });
});
