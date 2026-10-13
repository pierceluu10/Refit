import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { readSpecification } from './specifications.ts';

const execute = promisify(execFile);
const roots: string[] = [];
const bin = resolve('bin/refit.mjs');
const OPENAPI = 'openapi: 3.1.0\ninfo:\n  title: Example\n  version: "1"\npaths: {}\n';

async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'refit-source-snapshot-'));
  roots.push(root);
  return root;
}

async function run(root: string, ...arguments_: string[]) {
  return execute(process.execPath, [bin, 'source-snapshot', ...arguments_], {
    cwd: root,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('captures a provider-neutral local specification as a hash-verified pinned snapshot', async () => {
  const root = await directory();
  const source = join(root, 'openapi.yaml');
  const output = join(root, 'baseline.json');
  await writeFile(source, OPENAPI);

  const { stdout } = await run(root, '--provider', 'openai', '--file', source, '--output', output);
  const snapshot = JSON.parse(await readFile(output, 'utf8'));
  const specification = await readSpecification(output);

  expect(snapshot).toMatchObject({
    kind: 'refit-source-snapshot',
    provider: 'openai',
    content: OPENAPI,
    hash: expect.any(String),
    revision: expect.any(String),
    url: expect.stringMatching(/^file:/),
  });
  expect(snapshot.revision).toBe(snapshot.hash);
  expect(specification.provenance).toMatchObject({ provider: 'openai', revision: snapshot.hash });
  expect(stdout).toContain('Saved openai OpenAPI snapshot');
  expect(stdout).toContain(`Output    ${output}`);
});

it('refuses to overwrite an existing baseline snapshot', async () => {
  const root = await directory();
  const source = join(root, 'openapi.json');
  const output = join(root, 'baseline.json');
  await writeFile(source, JSON.stringify({ openapi: '3.0.3', paths: {} }));
  await writeFile(output, 'keep this baseline');

  await expect(
    run(root, '--provider', 'example', '--file', source, '--output', output),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('EEXIST') });
  await expect(readFile(output, 'utf8')).resolves.toBe('keep this baseline');
});

it('requires a valid provider ID and exactly one OpenAPI source', async () => {
  const root = await directory();
  const source = join(root, 'openapi.json');
  const output = join(root, 'baseline.json');
  await writeFile(source, JSON.stringify({ openapi: '3.0.3', paths: {} }));

  await expect(
    run(root, '--provider', '../other', '--file', source, '--output', output),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Provider ID') });
  await expect(
    run(
      root,
      '--provider',
      'example',
      '--file',
      source,
      '--url',
      'https://example.com/spec',
      '--output',
      output,
    ),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('exactly one source') });
  await expect(run(root, '--provider', 'example', '--output', output)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('exactly one source'),
  });
});

it('shows source and output requirements in command help', async () => {
  const root = await directory();
  const { stdout } = await run(root, '--help');
  expect(stdout).toContain('Usage: refit source-snapshot');
  expect(stdout).toContain('--provider <id>');
});
