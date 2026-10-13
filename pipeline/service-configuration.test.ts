import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readServiceConfiguration } from './service-configuration.ts';

const roots: string[] = [];
const APP = { appId: '123', privateKeyFile: 'unused-test-key' };
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
        { ...target, id: 'another-provider', source: { kind: 'file', path: './current.yaml' } },
      ],
    }),
  );
  const result = await readServiceConfiguration(path, APP);
  expect(result[0].workflow.repository).toBeUndefined();
  expect(result[0].workflow.before).toBe(join(root, 'before.json'));
  expect(result[0].source).toEqual({ kind: 'file', path: join(root, 'after.json') });
  expect(result[1].source).toEqual({ kind: 'file', path: join(root, 'current.yaml') });
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
