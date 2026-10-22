import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, expect, it } from 'vitest';
import { openHostedStore } from './hosted-store.ts';
import { DEFAULT_TENANCY_LIMITS, TENANCY_REFUSALS } from './hosted-tenancy.ts';
import { openInventoryStore } from './inventory-store.ts';

const DATABASE = process.env.REFIT_POSTGRES_URL;
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function database() {
  const schema = `refit_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: DATABASE });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: DATABASE, options: `-c search_path=${schema}` });
  cleanups.push(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  return pool;
}

// Both stores take the same limits, as the hosted service passes them.
const LIMITS = { ...DEFAULT_TENANCY_LIMITS, dailyInventories: 2 };
const tenancy = (accounts: string[]) => ({ accounts, limits: LIMITS });

function install(
  store: Awaited<ReturnType<typeof openHostedStore>>,
  installationId: number,
  owner: string,
  repositories: string[],
) {
  return store.accept(randomUUID(), 'installation', new TextEncoder().encode(randomUUID()), {
    kind: 'installation',
    installationId,
    owner,
    action: 'created',
    added: repositories.map((name, index) => ({ id: installationId * 100 + index, name })),
    removed: [],
  });
}

it.skipIf(!DATABASE)(
  'inventories only allowed accounts, backfills one once allowed and holds an installation at its daily cap',
  async () => {
    const pool = await database();
    const store = await openHostedStore(pool, tenancy(['example']));
    const inventories = await openInventoryStore(pool, LIMITS);
    await install(store, 1, 'example', ['example/one', 'example/two', 'example/three']);
    expect(await install(store, 2, 'customer', ['customer/app'])).toMatchObject({
      status: 'not-allowed',
    });

    // Another account's repositories are recorded by the hosted store but never queued.
    expect(await inventories.request(2, ['customer/app'])).toBe(0);
    await expect(inventories.requestRepository('customer/app')).rejects.toThrow(
      'customer/app is not installed in an allowed, active installation.',
    );
    expect(await inventories.requestMissing()).toBe(3);
    expect((await inventories.read()).map((row) => row.repository)).toEqual([
      'example/one',
      'example/three',
      'example/two',
    ]);

    // Two inventories fit today's cap; the third waits, and status names the refusal.
    const first = await inventories.claim('worker-a', 60);
    const second = await inventories.claim('worker-a', 60);
    expect([first?.repository, second?.repository].sort()).toEqual([
      'example/one',
      'example/three',
    ]);
    expect(await inventories.claim('worker-a', 60)).toBeNull();
    const [installation] = (await store.read()).installations;
    expect(installation).toMatchObject({ id: '1', inventoriesToday: 2 });
    expect(installation.refusals).toContain(TENANCY_REFUSALS.dailyInventories);
    expect((await inventories.read('example/two'))[0]).toMatchObject({ state: 'queued' });

    // Reclaiming a crashed worker's lease does not count against the cap again.
    await pool.query(
      `UPDATE refit_inventories SET lease_expires_at = now() - interval '1 second'
       WHERE repository = $1`,
      [first!.repository],
    );
    expect(await inventories.claim('worker-b', 60)).toMatchObject({
      repository: first!.repository,
    });
    expect((await store.read()).installations[0]).toMatchObject({ inventoriesToday: 2 });

    // Allowing the account later backfills its installed repositories.
    const widened = await openHostedStore(pool, tenancy(['example', 'customer']));
    await widened.allow();
    expect(await inventories.requestMissing()).toBe(1);
    expect(await inventories.claim('worker-a', 60)).toMatchObject({
      installationId: 2,
      repository: 'customer/app',
    });
    expect(await inventories.requestRepository('customer/app')).toBe(2);
  },
);
