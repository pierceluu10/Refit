import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchStripeSnapshot } from './snapshots.ts';
import { MAX_SPECIFICATION_BYTES, readSpecification } from './specifications.ts';

const REVISION = 'a'.repeat(40);
const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function snapshotFile(content: string) {
  const directory = await mkdtemp(join(tmpdir(), 'refit-snapshot-'));
  directories.push(directory);
  const path = join(directory, 'snapshot.json');
  await writeFile(path, content);
  return path;
}

it.each(['master', '../main', 'abcdef', 'A'.repeat(40)])(
  'rejects an unpinned revision %s before networking',
  async (revision) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(fetchStripeSnapshot(revision)).rejects.toThrow(/full lowercase 40-character/);
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it.each([
  { content: '{}' },
  { hash: 'incorrect' },
  { provider: 'other' },
  { url: 'https://example.com/spec.json' },
  { revision: 'master' },
  { formatVersion: 2 },
])('rejects altered snapshot provenance or content: %j', async (modification) => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(await readFile('pipeline/fixtures/before.json'))),
  );
  const snapshot = await fetchStripeSnapshot(REVISION);
  const path = await snapshotFile(JSON.stringify({ ...snapshot, ...modification }));
  await expect(readSpecification(path)).rejects.toThrow();
});

it('reports unavailable revisions and cancels the response body', async () => {
  const response = new Response('not found', { status: 404 });
  const cancel = vi.spyOn(response.body!, 'cancel');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  await expect(fetchStripeSnapshot(REVISION)).rejects.toThrow(/HTTP 404/);
  expect(cancel).toHaveBeenCalled();
});

it('rejects a downloaded document that is not a supported specification', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"message":"error"}')));
  await expect(fetchStripeSnapshot(REVISION)).rejects.toThrow(/components.schemas/);
});

it('bounds streamed downloads even without a Content-Length header', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let bytes = 0;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk);
      bytes += chunk.byteLength;
    },
    cancel,
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)));
  await expect(fetchStripeSnapshot(REVISION)).rejects.toThrow(/download limit/);
  expect(bytes).toBeGreaterThan(MAX_SPECIFICATION_BYTES);
  expect(cancel).toHaveBeenCalled();
});
