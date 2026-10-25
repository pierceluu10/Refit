import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const execute = promisify(execFile);
const bin = resolve('bin/refit.mjs');
const fixture = resolve('pipeline/fixtures');
const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'refit-first-run-'));
  roots.push(root);
  const app = join(root, 'application with spaces');
  await cp(join(fixture, 'repository'), app, { recursive: true });
  await cp(join(fixture, 'before.json'), join(app, 'before.json'));
  const configuration = {
    formatVersion: 1,
    before: './before.json',
    after: './before.json',
    apiVersion: '2022-08-01',
    fullDiff: false,
    image: 'node:22-alpine',
    command: ['node', '--version'],
  };
  const path = join(app, '.refit.json');
  await writeFile(path, JSON.stringify(configuration));
  const env = { ...process.env, TMPDIR: root };
  const run = (args: string[] = [], cwd = app) =>
    execute(process.execPath, [bin, 'run', '--json', ...args], { cwd, env });
  const evidence = async (args: string[] = [], cwd = app) => {
    try {
      await run(args, cwd);
      throw new Error('Expected a review-required scan without API changes.');
    } catch (error) {
      expect(error).toMatchObject({ code: 2 });
      return JSON.parse((error as { stdout: string }).stdout);
    }
  };
  return { root, app, path, configuration, run, evidence };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('runs a root profile with no path flags and retains distinct private evidence without changing application files', async () => {
  const sample = await setup();
  const before = await readFile(join(sample.app, 'billing.ts'), 'utf8');
  const first = await sample.evidence();
  const second = await sample.evidence();
  expect(first.directory).not.toBe(second.directory);
  expect(dirname(first.directory)).toBe(sample.root);
  if (process.platform !== 'win32') expect((await stat(first.directory)).mode & 0o777).toBe(0o700);
  expect(first.manifest).toMatchObject({ status: 'needs-review', stage: 'scan' });
  expect(first.manifest.files.map((file: { path: string }) => file.path)).toEqual([
    'before.json',
    'after.json',
    'scan.json.gz',
  ]);
  expect(await readFile(join(sample.app, 'billing.ts'), 'utf8')).toBe(before);
  expect(await readFile(sample.path, 'utf8')).toBe(JSON.stringify(sample.configuration));
});

it('uses --repository from elsewhere and derives an explicitly selected root configuration repository', async () => {
  const sample = await setup();
  const external = join(sample.root, 'operator.json');
  await writeFile(
    external,
    JSON.stringify({
      ...sample.configuration,
      before: join(sample.app, 'before.json'),
      after: join(sample.app, 'before.json'),
    }),
  );
  // Each run writes its own evidence directory, so they start together; a CLI start costs about 0.3 s.
  const [fromRepository, fromConfig] = await Promise.all([
    sample.evidence(['--repository', sample.app], sample.root),
    sample.evidence(['--config', sample.path], sample.root),
    expect(sample.run(['--config', external], sample.root)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Missing run inputs'),
    }),
  ]);
  expect(fromRepository.manifest.status).toBe('needs-review');
  expect(fromConfig.manifest.status).toBe('needs-review');
});

it('requires an explicit integration choice and retains it in automatic evidence', async () => {
  const sample = await setup();
  const { formatVersion: _format, ...profile } = sample.configuration;
  await writeFile(
    sample.path,
    JSON.stringify({
      formatVersion: 2,
      integrations: [
        { id: 'stripe', ...profile },
        { id: 'secondary', ...profile },
      ],
    }),
  );
  await expect(sample.run()).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(
      'This configuration has 2 integrations; choose one with --integration: stripe, secondary.',
    ),
  });
  expect((await sample.evidence(['--integration', 'stripe'])).manifest.integration).toBe('stripe');
});

it('selects the only integration of a collection without --integration', async () => {
  // refit agents --add writes a one-integration collection; the next command should just work.
  const sample = await setup();
  const { formatVersion: _format, ...profile } = sample.configuration;
  await writeFile(
    sample.path,
    JSON.stringify({ formatVersion: 2, integrations: [{ id: 'stripe', ...profile }] }),
  );
  expect((await sample.evidence()).manifest.integration).toBe('stripe');
});

it('honors explicit output and refuses an existing directory', async () => {
  const sample = await setup();
  const output = join(sample.root, 'evidence');
  expect((await sample.evidence(['--output', output])).directory).toBe(output);
  await expect(sample.run(['--output', output])).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('EEXIST'),
  });
});

it('explains a missing profile and refuses implicit repository redirection before creating evidence', async () => {
  const sample = await setup();
  await rm(sample.path);
  await expect(sample.run()).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(
      'Run refit agents to see which provider agents apply and refit agents --add <id> to write one',
    ),
  });
  await writeFile(sample.path, JSON.stringify({ ...sample.configuration, repository: '..' }));
  await expect(sample.run()).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('cannot redirect the run'),
  });
  expect((await readdir(sample.root)).filter((name) => name.startsWith('refit-run-'))).toEqual([]);
});

it('refuses automatic evidence inside the application even when the OS temp directory is redirected there', async () => {
  const sample = await setup();
  await expect(
    execute(process.execPath, [bin, 'run'], {
      cwd: sample.app,
      env: { ...process.env, TMPDIR: sample.app },
    }),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('Artifact output must be outside the scanned repository'),
  });
  expect((await readdir(sample.app)).filter((name) => name.startsWith('refit-run-'))).toEqual([]);
});
