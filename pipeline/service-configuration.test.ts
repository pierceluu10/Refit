import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { readServiceConfiguration } from './service-configuration.ts';

const roots: string[] = [];
const APP = { appId: '123', privateKeyFile: 'unused-test-key' };
const execute = promisify(execFile);
const bin = resolve('bin/refit.mjs');
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'refit-service-config-'));
  roots.push(root);
  await writeFile(
    join(root, 'workflow.json'),
    JSON.stringify({
      formatVersion: 1,
      before: 'before.json',
      after: 'after.json',
      image: 'checks:local',
      command: ['npm', 'test'],
    }),
  );
  const target = {
    id: 'billing',
    repository: 'example/application',
    base: 'main',
    workflow: './workflow.json',
  };
  const path = join(root, 'service.json');
  return { root, path, target };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('resolves each approved workflow and source relative to the service configuration without local checkouts', async () => {
  const { root, path, target } = await setup();
  await writeFile(
    path,
    JSON.stringify({
      formatVersion: 1,
      targets: [
        target,
        {
          ...target,
          id: 'another-provider',
          source: { kind: 'file', path: './current.yaml' },
          documentationSources: [{ label: 'Changelog', url: 'https://docs.example.com/changelog' }],
        },
      ],
    }),
  );
  const result = await readServiceConfiguration(path, APP);
  expect(result[0].workflow?.repository).toBeUndefined();
  expect(result[0].workflow?.before).toBe(join(root, 'before.json'));
  expect(result[0].source).toEqual({ kind: 'file', path: join(root, 'after.json') });
  expect(result[1].source).toEqual({ kind: 'file', path: join(root, 'current.yaml') });
  expect(result[1].documentationSources).toEqual([
    { label: 'Changelog', url: 'https://docs.example.com/changelog' },
  ]);
});

it('rejects duplicate identities, secrets, automatic publication and credential-bearing source URLs', async () => {
  const { path, target } = await setup();
  for (const value of [
    { formatVersion: 1, targets: [target, target] },
    { formatVersion: 1, targets: [target], apiKey: 'private-value' },
    { formatVersion: 1, targets: [{ ...target, publishDraft: true }] },
    {
      formatVersion: 1,
      targets: [
        { ...target, source: { kind: 'https', url: 'https://secret@example.com/spec.yaml' } },
      ],
    },
    {
      formatVersion: 1,
      targets: [
        { ...target, source: { kind: 'https', url: 'https://example.com/spec.yaml?token=secret' } },
      ],
    },
  ]) {
    await writeFile(path, JSON.stringify(value));
    await expect(readServiceConfiguration(path, APP)).rejects.toThrow();
  }
});

it('validates documentation monitors before the worker starts', async () => {
  const { path, target } = await setup();
  const valid = { label: 'Changelog', url: 'https://docs.example.com/changelog' };
  for (const documentationSources of [
    'invalid',
    [valid, valid],
    [{ ...valid, url: 'https://docs.example.com/changelog?token=secret' }],
    [{ ...valid, url: 'https://secret@docs.example.com/changelog' }],
    [{ ...valid, unexpected: true }],
    Array.from({ length: 9 }, (_, index) => ({
      label: `Source ${index}`,
      url: `https://docs.example.com/changelog-${index}`,
    })),
  ]) {
    await writeFile(
      path,
      JSON.stringify({
        formatVersion: 1,
        targets: [{ ...target, documentationSources }],
      }),
    );
    await expect(readServiceConfiguration(path, APP)).rejects.toThrow();
  }
});

it('exposes service help and refuses missing authentication or invalid scheduling before creating state', async () => {
  const { root, path, target } = await setup();
  await writeFile(path, JSON.stringify({ formatVersion: 1, targets: [target] }));
  expect((await execute(process.execPath, [bin, 'serve', '--help'])).stdout).toContain(
    '/github/webhook',
  );
  expect((await execute(process.execPath, [bin, 'watch', '--help'])).stdout).toContain(
    '--documentation-source',
  );
  const arguments_ = [bin, 'serve', '--config', path, '--state', join(root, 'state'), '--once'];
  const environment = {
    ...process.env,
    GITHUB_APP_ID: APP.appId,
    GITHUB_APP_PRIVATE_KEY_FILE: APP.privateKeyFile,
    REFIT_WEBHOOK_SECRET: '',
    REFIT_SERVICE_TOKEN: 'different-control-secret-for-tests-123',
  };
  await expect(execute(process.execPath, arguments_, { env: environment })).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('REFIT_WEBHOOK_SECRET'),
  });
  await expect(
    execute(process.execPath, [...arguments_, '--interval', '1'], {
      env: { ...environment, REFIT_WEBHOOK_SECRET: 'webhook-secret-for-cli-tests-12345' },
    }),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('30–86400') });
});
