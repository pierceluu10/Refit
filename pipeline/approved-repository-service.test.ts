import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { stripeContractFile, stripeContractVersion } from './enrollment-contracts.ts';
import {
  GENERATED_REPOSITORY,
  GENERATED_VERSIONS,
  SAVED_CONTRACTS,
  savedContractDownloads,
} from './fixtures/approved-repository.ts';
import { gitEnvironment } from './git-environment.ts';
import {
  approveRepositoryEnrollment,
  inspectRepositoryEnrollment,
  RepositoryApprovalError,
} from './repository-enrollment.ts';
import * as readiness from './readiness.ts';
import { UnclassifiedCheckError } from './readiness.ts';
import { pollServiceTarget, summarizePoll } from './service-worker.ts';
import { runLocalService } from './local-service.ts';
import { readServiceConfiguration, type ServiceTarget } from './service-configuration.ts';
import { readWorkflowConfiguration } from './workflow-configuration.ts';
import { verifyArtifacts } from './verification.ts';
import * as watch from './watch.ts';
import { readEvidence } from './state-files.ts';

const transport = vi.hoisted(() => ({
  source: '',
  head: '',
  calls: [] as { binary: string; args: string[] }[],
  dockerUnavailable: false,
  native: undefined as
    undefined | ((args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>),
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execute = promisify(actual.execFile);
  transport.native = (args, cwd) => execute('git', args, { cwd, env: gitEnvironment() });
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, {
    value: async (binary: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      transport.calls.push({ binary, args });
      if (binary === 'docker' && transport.dockerUnavailable)
        throw Object.assign(new Error('Simulated unavailable Docker daemon'), {
          code: 1,
          stderr: 'Cannot connect to the Docker daemon',
        });
      if (binary !== 'git' || !args.includes('fetch')) return execute(binary, args, options);
      const local = [...args];
      local[local.indexOf('origin')] = transport.source;
      return execute(binary, ['-c', 'protocol.file.allow=always', ...local], options);
    },
  });
  return { ...actual, execFile };
});
vi.mock('./github-app.ts', () => ({
  authenticateGitHubRead: vi.fn(async () => ({
    token: 'private-read-test-token',
    appId: 123,
    installationId: 456,
  })),
}));
vi.mock('./github.ts', async (original) => ({
  ...(await original<typeof import('./github.ts')>()),
  requestGitHub: vi.fn(async (_token: string, method: string, path: string) => {
    expect(method).toBe('GET');
    if (path === '/repos/example/application')
      return { id: 789, full_name: 'example/application', archived: false, disabled: false };
    expect(path).toBe('/repos/example/application/git/ref/heads/main');
    return { object: { type: 'commit', sha: transport.head } };
  }),
}));

const roots: string[] = [];
const fixture = resolve('pipeline/fixtures/endpoint-replacement');
const APP = { appId: '123', privateKeyFile: 'unused-test-key' };
const WEBHOOK_SECRET = 'webhook-secret-for-approved-profile-tests-123';
const CONTROL_TOKEN = 'control-secret-for-approved-profile-tests-456';
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  transport.calls = [];
  transport.dockerUnavailable = false;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function commit() {
  await transport.native!(['add', '.'], transport.source);
  await transport.native!(
    [
      '-c',
      'user.name=Refit Tests',
      '-c',
      'user.email=tests@refit.local',
      'commit',
      '--quiet',
      '-m',
      'test: update approved application',
    ],
    transport.source,
  );
  transport.head = (await transport.native!(['rev-parse', 'HEAD'], transport.source)).stdout.trim();
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'refit-approved-app-'));
  roots.push(root);
  transport.source = join(root, 'source');
  await cp(join(fixture, 'repository'), transport.source, { recursive: true });
  for (const name of ['before.json', 'provider.json'])
    await cp(join(fixture, name), join(transport.source, name));
  await cp(join(fixture, 'before.json'), join(transport.source, 'after.json'));
  const configuration = {
    formatVersion: 1,
    before: './before.json',
    after: './after.json',
    providerConfig: './provider.json',
    apiVersion: '1',
    fullDiff: Boolean(process.env.REFIT_OASDIFF),
    image: process.env.REFIT_DOCKER_IMAGE ?? 'unused-test-image',
    baselineCommand: ['node', '--experimental-strip-types', 'simulator/check.mjs', 'before'],
    command: ['node', '--experimental-strip-types', 'simulator/check.mjs', 'after'],
  };
  await writeFile(join(transport.source, '.refit.json'), JSON.stringify(configuration));
  await transport.native!(['init', '--quiet', '--initial-branch=main'], transport.source);
  await commit();
  const enrollment = await inspectRepositoryEnrollment({
    repository: transport.source,
    github: 'example/application',
    base: 'main',
  });
  await approveRepositoryEnrollment({
    enrollment,
    fingerprint: enrollment.fingerprint,
    output: join(root, 'approval.json'),
  });
  const servicePath = join(root, 'service.json');
  await writeFile(
    servicePath,
    JSON.stringify({
      formatVersion: 1,
      targets: [
        {
          id: 'approved',
          repository: 'example/application',
          base: 'main',
          approval: './approval.json',
        },
      ],
    }),
  );
  const target = (await readServiceConfiguration(servicePath, APP))[0];
  return {
    root,
    configuration,
    target,
    input: {
      target,
      app: APP,
      stateDirectory: join(root, 'worker'),
      signal: new AbortController().signal,
      repairAttempts: 0,
    },
  };
}

// A repository that commits no .refit.json, so the worker runs the configuration Refit generates.
async function setupGenerated() {
  const root = await mkdtemp(join(tmpdir(), 'refit-generated-app-'));
  roots.push(root);
  transport.source = join(root, 'source');
  await cp(GENERATED_REPOSITORY, transport.source, { recursive: true });
  await transport.native!(['init', '--quiet', '--initial-branch=main'], transport.source);
  await commit();
  return {
    root,
    contracts: join(root, 'contracts'),
    input: {
      app: APP,
      stateDirectory: join(root, 'worker'),
      signal: new AbortController().signal,
      repairAttempts: 0,
    },
  };
}

function generatedTarget(approval: ServiceTarget['approval'] & object): ServiceTarget {
  return {
    id: 'generated',
    integration: 'stripe',
    repository: 'example/application',
    base: 'main',
    documentationSources: [],
    approval,
  };
}

async function setupMultiple() {
  const root = await mkdtemp(join(tmpdir(), 'refit-multiple-app-'));
  roots.push(root);
  transport.source = join(root, 'source');
  await cp(resolve('pipeline/fixtures/multiple-integrations/repository'), transport.source, {
    recursive: true,
  });
  await transport.native!(['init', '--quiet', '--initial-branch=main'], transport.source);
  await commit();
  const enrollment = await inspectRepositoryEnrollment({
    repository: transport.source,
    github: 'example/application',
    base: 'main',
  });
  await approveRepositoryEnrollment({
    enrollment,
    fingerprint: enrollment.fingerprint,
    output: join(root, 'approval.json'),
  });
  const service = join(root, 'service.json');
  await writeFile(
    service,
    JSON.stringify({
      formatVersion: 1,
      targets: [
        {
          id: 'billing',
          repository: 'example/application',
          base: 'main',
          approval: './approval.json',
        },
      ],
    }),
  );
  const targets = await readServiceConfiguration(service, APP);
  return {
    root,
    targets,
    input: {
      targets,
      app: APP,
      directory: join(root, 'service-state'),
      port: 0,
      once: true,
      signal: new AbortController().signal,
      webhookSecret: WEBHOOK_SECRET,
      controlToken: CONTROL_TOKEN,
    },
  };
}

async function publishSimulatedContracts() {
  for (const provider of ['stripe', 'openai'])
    await cp(
      join(transport.source, 'contracts', `${provider}-after.json`),
      join(transport.source, 'contracts', `${provider}-current.json`),
    );
  await commit();
}

it.skipIf(
  !process.env.REFIT_DOCKER_IMAGE || !process.env.REFIT_OASDIFF || !process.env.REFIT_NPM_PREPARE,
)(
  'migrates two installed SDKs independently under one approval with peer checks and offline Docker',
  async () => {
    const sample = await setupMultiple();
    const initial = await runLocalService(sample.input);
    expect(Object.keys(initial.registry.targets)).toEqual(['billing.stripe', 'billing.openai']);
    expect(Object.values(initial.registry.targets).map(({ status }) => status)).toEqual([
      'needs-review',
      'needs-review',
    ]);
    await publishSimulatedContracts();
    const changed = await runLocalService(sample.input);
    for (const [id, file] of [
      ['stripe', 'src/history.ts'],
      ['openai', 'src/model.js'],
    ]) {
      const record = changed.registry.targets[`billing.${id}`];
      expect(record).toMatchObject({
        integration: id,
        status: 'validated',
        access: 'active',
        approvalFingerprint: sample.targets[0].approval!.fingerprint,
      });
      const report = JSON.parse((await readEvidence(record.output!, 'report.json'))!);
      expect(await readFile(join(record.output!, 'pull-request.md'), 'utf8')).toContain(
        `<!-- refit-integration:${id} -->`,
      );
      expect(report.validation.baseline.status).toBe('passed');
      expect(report.validation.patched.status).toBe('passed');
      expect(report.validation.baseline.stdout).toContain('request error passed');
      expect(report.validation.patched.stdout).toContain('retrieval error passed');
      expect(report.patch.generator).toBe('deterministic');
      expect(report.publicationFiles.map((entry: { path: string }) => entry.path)).toEqual([file]);
      expect((await verifyArtifacts(record.output!)).status).toBe('integrity-verified');
    }
    expect(changed.registry.targets['billing.stripe'].output).not.toBe(
      changed.registry.targets['billing.openai'].output,
    );
    const calls = transport.calls.filter(({ binary }) => binary === 'docker').length;
    const repeated = await runLocalService(sample.input);
    expect(
      Object.values(repeated.registry.targets).every(({ message }) =>
        message?.startsWith('Saved worker result reused; checks were not rerun.'),
      ),
    ).toBe(true);
    expect(transport.calls.filter(({ binary }) => binary === 'docker')).toHaveLength(calls);
    expect((await transport.native!(['status', '--porcelain'], transport.source)).stdout).toBe('');
  },
  120_000,
);

it.skipIf(
  !process.env.REFIT_DOCKER_IMAGE || !process.env.REFIT_OASDIFF || !process.env.REFIT_NPM_PREPARE,
)(
  'retries only the selected integration while preserving the sibling failed receipt',
  async () => {
    const sample = await setupMultiple();
    await publishSimulatedContracts();
    transport.dockerUnavailable = true;
    const failed = await runLocalService(sample.input);
    expect(Object.values(failed.registry.targets).every(({ status }) => status === 'error')).toBe(
      true,
    );
    const sibling = failed.registry.targets['billing.openai'];
    transport.dockerUnavailable = false;
    const retried = await runLocalService({ ...sample.input, retryTargets: ['billing.stripe'] });
    expect(retried.registry.targets['billing.stripe'].status).toBe('validated');
    expect(retried.registry.targets['billing.stripe'].output).toMatch(/-2$/);
    expect(retried.registry.targets['billing.openai']).toEqual(sibling);
    expect((await verifyArtifacts(sibling.output!)).status).toBe('integrity-verified');
    const calls = transport.calls.filter(({ binary }) => binary === 'docker').length;
    await runLocalService({ ...sample.input, retryTargets: ['billing.stripe'] });
    expect(transport.calls.filter(({ binary }) => binary === 'docker')).toHaveLength(calls);
  },
  120_000,
);

it('loads reviewed inputs from a native App-managed checkout and reuses the worker receipt on restart', async () => {
  const sample = await setup();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No model or provider request expected');
    }),
  );
  const first = await pollServiceTarget(sample.input);
  expect(first.status).toBe('processed');
  if (first.status !== 'processed') throw new Error('Expected a first worker receipt');
  expect(first.result.manifest.status).toBe('needs-review');
  const repeated = await pollServiceTarget(sample.input);
  expect(repeated.status).toBe('already-processed');
  expect(repeated.output).toBe(first.output);
  expect(first).toMatchObject({ checkout: { revision: transport.head } });
  expect(transport.calls.filter((call) => call.binary === 'docker')).toHaveLength(0);
  expect(
    transport.calls.every((call) => !call.args.join(' ').includes('private-read-test-token')),
  ).toBe(true);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('downloads no Stripe contract for a repository that commits its .refit.json', async () => {
  const sample = await setup();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No contract download expected');
    }),
  );
  const contracts = join(sample.root, 'contracts');
  expect((await pollServiceTarget({ ...sample.input, contracts })).status).toBe('processed');
  expect(globalThis.fetch).not.toHaveBeenCalled();
  await expect(readdir(contracts)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('stops a generated configuration whose contracts cannot be downloaded before loading the approval', async () => {
  const sample = await setupGenerated();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('unavailable', { status: 503 })),
  );
  const worker = vi.spyOn(watch, 'watchOnce');
  // The approval is never read: the download fails first.
  const target = generatedTarget({
    formatVersion: 2,
    kind: 'refit-repository-approval',
    repository: 'example/application',
    base: 'main',
    fingerprint: 'f'.repeat(64),
    files: [],
    reviewedRevision: transport.head,
    approvedAt: '2026-10-24T00:00:00.000Z',
  });
  await expect(
    pollServiceTarget({ ...sample.input, target, contracts: sample.contracts }),
  ).rejects.toThrow('The specification source returned HTTP 503.');
  expect(worker).not.toHaveBeenCalled();
  await expect(readdir(sample.contracts)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('stops a generated configuration for review when a Stripe-importing file does not parse', async () => {
  const sample = await setupGenerated();
  await writeFile(
    join(transport.source, 'src/billing.ts'),
    "import Stripe from 'stripe';\nconst total = ;\n",
  );
  await commit();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No contract download expected');
    }),
  );
  const worker = vi.spyOn(watch, 'watchOnce');
  const target = generatedTarget({
    formatVersion: 2,
    kind: 'refit-repository-approval',
    repository: 'example/application',
    base: 'main',
    fingerprint: 'f'.repeat(64),
    files: [],
    integrations: ['stripe'],
    reviewedRevision: transport.head,
    approvedAt: '2026-10-24T00:00:00.000Z',
  });
  const stopped = pollServiceTarget({ ...sample.input, target, contracts: sample.contracts });
  // A RepositoryApprovalError is what hosted jobs record as needs-review rather than error.
  await expect(stopped).rejects.toBeInstanceOf(RepositoryApprovalError);
  await expect(stopped).rejects.toThrow('src/billing.ts imports stripe but does not parse');
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(worker).not.toHaveBeenCalled();
});

it.skipIf(!SAVED_CONTRACTS)(
  "downloads the generated configuration's contracts once, loads its approval and runs from the saved files",
  async () => {
    const sample = await setupGenerated();
    const enrollment = await inspectRepositoryEnrollment({
      repository: transport.source,
      github: 'example/application',
      base: 'main',
      contracts: SAVED_CONTRACTS,
    });
    const { approval } = await approveRepositoryEnrollment({
      enrollment,
      fingerprint: enrollment.fingerprint,
      output: join(sample.root, 'approval.json'),
    });
    const downloads = await savedContractDownloads(SAVED_CONTRACTS!);
    vi.stubGlobal('fetch', vi.fn(downloads.respond));
    const input = {
      ...sample.input,
      target: generatedTarget(approval),
      contracts: sample.contracts,
    };
    // The hosted worker runs refit doctor first. The approval loads and the contracts check passes;
    // this two-file fixture still lacks an installed SDK, so doctor stops before scanning.
    const hosted = await pollServiceTarget({ ...input, inspectReadiness: true });
    expect(vi.mocked(globalThis.fetch).mock.calls.map(([url]) => url)).toEqual(downloads.urls);
    expect((await readdir(join(sample.contracts, 'refit'))).sort()).toEqual(
      GENERATED_VERSIONS.map((version) => stripeContractFile(version).slice('refit/'.length)),
    );
    if (hosted.status !== 'readiness-blocked')
      throw new Error(`Expected doctor to stop, got ${hosted.status}`);
    const checks = new Map(hosted.readiness.checks.map((check) => [check.id, check.status]));
    expect(checks.get('configuration')).toBe('passed');
    expect(checks.has('contracts')).toBe(false);
    // Without doctor the job compares against the saved target contract, a file that cannot change.
    const worker = vi.spyOn(watch, 'watchOnce').mockResolvedValue({
      status: 'already-processed',
      provider: 'stripe',
      jobKey: 'generated',
      sourceHash: stripeContractVersion(GENERATED_VERSIONS[1])!.sha256,
      previousStatus: 'needs-review',
      output: null,
    });
    await pollServiceTarget(input);
    expect(worker).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          kind: 'file',
          path: join(sample.contracts, stripeContractFile(GENERATED_VERSIONS[1])),
        },
      }),
    );
    // The second poll read the saved, checked files and downloaded nothing.
    expect(globalThis.fetch).toHaveBeenCalledTimes(GENERATED_VERSIONS.length);
  },
);

it.skipIf(!SAVED_CONTRACTS)(
  'runs a generated configuration without a lockfile only under --publish-unresolved',
  async () => {
    const sample = await setupGenerated();
    await rm(join(transport.source, 'package-lock.json'));
    await commit();
    const enrollment = await inspectRepositoryEnrollment({
      repository: transport.source,
      github: 'example/application',
      base: 'main',
      contracts: SAVED_CONTRACTS,
      allowUntested: true,
    });
    const { approval } = await approveRepositoryEnrollment({
      enrollment,
      fingerprint: enrollment.fingerprint,
      output: join(sample.root, 'approval.json'),
    });
    const downloads = await savedContractDownloads(SAVED_CONTRACTS!);
    vi.stubGlobal('fetch', vi.fn(downloads.respond));
    const input = {
      ...sample.input,
      target: generatedTarget(approval),
      contracts: sample.contracts,
      inspectReadiness: true,
    };
    const worker = vi.spyOn(watch, 'watchOnce').mockResolvedValue({
      status: 'already-processed',
      provider: 'stripe',
      jobKey: 'generated',
      sourceHash: stripeContractVersion(GENERATED_VERSIONS[1])!.sha256,
      previousStatus: 'needs-review',
      output: null,
    });
    // Without decision 1 the regenerated configuration refuses again, before doctor or the workflow.
    await expect(pollServiceTarget(input)).rejects.toThrow(
      new RepositoryApprovalError(
        'Repository configuration needs review: Refit installs dependencies only from a committed lockfile, and this repository has none at its root. Run npm install, pnpm install or yarn install once and commit the lockfile it writes.',
      ),
    );
    expect(worker).not.toHaveBeenCalled();
    // With it, doctor's dependency check does not stop the job; the workflow prepares, fails on the
    // missing lockfile and publishes the patch untested for review. Docker belongs to the worker
    // machine, not the repository, and the machine running this test may have none.
    const doctor = readiness.inspectRepositoryReadiness;
    const inspect = vi
      .spyOn(readiness, 'inspectRepositoryReadiness')
      .mockImplementation(async (options) => {
        const report = await doctor(options);
        return { ...report, checks: report.checks.filter((check) => check.id !== 'docker') };
      });
    const polled = await pollServiceTarget({ ...input, publishUnresolved: true });
    expect(polled.status).toBe('already-processed');
    const report = await inspect.mock.results[0].value;
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: 'dependencies', status: 'blocked' }),
    );
    expect(worker).toHaveBeenCalledWith(
      expect.objectContaining({
        configuration: expect.objectContaining({
          command: ['npm', 'test'],
          prepareDependencies: true,
          allowUnresolved: true,
        }),
      }),
    );
  },
);

it('blocks changed commands before source polling, paid generation, validation or publication', async () => {
  const sample = await setup();
  await writeFile(
    join(transport.source, '.refit.json'),
    JSON.stringify({
      ...sample.configuration,
      command: ['node', '-e', 'throw new Error("must never execute")'],
    }),
  );
  await commit();
  const worker = vi.spyOn(watch, 'watchOnce');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Must not request a model or API source');
    }),
  );
  await expect(
    pollServiceTarget({
      ...sample.input,
      aiPatch: { apiKey: 'unused-private-key', model: 'test-model' },
      publishDraft: true,
      retry: true,
    }),
  ).rejects.toBeInstanceOf(RepositoryApprovalError);
  expect(worker).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(transport.calls.some((call) => call.binary === 'docker')).toBe(false);
  await expect(readFile(join(sample.input.stateDirectory, 'state.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('keeps installation access active for a review-required profile and continues another explicit target', async () => {
  const sample = await setup();
  await writeFile(
    join(transport.source, '.refit.json'),
    JSON.stringify({ ...sample.configuration, command: ['node', '--version'] }),
  );
  await commit();
  const workflow = await readWorkflowConfiguration(join(transport.source, '.refit.json'));
  const other = {
    id: 'operator',
    repository: 'example/application',
    base: 'main',
    workflow,
    source: { kind: 'file' as const, path: join(transport.source, 'after.json') },
    documentationSources: [],
  };
  const result = await runLocalService({
    targets: [sample.target, other],
    app: APP,
    directory: join(sample.root, 'service-state'),
    port: 0,
    once: true,
    signal: new AbortController().signal,
    webhookSecret: WEBHOOK_SECRET,
    controlToken: CONTROL_TOKEN,
  });
  expect(result.registry.targets.approved).toMatchObject({
    access: 'active',
    status: 'needs-review',
    approvalFingerprint: sample.target.approval?.fingerprint,
    message: expect.stringContaining('Approved repository inputs changed'),
  });
  expect(result.registry.targets.operator.output).toBeTruthy();
  expect(result.registry.targets.operator.status).toBe('needs-review');
  expect(transport.calls.some((call) => call.binary === 'docker')).toBe(false);
});

it.skipIf(!process.env.REFIT_DOCKER_IMAGE || !process.env.REFIT_OASDIFF)(
  'observes a committed source update, validates its migration in real offline Docker and deduplicates without reapproval',
  async () => {
    const sample = await setup();
    await pollServiceTarget(sample.input);
    const reviewedFingerprint = sample.target.approval!.fingerprint;
    await cp(join(fixture, 'after.json'), join(transport.source, 'after.json'));
    await commit();
    const result = await pollServiceTarget(sample.input);
    expect(result.status).toBe('processed');
    if (result.status !== 'processed') throw new Error('Expected changed source to start one job');
    expect(result.result.manifest.status).toBe('validated');
    const report = JSON.parse((await readEvidence(result.output, 'report.json'))!);
    expect(report.validation.baseline.status).toBe('passed');
    expect(report.validation.patched.status).toBe('passed');
    expect(report.patch.generator).toBe('deterministic');
    expect(report.publicationFiles.map((file: { path: string }) => file.path)).toEqual([
      'src/items.ts',
    ]);
    expect((await verifyArtifacts(result.output)).status).toBe('integrity-verified');
    expect(
      (
        await inspectRepositoryEnrollment({
          repository: transport.source,
          github: 'example/application',
          base: 'main',
        })
      ).fingerprint,
    ).toBe(reviewedFingerprint);
    const dockerCalls = transport.calls.filter((call) => call.binary === 'docker').length;
    expect((await pollServiceTarget(sample.input)).status).toBe('already-processed');
    expect((await pollServiceTarget({ ...sample.input, retry: true })).status).toBe(
      'already-processed',
    );
    expect(transport.calls.filter((call) => call.binary === 'docker')).toHaveLength(dockerCalls);
    expect((await transport.native!(['status', '--porcelain'], transport.source)).stdout).toBe('');
  },
  60_000,
);

it.skipIf(!process.env.REFIT_DOCKER_IMAGE || !process.env.REFIT_OASDIFF)(
  'retains a failed approved job and recovers it once through the service after Docker becomes available',
  async () => {
    const sample = await setup();
    await cp(join(fixture, 'after.json'), join(transport.source, 'after.json'));
    await commit();
    const input = {
      targets: [sample.target],
      app: APP,
      directory: join(sample.root, 'service-state'),
      port: 0,
      once: true,
      signal: new AbortController().signal,
      webhookSecret: WEBHOOK_SECRET,
      controlToken: CONTROL_TOKEN,
    };
    transport.dockerUnavailable = true;
    const first = await runLocalService(input);
    expect(first.registry.targets.approved).toMatchObject({ access: 'active', status: 'error' });
    const failedOutput = first.registry.targets.approved.output!;
    expect((await verifyArtifacts(failedOutput)).status).toBe('integrity-verified');
    transport.dockerUnavailable = false;
    const dockerCalls = transport.calls.filter((call) => call.binary === 'docker').length;
    const cached = await runLocalService(input);
    expect(cached.registry.targets.approved.status).toBe('error');
    expect(cached.registry.targets.approved.output).toBe(failedOutput);
    expect(transport.calls.filter((call) => call.binary === 'docker')).toHaveLength(dockerCalls);
    const retried = await runLocalService({ ...input, retryTargets: ['approved'] });
    const record = retried.registry.targets.approved;
    expect(record).toMatchObject({
      access: 'active',
      status: 'validated',
      approvalFingerprint: sample.target.approval!.fingerprint,
    });
    expect(record.output).not.toBe(failedOutput);
    expect(record.output).toMatch(/-2$/);
    const report = JSON.parse((await readEvidence(record.output!, 'report.json'))!);
    expect(report.validation.baseline.status).toBe('passed');
    expect(report.validation.patched.status).toBe('passed');
    expect(report.patch.generator).toBe('deterministic');
    expect((await verifyArtifacts(record.output!)).status).toBe('integrity-verified');
    expect((await verifyArtifacts(failedOutput)).status).toBe('integrity-verified');
    const checksAfterRetry = transport.calls.filter((call) => call.binary === 'docker').length;
    const successfulRetry = await runLocalService({ ...input, retryTargets: ['approved'] });
    expect(successfulRetry.registry.targets.approved.output).toBe(record.output);
    expect(transport.calls.filter((call) => call.binary === 'docker')).toHaveLength(
      checksAfterRetry,
    );
    expect((await transport.native!(['status', '--porcelain'], transport.source)).stdout).toBe('');
  },
  60_000,
);

// Owner decision 1: under --publish-unresolved only setup checks stop a hosted job; the checks only
// doctor sees join the draft, and the workflow reports the rest itself.
it('lets only setup problems stop a job under --publish-unresolved and passes doctor findings on', async () => {
  const sample = await setup();
  const check = (id: string, title: string) => ({
    id,
    title,
    status: 'blocked' as const,
    detail: `${title} detail.`,
    action: `${title} action.`,
  });
  const readinessReport = (...checks: ReturnType<typeof check>[]) => ({
    formatVersion: 1 as const,
    kind: 'refit-readiness' as const,
    status: 'needs-attention' as const,
    configuration: '.refit.json',
    repository: null,
    revision: null,
    provider: null,
    image: null,
    currentSourceChecked: false,
    checks,
    sdkCoverage: null,
    scope: [],
  });
  const coverage = check('sdk-coverage', 'SDK call mapping');
  const migration = check('migration-coverage', 'Supported migration coverage');
  const inspect = vi.spyOn(readiness, 'inspectRepositoryReadiness');
  const worker = vi.spyOn(watch, 'watchOnce').mockResolvedValue({
    status: 'already-processed',
    provider: 'stripe',
    jobKey: 'decision-1',
    sourceHash: 'a'.repeat(64),
    previousStatus: 'needs-review',
    output: null,
  });
  const input = { ...sample.input, inspectReadiness: true };

  inspect.mockResolvedValue(readinessReport(coverage, migration));
  const stopped = await pollServiceTarget(input);
  expect(stopped).toMatchObject({ status: 'readiness-blocked', stops: [coverage, migration] });
  expect(summarizePoll(stopped).message).toBe(
    'refit doctor found setup problems: SDK call mapping, Supported migration coverage. Scanning and checks did not run.',
  );
  expect(worker).not.toHaveBeenCalled();

  expect((await pollServiceTarget({ ...input, publishUnresolved: true })).status).toBe(
    'already-processed',
  );
  expect(worker.mock.calls[0][0].configuration).toMatchObject({
    allowUnresolved: true,
    doctor: [coverage],
  });

  const docker = check('docker', 'Local Docker image');
  inspect.mockResolvedValue(readinessReport(coverage, docker));
  const setupStop = await pollServiceTarget({ ...input, publishUnresolved: true });
  expect(setupStop).toMatchObject({ status: 'readiness-blocked', stops: [docker] });
  expect(summarizePoll(setupStop).message).toBe(
    'refit doctor found setup problems: Local Docker image. Scanning and checks did not run.',
  );

  inspect.mockResolvedValue(readinessReport(check('new-check', 'A check nobody classified')));
  await expect(pollServiceTarget({ ...input, publishUnresolved: true })).rejects.toBeInstanceOf(
    UnclassifiedCheckError,
  );
  expect(worker).toHaveBeenCalledOnce();
});
