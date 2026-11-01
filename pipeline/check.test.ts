import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { checkStripe } from './check.ts';
import { discoverStripeRevision, encodeSnapshot } from './snapshots.ts';
import { digest, stripeSpecificationUrl } from './specifications.ts';

const BEFORE = 'a'.repeat(40);
const AFTER = 'b'.repeat(40);
const roots: string[] = [];

async function inputs() {
  const root = await mkdtemp(join(tmpdir(), 'refit-check-test-'));
  roots.push(root);
  const content = await readFile('pipeline/fixtures/before.json', 'utf8');
  const baseline = join(root, 'baseline.json');
  const snapshot = encodeSnapshot({
    formatVersion: 1,
    kind: 'refit-snapshot',
    provider: 'stripe',
    revision: BEFORE,
    url: stripeSpecificationUrl(BEFORE),
    hash: digest(content),
    content,
  });
  await writeFile(baseline, snapshot);
  return {
    repository: resolve('pipeline/fixtures/repository'),
    baseline,
    output: join(root, 'result'),
    snapshot,
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('rescans local code without downloading the same revision or claiming unaffected code', async () => {
  const options = await inputs();
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ sha: BEFORE }])));
  vi.stubGlobal('fetch', fetcher);
  const result = await checkStripe(options);
  expect(result.manifest.upstream).toBe('unchanged');
  expect(result.manifest.status).toBe('needs-review');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await readFile(join(options.output, 'after.json'), 'utf8')).toBe(options.snapshot);
});

it('cleans up failed runs without advancing or replacing the baseline', async () => {
  const options = await inputs();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })));
  await expect(checkStripe(options)).rejects.toThrow(/HTTP 429/);
  await expect(stat(options.output)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(options.baseline, 'utf8')).toBe(options.snapshot);
});

it('refuses raw baselines, existing output and output inside the repository', async () => {
  const options = await inputs();
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(checkStripe({ ...options, output: options.repository })).rejects.toMatchObject({
    code: 'EEXIST',
  });
  await expect(
    checkStripe({ ...options, output: join(options.repository, 'new-output') }),
  ).rejects.toThrow(/outside/);
  await writeFile(options.baseline, await readFile('pipeline/fixtures/before.json'));
  await expect(checkStripe(options)).rejects.toThrow(/pinned Refit snapshot/);
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([[], [{ sha: 'main' }], [{ sha: BEFORE }, { sha: AFTER }], { message: 'no commits' }])(
  'rejects malformed discovery results: %j',
  async (value) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(value))));
    await expect(discoverStripeRevision()).rejects.toThrow(/one pinned commit/);
  },
);
