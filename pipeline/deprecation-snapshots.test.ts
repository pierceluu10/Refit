import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  buildDeprecationSnapshot,
  hashDeprecationModels,
  readDeprecationSnapshot,
  validateDeprecationSnapshot,
  type DeprecationModel,
} from './deprecation-snapshots.ts';

const execute = promisify(execFile);
const directories: string[] = [];
const fixture = resolve('pipeline/fixtures/openai/deprecation-snapshot.json');
const cli = resolve('pipeline/ai-snapshot-cli.ts');

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'refit-ai-snapshot-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it('accepts the labeled OpenAI fixture and verifies its canonical models hash', async () => {
  const snapshot = await readDeprecationSnapshot(fixture);
  expect(snapshot.provider).toBe('openai');
  expect(snapshot.models).toEqual([
    expect.objectContaining({
      id: 'fixture-openai-retired-model',
      sourceNote: expect.stringContaining('Synthetic test fixture only'),
    }),
  ]);
  expect(snapshot.source.url).toBe('https://fixture.invalid/openai/deprecations');
  expect(snapshot.source.sha256).toBe(hashDeprecationModels(snapshot.models));
});

it('uses canonical JSON object-key ordering when hashing models', () => {
  const first: DeprecationModel[] = [
    {
      id: 'fixture-model',
      status: 'deprecated',
      shutdownDate: null,
      replacement: null,
      sourceNote: 'Fixture',
    },
  ];
  const reordered = [
    {
      sourceNote: 'Fixture',
      replacement: null,
      shutdownDate: null,
      status: 'deprecated',
      id: 'fixture-model',
    },
  ] as DeprecationModel[];
  expect(hashDeprecationModels(first)).toBe(hashDeprecationModels(reordered));
});

it.each([
  ['wrong kind', { kind: 'other' }],
  ['unknown provider', { provider: 'other' }],
  ['unknown top-level property', { extra: true }],
  ['malformed source', { source: { url: 'TODO_VERIFY' } }],
  ['models is not an array', { models: {} }],
])('rejects a malformed snapshot: %s', async (_name, modification) => {
  const valid = JSON.parse(await readFile(fixture, 'utf8')) as Record<string, unknown>;
  expect(() => validateDeprecationSnapshot({ ...valid, ...modification })).toThrow();
});

it('rejects a snapshot when model data is edited without updating the hash', async () => {
  const valid = JSON.parse(await readFile(fixture, 'utf8')) as {
    models: { id: string }[];
  };
  valid.models[0].id = 'tampered-fixture-model';
  expect(() => validateDeprecationSnapshot(valid)).toThrow(/canonical models hash/);
});

it('builds and verifies a snapshot through the CLI without network access', async () => {
  const directory = await temporaryDirectory();
  const fixtureSnapshot = JSON.parse(await readFile(fixture, 'utf8')) as {
    source: Record<string, unknown>;
  };
  const { sha256: _sha256, ...source } = fixtureSnapshot.source;
  const input = join(directory, 'input.json');
  const output = join(directory, 'snapshot.json');
  const guard = join(directory, 'no-network.mjs');
  await writeFile(input, JSON.stringify({ ...fixtureSnapshot, source }));
  await writeFile(
    guard,
    "globalThis.fetch = () => { throw new Error('network access is forbidden'); };\n",
  );
  const environment = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${guard}`.trim(),
  };
  const created = await execute(
    process.execPath,
    ['--import', 'tsx', cli, '--input', input, '--output', output],
    { env: environment },
  );
  expect(JSON.parse(created.stdout)).toMatchObject({
    output,
    provider: 'openai',
    models: 1,
  });
  const verified = await execute(process.execPath, ['--import', 'tsx', cli, '--verify', output], {
    env: environment,
  });
  expect(JSON.parse(verified.stdout)).toMatchObject({
    verified: output,
    provider: 'openai',
    models: 1,
  });
  expect(await readDeprecationSnapshot(output)).toEqual(
    buildDeprecationSnapshot(JSON.parse(await readFile(input, 'utf8'))),
  );
});

it('does not overwrite an existing CLI output file', async () => {
  const directory = await temporaryDirectory();
  const input = join(directory, 'input.json');
  const output = join(directory, 'existing.json');
  const snapshot = JSON.parse(await readFile(fixture, 'utf8')) as {
    source: Record<string, unknown>;
  };
  delete snapshot.source.sha256;
  await writeFile(input, JSON.stringify(snapshot));
  await writeFile(output, 'keep this content');
  await expect(
    execute(process.execPath, ['--import', 'tsx', cli, '--input', input, '--output', output], {
      env: process.env,
    }),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('EEXIST'),
  });
  expect(await readFile(output, 'utf8')).toBe('keep this content');
});
