import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { digest } from './specifications.ts';
import { verifyArtifacts } from './verification.ts';

const execute = promisify(execFile);
const roots: string[] = [];
const content = '{"message":"évidence"}\n';
const entry = { path: 'report.json', sha256: digest(content), bytes: Buffer.byteLength(content) };
async function fixture(files: unknown[] = [entry]) {
  const root = await mkdtemp(join(tmpdir(), 'refit-evidence-'));
  roots.push(root);
  await writeFile(join(root, 'report.json'), content);
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({ formatVersion: 1, kind: 'refit-workflow', files }),
  );
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('verifies exact UTF-8 bytes through the installed command route without executing evidence', async () => {
  const root = await fixture();
  const result = await execute(
    process.execPath,
    [resolve('bin/refit.mjs'), 'verify', '--directory', root],
    { cwd: tmpdir() },
  );
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: 'integrity-verified',
    files: 1,
    bytes: entry.bytes,
  });
  await writeFile(join(root, 'report.json'), content.replace('message', 'changed'));
  await expect(verifyArtifacts(root)).rejects.toThrow(/mismatch/);
});

it('rejects truncated, missing and unlisted artifacts', async () => {
  const root = await fixture();
  await writeFile(join(root, 'report.json'), '{}');
  await expect(verifyArtifacts(root)).rejects.toThrow(/mismatch/);
  await rm(join(root, 'report.json'));
  await expect(verifyArtifacts(root)).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(join(root, 'report.json'), content);
  await writeFile(join(root, 'extra.txt'), 'not recorded');
  await expect(verifyArtifacts(root)).rejects.toThrow(/Unlisted/);
});

it.each(
  [
    [{ ...entry, path: '../outside.json' }],
    [{ ...entry, path: '/absolute.json' }],
    [{ ...entry, path: 'nested/report.json' }],
    [{ ...entry, path: 'manifest.json' }],
    [entry, entry],
    [{ ...entry, bytes: -1 }],
    [{ ...entry, bytes: 0.5 }],
    [{ ...entry, bytes: 257 * 1024 * 1024 }],
    [{ ...entry, sha256: 'invalid' }],
  ].map((files) => ({ files })),
)('rejects malformed manifest entries: %j', async ({ files }) => {
  await expect(verifyArtifacts(await fixture(files))).rejects.toThrow(/Invalid or duplicate/);
});

it('rejects symlink artifacts and symlink manifests', async () => {
  const root = await fixture();
  const other = await fixture();
  await rm(join(root, 'report.json'));
  await symlink(join(other, 'report.json'), join(root, 'report.json'));
  await expect(verifyArtifacts(root)).rejects.toThrow(/regular files/);
  await rm(join(root, 'manifest.json'));
  await symlink(join(other, 'manifest.json'), join(root, 'manifest.json'));
  await expect(verifyArtifacts(root)).rejects.toThrow(/regular files/);
});

it('rejects unsupported or missing manifests rather than treating directories as completed runs', async () => {
  const root = await fixture();
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({ formatVersion: 2, kind: 'refit-workflow', files: [] }),
  );
  await expect(verifyArtifacts(root)).rejects.toThrow(/Unsupported/);
  await rm(join(root, 'manifest.json'));
  await expect(verifyArtifacts(root)).rejects.toMatchObject({ code: 'ENOENT' });
});
