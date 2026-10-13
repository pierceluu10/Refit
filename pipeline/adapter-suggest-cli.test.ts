import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const execute = promisify(execFile);
const bin = resolve('bin/refit.mjs');
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'refit-adapter-suggest-cli-'));
  directories.push(directory);
  return directory;
}

it('shows adapter-suggestion command requirements through the installed CLI entry point', async () => {
  const { stdout } = await execute(process.execPath, [bin, 'adapter-suggest', '--help']);
  expect(stdout).toContain('Usage: refit adapter-suggest');
  expect(stdout).toContain('--operation-id');
});

it('rejects ambiguous import settings before inspecting files or requesting AI', async () => {
  const directory = await temporaryDirectory();
  const output = join(directory, 'provider.json');
  await expect(
    execute(process.execPath, [
      bin,
      'adapter-suggest',
      '--repository',
      directory,
      '--spec',
      join(directory, 'missing.json'),
      '--id',
      'example-provider',
      '--package',
      '@example/sdk',
      '--default-import',
      '--export',
      'Client',
      '--output',
      output,
    ]),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('Choose exactly one of --default-import or --export'),
  });
  await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' });
});
