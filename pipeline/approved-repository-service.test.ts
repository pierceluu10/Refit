import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { gitEnvironment } from './git-environment.ts';
import {
  approveRepositoryEnrollment,
  inspectRepositoryEnrollment,
  RepositoryApprovalError,
} from './repository-enrollment.ts';
import { pollServiceTarget } from './service-worker.ts';
import { runLocalService } from './local-service.ts';
import { readServiceConfiguration } from './service-configuration.ts';
import { readWorkflowConfiguration } from './workflow-configuration.ts';
import { verifyArtifacts } from './verification.ts';
import * as watch from './watch.ts';

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
      const report = JSON.parse(await readFile(join(record.output!, 'report.json'), 'utf8'));
      expect(await readFile(join(record.output!, 'pull-request.md'), 'utf8')).toContain(
        `**Integration:** \`${id}\``,
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
      Object.values(repeated.registry.targets).every(
        ({ message }) => message === 'Saved worker result reused; checks were not rerun.',
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
    const report = JSON.parse(await readFile(join(result.output, 'report.json'), 'utf8'));
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
    const report = JSON.parse(await readFile(join(record.output!, 'report.json'), 'utf8'));
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
