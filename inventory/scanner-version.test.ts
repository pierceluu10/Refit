import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashScannerSources, SCANNER_VERSION } from './scanner-version.ts';

describe('hashScannerSources', () => {
  let root: string;
  const write = (file: string, text: string) => writeFile(path.join(root, file), text);

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'scanner-version-'));
    await mkdir(path.join(root, 'inventory'));
    await mkdir(path.join(root, 'dead-apis', 'data'), { recursive: true });
    await write('inventory/scan.ts', 'one');
    await write('dead-apis/match.ts', 'two');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('is the same on every read of the same code', () => {
    expect(hashScannerSources(root)).toBe(hashScannerSources(root));
    expect(SCANNER_VERSION).toBe(hashScannerSources(path.join(import.meta.dirname, '..')));
  });

  it.each([
    ['an edit to a scanner file', 'inventory/scan.ts', 'changed'],
    ['an edit to the matching code', 'dead-apis/match.ts', 'changed'],
    ['a new scanner file', 'inventory/dead-scan-new.ts', 'new'],
  ])('moves with %s', async (_name, file, text) => {
    const before = hashScannerSources(root);
    await write(file, text);
    expect(hashScannerSources(root)).not.toBe(before);
  });

  it.each([
    ['a test', 'inventory/scan.test.ts'],
    ['the list data, which has its own version', 'dead-apis/data/stripe.json'],
  ])('ignores %s', async (_name, file) => {
    const before = hashScannerSources(root);
    await write(file, 'changed');
    expect(hashScannerSources(root)).toBe(before);
  });
});
