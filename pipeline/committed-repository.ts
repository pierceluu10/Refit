import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gitEnvironment } from './git-environment.ts';
import { PipelineInputError } from './types.ts';

const execute = promisify(execFile);
const PROCESS_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT_BYTES = 50 * 1024 * 1024;

export async function readCommittedRepository(path: string) {
  const directory = await realpath(path);
  const git = (argumentsList: string[]) =>
    execute('git', ['-c', 'core.fsmonitor=false', '-C', directory, ...argumentsList], {
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      env: gitEnvironment(),
    });
  const topLevel = await realpath((await git(['rev-parse', '--show-toplevel'])).stdout.trim());
  if (directory !== topLevel)
    throw new PipelineInputError('Validation requires the Git repository root directory.');
  const revision = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
  if ((await git(['status', '--porcelain', '--untracked-files=all'])).stdout)
    throw new PipelineInputError(
      'Validation requires a clean committed repository, including untracked files.',
    );
  const entries = (await git(['ls-tree', '-rz', revision])).stdout.split('\0').filter(Boolean);
  if (entries.some((entry) => !/^(100644|100755) blob /.test(entry)))
    throw new PipelineInputError(
      'Validation does not accept tracked symbolic links or submodules.',
    );
  return { directory, revision, entries, git };
}
