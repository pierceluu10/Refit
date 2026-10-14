import { migrationReviewReason } from './migration-review.ts';
import type { AiOptions, AiUsage } from './ai-budget.ts';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runPipeline } from './run.ts';
import {
  apiVersionSourceBlocked,
  compareApiVersion,
  validateApiVersion,
  type ApiVersionPolicy,
} from './api-version.ts';
import { digest, readSpecification } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { readRepository } from './repository.ts';
import { validateCheckCommand, validateRepairAttempts } from './validation-options.ts';
import { proposeAiPatch } from './ai-patches.ts';
import { gitEnvironment } from './git-environment.ts';
import { readCommittedRepository } from './committed-repository.ts';
import { MAX_DEPENDENCY_ARCHIVE_BYTES, prepareNpmDependencies } from './npm-dependencies.ts';
import { inspectArtifactFile } from './verification.ts';
import { analyzeRepository } from './analyzer.ts';
import {
  dockerSandboxArguments,
  removeDockerContainer,
  resolveDockerImage,
} from './docker-sandbox.ts';

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
const MAX_REPAIR_LOG_CHARACTERS = 4096;

export interface ValidationAttempt {
  number: number;
  patchHash: string;
  diff: string;
  check: CheckResult;
  responseId: string | null;
  evidenceHash: string | null;
  usage: AiUsage | null;
  costUsd: number | null;
}

export interface CheckResult {
  status: 'passed' | 'failed' | 'error' | 'not-run';
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
    env: binary === 'git' ? gitEnvironment() : undefined,
  });
}

async function containerCheck(
  directory: string,
  image: string,
  argumentsList: string[],
  dependencies?: string,
): Promise<CheckResult> {
  const name = `refit-${randomUUID()}`;
  try {
    const result = await execute(
      'docker',
      dockerSandboxArguments({
        name,
        directory,
        image,
        command: argumentsList,
        network: 'none',
        dependencies,
      }),
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
    await removeDockerContainer(name);
  }
}

export async function validateMigration(options: {
  repository: string;
  before: string;
  after: string;
  image: string;
  command: string[];
  baselineCommand?: string[];
  prepareDependencies?: boolean;
  assessment?: AiOptions;
  aiPatch?: AiOptions;
  documentationSnapshots?: readonly string[];
  providerConfig?: string;
  apiVersion?: string;
  apiVersionPolicy?: ApiVersionPolicy;
  requireApiVersionMatch?: boolean;
  fullDiff?: boolean;
  repairAttempts?: number;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}) {
  validateCheckCommand(options.command);
  const baselineCommand = validateCheckCommand(options.baselineCommand ?? options.command);
  const repairLimit = validateRepairAttempts(options.repairAttempts ?? 0, Boolean(options.aiPatch));
  if (options.requireApiVersionMatch) {
    const [before, after] = await Promise.all([
      readSpecification(options.before),
      readSpecification(options.after),
    ]);
    const applicability = compareApiVersion(
      validateApiVersion(options.apiVersion),
      before.document,
      after.document,
    );
    if (applicability.applicability !== 'matches-before')
      throw new PipelineInputError(`Automated publication is blocked. ${applicability.reason}`);
  }
  const snapshot = await readCommittedRepository(options.repository);
  const repository = snapshot.directory;
  const preflight = await runPipeline({
    ...options,
    repository,
    proposePatch: false,
    fullDiff: false,
    aiPatch: undefined,
    assessment: undefined,
  });
  if (apiVersionSourceBlocked(preflight.apiVersion))
    throw new PipelineInputError(`Validation is blocked. ${preflight.apiVersion.reason}`);
  const reviewReason = migrationReviewReason(preflight, true);
  if (reviewReason) throw new PipelineInputError(reviewReason);
  const git = (args: string[]) =>
    command('git', ['-c', 'core.fsmonitor=false', '-C', repository, ...args]);
  const { revision, entries } = snapshot;
  const image = await resolveDockerImage(options.image);
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
        env: gitEnvironment(),
      },
    );
    await writeFile(archive, archiveResult.stdout);
    await command('tar', ['-xf', archive, '-C', baselineDirectory]);
    let dependencies: string | undefined;
    let environment: Record<string, unknown> | undefined;
    if (options.prepareDependencies) {
      const prepared = await prepareNpmDependencies({
        repository,
        image,
        signal: options.signal,
        onProgress: options.onProgress,
      });
      dependencies = join(root, 'dependencies.tar');
      await copyFile(prepared.archive, dependencies);
      const copied = await inspectArtifactFile(dependencies, MAX_DEPENDENCY_ARCHIVE_BYTES);
      if (
        copied.sha256 !== prepared.environment.archiveHash ||
        copied.bytes !== prepared.environment.archiveBytes
      )
        throw new PipelineInputError(
          'Prepared dependencies changed while creating the validation snapshot.',
        );
      environment = { ...prepared.environment, reused: prepared.reused };
    }
    options.signal?.throwIfAborted();
    options.onProgress?.('Running baseline checks in offline Docker...');
    const baseline = await containerCheck(baselineDirectory, image, baselineCommand, dependencies);
    options.signal?.throwIfAborted();
    const report = await runPipeline({
      ...options,
      repository: baselineDirectory,
      proposePatch: true,
      aiPatch: baseline.status === 'passed' ? options.aiPatch : undefined,
      assessment: baseline.status === 'passed' ? options.assessment : undefined,
      onProgress: baseline.status === 'passed' ? options.onProgress : undefined,
    });
    const configuredEndpointProposal = report.operationChanges.some(
      (change) => change.usages.length > 0,
    );
    const configuredRequestProposal = report.requestChanges?.some(
      (change) => change.usages.length > 0,
    );
    const [beforeSpecification, afterSpecification] = await Promise.all([
      readSpecification(options.before),
      readSpecification(options.after),
    ]);
    if (beforeSpecification.hash !== report.snapshots.before)
      throw new PipelineInputError('Baseline specification changed during validation.');
    if (afterSpecification.hash !== report.snapshots.after)
      throw new PipelineInputError('Current specification changed during validation.');
    if (!('diff' in report.patch) || (!report.patch.diff && baseline.status === 'passed'))
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
      const candidateVersion = compareApiVersion(
        report.apiVersion.application ?? undefined,
        { info: { version: report.apiVersion.before } },
        { info: { version: report.apiVersion.after } },
        {
          configured: Boolean(report.adapter.apiVersion),
          declarations: analyzeRepository(patchedSources, [], report.adapter)
            .apiVersionDeclarations,
        },
        report.apiVersion.policy,
      );
      if (
        apiVersionSourceBlocked(candidateVersion) ||
        (report.apiVersion.source.status === 'verified' &&
          candidateVersion.source.status !== 'verified')
      )
        throw new PipelineInputError(
          'Migration proposal changes or weakens the verified SDK API-version declarations; inspect the version rollout separately.',
        );
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
    const initialCandidate =
      baseline.status === 'passed' ? await prepareCandidate(proposal.diff) : undefined;
    let publicationFiles = initialCandidate?.publicationFiles ?? [];
    if (initialCandidate) options.onProgress?.('Running patched checks in offline Docker...');
    let patched: CheckResult = initialCandidate
      ? await containerCheck(initialCandidate.directory, image, options.command, dependencies)
      : { status: 'not-run', exitCode: null, stdout: '', stderr: '' };
    const attempts: ValidationAttempt[] = [];
    const recordAttempt = () =>
      attempts.push({
        number: attempts.length + 1,
        patchHash: digest(proposal.diff),
        diff: proposal.diff,
        check: patched,
        responseId: 'responseId' in proposal ? proposal.responseId : null,
        evidenceHash: 'evidenceHash' in proposal ? proposal.evidenceHash : null,
        usage: 'usage' in proposal ? proposal.usage : null,
        costUsd: 'budget' in proposal ? (proposal.budget?.costUsd ?? null) : null,
      });
    if (initialCandidate) recordAttempt();
    const repair: { limit: number; requested: number; stopReason: string; error: string | null } = {
      limit: repairLimit,
      requested: 0,
      stopReason:
        baseline.status === 'passed'
          ? configuredEndpointProposal
            ? 'configured-endpoint-replacement'
            : configuredRequestProposal
              ? 'configured-request-rename'
              : 'not-needed-or-disabled'
          : 'baseline-failed',
      error: null,
    };
    while (
      baseline.status === 'passed' &&
      patched.status === 'failed' &&
      repair.requested < repairLimit &&
      options.aiPatch &&
      !configuredEndpointProposal &&
      !configuredRequestProposal &&
      !report.findings.some((finding) => finding.webhook?.migration)
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
      options.onProgress?.(
        `Patched checks failed. Requesting AI repair ${repair.requested} of ${repairLimit}...`,
      );
      try {
        options.signal?.throwIfAborted();
        const candidate = await proposeAiPatch(
          originalSources,
          report.changes,
          report.findings,
          options.aiPatch,
          report.adapter,
          beforeSpecification.schemas,
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
          options.documentationSnapshots,
          afterSpecification.schemas,
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
        options.onProgress?.('Running repaired checks in offline Docker...');
        const check = await containerCheck(
          preparedCandidate.directory,
          image,
          options.command,
          dependencies,
        );
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
      ...(environment ? { environment } : {}),
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
