// Working copies for runs. Fetching a commit never runs repo code: no install, no hooks, no
// submodules. Running anything in the copy is the harness's job, inside its sandbox.
import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CheckoutRepo } from './types.ts';

const run = promisify(execFile);

const SAFE_GIT = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'protocol.file.allow=never',
  '-c',
  'submodule.recurse=false',
  '-c',
  'advice.detachedHead=false',
];

/** Shallow-fetches github.com/<repo> at the frozen commit into a temp directory. */
export function gitCheckout(baseUrl = 'https://github.com'): CheckoutRepo {
  return async (entry) => {
    const repoDir = mkdtempSync(join(tmpdir(), 'refit-eval-'));
    const cleanup = async () => rmSync(repoDir, { recursive: true, force: true });
    try {
      const git = (args: string[]) =>
        run('git', [...SAFE_GIT, '-C', repoDir, ...args], {
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' },
        });
      await git(['init', '--quiet']);
      await git(['fetch', '--quiet', '--depth', '1', `${baseUrl}/${entry.repo}.git`, entry.commit]);
      await git(['checkout', '--quiet', 'FETCH_HEAD']);
      return { repoDir, cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  };
}

/** Copies a local fixture directory (smoke tests). The source is never modified. */
export function fixtureCheckout(
  fixturesDir: string,
  dirFor: (repo: string) => string,
): CheckoutRepo {
  return async (entry) => {
    const repoDir = mkdtempSync(join(tmpdir(), 'refit-smoke-'));
    cpSync(join(fixturesDir, dirFor(entry.repo)), repoDir, { recursive: true });
    return { repoDir, cleanup: async () => rmSync(repoDir, { recursive: true, force: true }) };
  };
}
