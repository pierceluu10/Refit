import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

// package.json and the lockfile npm writes for one exact release of a dependency-free package.
async function lockedProject(version: string) {
  const root = await mkdtemp(join(tmpdir(), 'refit-source-patch-docker-'));
  roots.push(root);
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'app', private: true, dependencies: { 'is-number': version }, scripts: { test: 'node check.cjs' } }, null, 2)}\n`,
  );
  await execute('npm', ['install', '--package-lock-only', '--ignore-scripts'], { cwd: root });
  return root;
}

it.skipIf(!process.env.REFIT_DOCKER_IMAGE || !process.env.REFIT_NPM_PREPARE)(
  'checks a patch that moves a dependency against its patched lockfile',
  async () => {
    const repository = await lockedProject('6.0.0');
    await writeFile(
      join(repository, 'check.cjs'),
      "console.log(`is-number ${require('is-number/package.json').version}`);\n",
    );
    await writeFile(join(repository, 'index.js'), "module.exports = require('is-number');\n");
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
    // A tracked lockfile the repository's .gitignore also lists must reach the patched side.
    await writeFile(join(repository, '.gitignore'), 'package-lock.json\n');
    await git('init', '-q');
    await git('add', '--force', '.');
    await git('commit', '-q', '-m', 'test: seed');
    const upgraded = await lockedProject('7.0.0');
    for (const file of ['package.json', 'package-lock.json'])
      await writeFile(join(repository, file), await readFile(join(upgraded, file), 'utf8'));
    // Source patches always change code; the dependency moves with it.
    await writeFile(
      join(repository, 'index.js'),
      "module.exports = (value) => require('is-number')(value);\n",
    );
    const diff = (await git('diff')).stdout;
    await git('checkout', '--', '.');

    const result = await validateSourcePatch({
      repository,
      propose: async () => diff,
      image: process.env.REFIT_DOCKER_IMAGE!,
      command: ['npm', 'test'],
      prepareDependencies: true,
    });

    console.log(
      JSON.stringify(
        {
          status: result.status,
          ...('baseline' in result
            ? { baseline: result.baseline.stdout, patched: result.patched.stdout }
            : {}),
        },
        null,
        2,
      ),
    );
    expect(result.status).toBe('passed');
    if (!('baseline' in result)) throw new Error('Checks did not run.');
    expect(result.baseline.stdout).toContain('is-number 6.0.0');
    expect(result.patched.stdout).toContain('is-number 7.0.0');
    expect(result.candidateEnvironment).toBeDefined();
    expect(result.candidateEnvironment?.resolvedLockfile).toBeUndefined();
  },
  600_000,
);
