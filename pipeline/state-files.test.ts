import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BOOT_ID_PATH, compressEvidence, readEvidence, withStateLock } from './state-files.ts';

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

// refit-hosted job 2997: after a deploy, a lock written before the restart named pid 652, which
// the new boot had given to Fly's hallpass, so the target stayed locked.
it('recovers a lock from an earlier boot even when its process ID is in use again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-lock-test-'));
  roots.push(root);
  const path = join(root, 'checkout.lock');
  const reused = { pid: process.pid, host: hostname() };
  await writeFile(path, JSON.stringify({ ...reused, nonce: 'before-boot-ids' }));
  await utimes(path, new Date(0), new Date(0));
  await withStateLock(root, 'checkout', async () => {
    expect(JSON.parse(await readFile(path, 'utf8')).nonce).not.toBe('before-boot-ids');
  });
  // Written in this boot without a boot id: the process ID still decides.
  await writeFile(path, JSON.stringify({ ...reused, nonce: 'this-boot' }));
  await expect(withStateLock(root, 'checkout', async () => undefined)).rejects.toThrow(
    /active process/,
  );
});

it.skipIf(!existsSync(BOOT_ID_PATH))('compares the boot id a lock records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-lock-test-'));
  roots.push(root);
  const path = join(root, 'checkout.lock');
  const boot = (await readFile(BOOT_ID_PATH, 'utf8')).trim();
  const reused = { pid: process.pid, host: hostname() };
  await writeFile(path, JSON.stringify({ ...reused, nonce: 'earlier', boot: 'an-earlier-boot' }));
  await withStateLock(root, 'checkout', async () => {
    expect(JSON.parse(await readFile(path, 'utf8')).boot).toBe(boot);
  });
  await writeFile(path, JSON.stringify({ ...reused, nonce: 'current', boot }));
  await utimes(path, new Date(0), new Date(0));
  await expect(withStateLock(root, 'checkout', async () => undefined)).rejects.toThrow(
    /active process/,
  );
});
