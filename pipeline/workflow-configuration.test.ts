import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { readWorkflowConfiguration } from './workflow-configuration.ts';

const execute = promisify(execFile);
const roots: string[] = [];
const bin = resolve('bin/refit.mjs');
const fixture = resolve('pipeline/fixtures');
const CONFIGURATION_BYTE_LIMIT = 64 * 1024;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'refit-configuration-'));
  roots.push(root);
  const path = join(root, 'run.json');
  const configuration = {
    formatVersion: 1,
    repository: relative(root, join(fixture, 'repository')),
    before: relative(root, join(fixture, 'before.json')),
    after: relative(root, join(fixture, 'before.json')),
    apiVersion: '2022-08-01',
    image: 'node:22-alpine',
    command: ['node', '--version'],
  };
  await writeFile(path, JSON.stringify(configuration));
  return { root, path, configuration };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('loads strict policy and respects an explicit CLI override without execution or AI', async () => {
  const { root, path, configuration } = await setup();
  await writeFile(path, JSON.stringify({ ...configuration, apiVersionPolicy: 'source-verified' }));
  expect((await readWorkflowConfiguration(path)).apiVersionPolicy).toBe('source-verified');
  for (const [name, flags, policy] of [
    ['strict', [], 'source-verified'],
    ['operator', ['--api-version-policy', 'operator-pin'], 'operator-pin'],
  ] as const) {
    const output = join(root, name);
    await expect(
      execute(
        process.execPath,
        [bin, 'run', '--config', path, '--output', output, '--json', ...flags],
        { cwd: tmpdir() },
      ),
    ).rejects.toMatchObject({ code: 2 });
    const scan = JSON.parse(await readFile(join(output, 'scan.json'), 'utf8'));
    expect(scan.apiVersion.policy).toBe(policy);
    expect(scan.apiVersion.source.status).toBe('unknown');
    expect(scan.apiVersion.applicability).toBe(
      policy === 'source-verified' ? 'unknown' : 'matches-before',
    );
  }
  await writeFile(path, JSON.stringify({ ...configuration, apiVersionPolicy: 'guess' }));
  await expect(readWorkflowConfiguration(path)).rejects.toThrow(/API-version policy/);
});

it('runs from another directory using paths relative to the configuration and explicit env credentials', async () => {
  const { root, path } = await setup();
  const environment = join(root, '.env');
  await writeFile(
    environment,
    'export OPENAI_API_KEY="env-file-test-key"\nOPENAI_MODEL="test-model"\n',
  );
  try {
    await execute(
      process.execPath,
      [
        bin,
        'run',
        '--config',
        path,
        '--env',
        environment,
        '--output',
        join(root, 'evidence'),
        '--ai-patch',
      ],
      {
        cwd: tmpdir(),
        env: { ...process.env, OPENAI_API_KEY: undefined, OPENAI_MODEL: undefined },
      },
    );
    throw new Error('Expected review-required exit code.');
  } catch (error) {
    expect(error).toMatchObject({ code: 2 });
    const result = error as { stdout: string; stderr: string };
    expect(JSON.parse(result.stdout).manifest.status).toBe('needs-review');
    expect(result.stdout + result.stderr).not.toContain('env-file-test-key');
  }
  expect(
    JSON.parse(await readFile(join(root, 'evidence/manifest.json'), 'utf8')).files,
  ).toHaveLength(3);
});

it('rejects secrets, automatic publication and output defaults before running any workflow', async () => {
  const { configuration, path } = await setup();
  for (const field of ['apiKey', 'publishDraft', 'output', 'aiPatch', 'github']) {
    await writeFile(path, JSON.stringify({ ...configuration, [field]: 'test-private-value' }));
    await expect(readWorkflowConfiguration(path)).rejects.toThrow(
      `Unknown run configuration fields: ${field}`,
    );
  }
});

it('rejects ambiguous specifications, invalid commands, versions and oversized files', async () => {
  const { configuration, path } = await setup();
  for (const [override, message] of [
    [{ latestStripe: true }, 'exactly one'],
    [{ latestStripe: 'true' }, 'boolean'],
    [{ prepareDependencies: 'true' }, 'boolean'],
    [{ before: '' }, 'before string'],
    [{ apiVersion: '' }, 'apiVersion string'],
    [{ apiVersion: 2022 }, 'apiVersion string'],
    [{ formatVersion: 2 }, 'formatVersion: 1'],
    [{ command: ['npm', ''] }, 'nonempty JSON array'],
  ] as const) {
    await writeFile(path, JSON.stringify({ ...configuration, ...override }));
    await expect(readWorkflowConfiguration(path)).rejects.toThrow(message);
  }
  await writeFile(path, ' '.repeat(CONFIGURATION_BYTE_LIMIT + 1));
  await expect(readWorkflowConfiguration(path)).rejects.toThrow('exceeds 64 KiB');
});

it('lets an explicit CLI API version override configuration and records after-version applicability', async () => {
  const { root, path } = await setup();
  await expect(
    execute(process.execPath, [
      bin,
      'run',
      '--config',
      path,
      '--after',
      resolve(fixture, 'after.json'),
      '--api-version',
      '2022-11-15',
      '--output',
      join(root, 'evidence'),
    ]),
  ).rejects.toMatchObject({ code: 2, stdout: expect.stringContaining('needs-review') });
  expect(
    JSON.parse(await readFile(join(root, 'evidence/scan.json'), 'utf8')).apiVersion,
  ).toMatchObject({ application: '2022-11-15', applicability: 'matches-after' });
});

it('lets a CLI after override replace latest discovery without fetching a remote specification', async () => {
  const { root, path, configuration } = await setup();
  await writeFile(path, JSON.stringify({ ...configuration, after: undefined, latestStripe: true }));
  await expect(
    execute(process.execPath, [
      bin,
      'run',
      '--config',
      path,
      '--after',
      join(fixture, 'before.json'),
      '--output',
      join(root, 'evidence'),
    ]),
  ).rejects.toMatchObject({
    code: 2,
    stdout: expect.stringContaining('needs-review'),
  });
});

it('preserves existing environment values and rejects duplicate or missing environment file options', async () => {
  const { root, path } = await setup();
  const environment = join(root, '.env');
  await writeFile(environment, 'OPENAI_API_KEY=test-key\nOPENAI_MODEL=test-model');
  await expect(
    execute(
      process.execPath,
      [
        bin,
        'run',
        '--config',
        path,
        `--env=${environment}`,
        '--output',
        join(root, 'evidence'),
        '--ai-patch',
      ],
      {
        env: { ...process.env, OPENAI_API_KEY: '', OPENAI_MODEL: '' },
      },
    ),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('OPENAI_API_KEY') });
  await expect(
    execute(process.execPath, [bin, '--env', environment, 'replay', `--env=${environment}`]),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('only once') });
  await expect(execute(process.execPath, [bin, 'replay', '--env'])).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('requires a file path'),
  });
  await expect(
    execute(process.execPath, [bin, 'replay', '--env', join(root, 'missing.env')]),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('ENOENT') });
});

it('requires explicit publication and complete app configuration before starting an AI workflow', async () => {
  const { root, path } = await setup();
  const arguments_ = [
    bin,
    'run',
    '--config',
    path,
    '--output',
    join(root, 'evidence'),
    '--github-app',
  ];
  await expect(execute(process.execPath, arguments_)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('require --publish-draft'),
  });
  await expect(
    execute(
      process.execPath,
      [...arguments_, '--publish-draft', '--github', 'example/application', '--base', 'main'],
      {
        env: { ...process.env, GITHUB_APP_ID: '', GITHUB_APP_PRIVATE_KEY_FILE: '' },
      },
    ),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('GITHUB_APP_ID') });
  await expect(readFile(join(root, 'evidence/manifest.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('allows a checkout-free configuration but requires explicit App syncing before a worker can use it', async () => {
  const { root, path, configuration } = await setup();
  await writeFile(path, JSON.stringify({ ...configuration, repository: undefined }));
  expect((await readWorkflowConfiguration(path)).repository).toBeUndefined();
  const arguments_ = [bin, 'watch', '--config', path, '--state', join(root, 'state'), '--once'];
  await expect(execute(process.execPath, arguments_)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('local repository or --sync-github'),
  });
  await expect(
    execute(process.execPath, [
      ...arguments_,
      '--sync-github',
      '--github',
      'example/application',
      '--base',
      'main',
    ]),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('--sync-github requires --github-app'),
  });
  await expect(readFile(join(root, 'state/github/managed-checkout.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
