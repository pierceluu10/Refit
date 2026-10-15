import { migrationReviewReason } from './migration-review.ts';
import type { AiOptions, AiUsage } from './ai-budget.ts';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
import { MAX_DEPENDENCY_ARCHIVE_BYTES, prepareDependencies } from './dependency-preparation.ts';
import { inspectArtifactFile } from './verification.ts';
import { analyzeRepository } from './analyzer.ts';
import {
  extractStripeMock,
  generatedCommand,
  generatedEntryPoints,
  readMockDocument,
  writeHarness,
  type GeneratedChecks,
} from './generated-checks.ts';
import { codeDiff, PACKAGE_FILES, packageDiff } from './stripe-package-upgrade.ts';
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
  readOnlyMounts?: { source: string; target: string }[],
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
        readOnlyMounts,
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

// Runs the enclosing exported functions of confirmed findings against stripe-mock serving each
// side's pinned contract and fixtures, inside the same offline sandbox as configured checks.
async function generatedStripeChecks(options: {
  settings: GeneratedChecks;
  root: string;
  image: string;
  dependencies?: string;
  entryPoints: ReturnType<typeof generatedEntryPoints>;
  runs: { directory: string; contract: string; side: 'before' | 'after'; dependencies?: string }[];
  onProgress?: (message: string) => void;
}) {
  const { entries, uncovered } = options.entryPoints;
  const tools = await mkdtemp(join(options.root, 'generated-'));
  const mock = await extractStripeMock(options.settings.stripeMockImage, tools);
  const fixtures = {
    before: options.settings.beforeFixtures,
    after: options.settings.afterFixtures,
  };
  const hashes = {
    before: {
      contract: await readMockDocument(options.runs[0].contract, 'before contract'),
      fixtures: await readMockDocument(fixtures.before, 'before fixtures file'),
    },
    after: {
      contract: await readMockDocument(options.runs[1].contract, 'after contract'),
      fixtures: await readMockDocument(fixtures.after, 'after fixtures file'),
    },
  };
  await writeHarness(tools, entries);
  const notRun: CheckResult = { status: 'not-run', exitCode: null, stdout: '', stderr: '' };
  const results: CheckResult[] = [];
  for (const run of options.runs) {
    if (!entries.length) {
      results.push(notRun);
      continue;
    }
    options.onProgress?.(
      `Running generated Stripe checks against ${run.side}-version stripe-mock in offline Docker...`,
    );
    results.push(
      await containerCheck(
        run.directory,
        options.image,
        generatedCommand(entries),
        run.dependencies ?? options.dependencies,
        [
          { source: mock.binary, target: '/refit/stripe-mock' },
          { source: run.contract, target: '/refit/spec.json' },
          { source: fixtures[run.side], target: '/refit/fixtures.json' },
          { source: tools, target: '/refit/generated' },
        ],
      ),
    );
  }
  return {
    engine: 'stripe-mock',
    image: mock.imageId,
    binaryHash: mock.binaryHash,
    inputs: hashes,
    entryPoints: entries,
    uncoveredFindings: uncovered,
    baseline: results[0],
    patched: results[1],
    claim:
      "Exported functions enclosing confirmed findings ran against stripe-mock serving each side's contract and fixtures. Placeholder fixtures check response shapes, not business data or application tests.",
  };
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
  generatedChecks?: GeneratedChecks;
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
  const reviewReason = migrationReviewReason(preflight, true, true);
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
      const prepared = await prepareDependencies({
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
      // An SDK upgrade in the patch needs dependencies prepared from the patched lockfile, which
      // preparation reads from a committed snapshot.
      let candidateDependencies = dependencies;
      let candidateEnvironment: Record<string, unknown> | undefined;
      if (packageDiff(diff) && options.prepareDependencies) {
        await command('git', ['init', '-q'], patchedDirectory);
        await command('git', ['add', '-A'], patchedDirectory);
        await command(
          'git',
          [
            '-c',
            'user.name=Refit',
            '-c',
            'user.email=refit@localhost',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '-q',
            '-m',
            'Refit migration candidate',
          ],
          patchedDirectory,
        );
        const prepared = await prepareDependencies({
          repository: patchedDirectory,
          image,
          signal: options.signal,
          onProgress: options.onProgress,
        });
        await rm(join(patchedDirectory, '.git'), { recursive: true, force: true });
        candidateEnvironment = { ...prepared.environment, reused: prepared.reused };
        candidateDependencies = join(root, `${basename(patchedDirectory)}-dependencies.tar`);
        await copyFile(prepared.archive, candidateDependencies);
        const copied = await inspectArtifactFile(
          candidateDependencies,
          MAX_DEPENDENCY_ARCHIVE_BYTES,
        );
        if (
          copied.sha256 !== prepared.environment.archiveHash ||
          copied.bytes !== prepared.environment.archiveBytes
        )
          throw new PipelineInputError(
            'Prepared dependencies changed while creating the validation snapshot.',
          );
      }
      const patchedSources = await readRepository(patchedDirectory, report.adapter.packageName);
      const declarations = analyzeRepository(
        patchedSources,
        [],
        report.adapter,
      ).apiVersionDeclarations;
      // Moving every literal pin to the target version is part of the migration, so the patched
      // code is checked against that version instead of the original one.
      const literals = declarations.filter((declaration) => declaration.status === 'literal');
      const bumped =
        report.apiVersion.after !== null &&
        literals.length > 0 &&
        literals.every((declaration) => declaration.value === report.apiVersion.after);
      const candidateVersion = compareApiVersion(
        (bumped ? report.apiVersion.after : report.apiVersion.application) ?? undefined,
        { info: { version: report.apiVersion.before } },
        { info: { version: report.apiVersion.after } },
        { configured: Boolean(report.adapter.apiVersion), declarations },
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
      const packageFiles = await Promise.all(
        PACKAGE_FILES.map(async (path) => ({
          path,
          before: await readFile(join(baselineDirectory, path), 'utf8').catch(() => undefined),
          after: await readFile(join(patchedDirectory, path), 'utf8').catch(() => undefined),
        })),
      );
      for (const file of [
        ...patchedSources.files,
        ...packageFiles
          .filter((file) => file.before !== undefined && file.after !== undefined)
          .map((file) => ({ path: file.path, content: file.after! })),
      ]) {
        const original =
          originalSources.files.find((source) => source.path === file.path) ??
          packageFiles
            .filter((source) => source.path === file.path && source.before !== undefined)
            .map((source) => ({ path: source.path, content: source.before! }))[0];
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
      return {
        publicationFiles,
        directory: patchedDirectory,
        dependencies: candidateDependencies,
        environment: candidateEnvironment,
      };
    };
    const initialCandidate =
      baseline.status === 'passed' ? await prepareCandidate(proposal.diff) : undefined;
    let publicationFiles = initialCandidate?.publicationFiles ?? [];
    let candidateDirectory = initialCandidate?.directory;
    let candidateDependencies = initialCandidate?.dependencies;
    let candidateEnvironment = initialCandidate?.environment;
    if (initialCandidate) options.onProgress?.('Running patched checks in offline Docker...');
    let patched: CheckResult = initialCandidate
      ? await containerCheck(
          initialCandidate.directory,
          image,
          options.command,
          initialCandidate.dependencies,
        )
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
            failedPatch: codeDiff(proposal.diff),
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
          'ruleEdits' in report.patch ? report.patch.ruleEdits : [],
        );
        // The SDK upgrade is deterministic; repairs change only code and keep it.
        if (candidate.diff) candidate.diff += packageDiff(report.patch.diff);
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
          preparedCandidate.dependencies,
        );
        candidateDependencies = preparedCandidate.dependencies;
        candidateEnvironment = preparedCandidate.environment;
        proposal = candidate;
        publicationFiles = preparedCandidate.publicationFiles;
        candidateDirectory = preparedCandidate.directory;
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
    const generated =
      options.generatedChecks &&
      candidateDirectory &&
      baseline.status === 'passed' &&
      patched.status === 'passed'
        ? await generatedStripeChecks({
            settings: options.generatedChecks,
            root,
            image,
            dependencies,
            entryPoints: generatedEntryPoints(originalSources, report.findings),
            runs: [
              { directory: baselineDirectory, contract: options.before, side: 'before' },
              {
                directory: candidateDirectory,
                contract: options.after,
                side: 'after',
                dependencies: candidateDependencies,
              },
            ],
            onProgress: options.onProgress,
          })
        : undefined;
    const currentRevision = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
    const currentStatus = (await git(['status', '--porcelain', '--untracked-files=all'])).stdout;
    const validationStatus =
      currentRevision !== revision || currentStatus
        ? 'stale'
        : [baseline, patched, generated?.baseline, generated?.patched].some(
              (check) => check?.status === 'error',
            )
          ? 'error'
          : baseline.status !== 'passed' || (generated && generated.baseline.status !== 'passed')
            ? 'baseline-failed'
            : patched.status !== 'passed' || (generated && generated.patched.status !== 'passed')
              ? 'regression'
              : 'passed';
    const validation = {
      status: validationStatus,
      revision,
      image,
      ...(environment ? { environment } : {}),
      ...(candidateEnvironment ? { patchedEnvironment: candidateEnvironment } : {}),
      command: options.command,
      baselineCommand,
      archiveHash: digest(archiveResult.stdout),
      patchHash: digest(proposal.diff),
      baseline,
      patched,
      ...(generated ? { generated } : {}),
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
