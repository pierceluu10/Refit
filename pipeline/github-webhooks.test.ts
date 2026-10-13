import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parseWebhook, verifyWebhook } from './github-webhooks.ts';
import { openServiceStore } from './service-state.ts';
import type { ServiceTarget } from './service-configuration.ts';

const SECRET = 'webhook-test-secret-that-is-long-enough';
const APP_ID = 123;
const INSTALLATION_ID = 456;
const roots: string[] = [];
const payload = {
  action: 'created',
  installation: { id: INSTALLATION_ID, app_id: APP_ID, account: { login: 'Example' } },
  repositories: [{ id: 789, full_name: 'Example/Application' }],
};
const targets: ServiceTarget[] = [
  {
    id: 'demo',
    repository: 'example/application',
    base: 'main',
    workflow: {
      repository: undefined,
      before: 'before.json',
      after: 'after.json',
      latestStripe: undefined,
      image: 'checks:local',
      command: ['npm', 'test'],
      baselineCommand: undefined,
      providerConfig: undefined,
      fullDiff: true,
    },
    source: { kind: 'file', path: 'after.json' },
  },
];
async function store() {
  const root = await mkdtemp(join(tmpdir(), 'refit-webhooks-'));
  roots.push(root);
  return { root, value: await openServiceStore(root, 'test-configuration', APP_ID, targets) };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('authenticates exact UTF-8 bytes and rejects tampering, missing signatures and bad delivery IDs', () => {
  const body = Buffer.from('{"word":"café"}\n');
  const signature = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
  const delivery = randomUUID();
  expect(verifyWebhook(body, signature, delivery.toUpperCase(), SECRET)).toBe(delivery);
  expect(() =>
    verifyWebhook(Buffer.from(body.toString().trim()), signature, delivery, SECRET),
  ).toThrow(/did not match/);
  expect(() => verifyWebhook(body, undefined, delivery, SECRET)).toThrow(/signature/);
  expect(() => verifyWebhook(body, signature, 'not-a-guid', SECRET)).toThrow(/GUID/);
});

it('normalizes installation access without trusting foreign Apps, owners or executable payload fields', () => {
  const body = Buffer.from(JSON.stringify({ ...payload, command: ['untrusted', 'command'] }));
  const change = parseWebhook(body, 'installation', APP_ID);
  expect(change).toMatchObject({
    kind: 'installation',
    installationId: INSTALLATION_ID,
    owner: 'example',
    added: [{ id: 789, name: 'example/application' }],
  });
  expect(change).not.toHaveProperty('command');
  expect(() => parseWebhook(body, 'installation', APP_ID + 1)).toThrow(/this App/);
  expect(() =>
    parseWebhook(
      Buffer.from(
        JSON.stringify({ ...payload, repositories: [{ id: 1, full_name: 'other/application' }] }),
      ),
      'installation',
      APP_ID,
    ),
  ).toThrow(/owner/);
  expect(parseWebhook(Buffer.from('{"anything":true}'), 'issues', APP_ID)).toEqual({
    kind: 'ignored',
  });
});

it('deduplicates concurrent deliveries and keeps receipts across restart without granting access', async () => {
  const { root, value } = await store();
  const id = randomUUID();
  const body = Buffer.from(JSON.stringify(payload));
  const change = parseWebhook(body, 'installation', APP_ID);
  const outcomes = await Promise.all([
    value.accept(id, 'installation', body, change),
    value.accept(id, 'installation', body, change),
  ]);
  expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['accepted', 'duplicate']);
  const registry = await value.read();
  expect(registry.accessVersion).toBe(1);
  expect(registry.targets.demo.access).toBe('unknown');
  expect(registry.installations[String(INSTALLATION_ID)]).toMatchObject({
    owner: 'example',
    status: 'pending',
  });
  const restarted = await openServiceStore(root, 'test-configuration', APP_ID, targets);
  expect((await restarted.accept(id, 'installation', body, change)).status).toBe('duplicate');
  await expect(
    restarted.accept(id, 'installation', Buffer.from('{}'), change),
  ).rejects.toMatchObject({ status: 409 });
  expect(await readFile(join(root, 'registry.json'), 'utf8')).not.toContain(SECRET);
});

it('blocks revoked repositories and ignores removal events from an old installation', async () => {
  const { value } = await store();
  await value.update((state) => {
    state.targets.demo.installationId = INSTALLATION_ID;
    state.targets.demo.access = 'active';
  });
  const removal = {
    action: 'removed',
    installation: payload.installation,
    repositories_added: [],
    repositories_removed: payload.repositories,
  };
  const body = Buffer.from(JSON.stringify(removal));
  const event = parseWebhook(body, 'installation_repositories', APP_ID);
  const result = await value.accept(randomUUID(), 'installation_repositories', body, event);
  expect(result.disabled).toEqual(['demo']);
  expect((await value.read()).targets.demo.access).toBe('blocked');
  await value.update((state) => {
    state.targets.demo.installationId = INSTALLATION_ID + 1;
    state.targets.demo.access = 'active';
  });
  expect(
    (await value.accept(randomUUID(), 'installation_repositories', body, event)).disabled,
  ).toEqual([]);
  expect((await value.read()).targets.demo.access).toBe('active');
});

it('records unconfigured repositories without creating an automatic worker target', async () => {
  const { value } = await store();
  const body = Buffer.from(
    JSON.stringify({ ...payload, repositories: [{ id: 2, full_name: 'example/unknown' }] }),
  );
  await value.accept(
    randomUUID(),
    'installation',
    body,
    parseWebhook(body, 'installation', APP_ID),
  );
  const state = await value.read();
  expect(state.installations[String(INSTALLATION_ID)].repositories).toHaveProperty(
    'example/unknown',
  );
  expect(Object.keys(state.targets)).toEqual(['demo']);
});
