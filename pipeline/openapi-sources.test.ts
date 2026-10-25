import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { captureSpecification } from './openapi-sources.ts';
import {
  digest,
  parseSpecification,
  readSpecification,
  stripeSpecificationUrl,
} from './specifications.ts';
import { SpecificationUnavailableError } from './network.ts';

const roots: string[] = [];
const YAML =
  'openapi: 3.1.0\ninfo:\n  title: Example\n  version: "1"\npaths: {}\ncomponents:\n  schemas:\n    Model:\n      type: object\n      properties:\n        owned_by:\n          type: string\n';

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it('captures a provider-neutral YAML source and verifies its saved content provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-source-test-'));
  roots.push(root);
  const source = join(root, 'openapi.yaml');
  await writeFile(source, YAML);
  const snapshot = await captureSpecification({ kind: 'file', path: source }, 'openai');
  const saved = join(root, 'snapshot.json');
  await writeFile(saved, JSON.stringify(snapshot));
  expect((await readSpecification(saved)).provenance).toMatchObject({
    provider: 'openai',
    revision: snapshot.hash,
  });
  expect((await readSpecification(saved)).schemas.Model).toHaveProperty('properties.owned_by');
  await writeFile(
    saved,
    JSON.stringify({ ...snapshot, content: YAML.replace('owned_by', 'owner') }),
  );
  await expect(readSpecification(saved)).rejects.toThrow(/content hash/);
});

it('keeps a file source that is already a verified Refit snapshot, as enrollment generates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-source-test-'));
  roots.push(root);
  const content = JSON.stringify({ openapi: '3.0.0', paths: {} });
  const revision = 'ce576d4f145edeef361a64d9d51b2153e3696b0b';
  const stripe = {
    formatVersion: 1,
    kind: 'refit-snapshot',
    provider: 'stripe',
    revision,
    url: stripeSpecificationUrl(revision),
    hash: digest(content),
    content,
  };
  const yaml = join(root, 'openapi.yaml');
  await writeFile(yaml, YAML);
  const source = await captureSpecification({ kind: 'file', path: yaml }, 'openai');
  for (const snapshot of [stripe, source]) {
    const path = join(root, `${snapshot.kind}.json`);
    await writeFile(path, JSON.stringify(snapshot));
    expect(await captureSpecification({ kind: 'file', path }, snapshot.provider)).toEqual(snapshot);
    await writeFile(path, JSON.stringify({ ...snapshot, hash: digest('tampered') }));
    await expect(captureSpecification({ kind: 'file', path }, snapshot.provider)).rejects.toThrow(
      /content hash/,
    );
  }
});

it('downloads public HTTPS specifications without redirects or credentials', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(YAML));
  vi.stubGlobal('fetch', fetcher);
  const snapshot = await captureSpecification(
    { kind: 'https', url: 'https://example.com/openapi.yaml' },
    'another-provider',
  );
  expect(snapshot.provider).toBe('another-provider');
  expect(fetcher.mock.calls[0][1].redirect).toBe('error');
  expect(fetcher.mock.calls[0][1].headers).toBeUndefined();
  await expect(
    captureSpecification({ kind: 'https', url: 'http://example.com/spec' }, 'example'),
  ).rejects.toThrow(/HTTPS/);
  await expect(
    captureSpecification({ kind: 'https', url: 'https://key@example.com/spec' }, 'example'),
  ).rejects.toThrow(/credentials/);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('supports inline-only contracts and rejects YAML alias expansion, duplicate keys and unknown tags', () => {
  expect(parseSpecification('openapi: 3.0.3\npaths: {}', 'inline').schemas).toEqual({});
  expect(() =>
    parseSpecification('openapi: 3.0.3\npaths: &paths {}\ncomponents: *paths', 'alias'),
  ).toThrow(/aliases/);
  expect(() =>
    parseSpecification('openapi: 3.0.3\nopenapi: 3.1.0\npaths: {}', 'duplicate'),
  ).toThrow(/YAML/);
  expect(() => parseSpecification('openapi: 3.0.3\npaths: !unknown {}', 'tag')).toThrow(/YAML/);
});

it('reuses a captured HTTPS specification on an ETag match instead of downloading it again', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(YAML, { headers: { etag: '"version-1"' } }))
    .mockResolvedValueOnce(new Response(null, { status: 304 }));
  vi.stubGlobal('fetch', fetcher);
  const source = { kind: 'https' as const, url: 'https://example.com/openapi.yaml' };
  const first = await captureSpecification(source, 'example');
  const second = await captureSpecification(source, 'example', first);
  expect(second).toEqual(first);
  expect(fetcher.mock.calls[1][1].headers).toEqual({ 'If-None-Match': '"version-1"' });
});

it('distinguishes temporary source outages from rejected authentication or malformed contracts', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(new Response('not an OpenAPI contract'));
  vi.stubGlobal('fetch', fetcher);
  const source = { kind: 'https' as const, url: 'https://example.com/openapi.yaml' };
  await expect(captureSpecification(source, 'example')).rejects.toBeInstanceOf(
    SpecificationUnavailableError,
  );
  await expect(captureSpecification(source, 'example')).rejects.not.toBeInstanceOf(
    SpecificationUnavailableError,
  );
  await expect(captureSpecification(source, 'example')).rejects.not.toBeInstanceOf(
    SpecificationUnavailableError,
  );
  expect(fetcher).toHaveBeenCalledTimes(3);
});
