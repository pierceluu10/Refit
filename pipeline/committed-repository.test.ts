import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { readCommittedRepository } from './committed-repository.ts';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Commits files plus gitlinks staged straight into the index, as a clone without submodules
// leaves them: an empty directory at each gitlink path.
async function repositoryWithGitlinks(files: Record<string, string>, gitlinks: string[]) {
  const repository = await mkdtemp(join(tmpdir(), 'refit-gitlink-'));
  roots.push(repository);
  await execute('git', ['init', '-q', repository]);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(repository, path, '..'), { recursive: true });
    await writeFile(join(repository, path), content);
  }
  await execute('git', ['-C', repository, 'add', '.']);
  for (const path of gitlinks) {
    await execute('git', [
      '-C',
      repository,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${'c'.repeat(40)},${path}`,
    ]);
    await mkdir(join(repository, path), { recursive: true });
  }
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
    '-qm',
    'test: gitlinks',
  ]);
  return repository;
}

it.each([
  // kaorii-ako/Shiori-v1 at ccf7f3b and bichsonnhat/cognito at 57f5008 commit one gitlink each
  // and no .gitmodules, so no clone can fetch them.
  ['kaorii-ako/Shiori-v1', '~/.claude/skills/gstack'],
  ['bichsonnhat/cognito', 'server/facefusion'],
])(
  'reads %s, whose gitlink %s no .gitmodules declares, as the empty directory every clone has',
  async (_repository, gitlink) => {
    const repository = await repositoryWithGitlinks(
      { 'package.json': '{"name":"app"}', 'server/index.js': '' },
      [gitlink],
    );
    const snapshot = await readCommittedRepository(repository);
    expect(snapshot.entries).toContain(`160000 commit ${'c'.repeat(40)}\t${gitlink}`);
  },
);

it('still refuses a gitlink .gitmodules declares, and reads one whose declared path differs', async () => {
  // RescuePC/Donation-Link at 960411c commits the gitlink Donation-Link-Clean without .gitmodules;
  // declaring it makes it a submodule whose files the commit does not hold.
  const declared = await repositoryWithGitlinks(
    {
      'package.json': '{"name":"app"}',
      '.gitmodules':
        '[submodule "clean"]\n\tpath = Donation-Link-Clean\n\turl = https://example.invalid/clean.git\n',
    },
    ['Donation-Link-Clean'],
  );
  await expect(readCommittedRepository(declared)).rejects.toThrow(
    'Validation does not accept submodules; Donation-Link-Clean is one. Refit checks committed files only, so commit its files to the repository or remove the submodule.',
  );
  const elsewhere = await repositoryWithGitlinks(
    {
      'package.json': '{"name":"app"}',
      '.gitmodules':
        '[submodule "clean"]\n\tpath = vendor/clean\n\turl = https://example.invalid/clean.git\n',
    },
    ['Donation-Link-Clean'],
  );
  expect((await readCommittedRepository(elsewhere)).revision).toMatch(/^[0-9a-f]{40}$/);
});
