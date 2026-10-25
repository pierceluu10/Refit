import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  latestStripeContract,
  readStripeContract,
  saveStripeContract,
  stripeContractFile,
  stripeContractVersion,
  stripeContractVersions,
} from './enrollment-contracts.ts';
import { encodeSnapshot, fetchStripeSnapshot } from './snapshots.ts';
import { stripeSpecificationUrl } from './specifications.ts';

// Both pass through unless a test makes one fail.
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
vi.mock('./snapshots.ts', async (original) => {
  const actual = await original<typeof import('./snapshots.ts')>();
  return { ...actual, fetchStripeSnapshot: vi.fn(actual.fetchStripeSnapshot) };
});

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'refit-contracts-'));
  roots.push(root);
  return root;
}

// A new frozen list that pins another tag fails here: run scripts/stripe-openapi-versions.mjs again.
it('names exactly the stripe/openapi tags the frozen benchmark lists pin, oldest first', async () => {
  const pinned = new Map<string, string>();
  for (const name of await readdir('docs/benchmarks')) {
    if (!name.endsWith('.json')) continue;
    const list = JSON.parse(await readFile(join('docs/benchmarks', name), 'utf8'));
    for (const spec of Array.isArray(list.specs) ? list.specs : [])
      pinned.set(spec.version, spec.tag);
  }
  const table = stripeContractVersions();
  expect(Object.fromEntries(table.map((entry) => [entry.version, entry.tag]))).toEqual(
    Object.fromEntries([...pinned].sort(([left], [right]) => left.localeCompare(right))),
  );
  expect(table.map((entry) => entry.version)).toEqual(
    [...pinned.keys()].sort((left, right) => left.localeCompare(right)),
  );
  expect(latestStripeContract()).toMatchObject({ version: '2026-09-30.endive', tag: 'v2526' });
});

it('says how to save a contract that is missing and refuses a version it has no commit for', async () => {
  const contracts = await directory();
  await expect(readStripeContract(contracts, '2025-03-31.basil')).rejects.toThrow(
    "Stripe's 2025-03-31.basil contract is not saved on this machine yet. Run refit stripe-snapshot --version 2025-03-31.basil to save it.",
  );
  await expect(readStripeContract(contracts, '2020-08-27')).rejects.toThrow(
    'Refit has no Stripe contract for API version 2020-08-27; it knows 2022-08-01 to 2026-09-30.endive.',
  );
});

it('refuses a saved contract whose commit or content differs from the table', async () => {
  const contracts = await directory();
  const entry = stripeContractVersion('2025-03-31.basil')!;
  const path = join(contracts, stripeContractFile(entry.version));
  await mkdir(join(contracts, 'refit'));
  const content = '{"openapi":"3.0.0","info":{"version":"2025-03-31.basil"},"paths":{}}';
  const refusal = `${path} is not stripe/openapi ${entry.tag}; delete it and run refit stripe-snapshot --version 2025-03-31.basil again.`;
  // The table's hash with content edited after download.
  await writeFile(
    path,
    encodeSnapshot({
      formatVersion: 1,
      kind: 'refit-snapshot',
      provider: 'stripe',
      revision: entry.commit,
      url: stripeSpecificationUrl(entry.commit),
      hash: entry.sha256,
      content,
    }),
  );
  await expect(readStripeContract(contracts, entry.version)).rejects.toThrow(refusal);
  // Another commit's snapshot saved under this version's name.
  await writeFile(
    path,
    encodeSnapshot({
      formatVersion: 1,
      kind: 'refit-snapshot',
      provider: 'stripe',
      revision: latestStripeContract().commit,
      url: stripeSpecificationUrl(latestStripeContract().commit),
      hash: entry.sha256,
      content,
    }),
  );
  await expect(readStripeContract(contracts, entry.version)).rejects.toThrow(refusal);
});

it('saves nothing when the pinned commit no longer serves the recorded content', async () => {
  const contracts = await directory();
  const entry = stripeContractVersion('2023-10-16')!;
  const fetcher = vi.fn(
    async () =>
      new Response('{"openapi":"3.0.0","info":{"version":"2023-10-16"},"paths":{}}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(saveStripeContract(contracts, entry.version)).rejects.toThrow(
    `stripe/openapi ${entry.tag} no longer has the content Refit recorded for 2023-10-16; nothing was saved.`,
  );
  expect(fetcher).toHaveBeenCalledWith(stripeSpecificationUrl(entry.commit), expect.anything());
  expect(await readdir(contracts)).toEqual([]);
});

it('removes the partial file of a failed save, so the next download writes the contract', async () => {
  const contracts = await directory();
  const entry = stripeContractVersion('2025-03-31.basil')!;
  const path = join(contracts, stripeContractFile(entry.version));
  // The table's hash on other content: it passes the download check and fails the saved-file check.
  vi.mocked(fetchStripeSnapshot).mockResolvedValue({
    formatVersion: 1,
    kind: 'refit-snapshot',
    provider: 'stripe',
    revision: entry.commit,
    url: stripeSpecificationUrl(entry.commit),
    hash: entry.sha256,
    content: '{"openapi":"3.0.0","info":{"version":"2025-03-31.basil"},"paths":{}}',
  });
  vi.mocked(rename).mockRejectedValueOnce(
    Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' }),
  );
  await expect(saveStripeContract(contracts, entry.version)).rejects.toThrow('ENOSPC');
  expect(await readdir(join(contracts, 'refit'))).toEqual([]);
  await expect(saveStripeContract(contracts, entry.version)).rejects.toThrow(
    `${path} is not stripe/openapi ${entry.tag}`,
  );
  expect(await readdir(join(contracts, 'refit'))).toEqual([
    stripeContractFile(entry.version).slice('refit/'.length),
  ]);
});
