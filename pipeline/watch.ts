import { execFile } from 'node:child_process';
import { createPatch } from 'diff';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  captureSpecification,
  type SpecificationSource,
  type CapturedSpecification,
} from './openapi-sources.ts';
import {
  captureDocumentation,
  documentationSourceId,
  normalizeDocumentationSource,
  validateDocumentationSnapshot,
  MAX_DOCUMENTATION_BYTES,
  MAX_DOCUMENTATION_SOURCES,
  type CapturedDocumentation,
  type DocumentationSource,
} from './documentation-sources.ts';
import { readProviderAdapter } from './providers.ts';
import { isRemovedOperationChange } from './openapi-operations.ts';
import { digest, isObject, readSpecification } from './specifications.ts';
import {
  hasErrorCode,
  readState,
  stateDirectoryOutsideRepository,
  withStateLock,
  writeState,
} from './state-files.ts';
import { runPipeline } from './run.ts';
import { runWorkflow } from './workflow.ts';
import { targetReached } from './migration-review.ts';
import { specificationVersion } from './api-version.ts';
import { verifyArtifacts } from './verification.ts';
import { PipelineInputError } from './types.ts';
import { withGitHubCheckout, type GitHubCheckoutTarget } from './github-checkout.ts';
import { gitEnvironment } from './git-environment.ts';
import { REFIT_VERSION } from './migration-identity.ts';
import { commentOnOwnDraft } from './publication.ts';

const execute = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const RETRYABLE_STATUSES = new Set(['error', 'validation-failed', 'interrupted', 'needs-review']);
// Outcomes with an open draft: after a Refit release, one more run lets the workflow refresh a
// [Needs review] draft the earlier release wrote. A current draft is found before generation.
const OPEN_DRAFT_STATUSES = new Set(['draft-created', 'draft-updated', 'existing-pr']);
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
type WorkflowOptions = Parameters<typeof runWorkflow>[0];
export interface WatchOptions {
  configuration: Omit<WorkflowOptions, 'repository' | 'output' | 'after' | 'latestStripe'> & {
    repository?: string;
  };
  source: SpecificationSource;
  documentationSources?: DocumentationSource[];
  stateDirectory: string;
  retry?: boolean;
  onProgress?: (message: string) => void;
  syncGitHub?: GitHubCheckoutTarget;
  // Off by default: once a week, a short comment on an open draft whose job nothing has changed.
  weeklyStatus?: boolean;
}

interface DocumentationChange {
  label: string;
  url: string;
  previousHash: string;
  currentHash: string;
  addedLines: number;
  removedLines: number;
  patch: string;
  evidence: string;
}

interface DocumentationBaseline {
  label: string;
  url: string;
  hash: string;
}

export async function watchOnce(options: WatchOptions) {
  if (options.syncGitHub) {
    const directory = options.configuration.repository
      ? await stateDirectoryOutsideRepository(
          options.configuration.repository,
          options.stateDirectory,
        )
      : resolve(options.stateDirectory);
    return withGitHubCheckout(
      {
        directory: join(directory, 'github'),
        target: options.syncGitHub,
        signal: options.configuration.signal,
        onProgress: options.onProgress,
      },
      async (checkout) => ({
        ...(await watchLocalOnce({
          ...options,
          stateDirectory: directory,
          configuration: { ...options.configuration, repository: checkout.directory },
        })),
        checkout,
      }),
    );
  }
  if (!options.configuration.repository)
    throw new PipelineInputError('Watch requires a local repository or --sync-github.');
  return watchLocalOnce({
    ...options,
    configuration: { ...options.configuration, repository: options.configuration.repository },
  });
}

async function watchLocalOnce(
  options: WatchOptions & { configuration: WatchOptions['configuration'] & { repository: string } },
) {
  const repository = await realpath(options.configuration.repository);
  const physicalDirectory = await stateDirectoryOutsideRepository(
    repository,
    options.stateDirectory,
  );
  return withStateLock(physicalDirectory, 'watch', async () => {
    const configuration = {
      ...options.configuration,
      repository,
      fullDiff: options.configuration.fullDiff ?? true,
      latestStripe: undefined,
    };
    const documentationSources = (options.documentationSources ?? [])
      .map(normalizeDocumentationSource)
      .sort((left, right) =>
        documentationSourceId(left).localeCompare(documentationSourceId(right)),
      );
    if (
      documentationSources.length > MAX_DOCUMENTATION_SOURCES ||
      new Set(documentationSources.map(documentationSourceId)).size !== documentationSources.length
    )
      throw new PipelineInputError(
        `Watch accepts up to ${MAX_DOCUMENTATION_SOURCES} unique documentation sources.`,
      );
    const provider = await readProviderAdapter(configuration.providerConfig);
    const before = await readSpecification(configuration.before);
    const signature = digest(
      JSON.stringify({
        repository,
        integration: configuration.integration,
        provider,
        before: before.hash,
        apiVersion: configuration.apiVersion,
        apiVersionPolicy: configuration.apiVersionPolicy,
        source: options.source,
        ...(documentationSources.length ? { documentationSources } : {}),
        image: configuration.image,
        ...(configuration.prepareDependencies ? { prepareDependencies: true } : {}),
        ...(configuration.generatedChecks
          ? { generatedChecks: configuration.generatedChecks }
          : {}),
        ...(configuration.compareTypeErrors ? { compareTypeErrors: true } : {}),
        ...(configuration.keepListedPaymentMethods ? { keepListedPaymentMethods: true } : {}),
        command: configuration.command,
        baselineCommand: configuration.baselineCommand,
        fullDiff: configuration.fullDiff,
        publication: configuration.publication
          ? {
              repository: configuration.publication.repository,
              base: configuration.publication.base,
              mode: configuration.publication.app ? 'app' : 'token',
            }
          : null,
      }),
    );
    const statePath = join(physicalDirectory, 'state.json');
    const state = (await readState(statePath)) ?? {
      formatVersion: 1,
      signature,
      jobs: {},
      lastSource: null,
    };
    if (state.formatVersion !== 1 || state.signature !== signature || !isObject(state.jobs))
      throw new PipelineInputError(
        'Watch state belongs to another configuration or is invalid. Choose a fresh state directory.',
      );
    const jobs = state.jobs;
    const advanced = advancedBaseline(state.baseline);
    if (state.documentation !== undefined && !isObject(state.documentation))
      throw new PipelineInputError('Watch documentation source state is invalid.');
    const documentationState = isObject(state.documentation) ? state.documentation : {};
    let previousSnapshot: CapturedSpecification | undefined;
    if (typeof state.lastSource === 'string') {
      const path = join(physicalDirectory, 'snapshots', `${state.lastSource}.json`);
      await readSpecification(path);
      previousSnapshot = JSON.parse(await readFile(path, 'utf8'));
    }
    const snapshot = await captureSpecification(options.source, provider.id, previousSnapshot);
    const snapshots = join(physicalDirectory, 'snapshots');
    const observations = join(physicalDirectory, 'observations');
    const runs = join(physicalDirectory, 'runs');
    for (const path of [snapshots, observations, runs])
      await mkdir(path, { recursive: true, mode: 0o700 });
    const capturedDocumentation = await captureDocumentationSources(
      documentationSources,
      documentationState,
      snapshots,
      observations,
    );
    const baseline = join(snapshots, `${before.hash}.baseline.json`);
    try {
      await writeFile(baseline, await readFile(configuration.before, 'utf8'), {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    if ((await readSpecification(baseline)).hash !== before.hash)
      throw new PipelineInputError('The baseline changed while capturing watch inputs.');
    configuration.before = baseline;
    if (advanced) {
      configuration.before = join(snapshots, `${advanced.hash}.baseline.json`);
      if ((await readSpecification(configuration.before)).hash !== advanced.hash)
        throw new PipelineInputError(
          'The advanced watch baseline does not match its recorded hash.',
        );
      configuration.apiVersion = advanced.apiVersion;
      // Nobody attested this pin; only the code's own declarations, checked on every poll, back it.
      configuration.apiVersionPolicy = 'source-verified';
    }
    const after = join(snapshots, `${snapshot.hash}.json`);
    try {
      await writeFile(after, `${JSON.stringify(snapshot)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      if ((await readSpecification(after)).hash !== snapshot.hash)
        throw new PipelineInputError(
          'Captured specification state does not match its recorded hash.',
        );
    }
    const scan = await runPipeline({
      repository,
      before: configuration.before,
      after,
      providerConfig: configuration.providerConfig,
      apiVersion: configuration.apiVersion,
      apiVersionPolicy: configuration.apiVersionPolicy,
      fullDiff: configuration.fullDiff,
      proposePatch: true,
    });
    const contractChanges =
      scan.specificationDiff.engine === 'oasdiff'
        ? scan.specificationDiff.changes
            .filter((change) => Number(change.level) >= 2 || isRemovedOperationChange(change))
            .map(
              (change) =>
                change.fingerprint ?? { id: change.id, path: change.path, text: change.text },
            )
        : [];
    const { stdout } = await execute(
      'git',
      ['-c', 'core.fsmonitor=false', '-C', repository, 'rev-parse', '--verify', 'HEAD^{commit}'],
      { timeout: GIT_TIMEOUT_MS, env: gitEnvironment() },
    );
    const revision = stdout.trim();
    const jobKey = digest(
      JSON.stringify({
        revision,
        repositoryHash: scan.repository.hash,
        adapter: provider,
        // A new release is a new target even when the changes Refit maps are the same: it gets its
        // own draft (draftKey in pipeline/publication.ts). The older draft closes only with
        // --supersede-drafts.
        apiVersion: {
          application: scan.apiVersion.application,
          before: scan.apiVersion.before,
          after: scan.apiVersion.after,
          applicability: scan.apiVersion.applicability,
        },
        changes: scan.changes.map((change) => change.id),
        ...(scan.operationChanges.length
          ? { operationChanges: scan.operationChanges.map((change) => change.id) }
          : {}),
        ...(scan.requestChanges?.length
          ? { requestChanges: scan.requestChanges.map((change) => change.id) }
          : {}),
        contractChanges,
      }),
    );
    await writeState(join(observations, `${snapshot.hash}.json`), {
      source: snapshot.url,
      sourceHash: snapshot.hash,
      provider: provider.id,
      scan,
      ...(capturedDocumentation.changes.length
        ? { documentationChanges: capturedDocumentation.changes }
        : {}),
    });
    state.lastSource = snapshot.hash;
    await writeState(statePath, state);
    const previous = jobs[jobKey];
    if (isObject(previous) && previous.status === 'running') {
      try {
        if (typeof previous.output !== 'string')
          throw new PipelineInputError('Interrupted job has no evidence directory.');
        await verifyArtifacts(previous.output);
        const manifest = await readState(join(previous.output, 'manifest.json'));
        if (
          !manifest ||
          manifest.kind !== 'refit-workflow' ||
          manifest.runId !== previous.runId ||
          typeof manifest.status !== 'string'
        )
          throw new PipelineInputError('Interrupted job has mismatched evidence.');
        previous.status = manifest.status;
        if (typeof manifest.reason === 'string') previous.reason = manifest.reason;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        previous.status = 'interrupted';
        previous.error = { name: error.name, message: error.message };
      }
    }
    // Once the code reached this target, a new commit has nothing to compare until the next release.
    const settled =
      advanced?.hash === snapshot.hash
        ? { status: 'up-to-date', output: null }
        : isObject(previous) &&
            !(options.retry && RETRYABLE_STATUSES.has(String(previous.status))) &&
            !(OPEN_DRAFT_STATUSES.has(String(previous.status)) && previous.refit !== REFIT_VERSION)
          ? {
              status: String(previous.status),
              output: typeof previous.output === 'string' ? previous.output : null,
              reason: jobReason(previous),
            }
          : undefined;
    if (settled) {
      if (documentationSources.length) state.documentation = capturedDocumentation.state;
      await writeState(statePath, state);
      if (capturedDocumentation.changes.length)
        return {
          status: 'documentation-changed' as const,
          provider: provider.id,
          jobKey,
          sourceHash: snapshot.hash,
          previousStatus: settled.status,
          ...(settled.reason ? { previousReason: settled.reason } : {}),
          output: join(observations, 'documentation'),
          documentationChanges: capturedDocumentation.changes,
        };
      const weeklyStatus =
        options.weeklyStatus &&
        configuration.publication &&
        isObject(previous) &&
        OPEN_DRAFT_STATUSES.has(settled.status)
          ? await postWeeklyStatus(previous, configuration.publication, {
              base: configuration.publication.base,
              revision,
              target: scan.apiVersion.after,
            })
          : undefined;
      if (options.weeklyStatus) await writeState(statePath, state);
      return {
        status: 'already-processed' as const,
        provider: provider.id,
        jobKey,
        sourceHash: snapshot.hash,
        previousStatus: settled.status,
        ...(settled.reason ? { previousReason: settled.reason } : {}),
        output: settled.output,
        ...(weeklyStatus ? { weeklyStatus } : {}),
      };
    }
    const attempt =
      isObject(previous) && Number.isSafeInteger(previous.attempt)
        ? Number(previous.attempt) + 1
        : 1;
    const output = join(runs, `${jobKey}-${attempt}`);
    jobs[jobKey] = {
      status: 'running',
      attempt,
      output,
      runId: scan.runId,
      sourceHash: snapshot.hash,
      refit: REFIT_VERSION,
    };
    await writeState(statePath, state);
    const confirmedUsageCount = scan.findings.filter(
      (finding) => finding.confidence === 'confirmed',
    ).length;
    options.onProgress?.(
      `Detected ${confirmedUsageCount} confirmed ${confirmedUsageCount === 1 ? 'usage' : 'usages'}; processing ${provider.id} migration.${capturedDocumentation.changes.length ? ` Recorded ${capturedDocumentation.changes.length} documentation change${capturedDocumentation.changes.length === 1 ? '' : 's'} for review.` : ''}`,
    );
    try {
      const result = await runWorkflow({
        ...configuration,
        after,
        output,
        onProgress: options.onProgress,
        documentationSnapshots: capturedDocumentation.snapshotPaths,
      });
      jobs[jobKey] = {
        ...(jobs[jobKey] as object),
        status: result.manifest.status,
        reason: result.manifest.reason,
        finishedAt: new Date().toISOString(),
      };
      if (documentationSources.length) state.documentation = capturedDocumentation.state;
      // The code reached the target, by a merged draft or by hand: compare the next release with it.
      const reached =
        result.manifest.status === 'up-to-date' && targetReached(scan)
          ? { hash: snapshot.hash, apiVersion: scan.apiVersion.after!, revision }
          : undefined;
      if (reached) {
        const path = join(snapshots, `${reached.hash}.baseline.json`);
        try {
          await writeFile(path, await readFile(after, 'utf8'), { flag: 'wx', mode: 0o600 });
        } catch (error) {
          if (!hasErrorCode(error, 'EEXIST')) throw error;
        }
        if ((await readSpecification(path)).hash !== reached.hash)
          throw new PipelineInputError(
            'The advanced watch baseline does not match its recorded hash.',
          );
        state.baseline = reached;
      }
      await writeState(statePath, state);
      return {
        status: 'processed' as const,
        provider: provider.id,
        jobKey,
        sourceHash: snapshot.hash,
        output,
        ...(capturedDocumentation.changes.length
          ? { documentationChanges: capturedDocumentation.changes }
          : {}),
        ...(capturedDocumentation.baselines.length
          ? { documentationBaselines: capturedDocumentation.baselines }
          : {}),
        ...(reached
          ? {
              baselineAdvanced: {
                from: configuration.apiVersion ?? null,
                to: reached.apiVersion,
              },
            }
          : {}),
        result,
      };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      jobs[jobKey] = {
        ...(jobs[jobKey] as object),
        status: 'error',
        error: { name: error.name, message: error.message },
      };
      await writeState(statePath, state);
      throw error;
    }
  });
}

// Posts the weekly note on the job's draft when a week has passed since the job finished or the
// last note, and records when it checked on the job; returns the draft's URL when it posted.
async function postWeeklyStatus(
  job: Record<string, unknown>,
  publication: NonNullable<WorkflowOptions['publication']>,
  current: { base: string; revision: string; target: string | null },
) {
  if (typeof job.output !== 'string') return;
  const since = Date.parse(String(job.weeklyStatusAt ?? job.finishedAt));
  // A job recorded before weekly notes existed starts its week now.
  if (Number.isNaN(since)) {
    job.weeklyStatusAt = new Date().toISOString();
    return;
  }
  if (Date.now() - since < WEEK_MS) return;
  const draft = await readState(join(job.output, 'publication.json'));
  if (
    !isObject(draft) ||
    typeof draft.url !== 'string' ||
    typeof draft.number !== 'number' ||
    typeof draft.branch !== 'string'
  )
    return;
  const note = `Refit checked this draft again on ${new Date().toISOString().slice(0, 10)}. Nothing the patch depends on has changed since ${new Date(since).toISOString().slice(0, 10)}: \`${current.base}\` is still at \`${current.revision.slice(0, 7)}\`${current.target ? `, and the newest contract Refit has seen is still \`${current.target}\`` : ''}. The patch and the check results in the description still apply; Refit did not rerun the checks.

Refit posts this once a week while the draft is open, because the service runs with \`--weekly-status\`.`;
  const posted = await commentOnOwnDraft(
    publication,
    { number: draft.number, branch: draft.branch, revision: current.revision },
    note,
  );
  job.weeklyStatusAt = new Date().toISOString();
  return posted ? draft.url : undefined;
}

// Why a recorded job ended as it did, so a poll that reuses it can still say why.
function jobReason(job: Record<string, unknown>) {
  if (isObject(job.error) && typeof job.error.message === 'string')
    return `${String(job.error.name)}: ${job.error.message}`;
  return typeof job.reason === 'string' ? job.reason : undefined;
}

// The baseline a reached target replaced the configured one with; the configured baseline is part
// of the state's signature, so changing it starts a fresh state.
function advancedBaseline(value: unknown) {
  if (value === undefined) return undefined;
  if (
    !isObject(value) ||
    typeof value.hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.hash) ||
    typeof value.apiVersion !== 'string' ||
    !value.apiVersion
  )
    throw new PipelineInputError(
      'Watch baseline state is invalid. Choose a fresh state directory.',
    );
  return { hash: value.hash, apiVersion: value.apiVersion };
}

// The API versions code under this watcher may send besides the configured one: the target it last
// captured, which a merged draft moves the pin to, and the baseline a reached target replaced.
export async function watchedApiVersions(directory: string) {
  const state = await readState(join(directory, 'state.json'));
  if (!state) return [];
  const versions = [advancedBaseline(state.baseline)?.apiVersion];
  if (typeof state.lastSource === 'string')
    versions.push(
      specificationVersion(
        (await readSpecification(join(directory, 'snapshots', `${state.lastSource}.json`)))
          .document,
      ) ?? undefined,
    );
  return [...new Set(versions.filter((version) => version !== undefined))];
}

async function captureDocumentationSources(
  sources: DocumentationSource[],
  previousState: Record<string, unknown>,
  snapshots: string,
  observations: string,
) {
  const state: Record<string, string> = {};
  const changes: DocumentationChange[] = [];
  const baselines: DocumentationBaseline[] = [];
  const snapshotPaths: string[] = [];
  const sourceIds = new Set(sources.map(documentationSourceId));
  if (Object.keys(previousState).some((sourceId) => !sourceIds.has(sourceId)))
    throw new PipelineInputError(
      'Watch documentation source state does not match its configuration.',
    );
  for (const source of sources) {
    const sourceId = documentationSourceId(source);
    const previousHash = previousState[sourceId];
    let previous: CapturedDocumentation | undefined;
    if (previousHash !== undefined) {
      if (typeof previousHash !== 'string' || !/^[a-f0-9]{64}$/.test(previousHash))
        throw new PipelineInputError('Watch documentation source hash is invalid.');
      previous = validateDocumentationSnapshot(
        JSON.parse(
          await readFile(documentationSnapshotPath(snapshots, sourceId, previousHash), 'utf8'),
        ),
        source,
      );
      if (previous.hash !== previousHash)
        throw new PipelineInputError('Watch documentation snapshot does not match saved state.');
    }
    const current = await captureDocumentation(source, previous);
    await writeDocumentationSnapshot(snapshots, source, current);
    state[sourceId] = current.hash;
    snapshotPaths.push(documentationSnapshotPath(snapshots, sourceId, current.hash));
    if (!previous) baselines.push({ label: current.label, url: current.url, hash: current.hash });
    if (previous && previous.hash !== current.hash)
      changes.push(await recordDocumentationChange(observations, sourceId, previous, current));
  }
  return { state, changes, baselines, snapshotPaths };
}

// The files a later run reads from a watch state directory: its job ledger, the last captured
// specification, the baselines and the current documentation snapshots. The rest is evidence.
export async function watchCarryOver(directory: string) {
  const state = await readState(join(directory, 'state.json'));
  if (!state) return [];
  let snapshots: string[] = [];
  try {
    snapshots = await readdir(join(directory, 'snapshots'));
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }
  return [
    'state.json',
    ...snapshots
      .filter((name) => name.endsWith('.baseline.json') || name === `${state.lastSource}.json`)
      .map((name) => join('snapshots', name)),
    ...Object.entries(isObject(state.documentation) ? state.documentation : {}).map(
      ([sourceId, hash]) => documentationSnapshotPath('snapshots', sourceId, String(hash)),
    ),
  ];
}

function documentationSnapshotPath(snapshots: string, sourceId: string, hash: string) {
  return join(snapshots, 'documentation', `${sourceId}-${hash}.json`);
}

async function writeDocumentationSnapshot(
  snapshots: string,
  source: DocumentationSource,
  snapshot: CapturedDocumentation,
) {
  const path = documentationSnapshotPath(snapshots, documentationSourceId(source), snapshot.hash);
  await mkdir(join(snapshots, 'documentation'), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
    const current = validateDocumentationSnapshot(JSON.parse(await readFile(path, 'utf8')), source);
    if (
      current.hash !== snapshot.hash ||
      Buffer.byteLength(current.content) > MAX_DOCUMENTATION_BYTES
    )
      throw new PipelineInputError('Saved documentation snapshot does not match its content hash.');
  }
}

async function recordDocumentationChange(
  observations: string,
  sourceId: string,
  previous: CapturedDocumentation,
  current: CapturedDocumentation,
): Promise<DocumentationChange> {
  const patch = createPatch(
    `documentation-${sourceId.slice(0, 12)}.md`,
    previous.content,
    current.content,
    previous.hash,
    current.hash,
    { context: 3 },
  );
  const addedLines = patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const removedLines = patch
    .split('\n')
    .filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  const changeId = digest(`${sourceId}\n${previous.hash}\n${current.hash}`);
  const directory = join(observations, 'documentation');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const patchPath = join(directory, `${changeId}.patch`);
  try {
    await writeFile(patchPath, patch, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
    if ((await readFile(patchPath, 'utf8')) !== patch)
      throw new PipelineInputError('Saved documentation diff does not match its source snapshots.');
  }
  const evidence = join(directory, `${changeId}.json`);
  await writeState(evidence, {
    formatVersion: 1,
    kind: 'refit-documentation-change',
    label: current.label,
    url: current.url,
    previousHash: previous.hash,
    currentHash: current.hash,
    addedLines,
    removedLines,
    patch: patchPath,
  });
  return {
    label: current.label,
    url: current.url,
    previousHash: previous.hash,
    currentHash: current.hash,
    addedLines,
    removedLines,
    patch: patchPath,
    evidence,
  };
}
