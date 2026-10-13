import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gitEnvironment } from './git-environment.ts';
import { PipelineInputError } from './types.ts';

const execute = promisify(execFile);
const PROCESS_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT_BYTES = 50 * 1024 * 1024;

export async function readCommittedFile(
  snapshot: Awaited<ReturnType<typeof readCommittedRepository>>,
  path: string,
  maximumBytes: number,
) {
  if (!snapshot.entries.some((entry) => entry.slice(entry.indexOf('\t') + 1) === path))
    throw new PipelineInputError(
      `Repository profile input is not a committed regular file: ${path}`,
    );
  const object = `${snapshot.revision}:${path}`;
  const bytes = Number((await snapshot.git(['cat-file', '-s', object])).stdout.trim());
  const limit = Math.min(maximumBytes, MAX_GIT_OUTPUT_BYTES);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit)
    throw new PipelineInputError(`Committed input ${path} exceeds its ${limit}-byte read limit.`);
  const content = (await snapshot.git(['show', object])).stdout;
  if (Buffer.byteLength(content) !== bytes)
    throw new PipelineInputError(`Committed input ${path} is not supported UTF-8 text.`);
  return content;
}

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
