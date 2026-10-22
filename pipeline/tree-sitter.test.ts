import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GRAMMARS,
  isolated,
  TracerStopError,
  uniqueStops,
  verifiedGrammar,
  type TracerStop,
} from './tree-sitter.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const sha256 = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

describe.each(Object.values(GRAMMARS))('the vendored $package grammar', (pin) => {
  it('matches its pinned SHA-256 for the WASM build and the grammar source', async () => {
    expect(await sha256(pin.wasm)).toBe(pin.wasmSha256);
    expect(await sha256(pin.source)).toBe(pin.sourceSha256);
    expect(await readFile(pin.license, 'utf8')).toMatch(/^The MIT License/);
  });

  it('records where it came from', () => {
    expect(pin.tarball).toBe(
      `https://registry.npmjs.org/${pin.package}/-/${pin.package}-${pin.version}.tgz`,
    );
    expect(pin.tarballSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    expect(pin.repository).toBe(`https://github.com/tree-sitter/${pin.package}`);
    expect(pin.tag).toBe(`v${pin.version}`);
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('refuses to load a grammar that differs from its pin, with a named stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refit-grammar-'));
    roots.push(root);
    const bytes = await readFile(pin.wasm);
    bytes[bytes.length - 1] ^= 0xff;
    const tampered = join(root, 'grammar.wasm');
    await writeFile(tampered, bytes);
    const error = await verifiedGrammar({ ...pin, wasm: tampered }).catch((caught) => caught);
    expect(error).toBeInstanceOf(TracerStopError);
    expect(error.code).toBe('grammar-integrity');
    expect(error.message).toContain('it was not loaded');
    expect(await verifiedGrammar(pin)).toHaveLength((await readFile(pin.wasm)).length);
  });
});

describe('failure isolation', () => {
  it('turns any error in one language into a stop for that language', async () => {
    const stops: TracerStop[] = [];
    expect(
      await isolated('go', stops, 'fallback', async () => {
        throw new RangeError('Maximum call stack size exceeded');
      }),
    ).toBe('fallback');
    expect(
      await isolated('python', stops, [], async () => {
        throw new TracerStopError('scan-limits', 'python sources exceed scan limits');
      }),
    ).toEqual([]);
    expect(stops).toEqual([
      {
        language: 'go',
        file: null,
        code: 'tracer-failed',
        reason: 'The go tracer failed, so no go file was read: Maximum call stack size exceeded',
      },
      {
        language: 'python',
        file: null,
        code: 'scan-limits',
        reason: 'python sources exceed scan limits',
      },
    ]);
    // Without a stop list nothing is swallowed.
    await expect(
      isolated('go', undefined, [], async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('lists each stop once, in a stable order', () => {
    const stop = (language: 'python' | 'go', file: string | null): TracerStop => ({
      language,
      file,
      code: 'file-too-large',
      reason: 'r',
    });
    expect(
      uniqueStops([
        stop('python', 'b.py'),
        stop('go', 'a.go'),
        stop('python', 'b.py'),
        stop('go', null),
      ]),
    ).toEqual([stop('go', null), stop('go', 'a.go'), stop('python', 'b.py')]);
  });
});
