import { migrationReviewReason, withoutRequestParameters } from './migration-review.ts';
import type { AiOptions, AiUsage } from './ai-budget.ts';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { runPipeline } from './run.ts';
import { SHOPIFY, shopifyVersionDeclarations } from './shopify-pipeline.ts';
import {
  apiVersionSourceBlocked,
  compareApiVersion,
  validateApiVersion,
  type ApiVersionPolicy,
} from './api-version.ts';
import { digest, readSpecification } from './specifications.ts';
import { PipelineInputError, type SourceEdit } from './types.ts';
import { readRepository } from './repository.ts';
import { validateCheckCommand, validateRepairAttempts } from './validation-options.ts';
import { proposeAiPatch, TYPE_ERROR_CHANGE } from './ai-patches.ts';
import { PAYMENT_METHOD_RENAME_RULES, removedRequestParameters } from './request-removals.ts';
import { gitEnvironment } from './git-environment.ts';
import { readCommittedRepository } from './committed-repository.ts';
import { prepareDependencies, repositoryDependencyFailure } from './dependency-preparation.ts';
import { inspectArtifactFile } from './verification.ts';
import { analyzeRepository } from './analyzer.ts';
import {
  extractStripeMock,
  generatedCommand,
  compareGeneratedRuns,
  generatedEntryPoints,
  generatedImportMap,
  readMockDocument,
  typescriptDirectory,
  writeHarness,
  type GeneratedChecks,
} from './generated-checks.ts';
import { codeDiff, PACKAGE_FILES, packageDiff } from './stripe-package-upgrade.ts';
import { compactPatch, renderPatch } from './patches.ts';
import {
  crossesOpenEnums,
  OPEN_ENUM_REPAIR,
  OPEN_ENUM_RULE,
  openEnumRepair,
} from './stripe-open-enums.ts';
import { SUBSCRIPTION_PERIOD_RULE } from './stripe-subscription-periods.ts';
import {
  dockerSandboxArguments,
  removeDockerContainer,
  resolveDockerImage,
  validationProfile,
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

const TYPE_ERROR = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

// TypeScript diagnostics in a check's output, keyed without positions so moved lines still match.
export function typeErrors(check: CheckResult) {
  return `${check.stdout}\n${check.stderr}`
    .split('\n')
    .map((line) => TYPE_ERROR.exec(line.trim()))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => ({
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      code: match[4],
      message: match[5],
      key: `${match[1]} ${match[4]} ${match[5]}`,
    }));
}

// With compareTypeErrors, the original code's type errors are the baseline: a typecheck that
// reports errors still ran, and the patched check fails only on errors the patch introduced.
function introducedTypeErrors(baseline: CheckResult, patched: CheckResult) {
  const before = new Set(typeErrors(baseline).map((error) => error.key));
  return typeErrors(patched).filter((error) => !before.has(error.key));
}

// Literal comparisons the upgraded types reject, usually misspelled webhook event names that never
// matched, and the `never` narrowing they cause are application bugs to flag, not migration errors
// to fix (owner decision, 2026-10-16).
const REVIEW_TYPE_ERROR =
  /^Type '"[^"]*"' is not comparable to type|^This comparison appears to be unintentional because the types '"[^"]*"'|on type 'never'\.$/;

export function reviewTypeError(error: { message: string }) {
  return REVIEW_TYPE_ERROR.test(error.message);
}

const formatTypeError = (error: ReturnType<typeof typeErrors>[number]) =>
  `${error.file}(${error.line},${error.column}): error ${error.code}: ${error.message}`;

export function compareTypeCheck(baseline: CheckResult, patched?: CheckResult): CheckResult {
  const check = patched ?? baseline;
  const errors = typeErrors(check);
  if (check.status === 'error' || check.status === 'not-run') return check;
  if (check.exitCode !== 0 && !errors.length) return { ...check, status: 'failed' };
  if (!patched) return { ...check, status: 'passed' };
  const introduced = introducedTypeErrors(baseline, check);
  return introduced.length
    ? {
        ...check,
        status: 'failed',
        stdout: `Type errors this patch introduced:\n${introduced.map(formatTypeError).join('\n')}\n\n${check.stdout}`,
      }
    : { ...check, status: 'passed' };
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
  imports: ReturnType<typeof generatedImportMap>;
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
  await writeHarness(tools, entries, options.imports);
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
        generatedCommand(),
        run.dependencies ?? options.dependencies,
        [
          { source: mock.binary, target: '/refit/stripe-mock' },
          { source: run.contract, target: '/refit/spec.json' },
          { source: fixtures[run.side], target: '/refit/fixtures.json' },
          { source: tools, target: '/refit/generated' },
          { source: typescriptDirectory(), target: '/refit/typescript' },
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
    ...compareGeneratedRuns(entries, results[0], results[1]),
    claim:
      "Exported functions enclosing confirmed findings ran against stripe-mock serving each side's contract and fixtures. Placeholder fixtures check response shapes, not business data or application tests.",
  };
}

const mentions = (files: { content: string }[], name: string) =>
  files.reduce(
    (count, file) => count + (file.content.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0),
    0,
  );

// Removed request parameters a repair mentions fewer times than the original code does, less the
// sites the approved card rule (and an opted-in listed rename) already renamed.
export function droppedRequestParameters(
  names: string[],
  original: { content: string }[],
  candidate: { content: string }[],
  ruleEdits: SourceEdit[],
) {
  const renamed = ruleEdits.filter((edit) =>
    PAYMENT_METHOD_RENAME_RULES.has(edit.rule ?? ''),
  ).length;
  return names.filter(
    (name) =>
      mentions(candidate, name) <
      mentions(original, name) - (name === 'payment_method_types' ? renamed : 0),
  );
}

export async function validateMigration(options: {
  repository: string;
  before: string;
  after: string;
  image: string;
  command: string[];
  baselineCommand?: string[];
  prepareDependencies?: boolean;
  compareTypeErrors?: boolean;
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
  // --publish-unresolved: see withoutRequestParameters.
  leaveRequestParameters?: boolean;
  keepListedPaymentMethods?: boolean;
  // --publish-unresolved: a repository-side dependency preparation failure skips the checks and
  // returns the deterministic patch as `untested` instead of throwing.
  recordDependencyFailures?: boolean;
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
  const reviewReason = migrationReviewReason(
    options.leaveRequestParameters && !options.aiPatch
      ? withoutRequestParameters(preflight)
      : preflight,
    true,
    true,
    Boolean(options.aiPatch),
  );
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
    ).catch((error: unknown) => {
      if ((error as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
        throw new PipelineInputError(
          `Committed source exceeds the ${MAX_ARCHIVE_BYTES / 1024 / 1024} MiB validation archive limit.`,
        );
      throw error;
    });
    await writeFile(archive, archiveResult.stdout);
    await command('tar', ['-xf', archive, '-C', baselineDirectory]);
    let dependencies: string | undefined;
    let environment: Record<string, unknown> | undefined;
    let dependencyFailure: ReturnType<typeof repositoryDependencyFailure> = undefined;
    let prepared: Awaited<ReturnType<typeof prepareDependencies>> | undefined;
    if (options.prepareDependencies)
      try {
        prepared = await prepareDependencies({
          repository,
          image,
          signal: options.signal,
          onProgress: options.onProgress,
        });
      } catch (error) {
        dependencyFailure = options.recordDependencyFailures
          ? repositoryDependencyFailure(error)
          : undefined;
        if (!dependencyFailure) throw error;
        options.onProgress?.(`Dependency preparation failed: ${dependencyFailure.summary}`);
      }
    if (prepared) {
      dependencies = join(root, 'dependencies.tar');
      await copyFile(prepared.archive, dependencies);
      const copied = await inspectArtifactFile(dependencies, validationProfile().archiveBytes);
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
    if (!dependencyFailure) options.onProgress?.('Running baseline checks in offline Docker...');
    const baselineRun: CheckResult = dependencyFailure
      ? { status: 'not-run', exitCode: null, stdout: '', stderr: '' }
      : await containerCheck(baselineDirectory, image, baselineCommand, dependencies);
    const baseline = options.compareTypeErrors ? compareTypeCheck(baselineRun) : baselineRun;
    const compared = (check: CheckResult) =>
      options.compareTypeErrors ? compareTypeCheck(baselineRun, check) : check;
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
    if (
      !('diff' in report.patch) ||
      (!report.patch.diff && (baseline.status === 'passed' || dependencyFailure))
    )
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
      if (packageDiff(diff) && options.prepareDependencies && !dependencyFailure) {
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
          validationProfile().archiveBytes,
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
      const shopify = report.provider === SHOPIFY.id;
      const declarations = shopify
        ? shopifyVersionDeclarations(patchedSources)
        : analyzeRepository(patchedSources, [], report.adapter).apiVersionDeclarations;
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
        { configured: shopify || Boolean(report.adapter.apiVersion), declarations },
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
        // A file the patch creates (the generated period helper) has no committed original.
        if (!original && !entries.some((entry) => entry.endsWith(`\t${file.path}`))) {
          publicationFiles.push({ path: file.path, mode: '100644', content: file.content });
          continue;
        }
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
        sources: patchedSources,
        directory: patchedDirectory,
        dependencies: candidateDependencies,
        environment: candidateEnvironment,
      };
    };
    // An untested patch is still applied, so its publication files come from the same candidate.
    const initialCandidate =
      baseline.status === 'passed' || dependencyFailure
        ? await prepareCandidate(proposal.diff)
        : undefined;
    let publicationFiles = initialCandidate?.publicationFiles ?? [];
    let candidateDirectory = initialCandidate?.directory;
    let candidateSources = initialCandidate?.sources;
    // A deterministic proposal is the rules' output; AI repairs are guarded against it.
    const ruleSources =
      report.patch.generator === 'deterministic' ? initialCandidate?.sources.files : undefined;
    let candidateDependencies = initialCandidate?.dependencies;
    let candidateEnvironment = initialCandidate?.environment;
    const runPatched = initialCandidate && !dependencyFailure;
    if (runPatched) options.onProgress?.('Running patched checks in offline Docker...');
    let patched: CheckResult = runPatched
      ? compared(
          await containerCheck(
            initialCandidate.directory,
            image,
            options.command,
            initialCandidate.dependencies,
          ),
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
    const removedParameters = [
      ...new Set(
        removedRequestParameters(
          report.adapter,
          beforeSpecification.document,
          afterSpecification.document,
        ).map((removal) => removal.parameter),
      ),
    ];
    const repair: { limit: number; requested: number; stopReason: string; error: string | null } = {
      limit: repairLimit,
      requested: 0,
      stopReason: dependencyFailure
        ? 'dependencies-unavailable'
        : baseline.status === 'passed'
          ? configuredEndpointProposal
            ? 'configured-endpoint-replacement'
            : configuredRequestProposal
              ? 'configured-request-rename'
              : 'not-needed-or-disabled'
          : 'baseline-failed',
      error: null,
    };
    // stripe-node 22.4.0 widened open response enums with OtherString. Before any AI repair, a
    // deterministic repair restores their known literals where the upgraded types reject them; it
    // is kept only when every introduced error is that shape and the checks then pass.
    const sdkUpgrade =
      'sdkUpgrade' in report.patch
        ? (report.patch.sdkUpgrade as { from?: string; to?: string } | undefined)
        : undefined;
    const openEnumFiles =
      baseline.status === 'passed' &&
      patched.status === 'failed' &&
      options.compareTypeErrors &&
      candidateSources &&
      sdkUpgrade?.from &&
      sdkUpgrade.to &&
      crossesOpenEnums(sdkUpgrade.from, sdkUpgrade.to)
        ? openEnumRepair(candidateSources.files, introducedTypeErrors(baselineRun, patched))
        : undefined;
    if (openEnumFiles?.length && candidateSources) {
      const current = new Map(candidateSources.files.map((file) => [file.path, file.content]));
      const diff =
        proposal.diff +
        renderPatch(
          {
            ...candidateSources,
            files: openEnumFiles.map((file) => ({
              path: file.path,
              content: current.get(file.path)!,
            })),
          },
          openEnumFiles.map((file) => ({
            file: file.path,
            start: 0,
            end: current.get(file.path)!.length,
            replacement: file.content,
            changeId: OPEN_ENUM_RULE,
          })),
        );
      options.onProgress?.(
        'Restoring stripe-node open-enum literals; running checks in offline Docker...',
      );
      const prepared = await prepareCandidate(diff);
      const check = compared(
        await containerCheck(prepared.directory, image, options.command, prepared.dependencies),
      );
      if (check.status === 'passed') {
        proposal = { ...proposal, diff };
        publicationFiles = prepared.publicationFiles;
        candidateDirectory = prepared.directory;
        candidateSources = prepared.sources;
        candidateDependencies = prepared.dependencies;
        candidateEnvironment = prepared.environment;
        patched = check;
        recordAttempt();
        repair.stopReason = OPEN_ENUM_REPAIR;
      }
    }
    while (
      baseline.status === 'passed' &&
      patched.status === 'failed' &&
      repair.requested < repairLimit &&
      options.aiPatch &&
      !configuredEndpointProposal &&
      !configuredRequestProposal &&
      !report.findings.some(
        (finding) => finding.webhook?.migration?.rule === SUBSCRIPTION_PERIOD_RULE,
      )
    ) {
      const latestRevision = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
      if (
        latestRevision !== revision ||
        (await git(['status', '--porcelain', '--untracked-files=all'])).stdout
      ) {
        repair.stopReason = 'stale-repository';
        break;
      }
      const introduced = options.compareTypeErrors
        ? introducedTypeErrors(baselineRun, patched)
        : [];
      // Only review items remain: another round would have nothing it may fix.
      if (introduced.length && introduced.every(reviewTypeError)) {
        repair.stopReason = 'review-required';
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
          [
            ...report.findings,
            // Introduced type errors, at their positions in the failed candidate, become findings
            // the repair may fix, wherever they are.
            ...introduced
              .filter(
                (error) =>
                  !reviewTypeError(error) &&
                  candidateSources?.files.some((file) => file.path === error.file),
              )
              .map((error) => ({
                file: error.file,
                line: error.line,
                column: error.column,
                changeId: TYPE_ERROR_CHANGE,
                expression: error.code,
                confidence: 'confirmed' as const,
                reason: error.message,
              })),
          ],
          options.aiPatch,
          report.adapter,
          beforeSpecification.schemas,
          {
            attempt: repair.requested,
            failedPatch: compactPatch(codeDiff(proposal.diff)),
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
          options.compareTypeErrors && candidateSources
            ? { files: candidateSources.files, rules: ruleSources }
            : undefined,
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
        // A removed request parameter has no reviewed replacement; a repair must not drop it.
        const dropped = droppedRequestParameters(
          removedParameters,
          originalSources.files,
          preparedCandidate.sources.files,
          ('ruleEdits' in report.patch ? report.patch.ruleEdits : undefined) ?? [],
        );
        if (dropped.length) {
          repair.stopReason = 'review-required';
          repair.error = `AI repair drops removed request parameter ${dropped.join(', ')}; it stops for review.`;
          break;
        }
        options.onProgress?.('Running repaired checks in offline Docker...');
        const check = compared(
          await containerCheck(
            preparedCandidate.directory,
            image,
            options.command,
            preparedCandidate.dependencies,
          ),
        );
        candidateDependencies = preparedCandidate.dependencies;
        candidateEnvironment = preparedCandidate.environment;
        proposal = candidate;
        publicationFiles = preparedCandidate.publicationFiles;
        candidateDirectory = preparedCandidate.directory;
        candidateSources = preparedCandidate.sources;
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
            imports: generatedImportMap(originalSources),
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
        : dependencyFailure
          ? 'untested'
          : [baseline, patched, generated?.baseline, generated?.patched].some(
                (check) => check?.status === 'error',
              )
            ? 'error'
            : // A generated check with no runnable function is missing evidence, not a failure.
              baseline.status !== 'passed' ||
                (generated && !['passed', 'not-run'].includes(generated.baseline.status))
              ? 'baseline-failed'
              : patched.status !== 'passed' ||
                  (generated && !['passed', 'not-run'].includes(generated.patched.status))
                ? 'regression'
                : 'passed';
    const reviewTypeErrors = options.compareTypeErrors
      ? introducedTypeErrors(baselineRun, patched)
          .filter(reviewTypeError)
          .map(({ key, ...error }) => error)
      : [];
    const validation = {
      status: validationStatus,
      revision,
      image,
      ...(environment ? { environment } : {}),
      ...(dependencyFailure ? { dependencyFailure } : {}),
      ...(candidateEnvironment ? { patchedEnvironment: candidateEnvironment } : {}),
      command: options.command,
      baselineCommand,
      ...(options.compareTypeErrors ? { compareTypeErrors: true } : {}),
      archiveHash: digest(archiveResult.stdout),
      patchHash: digest(proposal.diff),
      baseline,
      patched,
      ...(generated ? { generated } : {}),
      attempts,
      repair,
      ...(reviewTypeErrors.length ? { reviewTypeErrors } : {}),
      limits: {
        timeoutMs: CHECK_TIMEOUT_MS,
        outputBytes: MAX_OUTPUT_BYTES,
        network: 'none',
        workspace: validationProfile().workspace,
        memory: validationProfile().memory,
      },
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
