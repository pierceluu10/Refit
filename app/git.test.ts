import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitError, InvalidRepoError, cloneRepo, filesFromDiff } from './git.ts';

let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'aptitude-git-'));
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@localhost');
  writeFileSync(join(repo, 'billing.ts'), 'export const version = "2024-06-20";\n');
  writeFileSync(join(repo, 'legacy.ts'), 'export {};\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

// The same shape the harness's sandbox produces: `git add -N` then `git diff`.
function harnessDiff(): string {
  writeFileSync(join(repo, 'billing.ts'), 'export const version = "2026-10-01";\n');
  unlinkSync(join(repo, 'legacy.ts'));
  writeFileSync(join(repo, 'new file.ts'), 'export const added = true;\n');
  git('add', '-A', '-N');
  const diff = git('diff', '--no-color', '--no-ext-diff', 'HEAD');
  git('reset', '-q', '--hard');
  git('clean', '-q', '-f');
  return diff;
}

describe('filesFromDiff', () => {
  it('turns a harness diff into file changes without touching the checkout', async () => {
    const diff = harnessDiff();
    const changes = await filesFromDiff(repo, diff);
    expect(changes).toEqual([
      { path: 'billing.ts', content: 'export const version = "2026-10-01";\n' },
      { path: 'legacy.ts', delete: true },
      { path: 'new file.ts', content: 'export const added = true;\n' },
    ]);
    expect(readFileSync(join(repo, 'billing.ts'), 'utf8')).toContain('2024-06-20');
    expect(git('status', '--porcelain')).toBe('');
  });

  it("throws GitError when the diff doesn't apply", async () => {
    const diff = harnessDiff().replace('2024-06-20', '1999-01-01');
    await expect(filesFromDiff(repo, diff)).rejects.toThrow(GitError);
  });
});

describe('cloneRepo', () => {
  it.each(['no-slash', 'a/..', '../etc', 'a/b/c', 'a/b c', '--upload-pack=x/y'])(
    'refuses %s before running git',
    async (name) => {
      await expect(cloneRepo('token', name, repo)).rejects.toThrow(InvalidRepoError);
    },
  );
});
