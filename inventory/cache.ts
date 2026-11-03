// Inventory reports cached by repo commit, so a repo that has not changed costs $0 the next time.
// The key is the repo, its commit and the inventory version (prompt and scan): a new prompt or
// scan reads every repo again. Only a finished run is cached, and only for a clean checkout, since
// a commit says nothing about uncommitted edits.
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

export const INVENTORY_CACHE_ENV = 'APTITUDE_INVENTORY_CACHE';

export function defaultInventoryCache(env: NodeJS.ProcessEnv = process.env): string {
  return env[INVENTORY_CACHE_ENV] || path.join(tmpdir(), 'aptitude-inventory');
}

// Read-only git queries on the checkout's own metadata: nothing in the repo runs.
const SAFE_GIT = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];

/**
 * The commit a clean checkout is at, or undefined: not a git checkout of its own, git missing, or
 * uncommitted changes (tracked or untracked), which the commit does not describe.
 */
export async function cleanCommit(repoDir: string): Promise<string | undefined> {
  const git = (args: string[]) =>
    promisify(execFile)('git', [...SAFE_GIT, '-C', repoDir, ...args], { timeout: 15_000 });
  try {
    const { stdout } = await git(['rev-parse', '--show-toplevel', 'HEAD']);
    const [top, commit] = stdout.trim().split('\n');
    // git looks up the tree, so a folder inside another repo would give that repo's commit.
    if (top !== (await realpath(repoDir)) || !/^[0-9a-f]{40,64}$/.test(commit ?? '')) {
      return undefined;
    }
    const { stdout: status } = await git(['status', '--porcelain']);
    return status.trim() === '' ? commit : undefined;
  } catch {
    return undefined;
  }
}

export type CachedInventory<Report> = {
  version: string;
  repo: string;
  commit: string;
  cachedAt: string;
  report: Report;
};

function cachePath(dir: string, repo: string, commit: string): string {
  return path.join(dir, repo.replace(/[^\w.-]+/g, '__'), `${commit}.json`);
}

export async function readCachedInventory<Report>(
  dir: string,
  repo: string,
  commit: string,
  version: string,
): Promise<CachedInventory<Report> | undefined> {
  const text = await readFile(cachePath(dir, repo, commit), 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const cached = JSON.parse(text) as CachedInventory<Report>;
    return cached.version === version && cached.repo === repo && cached.commit === commit
      ? cached
      : undefined;
  } catch {
    return undefined; // a torn or foreign file is a miss; the next finished run replaces it
  }
}

export async function writeCachedInventory<Report>(
  dir: string,
  entry: CachedInventory<Report>,
): Promise<void> {
  const file = cachePath(dir, entry.repo, entry.commit);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(entry)}\n`);
  await rename(temporary, file);
}
