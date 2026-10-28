import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { validateSourcePatch } from './validation.ts';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.skipIf(!process.env.REFIT_DOCKER_IMAGE || !process.env.REFIT_NPM_PREPARE)(
  "generates the Prisma client the repository's postinstall declares, offline, before the checks",
  async () => {
    const repository = await mkdtemp(join(tmpdir(), 'refit-prisma-docker-'));
    roots.push(repository);
    await writeFile(
      join(repository, 'package.json'),
      `${JSON.stringify(
        {
          name: 'app',
          private: true,
          scripts: { postinstall: 'prisma generate', test: 'node check.cjs' },
          dependencies: { '@prisma/client': '6.19.1' },
          devDependencies: { prisma: '6.19.1' },
        },
        null,
        2,
      )}\n`,
    );
    await mkdir(join(repository, 'prisma'));
    await writeFile(
      join(repository, 'prisma', 'schema.prisma'),
      'generator client {\n  provider = "prisma-client-js"\n}\n\ndatasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n\nmodel Payment {\n  id String @id\n}\n',
    );
    // Loading @prisma/client throws until the client is generated.
    await writeFile(
      join(repository, 'check.cjs'),
      "console.log(`models ${Object.keys(require('@prisma/client').Prisma.ModelName)}`);\n",
    );
    await execute('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
      cwd: repository,
    });
    const git = (...args: string[]) =>
      execute('git', [
        '-C',
        repository,
        '-c',
        'user.name=Refit Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ]);
    await git('init', '-q');
    await git('add', '.');
    await git('commit', '-q', '-m', 'test: seed');

    const result = await validateSourcePatch({
      repository,
      // A comment cannot change the check, so the patched run repeats the baseline.
      propose: async () =>
        "diff --git a/check.cjs b/check.cjs\n--- a/check.cjs\n+++ b/check.cjs\n@@ -1 +1,2 @@\n console.log(`models ${Object.keys(require('@prisma/client').Prisma.ModelName)}`);\n+// patched\n",
      image: process.env.REFIT_DOCKER_IMAGE!,
      command: ['npm', 'test'],
      prepareDependencies: true,
    });

    if (!('baseline' in result)) throw new Error('Checks did not run.');
    console.log(JSON.stringify({ baseline: result.baseline, patched: result.patched }, null, 2));
    expect(result.status).toBe('passed');
    for (const check of [result.baseline, result.patched]) {
      expect(check.stdout).toContain('models Payment');
      expect(check.generators).toEqual([
        expect.objectContaining({
          name: 'prisma generate',
          command: ['prisma', 'generate'],
          exitCode: 0,
        }),
      ]);
      expect(check.stderr).not.toContain('REFIT_GENERATOR_EXIT');
    }
  },
  600_000,
);
