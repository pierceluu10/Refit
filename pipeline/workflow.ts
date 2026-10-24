import type { GeneratedChecks } from './generated-checks.ts';
import { migrationReviewReason, withoutRequestParameters } from './migration-review.ts';
import type { AiOptions } from './ai-budget.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createArtifactDirectory } from './artifacts.ts';
import { readProviderAdapter } from './providers.ts';
import {
  findExistingMigration,
  publishDraft,
  type publicationConfiguration,
  publicationWaiver,
} from './publication.ts';
import { createReviewArtifacts } from './review.ts';
import { runPipeline } from './run.ts';
import { type SlackSend, workflowNotice } from './slack.ts';
import { discoverStripeRevision, encodeSnapshot, fetchStripeSnapshot } from './snapshots.ts';
import { digest, readSpecification } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { unmappedBreakingChanges } from './openapi-diff.ts';
import { checkFailureText } from './check-failures.ts';
import { validateMigration } from './validation.ts';
import {
  validateCheckCommand,
  validateRepairAttempts,
  validateWorkflowSources,
} from './validation-options.ts';
import { gitEnvironment } from './git-environment.ts';
import { countBreakingOperationUsages } from './provider-operations.ts';
import type { ApiVersionPolicy } from './api-version.ts';

const PREFLIGHT_GIT_TIMEOUT_MS = 30_000;

type Stage = 'inputs' | 'scan' | 'validation' | 'publication';
type Status =
  'needs-review' | 'validation-failed' | 'validated' | 'draft-created' | 'existing-pr' | 'error';

// The workflow's stops that need only its scan, checked in this order before dependency
// preparation or validation. The Stripe benchmark applies them before it starts `refit run`.
export function scanReviewReason(
  scan: Awaited<ReturnType<typeof runPipeline>>,
  aiPatch: boolean,
  leaveRequestParameters: boolean,
) {
  const reviewReason = migrationReviewReason(
    leaveRequestParameters ? withoutRequestParameters(scan) : scan,
    true,
    true,
    aiPatch,
  );
  if (reviewReason) return reviewReason;
  if (scan.apiVersion.applicability !== 'matches-before') return scan.apiVersion.reason;
  const operationUsageCount = countBreakingOperationUsages(scan.operationImpacts);
  if (operationUsageCount)
    return `Refit traced ${operationUsageCount} SDK call site${operationUsageCount === 1 ? '' : 's'} to unresolved breaking OpenAPI changes. A verified migration rule is required before AI generation, validation or publication.`;
  const unmapped = unmappedBreakingChanges(
    scan.specificationDiff,
    scan.changes,
    scan.findings,
    scan.operationChanges,
    scan.requestChanges,
    scan.expandedFields,
  );
  if (unmapped.length)
    return `${unmapped.length} breaking contract changes are outside the supported migration rules. Review the recorded contract report before proposing a patch.`;
  if (!scan.findings.some((finding) => finding.confidence === 'confirmed'))
    return 'No confirmed supported usage was found. This does not prove no impact; no patch or publication was attempted.';
}

// Checked after the existing-PR lookup, which only publication runs.
export function proposalReviewReason(
  scan: Awaited<ReturnType<typeof runPipeline>>,
  aiPatch: boolean,
) {
  if (!aiPatch && scan.patch.status !== 'proposed')
    return 'Confirmed usage has no deterministic migration rule. Enable AI patch generation or migrate manually.';
}

export async function runWorkflow(options: {
  repository: string;
  integration?: string;
  before: string;
  after?: string;
  latestStripe?: boolean;
  output: string;
  image: string;
  command: string[];
  baselineCommand?: string[];
  prepareDependencies?: boolean;
  generatedChecks?: GeneratedChecks;
  compareTypeErrors?: boolean;
  keepListedPaymentMethods?: boolean;
  shopifySdkUpgrade?: boolean;
  providerConfig?: string;
  apiVersion?: string;
  apiVersionPolicy?: ApiVersionPolicy;
  fullDiff?: boolean;
  assessment?: AiOptions;
  aiPatch?: AiOptions;
  documentationSnapshots?: readonly string[];
  repairAttempts?: number;
  publication?: ReturnType<typeof publicationConfiguration>;
  // --publish-unresolved without a publication target: continue past waivable stops and record
  // the waiver in the local review artifacts, so the saved report can be published later.
  allowUnresolved?: boolean;
  // Slack notices for a new validated draft PR and for [URGENT] outcomes; `repository` names the
  // repository in the message when no publication target does.
  notify?: { send: SlackSend; repository?: string };
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}) {
  validateWorkflowSources(options);
  validateCheckCommand(options.command);
  validateCheckCommand(options.baselineCommand ?? options.command);
  validateRepairAttempts(options.repairAttempts ?? 0, Boolean(options.aiPatch));
  const publication = options.publication
    ? {
        ...options.publication,
        ...(options.integration ? { integration: options.integration } : {}),
      }
    : undefined;
  const allowUnresolved = Boolean(options.allowUnresolved || publication?.allowUnresolved);
  // Removed request parameters are left only by deterministic rules; AI never sees them.
  const leaveRequestParameters = allowUnresolved && !options.aiPatch;
  const directory = await createArtifactDirectory(options.repository, options.output);
  const files: { path: string; sha256: string; bytes: number }[] = [];
  let stage: Stage = 'inputs';
  const save = async (path: string, content: string) => {
    await writeFile(join(directory, path), content, { flag: 'wx', mode: 0o600 });
    files.push({ path, sha256: digest(content), bytes: Buffer.byteLength(content) });
  };
  // Gates --publish-unresolved waived for this run, recorded in the manifest.
  const waivedGates: string[] = [];
  const finish = async (
    status: Status,
    reason: string,
    runId: string | null,
    error: { name: string; message: string } | null = null,
  ) => {
    const manifest = {
      formatVersion: 1,
      kind: 'refit-workflow',
      ...(options.integration ? { integration: options.integration } : {}),
      status,
      stage,
      reason,
      runId,
      ...(waivedGates.length ? { waivedGates } : {}),
      baselineAdvanced: false,
      reviewRequired: true,
      files,
      error,
    };
    await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    options.onProgress?.(`${status}: ${error ? error.message : reason}`);
    options.onProgress?.(`Evidence: ${directory}`);
    const notice =
      options.notify &&
      workflowNotice({
        repository:
          publication?.repository ?? options.notify.repository ?? basename(options.repository),
        status,
        stage,
        reason,
        validation,
        error,
      });
    if (notice) await options.notify!.send(notice);
    return { directory, manifest };
  };
  let runId: string | null = null;
  let validation: string | undefined;
  try {
    options.signal?.throwIfAborted();
    if (options.integration) options.onProgress?.(`Selected integration: ${options.integration}.`);
    options.onProgress?.('Preparing API specifications...');
    await readSpecification(options.before);
    await save('before.json', await readFile(options.before, 'utf8'));
    const before = join(directory, 'before.json');
    const baseline = await readSpecification(before);
    if (options.latestStripe) {
      if (!baseline.provenance)
        throw new PipelineInputError('--latest-stripe requires a pinned Refit baseline snapshot.');
      const revision = await discoverStripeRevision();
      await save(
        'after.json',
        revision === baseline.provenance.revision
          ? await readFile(before, 'utf8')
          : encodeSnapshot(await fetchStripeSnapshot(revision)),
      );
    } else {
      await readSpecification(options.after!);
      await save('after.json', await readFile(options.after!, 'utf8'));
    }
    let providerConfig: string | undefined;
    if (options.providerConfig) {
      await save(
        'adapter.json',
        `${JSON.stringify(await readProviderAdapter(options.providerConfig), null, 2)}\n`,
      );
      providerConfig = join(directory, 'adapter.json');
    }
    const inputs = {
      repository: options.repository,
      before,
      after: join(directory, 'after.json'),
      providerConfig,
      apiVersion: options.apiVersion,
      apiVersionPolicy: options.apiVersionPolicy,
      fullDiff: options.fullDiff,
      keepListedPaymentMethods: options.keepListedPaymentMethods,
      shopifySdkUpgrade: options.shopifySdkUpgrade,
    };
    stage = 'scan';
    options.onProgress?.('Scanning repository for affected API usage...');
    const scan = await runPipeline({ ...inputs, proposePatch: true, leaveRequestParameters });
    runId = scan.runId;
    await save('scan.json', `${JSON.stringify(scan, null, 2)}\n`);
    const reviewReason = scanReviewReason(scan, Boolean(options.aiPatch), leaveRequestParameters);
    if (reviewReason) return await finish('needs-review', reviewReason, runId);
    if (publication?.app) {
      options.signal?.throwIfAborted();
      options.onProgress?.('Checking for an existing Refit Agent migration...');
      const execute = promisify(execFile);
      const git = (argumentsList: string[]) =>
        execute('git', ['-c', 'core.fsmonitor=false', '-C', options.repository, ...argumentsList], {
          timeout: PREFLIGHT_GIT_TIMEOUT_MS,
          env: gitEnvironment(),
        });
      if (!(await git(['status', '--porcelain', '--untracked-files=all'])).stdout) {
        const revision = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
        const existing = await findExistingMigration(scan, revision, publication);
        if (existing) {
          stage = 'publication';
          await save('publication.json', `${JSON.stringify(existing, null, 2)}\n`);
          return await finish(
            'existing-pr',
            `${existing.url} already covers these changes. AI generation and validation were not rerun.`,
            runId,
          );
        }
      }
    }
    const proposalReason = proposalReviewReason(scan, Boolean(options.aiPatch));
    if (proposalReason) return await finish('needs-review', proposalReason, runId);
    stage = 'validation';
    options.signal?.throwIfAborted();
    options.onProgress?.('Validating the committed repository snapshot...');
    const report = await validateMigration({
      ...inputs,
      image: options.image,
      command: options.command,
      baselineCommand: options.baselineCommand,
      prepareDependencies: options.prepareDependencies,
      generatedChecks: options.generatedChecks,
      compareTypeErrors: options.compareTypeErrors,
      assessment: options.assessment,
      aiPatch: options.aiPatch,
      documentationSnapshots: options.documentationSnapshots,
      repairAttempts: options.repairAttempts,
      leaveRequestParameters,
      recordDependencyFailures: allowUnresolved,
      onProgress: options.onProgress,
      signal: options.signal,
    });
    runId = report.runId;
    validation = report.validation.status;
    const waiver = publicationWaiver(report, allowUnresolved);
    if (waiver) waivedGates.push(waiver.gate);
    const review = createReviewArtifacts(report, 'local', options.integration, waiver);
    for (const [path, content] of Object.entries(review.files)) await save(path, content);
    if (report.validation.status !== 'passed' && waiver?.gate !== 'dependency-preparation')
      return await finish(
        'validation-failed',
        `Validation returned ${report.validation.status}; publication was not attempted.${report.validation.baselineStop ? ` The baseline checks failed because ${report.validation.baselineStop.summary}. ${report.validation.baselineStop.action}` : ''}${checkFailureText(report.validation)}`,
        runId,
      );
    if (waiver && !publication)
      return await finish(
        'needs-review',
        `Review artifacts are ready as a [Needs review] draft with the ${waiver.gate} gate waived; publication was not requested.`,
        runId,
      );
    if (report.patch.unresolvedFindings !== 0 && !publication?.allowUnresolved)
      return await finish(
        'needs-review',
        'Checks passed but detected findings remain unresolved. Publication was not attempted.',
        runId,
      );
    if (!publication)
      return await finish(
        'validated',
        'Baseline and patched checks passed. Review artifacts are ready; publication was not requested.',
        runId,
      );
    stage = 'publication';
    options.signal?.throwIfAborted();
    options.onProgress?.(
      waiver?.gate === 'dependency-preparation'
        ? 'Checks did not run. Publishing an untested [Needs review] GitHub draft PR...'
        : 'Checks passed. Publishing a GitHub draft PR...',
    );
    const published = await publishDraft(report, publication);
    await save('publication.json', `${JSON.stringify(published, null, 2)}\n`);
    return await finish(
      published.status === 'created' ? 'draft-created' : 'existing-pr',
      published.url,
      runId,
    );
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return await finish(
      'error',
      `Workflow failed during ${stage}. Completed artifacts are retained. Publication errors can leave a remote branch or PR; reconcile before retrying.`,
      runId,
      { name: error.name, message: error.message },
    );
  }
}
