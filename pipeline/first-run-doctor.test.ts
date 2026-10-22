import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { inspectRepositoryReadiness } from './readiness.ts';
import { renderReadiness } from './readiness-presentation.ts';

// Messages a new user meets on the way from a fresh checkout to a clear doctor verdict
// (docs/FIRST-RUN.md). Each assertion pins the exact text that replaced a vaguer one.
const execute = promisify(execFile);
const roots: string[] = [];
const fixture = resolve('pipeline/fixtures/endpoint-replacement');

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function commit(repository: string) {
  await execute('git', ['-C', repository, 'add', '.']);
  await execute('git', [
    '-C',
    repository,
    '-c',
    'user.name=Refit Tests',
    '-c',
    'user.email=tests@refit.local',
    'commit',
    '-qm',
    'test: seed',
  ]);
}

async function repository(configuration?: object) {
  const root = await mkdtemp(join(tmpdir(), 'refit-first-run-doctor-'));
  roots.push(root);
  const repository = join(root, 'app');
  await cp(join(fixture, 'repository'), repository, { recursive: true });
  for (const file of ['before.json', 'after.json', 'provider.json'])
    await cp(join(fixture, file), join(repository, file));
  if (configuration)
    await writeFile(join(repository, '.refit.json'), JSON.stringify(configuration));
  const binaries = join(root, 'binaries');
  await mkdir(binaries);
  await writeFile(join(binaries, 'docker'), `#!/bin/sh\necho sha256:${'a'.repeat(64)}\n`, {
    mode: 0o755,
  });
  await writeFile(join(binaries, 'oasdiff'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  vi.stubEnv('PATH', `${binaries}:${process.env.PATH}`);
  await execute('git', ['-C', repository, 'init', '-qb', 'main']);
  await commit(repository);
  return repository;
}

const integration = (id: string, before = './before.json', after = './after.json') => ({
  id,
  before,
  after,
  providerConfig: './provider.json',
  apiVersion: '1',
  image: 'node:22-alpine',
  command: ['npm', 'test'],
});

it('sends a new user to refit agents when the repository has no .refit.json', async () => {
  const app = await repository();
  const report = await inspectRepositoryReadiness({ repository: app });
  expect(report.checks).toEqual([
    {
      id: 'configuration',
      title: 'Workflow configuration',
      status: 'blocked',
      detail: `No .refit.json in ${app} yet.`,
      action:
        'Run refit agents to see which provider agents apply, then refit agents --add <id> to write .refit.json.',
    },
  ]);
  const lines = renderReadiness(report).split('\n');
  // Before: "could not access a required file or executable" and four lines of caveats.
  expect(lines[0]).toBe('Refit setup needs attention: 1 of 1 check blocked');
  expect(lines[1]).toBe(
    'Next: Run refit agents to see which provider agents apply, then refit agents --add <id> to write .refit.json.',
  );
  expect(lines.at(-1)).toBe(
    'Doctor only reads files: it runs no code, installs and downloads nothing, and the configuration is not approved or activated. Passing checks permit a validation attempt, not proof the migration is correct.',
  );
  const missing = join(app, 'elsewhere.json');
  expect((await inspectRepositoryReadiness({ config: missing })).checks[0]).toMatchObject({
    detail: `${missing} does not exist.`,
    action: "Check the --config path, or omit --config to use the repository's .refit.json.",
  });
});

it('uses the only integration and says which --integration to run when there are several', async () => {
  const single = await repository({ formatVersion: 2, integrations: [integration('catalog')] });
  const report = await inspectRepositoryReadiness({ repository: single });
  expect(report).toMatchObject({ status: 'ready-for-validation', integration: 'catalog' });
  const several = await repository({
    formatVersion: 2,
    integrations: [integration('catalog'), integration('billing')],
  });
  expect((await inspectRepositoryReadiness({ repository: several })).checks[0]).toEqual({
    id: 'configuration',
    title: 'Workflow configuration',
    status: 'blocked',
    detail:
      'This configuration has 2 integrations; choose one with --integration: catalog, billing.',
    action: 'Run refit doctor --integration catalog, and once for each other integration listed.',
  });
});

it('names the uncommitted files and the commands that save missing contracts', async () => {
  const app = await repository({
    formatVersion: 2,
    integrations: [
      integration('stripe', './refit/stripe-before.json', './refit/stripe-after.json'),
    ],
  });
  await writeFile(join(app, 'notes.md'), 'draft');
  const report = await inspectRepositoryReadiness({ repository: app });
  expect(report.checks.find((check) => check.id === 'repository')).toMatchObject({
    status: 'blocked',
    detail:
      'Validation requires a clean committed repository, including untracked files; not committed: notes.md.',
  });
  const contracts =
    'Save the contracts: refit stripe-snapshot --revision <stripe/openapi commit for the API version your code pins> --output refit/stripe-before.json and refit stripe-snapshot --latest --output refit/stripe-after.json. Then run refit doctor again.';
  expect(report.checks.find((check) => check.id === 'analysis')).toMatchObject({
    status: 'blocked',
    detail: 'Missing contracts: refit/stripe-before.json, refit/stripe-after.json.',
    action: contracts,
  });
  // Committing comes last, so the summary points at the contracts first.
  expect(renderReadiness(report).split('\n').slice(0, 2)).toEqual([
    'Refit setup needs attention: 2 of 5 checks blocked',
    `Next: ${contracts}`,
  ]);
});
