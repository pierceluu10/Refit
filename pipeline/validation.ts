import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runPipeline } from './run.ts';
import { digest } from './specifications.ts';
import { PipelineInputError } from './types.ts';

const execute = promisify(execFile);
const PROCESS_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_USER = '65534:65534';
const WORKSPACE_TMPFS = '/workspace:rw,exec,size=512m,uid=65534,gid=65534,mode=0700';

export interface CheckResult {
  status: 'passed' | 'failed' | 'error';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

async function command(binary: string, args: string[], cwd?: string) {
  return execute(binary, args, {
    cwd,
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: MAX_ARCHIVE_BYTES,
    encoding: 'utf8',
  });
}

async function containerCheck(
  directory: string,
  image: string,
  argumentsList: string[],
): Promise<CheckResult> {
  const name = `refit-${randomUUID()}`;
  try {
    const result = await execute(
      'docker',
      [
        'run',
        '--name',
        name,
        '--pull',
        'never',
        '--network',
        'none',
        '--read-only',
        '--user',
        CONTAINER_USER,
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '128',
        '--memory',
        '1g',
        '--cpus',
        '1',
        '--tmpfs',
        WORKSPACE_TMPFS,
        '--tmpfs',
        '/tmp:rw,noexec,size=64m,mode=1777',
        '--mount',
        `type=bind,src=${directory},dst=/input,readonly`,
        '--workdir',
        '/workspace',
        '--entrypoint',
        '/bin/sh',
        image,
        '-c',
        'cp -R /input/. /workspace/ && exec "$@"',
        'refit-check',
        ...argumentsList,
      ],
      { timeout: CHECK_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
    );
    return { status: 'passed', exitCode: 0, ...result };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const failure = error as Error & {
      code?: number | string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
    };
    const exitCode = typeof failure.code === 'number' ? failure.code : null;
    return {
      status: exitCode !== null && !failure.killed && exitCode < 125 ? 'failed' : 'error',
      exitCode,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      error: failure.message,
    };
  } finally {
    // A killed Docker client does not necessarily stop the container it started.
    try {
      await command('docker', ['rm', '--force', name]);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('stderr' in error) ||
        typeof error.stderr !== 'string' ||
        !error.stderr.includes('No such container')
      )
        throw error;
    }
  }
}

export async function validateMigration(options: {
  repository: string;
  before: string;
  after: string;
  image: string;
  command: string[];
  assessment?: { apiKey: string; model: string };
  aiPatch?: { apiKey: string; model: string };
}) {
  if (
    !options.command.length ||
    options.command.some((part) => typeof part !== 'string' || !part || part.includes('\0'))
  )
    throw new PipelineInputError(
      'Validation command must be a nonempty JSON array of nonempty strings.',
    );
  if (!options.image || options.image.startsWith('-'))
    throw new PipelineInputError('A local Docker image is required.');
  const repository = await realpath(options.repository);
  const git = (args: string[]) =>
    command('git', ['-c', 'core.fsmonitor=false', '-C', repository, ...args]);
  const topLevel = await realpath((await git(['rev-parse', '--show-toplevel'])).stdout.trim());
  if (repository !== topLevel)
    throw new PipelineInputError('Validation requires the Git repository root directory.');
  const revision = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
  const status = (await git(['status', '--porcelain', '--untracked-files=all'])).stdout;
  if (status)
    throw new PipelineInputError(
      'Validation requires a clean committed repository, including untracked files.',
    );
  const entries = (await git(['ls-tree', '-r', revision])).stdout.split('\n').filter(Boolean);
  if (entries.some((entry) => !/^(100644|100755) blob /.test(entry)))
    throw new PipelineInputError(
      'Validation does not accept tracked symbolic links or submodules.',
    );
  const image = (
    await command('docker', ['image', 'inspect', '--format', '{{.Id}}', options.image])
  ).stdout.trim();
  if (!IMAGE_ID.test(image))
    throw new PipelineInputError('Docker did not resolve a unique immutable image ID.');
  const root = await mkdtemp(join(tmpdir(), 'refit-validation-'));
  try {
    const baselineDirectory = join(root, 'baseline');
    const patchedDirectory = join(root, 'patched');
    await mkdir(baselineDirectory);
    await mkdir(patchedDirectory);
    const archive = join(root, 'source.tar');
    const archiveResult = await execute(
      'git',
      ['-C', repository, 'archive', '--format=tar', revision],
      {
        encoding: 'buffer',
        timeout: PROCESS_TIMEOUT_MS,
        maxBuffer: MAX_ARCHIVE_BYTES,
      },
    );
    await writeFile(archive, archiveResult.stdout);
    for (const directory of [baselineDirectory, patchedDirectory])
      await command('tar', ['-xf', archive, '-C', directory]);
    const report = await runPipeline({
      ...options,
      repository: baselineDirectory,
      proposePatch: true,
    });
    if (!('diff' in report.patch) || !report.patch.diff)
      throw new PipelineInputError(
        'No supported patch proposal is available for this committed revision.',
      );
    const patch = join(root, 'migration.patch');
    await writeFile(patch, report.patch.diff);
    await command('git', ['apply', '--check', patch], patchedDirectory);
    await command('git', ['apply', patch], patchedDirectory);
    const baseline = await containerCheck(baselineDirectory, image, options.command);
    const patched = await containerCheck(patchedDirectory, image, options.command);
    const currentRevision = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
    const currentStatus = (await git(['status', '--porcelain', '--untracked-files=all'])).stdout;
    const validationStatus =
      currentRevision !== revision || currentStatus
        ? 'stale'
        : baseline.status === 'error' || patched.status === 'error'
          ? 'error'
          : baseline.status !== 'passed'
            ? 'baseline-failed'
            : patched.status !== 'passed'
              ? 'regression'
              : 'passed';
    const validation = {
      status: validationStatus,
      revision,
      image,
      command: options.command,
      archiveHash: digest(archiveResult.stdout),
      patchHash: digest(report.patch.diff),
      baseline,
      patched,
      limits: { timeoutMs: CHECK_TIMEOUT_MS, outputBytes: MAX_OUTPUT_BYTES, network: 'none' },
      publishable: false,
      reason:
        'Validation records check results only. Migration semantics and unresolved findings require review; publication is not implemented.',
    };
    return { ...report, patch: { ...report.patch, validation: validationStatus }, validation };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
