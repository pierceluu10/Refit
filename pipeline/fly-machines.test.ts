import { afterEach, expect, it } from 'vitest';
import { fakeFlyMachines } from './fixtures/fake-fly-machines.ts';
import { FlyMachinesError, flyMachines } from './fly-machines.ts';

const APP = 'refit-jobs-test';
const TOKEN = 'fly-test-token';
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const fake = await fakeFlyMachines({ app: APP, token: TOKEN });
  cleanups.push(fake.close);
  return { fake, client: flyMachines({ app: APP, token: TOKEN, api: fake.api }) };
}

const CONFIG = {
  region: 'iad',
  image: 'registry.example/refit:job',
  env: { REFIT_JOB_ID: '7' },
  guest: { cpu_kind: 'shared' as const, cpus: 2, memory_mb: 4096 },
  metadata: { refit: 'job', refit_job: '7' },
};

it('creates a self-destroying, never-restarting machine, lists it by metadata and destroys it', async () => {
  const { fake, client } = await setup();
  const created = await client.create(CONFIG);
  expect(created).toEqual({ id: expect.any(String), state: 'started', metadata: CONFIG.metadata });
  expect(fake.calls[0]).toMatchObject({
    method: 'POST',
    path: `/v1/apps/${APP}/machines`,
    body: {
      region: 'iad',
      config: {
        image: CONFIG.image,
        env: CONFIG.env,
        guest: CONFIG.guest,
        metadata: CONFIG.metadata,
        auto_destroy: true,
        restart: { policy: 'no' },
      },
    },
  });
  await client.create({ ...CONFIG, metadata: { refit: 'job', refit_job: '8' } });
  expect(
    (await client.list({ refit: 'job', refit_job: '7' })).map((machine) => machine.id),
  ).toEqual([created.id]);
  expect(fake.calls.at(-1)?.path).toBe(
    `/v1/apps/${APP}/machines?metadata.refit=job&metadata.refit_job=7`,
  );
  await client.destroy(created.id);
  expect(fake.calls.at(-1)).toMatchObject({
    method: 'DELETE',
    path: `/v1/apps/${APP}/machines/${created.id}?force=true`,
  });
  expect(await client.get(created.id)).toMatchObject({ state: 'destroyed' });
  // A machine that is already gone counts as destroyed.
  await client.destroy(created.id);
  await client.destroy('missing0machine');
});

it('retries 429 and 5xx responses a bounded number of times', async () => {
  const { fake, client } = await setup();
  fake.failures.push(429, 503, 500);
  expect((await client.create(CONFIG)).state).toBe('started');
  expect(fake.calls.filter((call) => call.method === 'POST')).toHaveLength(4);

  fake.failures.push(503, 503, 503, 503, 503);
  await expect(client.list({ refit: 'job' })).rejects.toMatchObject({
    name: 'FlyMachinesError',
    status: 503,
  });
  // Four attempts in total; the fifth queued failure was never requested.
  expect(fake.failures).toEqual([503]);
});

it('does not retry other 4xx responses', async () => {
  const { fake, client } = await setup();
  fake.failures.push(422);
  await expect(client.create(CONFIG)).rejects.toThrow(
    new FlyMachinesError('Fly POST machines failed with HTTP 422.', 422),
  );
  expect(fake.calls).toHaveLength(1);
  const unauthorized = flyMachines({ app: APP, token: 'wrong-token', api: fake.api });
  await expect(unauthorized.list({ refit: 'job' })).rejects.toMatchObject({ status: 401 });
  expect(fake.calls).toHaveLength(2);
});

it('retries network failures and then reports them', async () => {
  const { fake, client } = await setup();
  await fake.close();
  const started = Date.now();
  await expect(client.get('anymachine')).rejects.toThrow(/failed after 4 attempts/);
  // Backoff of 250, 500 and 1000 ms between the four attempts.
  expect(Date.now() - started).toBeGreaterThanOrEqual(1_700);
});

it('refuses an invalid job app name or an empty token before any request', () => {
  expect(() => flyMachines({ app: 'Refit Jobs', token: TOKEN })).toThrow(FlyMachinesError);
  expect(() => flyMachines({ app: APP, token: ' ' })).toThrow('FLY_API_TOKEN');
});
