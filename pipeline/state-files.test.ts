import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { withStateLock } from './state-files.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
