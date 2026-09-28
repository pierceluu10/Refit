import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runPipeline } from './run.ts';
import { digest } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { readRepository } from './repository.ts';
import { validateCheckCommand, validateRepairAttempts } from './validation-options.ts';
import { proposeAiPatch } from './ai-patches.ts';

export interface PublicationFile {
  path: string;
  mode: '100644' | '100755';
  content: string;
}

const execute = promisify(execFile);
const PROCESS_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_USER = '65534:65534';
const WORKSPACE_TMPFS = '/workspace:rw,exec,size=512m,uid=65534,gid=65534,mode=0700';
const MAX_REPAIR_LOG_CHARACTERS = 4096;

export interface ValidationAttempt {
  number: number;
  patchHash: string;
  diff: string;
  check: CheckResult;
  responseId: string | null;
  evidenceHash: string | null;
}

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
  baselineCommand?: string[];
  assessment?: { apiKey: string; model: string };
  aiPatch?: { apiKey: string; model: string };
  providerConfig?: string;
  repairAttempts?: number;
}) {
  validateCheckCommand(options.command);
  const baselineCommand = validateCheckCommand(options.baselineCommand ?? options.command);
  const repairLimit = validateRepairAttempts(options.repairAttempts ?? 0, Boolean(options.aiPatch));
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
  const entries = (await git(['ls-tree', '-rz', revision])).stdout.split('\0').filter(Boolean);
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
    await mkdir(baselineDirectory);
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
    await command('tar', ['-xf', archive, '-C', baselineDirectory]);
    const report = await runPipeline({
      ...options,
      repository: baselineDirectory,
      proposePatch: true,
    });
    if (!('diff' in report.patch) || !report.patch.diff)
      throw new PipelineInputError(
        'No supported patch proposal is available for this committed revision.',
      );
    let proposal = report.patch;
    const originalSources = await readRepository(baselineDirectory, report.adapter.packageName);
    const prepareCandidate = async (diff: string) => {
      // Reusing a removed bind-mount path can expose a stale directory in Docker Desktop.
      const patchedDirectory = await mkdtemp(join(root, 'candidate-'));
      await command('tar', ['-xf', archive, '-C', patchedDirectory]);
      const patch = join(root, 'migration.patch');
      await writeFile(patch, diff);
      await command('git', ['apply', '--check', patch], patchedDirectory);
      await command('git', ['apply', patch], patchedDirectory);
      const patchedSources = await readRepository(patchedDirectory, report.adapter.packageName);
      const publicationFiles: PublicationFile[] = [];
      for (const file of patchedSources.files) {
        const original = originalSources.files.find((source) => source.path === file.path);
        if (!original || original.content === file.content) continue;
        const entry = entries.find((entry) => entry.slice(entry.indexOf('\t') + 1) === file.path);
        const metadata = entry?.slice(0, entry.indexOf('\t')).split(' ');
        const originalBlob = createHash('sha1')
          .update(`blob ${Buffer.byteLength(original.content)}\0`)
          .update(original.content)
          .digest('hex');
        if (!metadata || metadata[2] !== originalBlob)
          throw new PipelineInputError('Archived source does not match the committed Git blob.');
        publicationFiles.push({
          path: file.path,
          mode: metadata[0] as PublicationFile['mode'],
          content: file.content,
        });
      }
      return { publicationFiles, directory: patchedDirectory };
    };
    const initialCandidate = await prepareCandidate(proposal.diff);
    let publicationFiles = initialCandidate.publicationFiles;
    const baseline = await containerCheck(baselineDirectory, image, baselineCommand);
    let patched = await containerCheck(initialCandidate.directory, image, options.command);
    const attempts: ValidationAttempt[] = [];
    const recordAttempt = () =>
      attempts.push({
        number: attempts.length + 1,
        patchHash: digest(proposal.diff),
        diff: proposal.diff,
        check: patched,
        responseId: 'responseId' in proposal ? proposal.responseId : null,
        evidenceHash: 'evidenceHash' in proposal ? proposal.evidenceHash : null,
      });
    recordAttempt();
    const repair: { limit: number; requested: number; stopReason: string; error: string | null } = {
      limit: repairLimit,
      requested: 0,
      stopReason: 'not-needed-or-disabled',
      error: null,
    };
    while (
      baseline.status === 'passed' &&
      patched.status === 'failed' &&
      repair.requested < repairLimit &&
      options.aiPatch
    ) {
      const latestRevision = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
      if (
        latestRevision !== revision ||
        (await git(['status', '--porcelain', '--untracked-files=all'])).stdout
      ) {
        repair.stopReason = 'stale-repository';
        break;
      }
      repair.requested++;
      try {
        const candidate = await proposeAiPatch(
          originalSources,
          report.changes,
          report.findings,
          options.aiPatch,
          report.adapter,
          {
            attempt: repair.requested,
            failedPatch: proposal.diff,
            check: {
              exitCode: patched.exitCode,
              stdout: patched.stdout.slice(0, MAX_REPAIR_LOG_CHARACTERS),
              stderr: patched.stderr.slice(0, MAX_REPAIR_LOG_CHARACTERS),
              truncated:
                patched.stdout.length > MAX_REPAIR_LOG_CHARACTERS ||
                patched.stderr.length > MAX_REPAIR_LOG_CHARACTERS,
            },
          },
        );
        if (!candidate.diff) {
          repair.stopReason = 'no-proposal';
          break;
        }
        if (attempts.some((attempt) => attempt.patchHash === digest(candidate.diff))) {
          repair.stopReason = 'repeated-proposal';
          break;
        }
        const preparedCandidate = await prepareCandidate(candidate.diff);
        const check = await containerCheck(preparedCandidate.directory, image, options.command);
        proposal = candidate;
        publicationFiles = preparedCandidate.publicationFiles;
        patched = check;
        recordAttempt();
        repair.stopReason =
          patched.status === 'passed'
            ? 'checks-passed'
            : patched.status === 'error'
              ? 'execution-error'
              : 'attempt-limit';
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        repair.stopReason = 'repair-error';
        repair.error = `${error.name}: ${error.message}`;
        break;
      }
    }
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
      baselineCommand,
      archiveHash: digest(archiveResult.stdout),
      patchHash: digest(proposal.diff),
      baseline,
      patched,
      attempts,
      repair,
      limits: { timeoutMs: CHECK_TIMEOUT_MS, outputBytes: MAX_OUTPUT_BYTES, network: 'none' },
      publishable: false,
      reason:
        'Validation records check results only. Draft publication requires an explicit GitHub target and passing checks; migration semantics require human review.',
    };
    return {
      ...report,
      patch: { ...proposal, validation: validationStatus },
      validation,
      publicationFiles,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
