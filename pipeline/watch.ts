import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  captureSpecification,
  type SpecificationSource,
  type CapturedSpecification,
} from './openapi-sources.ts';
import { readProviderAdapter } from './providers.ts';
import { digest, isObject, readSpecification } from './specifications.ts';
import { readState, withStateLock, writeState } from './state-files.ts';
import { runPipeline } from './run.ts';
import { runWorkflow } from './workflow.ts';
import { verifyArtifacts } from './verification.ts';
import { PipelineInputError } from './types.ts';

const execute = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const RETRYABLE_STATUSES = new Set(['error', 'validation-failed', 'interrupted', 'needs-review']);
type WorkflowOptions = Parameters<typeof runWorkflow>[0];
export interface WatchOptions {
  configuration: Omit<WorkflowOptions, 'output' | 'after' | 'latestStripe'>;
  source: SpecificationSource;
  stateDirectory: string;
  retry?: boolean;
  onProgress?: (message: string) => void;
}

export async function watchOnce(options: WatchOptions) {
  const repository = await realpath(options.configuration.repository);
  const directory = resolve(options.stateDirectory);
  const inside = relative(repository, directory);
  if (!inside || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)))
    throw new PipelineInputError('Watch state must be outside the monitored repository.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const physicalDirectory = await realpath(directory);
  const physicalInside = relative(repository, physicalDirectory);
  if (
    !physicalInside ||
    (physicalInside !== '..' &&
      !physicalInside.startsWith(`..${sep}`) &&
      !isAbsolute(physicalInside))
  )
    throw new PipelineInputError('Watch state must not resolve inside the monitored repository.');
  return withStateLock(physicalDirectory, 'watch', async () => {
    const configuration = {
      ...options.configuration,
      repository,
      fullDiff: options.configuration.fullDiff ?? true,
    };
    const provider = await readProviderAdapter(configuration.providerConfig);
    const before = await readSpecification(configuration.before);
    const signature = digest(
      JSON.stringify({
        repository,
        provider,
        before: before.hash,
        source: options.source,
        image: configuration.image,
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
      fullDiff: configuration.fullDiff,
      proposePatch: true,
    });
    const contractChanges =
      scan.specificationDiff.engine === 'oasdiff'
        ? scan.specificationDiff.changes
            .filter((change) => Number(change.level) >= 2)
            .map(
              (change) =>
                change.fingerprint ?? { id: change.id, path: change.path, text: change.text },
            )
        : [];
    const { stdout } = await execute(
      'git',
      ['-c', 'core.fsmonitor=false', '-C', repository, 'rev-parse', '--verify', 'HEAD^{commit}'],
      { timeout: GIT_TIMEOUT_MS },
    );
    const revision = stdout.trim();
    const jobKey = digest(
      JSON.stringify({
        revision,
        repositoryHash: scan.repository.hash,
        adapter: provider,
        changes: scan.changes.map((change) => change.id),
        contractChanges,
      }),
    );
    await writeState(join(observations, `${snapshot.hash}.json`), {
      source: snapshot.url,
      sourceHash: snapshot.hash,
      provider: provider.id,
      scan,
    });
    state.lastSource = snapshot.hash;
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
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        previous.status = 'interrupted';
        previous.error = { name: error.name, message: error.message };
      }
    }
    if (isObject(previous) && !(options.retry && RETRYABLE_STATUSES.has(String(previous.status)))) {
      await writeState(statePath, state);
      return {
        status: 'already-processed' as const,
        provider: provider.id,
        jobKey,
        sourceHash: snapshot.hash,
        previousStatus: String(previous.status),
        output: typeof previous.output === 'string' ? previous.output : null,
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
    };
    await writeState(statePath, state);
    options.onProgress?.(
      `Detected ${scan.findings.filter((finding) => finding.confidence === 'confirmed').length} confirmed usages; processing ${provider.id} migration.`,
    );
    try {
      const result = await runWorkflow({
        ...configuration,
        after,
        output,
        onProgress: options.onProgress,
      });
      jobs[jobKey] = { ...(jobs[jobKey] as object), status: result.manifest.status };
      await writeState(statePath, state);
      return {
        status: 'processed' as const,
        provider: provider.id,
        jobKey,
        sourceHash: snapshot.hash,
        output,
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
