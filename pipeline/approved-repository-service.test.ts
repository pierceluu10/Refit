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
    expect(transport.calls.filter((call) => call.binary === 'docker')).toHaveLength(dockerCalls);
    expect((await transport.native!(['status', '--porcelain'], transport.source)).stdout).toBe('');
  },
  60_000,
);
