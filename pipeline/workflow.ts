import type { GeneratedChecks } from './generated-checks.ts';
import {
  migrationReviewReason,
  REMOVED_REQUEST_PARAMETER_REVIEW_REASON,
  removedParameterSites,
  reviewBlocksAi,
  targetReached,
} from './migration-review.ts';
import type { AiOptions } from './ai-budget.ts';
import type { BehaviourTestWriter } from './behaviour-test-writer.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createArtifactDirectory } from './artifacts.ts';
import { readProviderAdapter } from './providers.ts';
import {
  AI_PATCH_STOP,
  closeResolvedDraft,
  findExistingMigration,
  publishDraft,
  type publicationConfiguration,
  publicationWaiver,
} from './publication.ts';
import { createReviewArtifacts, NEEDS_REVIEW_PREFIX } from './review.ts';
import { runPipeline } from './run.ts';
import { type SlackSend, workflowNotice } from './slack.ts';
import { discoverStripeRevision, encodeSnapshot, fetchStripeSnapshot } from './snapshots.ts';
import { digest, isObject, readSpecification } from './specifications.ts';
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
import { COMPRESSED_SUFFIX, compressEvidence } from './state-files.ts';
import { countBreakingOperationUsages } from './provider-operations.ts';
import { apiVersionSourceBlocked, type ApiVersionPolicy } from './api-version.ts';
import type { ReadinessCheck } from './readiness.ts';

const PREFLIGHT_GIT_TIMEOUT_MS = 30_000;
// Both hold the full contract diff, which dominates their size; see COMPRESSED_SUFFIX.
const COMPRESSED_EVIDENCE = new Set(['scan.json', 'report.json']);
const NO_USAGE_REASON =
  'No confirmed supported usage was found. This does not prove no impact; no patch or publication was attempted.';
const NO_PATCH_NOTE =
  'Refit opens a [Needs review] draft wherever it used to stop, but this run has no code change to publish.';

const REGRESSION_NOTE =
  "Refit's patch failed the repository checks, so it is kept with this run's artifacts as evidence and not published.";

type Stage = 'inputs' | 'scan' | 'validation' | 'publication';
type Status =
  | 'needs-review'
  | 'validation-failed'
  | 'validated'
  | 'draft-created'
  | 'draft-updated'
  | 'draft-closed'
  | 'existing-pr'
  | 'up-to-date'
  | 'error';

// How a found or published draft ends the run. A draft a person closed or merged is final for its
// target version, and one they edited is theirs.
function publicationOutcome(
  draft: {
    status: 'created' | 'updated' | 'existing' | 'closed' | 'merged';
    url: string;
    leftUnchanged?: string;
    validation?: 'not-rerun';
  },
  report: Pick<Awaited<ReturnType<typeof runPipeline>>, 'apiVersion'>,
): [Status, string] {
  const target = report.apiVersion.after ?? 'this target contract';
  const rerun =
    draft.validation === 'not-rerun' ? ' AI generation and validation were not rerun.' : '';
  if (draft.status === 'created') return ['draft-created', draft.url];
  if (draft.status === 'updated') return ['draft-updated', draft.url];
  if (draft.status === 'merged')
    return [
      'draft-closed',
      `${draft.url} was merged. Refit does not open another draft for ${target}.${rerun}`,
    ];
  if (draft.status === 'closed')
    return [
      'draft-closed',
      `${draft.url} was closed without merging. Refit does not reopen or replace it for ${target}; reopen it to have Refit update it.${rerun}`,
    ];
  if (draft.leftUnchanged) return ['existing-pr', `${draft.url}: ${draft.leftUnchanged}${rerun}`];
  return ['existing-pr', `${draft.url} already covers these changes.${rerun}`];
}

// The workflow's stops that need only its scan, checked in this order before dependency
// preparation or validation. The Stripe benchmark applies them before it starts `refit run`.
// With `leaveReviewedFindings` (owner decision 1) the draft carries a stop's reasons instead, so
// it holds only when no patch can, or when a source-verified policy refuses the code's API-version
// declarations, which validation and publication refuse too. Conflicting pins all move.
export function scanReviewReason(
  scan: Awaited<ReturnType<typeof runPipeline>>,
  aiPatch: boolean,
  leaveReviewedFindings: boolean,
) {
  const reason = scanStop(scan, aiPatch);
  if (!reason || !leaveReviewedFindings) return reason;
  if (apiVersionSourceBlocked(scan.apiVersion, true)) return scan.apiVersion.reason;
  const aiWrites =
    aiPatch &&
    !reviewBlocksAi(scan) &&
    scan.findings.some((finding) => finding.confidence === 'confirmed');
  if (scan.patch.status !== 'proposed' && !aiWrites) return `${reason} ${NO_PATCH_NOTE}`;
}

function scanStop(scan: Awaited<ReturnType<typeof runPipeline>>, aiPatch: boolean) {
  const reviewReason = migrationReviewReason(scan, true, true, aiPatch);
  // The constant stays comparable for publication; the stop a person reads names the calls.
  if (reviewReason === REMOVED_REQUEST_PARAMETER_REVIEW_REASON)
    return `${reviewReason} ${removedParameterSites(scan.findings)}`;
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
  if (!scan.findings.some((finding) => finding.confidence === 'confirmed')) return NO_USAGE_REASON;
}

// The rules' patch moved a pin or upgraded stripe-node.
function movesApiVersion(report: Awaited<ReturnType<typeof validateMigration>>) {
  const { patch } = report;
  return (
    patch.generator === 'deterministic' &&
    (('ruleEdits' in patch &&
      patch.ruleEdits?.some((edit) => edit.rule === 'stripe-api-version')) ||
      ('sdkUpgrade' in patch && isObject(patch.sdkUpgrade) && 'from' in patch.sdkUpgrade))
  );
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
  behaviourTestWriter?: BehaviourTestWriter;
  documentationSnapshots?: readonly string[];
  repairAttempts?: number;
  publication?: ReturnType<typeof publicationConfiguration>;
  // Owner decision 1 without a publication target: continue past the stops owner decision 1
  // turns into review reasons and record them in the local review artifacts, so the saved report
  // can be published later.
  allowUnresolved?: boolean;
  // refit doctor's review findings, which join the draft's review reasons under owner decision 1.
  doctor?: readonly ReadinessCheck[];
  // Slack notices for a new draft PR and for [URGENT] outcomes; `repository` names the
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
  const directory = await createArtifactDirectory(options.repository, options.output);
  const files: { path: string; sha256: string; bytes: number }[] = [];
  let stage: Stage = 'inputs';
  const save = async (name: string, text: string) => {
    const compressed = COMPRESSED_EVIDENCE.has(name);
    const path = compressed ? `${name}${COMPRESSED_SUFFIX}` : name;
    const content = compressed ? await compressEvidence(text) : text;
    await writeFile(join(directory, path), content, { flag: 'wx', mode: 0o600 });
    files.push({ path, sha256: digest(content), bytes: Buffer.byteLength(content) });
  };
  // The review reasons' gates the [Needs review] draft carries, recorded in the manifest.
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
        needsReview,
        error,
      });
    if (notice) await options.notify!.send(notice);
    return { directory, manifest };
  };
  let runId: string | null = null;
  let validation: string | undefined;
  let needsReview = false;
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
    const scan = await runPipeline({
      ...inputs,
      proposePatch: true,
      leaveReviewedFindings: allowUnresolved,
    });
    runId = scan.runId;
    await save('scan.json', `${JSON.stringify(scan, null, 2)}\n`);
    // The commit a clean checkout is at, which publication checks against GitHub.
    const checkoutRevision = async () => {
      const execute = promisify(execFile);
      const git = (argumentsList: string[]) =>
        execute('git', ['-c', 'core.fsmonitor=false', '-C', options.repository, ...argumentsList], {
          timeout: PREFLIGHT_GIT_TIMEOUT_MS,
          env: gitEnvironment(),
        });
      if ((await git(['status', '--porcelain', '--untracked-files=all'])).stdout) return undefined;
      return (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
    };
    // The customer migrated the code themselves: Refit's open draft for this target no longer applies.
    const closeResolved = async (why: string) => {
      if (!publication?.app) return undefined;
      const revision = await checkoutRevision();
      if (!revision) return undefined;
      stage = 'publication';
      options.onProgress?.('Checking whether a Refit Agent draft no longer applies...');
      const closed = await closeResolvedDraft(
        scan,
        revision,
        publication,
        `Refit is closing this draft. On \`${publication.base}\` at ${revision.slice(0, 12)}, ${why}, so this migration no longer applies. If you reopen it, Refit leaves it open.`,
      );
      if (closed) await save('publication.json', `${JSON.stringify(closed, null, 2)}\n`);
      else stage = 'scan';
      return closed;
    };
    const target = scan.apiVersion.after ?? 'the target contract';
    if (targetReached(scan)) {
      const closed = await closeResolved(
        `the code already sends ${target} and uses none of what it breaks`,
      );
      return await finish(
        'up-to-date',
        `The code already sends ${target} and uses none of what it breaks.${closed ? ` Refit closed its draft ${closed.url}.` : ''}`,
        runId,
      );
    }
    const reviewReason = scanReviewReason(scan, Boolean(options.aiPatch), allowUnresolved);
    // Untraced reads keep the draft open: it lists them for review.
    if (reviewReason?.startsWith(NO_USAGE_REASON) && !scan.findings.length) {
      const closed = await closeResolved('Refit no longer finds the usages this draft migrated');
      if (closed)
        return await finish(
          'draft-closed',
          `Refit no longer finds the usages ${closed.url} migrated, so it closed that draft.`,
          runId,
        );
    }
    if (reviewReason) return await finish('needs-review', reviewReason, runId);
    if (publication?.app) {
      options.signal?.throwIfAborted();
      options.onProgress?.('Checking for an existing Refit Agent migration...');
      const revision = await checkoutRevision();
      if (revision) {
        const existing = await findExistingMigration(
          scan,
          revision,
          publication,
          options.assessment ? false : options.aiPatch ? 'ai' : 'release',
        );
        if (existing) {
          stage = 'publication';
          await save('publication.json', `${JSON.stringify(existing, null, 2)}\n`);
          return await finish(...publicationOutcome(existing, scan), runId);
        }
      }
    }
    const proposalReason = proposalReviewReason(scan, Boolean(options.aiPatch));
    if (proposalReason) return await finish('needs-review', proposalReason, runId);
    stage = 'validation';
    options.signal?.throwIfAborted();
    options.onProgress?.('Validating the committed repository snapshot...');
    const validate = (keepApiVersion: boolean) =>
      validateMigration({
        ...inputs,
        keepApiVersion,
        image: options.image,
        command: options.command,
        baselineCommand: options.baselineCommand,
        prepareDependencies: options.prepareDependencies,
        generatedChecks: options.generatedChecks,
        compareTypeErrors: options.compareTypeErrors,
        assessment: options.assessment,
        aiPatch: options.aiPatch,
        // shortcut: the retry without the API-version move writes no behaviour tests, so it never
        // pays for a second identical request; reuse the first run's tests if that retry needs grade A.
        behaviourTestWriter: keepApiVersion ? undefined : options.behaviourTestWriter,
        documentationSnapshots: options.documentationSnapshots,
        repairAttempts: options.repairAttempts,
        leaveReviewedFindings: allowUnresolved,
        recordUntested: allowUnresolved,
        onProgress: options.onProgress,
        signal: options.signal,
      });
    let report = await validate(false);
    // Owner decision 1: a rules' patch that moved the API version and then failed the checks is
    // retried without the move, keeping the edits that work under either version.
    if (allowUnresolved && report.validation.status === 'regression' && movesApiVersion(report)) {
      options.onProgress?.(
        'The patch failed the checks. Validating it without the API-version move...',
      );
      // Without the move there may be nothing to patch; the regression then stands.
      const kept = await validate(true).catch((error: unknown) => {
        if (error instanceof PipelineInputError) return undefined;
        throw error;
      });
      if (kept?.validation.status === 'passed' && kept.publicationFiles.length) report = kept;
    }
    runId = report.runId;
    validation = report.validation.status;
    const reviews = publicationWaiver(report, allowUnresolved, options.doctor);
    waivedGates.push(...new Set(reviews?.map((entry) => entry.gate)));
    const review = createReviewArtifacts(report, 'local', options.integration, reviews);
    needsReview = review.manifest.title.startsWith(NEEDS_REVIEW_PREFIX);
    for (const [path, content] of Object.entries(review.files)) await save(path, content);
    // Where the scan alone would have stopped, the run ends as that stop's draft did before
    // owner decision 1, with the failed patch kept as evidence and never published.
    const stop =
      allowUnresolved && report.validation.status === 'regression'
        ? scanReviewReason(scan, Boolean(options.aiPatch), false)
        : undefined;
    if (stop) return await finish('needs-review', `${stop} ${REGRESSION_NOTE}`, runId);
    if (report.validation.status !== 'passed' && !reviews)
      return await finish(
        'validation-failed',
        `Validation returned ${report.validation.status}; publication was not attempted.${report.validation.baselineStop ? ` The baseline checks failed because ${report.validation.baselineStop.summary}. ${report.validation.baselineStop.action}` : ''}${checkFailureText(report.validation)}`,
        runId,
      );
    if (!reviews && report.patch.generator === 'openai')
      return await finish('needs-review', AI_PATCH_STOP, runId);
    if (reviews && !report.publicationFiles.length)
      return await finish(
        'needs-review',
        `Validation returned ${report.validation.status}. ${NO_PATCH_NOTE}`,
        runId,
      );
    if (reviews?.length && !publication)
      return await finish(
        'needs-review',
        `Review artifacts are ready as a [Needs review] draft for ${waivedGates.join(', ')}; publication was not requested.`,
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
      report.validation.status === 'passed'
        ? 'Checks passed. Publishing a GitHub draft PR...'
        : 'Checks did not run. Publishing an untested [Needs review] GitHub draft PR...',
    );
    const published = await publishDraft(report, publication, options.doctor);
    await save('publication.json', `${JSON.stringify(published, null, 2)}\n`);
    return await finish(...publicationOutcome(published, report), runId);
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
