import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { validateSourcePatch } from './validation.ts';

const execute = promisify(execFile);
const MIB = 1024 * 1024;
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function validateWithMedia(mediaBytes: number) {
  const root = await mkdtemp(join(tmpdir(), 'refit-source-limit-'));
  roots.push(root);
  const repository = join(root, 'repository');
  const binary = join(root, 'bin');
  await mkdir(join(repository, 'public', 'uploads'), { recursive: true });
  await mkdir(binary);
  await writeFile(
    join(repository, 'package.json'),
    '{"name":"agriflow","scripts":{"test":"jest"}}',
  );
  await writeFile(join(repository, 'index.js'), 'module.exports = 1;\n');
  await writeFile(join(repository, 'public', 'uploads', 'field.jpg'), randomBytes(mediaBytes));
  await execute('git', ['init', '-q', repository]);
  // Random media does not compress; storing it keeps the large cases fast.
  await execute('git', ['-C', repository, '-c', 'core.compression=0', 'add', '.']);
  await execute('git', [
    '-C',
    repository,
    '-c',
    'user.name=Refit Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'test: seed',
  ]);
  // Every check passes; only the source archive is under test.
  await writeFile(
    join(binary, 'docker'),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'image') { console.log(args[3] === '{{.Id}}' ? 'sha256:${'a'.repeat(64)}' : JSON.stringify(['NODE_VERSION=22.23.3'])); process.exit(0); }
process.exit(0);
`,
  );
  await chmod(join(binary, 'docker'), 0o755);
  vi.stubEnv('PATH', binary + delimiter + process.env.PATH);
  return validateSourcePatch({
    repository,
    propose: async () =>
      'diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-module.exports = 1;\n+module.exports = 2;\n',
    image: 'node:22-alpine',
    command: ['npm', 'test'],
  });
}

// Shefaul-22/AgriFlow at 4a7741c commits 73.3 MiB, 72.6 MiB of it JPEGs under public/uploads;
// CRONANANI/EzanaFinance3 at 4666e5a commits 53.6 MiB, 21.7 MiB of it PNGs.
it.each([
  ['Shefaul-22/AgriFlow', 73],
  ['CRONANANI/EzanaFinance3', 54],
])(
  'archives %s (%i MiB) on the 2g profile, which takes 256 MiB of source, and refuses it on 1g',
  async (_repository, mebibytes) => {
    vi.stubEnv('REFIT_VALIDATION_WORKSPACE', '2g');
    expect((await validateWithMedia(mebibytes * MIB)).status).toBe('passed');
    vi.stubEnv('REFIT_VALIDATION_WORKSPACE', '1g');
    await expect(validateWithMedia(mebibytes * MIB)).rejects.toThrow(
      'Committed source exceeds the 50 MiB validation archive limit. Stop committing build output, media or data files (or track them with Git LFS) so the committed tree fits.',
    );
  },
  60_000,
);

// Founders' decision (2026-10-27): the default 4g profile takes 512 MiB of source, past the old 256.
it('archives 300 MiB of source on the 4g profile and refuses it on 2g', async () => {
  vi.stubEnv('REFIT_VALIDATION_WORKSPACE', '4g');
  expect((await validateWithMedia(300 * MIB)).status).toBe('passed');
  vi.stubEnv('REFIT_VALIDATION_WORKSPACE', '2g');
  await expect(validateWithMedia(300 * MIB)).rejects.toThrow(
    'Committed source exceeds the 256 MiB validation archive limit.',
  );
}, 180_000);
