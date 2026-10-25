import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { compressEvidence, readEvidence, withStateLock } from './state-files.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('reads compressed evidence first, then evidence written before compression', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-evidence-test-'));
  roots.push(root);
  expect(await readEvidence(root, 'scan.json')).toBeUndefined();
  await writeFile(join(root, 'scan.json'), '{"format":"uncompressed"}\n');
  expect(await readEvidence(root, 'scan.json')).toBe('{"format":"uncompressed"}\n');
  await writeFile(join(root, 'scan.json.gz'), await compressEvidence('{"format":"gzip"}\n'));
  expect(await readEvidence(root, 'scan.json')).toBe('{"format":"gzip"}\n');
  await writeFile(join(root, 'report.json.gz'), '{"not":"gzip"}');
  await expect(readEvidence(root, 'report.json')).rejects.toMatchObject({ code: 'Z_DATA_ERROR' });
});

it('recovers a verified dead local owner but refuses an active or foreign owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-lock-test-'));
  roots.push(root);
  const child = await promisify(execFile)(process.execPath, ['-e', 'console.log(process.pid)']);
  const path = join(root, 'watch.lock');
  await writeFile(
    path,
    JSON.stringify({ pid: Number(child.stdout.trim()), host: hostname(), nonce: 'dead-owner' }),
  );
  await withStateLock(root, 'watch', async () => {
    expect(JSON.parse(await readFile(path, 'utf8')).pid).toBe(process.pid);
  });
  await writeFile(
    path,
    JSON.stringify({ pid: process.pid, host: hostname(), nonce: 'active-owner' }),
  );
  await expect(withStateLock(root, 'watch', async () => undefined)).rejects.toThrow(
    /active process/,
  );
  await writeFile(path, JSON.stringify({ pid: 1, host: 'another-host', nonce: 'foreign-owner' }));
  await expect(withStateLock(root, 'watch', async () => undefined)).rejects.toThrow(
    /cannot be verified/,
  );
});
