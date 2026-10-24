import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { approvedRepository } from './fixtures/approved-repository.ts';
import { fakeFlyMachines, type FakeMachine } from './fixtures/fake-fly-machines.ts';
import { flyMachines } from './fly-machines.ts';
import { WebhookInputError } from './github-webhooks.ts';
import {
  JOB_GUEST,
  jobChannel,
  MAX_JOB_TRANSFER_BYTES,
  reapJobMachines,
  runHostedJob,
  runJobMachine,
  unchangedReceipt,
  type HostedOutcome,
} from './hosted-runner.ts';
import { hostedTargetId, type HostedTarget } from './hosted-store.ts';
import { respond } from './local-service.ts';

const transport = vi.hoisted(() => ({ source: '', head: '', tokens: [] as string[] }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execute = promisify(actual.execFile);
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, {
    value: async (binary: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      if (binary !== 'git' || !args.includes('fetch')) return execute(binary, args, options);
      const local = [...args];
      local[local.indexOf('origin')] = transport.source;
      return execute(binary, ['-c', 'protocol.file.allow=always', ...local], options);
    },
  });
  return { ...actual, execFile };
});
vi.mock('./github.ts', async (original) => ({
  ...(await original<typeof import('./github.ts')>()),
  requestGitHub: vi.fn(async (token: string, method: string, path: string) => {
    transport.tokens.push(token);
    expect(method).toBe('GET');
    expect(path).toBe('/repos/example/application/git/ref/heads/main');
    return { object: { type: 'commit', sha: transport.head } };
  }),
}));

const APP = 'refit-jobs-test';
const FLY_TOKEN = 'fly-test-token';
const JOB = 41;
const READ_TOKEN = 'job-read-token';
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  transport.tokens = [];
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// The control side of one job: an approved repository, a state root, the job channel served on
// port 0 and a simulated Machines API. `machine` plays each created machine's part.
async function setup(machine: (created: FakeMachine) => void = () => undefined) {
  const root = await mkdtemp(join(tmpdir(), 'refit-runner-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  // The first job expects doctor to stop for a missing image, so a gated run's image is not used.
  vi.stubEnv('REFIT_DOCKER_IMAGE', undefined);
  const sample = await approvedRepository(root);
  transport.source = sample.source;
  transport.head = sample.head;
  await mkdir(join(root, 'state'));
  const directory = await realpath(join(root, 'state'));
  const channel = jobChannel();
  const server = createServer((request, response) => {
    void channel.handle(request, response).catch((error: unknown) => {
      respond(response, error instanceof WebhookInputError ? error.status : 500, {
        error: error instanceof Error ? error.message : 'unknown',
      });
      request.resume();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const callback = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fake = await fakeFlyMachines({ app: APP, token: FLY_TOKEN, onCreate: machine });
  cleanups.push(fake.close);
  const target: HostedTarget = {
    id: hostedTargetId('example/application', 'main'),
    repository: 'example/application',
    base: 'main',
    integration: null,
    installationId: 456,
    approval: sample.approval,
  };
  const controller = new AbortController();
  const progress: string[] = [];
  const machines = flyMachines({ app: APP, token: FLY_TOKEN, api: fake.api });
  const run = (overrides: Partial<Parameters<typeof runJobMachine>[0]> = {}) =>
    runJobMachine({
      machines,
      channel,
      callback,
      job: JOB,
      target,
      retry: false,
      directory,
      github: { appId: '123', installationId: 456, token: READ_TOKEN },
      image: 'registry.example/refit:job',
      region: 'iad',
      images: ['node:22-alpine'],
      timeoutSeconds: 60,
      pollSeconds: 0.05,
      signal: controller.signal,
      onProgress: (message) => progress.push(message),
      ...overrides,
    });
  return {
    sample,
    directory,
    targetDirectory: join(directory, 'targets', target.id),
    channel,
    callback,
    fake,
    machines,
    target,
    controller,
    progress,
    run,
  };
}

async function post(url: string, secret: string | undefined, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function inputs(machine: FakeMachine) {
  const response = await fetch(`${machine.config.env.REFIT_JOB_URL}/jobs/${JOB}/inputs`, {
    headers: { Authorization: `Bearer ${machine.config.env.REFIT_JOB_SECRET}` },
  });
  expect(response.status).toBe(200);
  return response.json();
}

function report(machine: FakeMachine, body: unknown, secret = machine.config.env.REFIT_JOB_SECRET) {
  return post(`${machine.config.env.REFIT_JOB_URL}/jobs/${JOB}/receipt`, secret, body);
}

const encode = (value: string) => Buffer.from(value).toString('base64');

it('runs a job on its own machine with only a read token, collects the report and destroys the machine', async () => {
  let booted: Promise<HostedOutcome> | undefined;
  const job = await setup((machine) => {
    booted = runHostedJob({
      url: machine.config.env.REFIT_JOB_URL,
      job: Number(machine.config.env.REFIT_JOB_ID),
      secret: machine.config.env.REFIT_JOB_SECRET,
      signal: AbortSignal.timeout(60_000),
    });
  });
  const outcome = await job.run();
  console.log(job.progress.join('\n'));

  // Without the validation image, refit doctor stops the job before scanning: a real outcome of
  // the existing pollServiceTarget path, run by the machine against the approved checkout.
  expect(outcome).toEqual({
    status: 'finished',
    receipt: expect.objectContaining({
      status: 'needs-attention',
      output: null,
      revision: job.sample.head,
      readiness: 'needs-attention',
    }),
  });
  expect(await booted).toEqual(outcome);
  expect(transport.tokens.length).toBeGreaterThan(0);
  expect(transport.tokens.every((token) => token === READ_TOKEN)).toBe(true);

  const [created] = job.fake.machines.values();
  expect(created).toMatchObject({
    region: 'iad',
    state: 'destroyed',
    config: {
      image: 'registry.example/refit:job',
      guest: JOB_GUEST,
      metadata: { refit: 'job', refit_job: String(JOB) },
      auto_destroy: true,
      restart: { policy: 'no' },
    },
  });
  expect(Object.keys(created.config.env).sort()).toEqual([
    'REFIT_HOSTED_IMAGES',
    'REFIT_JOB_ID',
    'REFIT_JOB_SECRET',
    'REFIT_JOB_URL',
  ]);
  expect(created.config.env.REFIT_HOSTED_IMAGES).toBe('node:22-alpine');
  expect(created.config.env.REFIT_JOB_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const create = JSON.stringify(job.fake.calls.find((call) => call.method === 'POST'));
  for (const secret of ['privateKeyFile', 'PRIVATE_KEY', 'DATABASE', 'postgres', READ_TOKEN])
    expect(create).not.toContain(secret);
  expect(job.fake.calls.map((call) => call.method)).toContain('DELETE');
  expect(job.channel.has(JOB)).toBe(false);
  // The channel forgets the job once it ends: its secret no longer opens anything.
  expect((await report(created, { formatVersion: 1, job: JOB })).status).toBe(401);
}, 60_000);

it('carries only the watch state a later run reads and stores the evidence the machine returns', async () => {
  let received: Record<string, unknown> | undefined;
  const job = await setup((machine) => {
    void (async () => {
      received = await inputs(machine);
      const output = join(job.targetDirectory, 'runs', 'key-2');
      expect(
        await report(machine, {
          formatVersion: 1,
          job: JOB,
          status: 'finished',
          receipt: {
            status: 'validated',
            output,
            message: 'Baseline and patched checks passed.',
            revision: job.sample.head,
            readiness: 'ready-for-validation',
          },
          files: [
            { path: 'state.json', content: encode('{"jobs":{"key":{"status":"validated"}}}') },
            { path: 'runs/key-2/report.json', content: encode('{"status":"validated"}') },
            { path: 'snapshots/new-source.json', content: encode('{"new":true}') },
          ],
        }),
      ).toEqual({ status: 202, body: { job: JOB, status: 'accepted' } });
    })();
  });
  const state = job.targetDirectory;
  for (const [path, content] of Object.entries({
    'state.json': JSON.stringify({ formatVersion: 1, jobs: {}, lastSource: 'old-source' }),
    'snapshots/old-source.json': '{"old":true}',
    'snapshots/before.baseline.json': '{"baseline":true}',
    'snapshots/superseded.json': '{"superseded":true}',
    'runs/key-1/report.json': '{"status":"error"}',
    'observations/old-source.json': '{}',
    'github/checkout/README.md': 'checkout',
    'approved-inputs/before.json': '{}',
  })) {
    await mkdir(join(state, path, '..'), { recursive: true });
    await writeFile(join(state, path), content);
  }

  const outcome = await job.run();
  expect(outcome).toEqual({
    status: 'finished',
    receipt: {
      status: 'validated',
      output: join(state, 'runs', 'key-2'),
      message: 'Baseline and patched checks passed.',
      revision: job.sample.head,
      readiness: 'ready-for-validation',
    },
  });
  expect(received).toMatchObject({
    formatVersion: 1,
    job: JOB,
    directory: job.directory,
    target: { id: job.target.id, approval: job.sample.approval },
    retry: false,
    github: { appId: '123', installationId: 456, token: READ_TOKEN },
  });
  expect(received!.deadline).toBeGreaterThan(Date.now());
  const files = received!.files as { path: string; content: string }[];
  expect(files.map((file) => file.path).sort()).toEqual([
    'snapshots/before.baseline.json',
    'snapshots/old-source.json',
    'state.json',
  ]);
  expect(
    Buffer.from(files.find((file) => file.path === 'state.json')!.content, 'base64').toString(),
  ).toContain('old-source');
  expect(await readFile(join(state, 'state.json'), 'utf8')).toBe(
    '{"jobs":{"key":{"status":"validated"}}}',
  );
  expect(await readFile(join(state, 'runs/key-2/report.json'), 'utf8')).toBe(
    '{"status":"validated"}',
  );
  expect(await readFile(join(state, 'snapshots/new-source.json'), 'utf8')).toBe('{"new":true}');
  expect(await readFile(join(state, 'runs/key-1/report.json'), 'utf8')).toBe('{"status":"error"}');
  expect(job.fake.calls.at(-1)?.method).toBe('DELETE');
});

it('destroys the machine when the job is cancelled', async () => {
  const job = await setup((machine) => {
    expect(machine.state).toBe('started');
    job.controller.abort();
  });
  const outcome = await job.run();
  expect(outcome).toMatchObject({
    status: 'failed',
    receipt: { status: 'interrupted', message: expect.stringContaining('was cancelled') },
  });
  const [created] = job.fake.machines.values();
  expect(created.state).toBe('destroyed');
  expect(job.progress).toContain(`Job machine ${created.id} destroyed.`);
});

it('destroys the machine when the job times out', async () => {
  const job = await setup();
  const outcome = await job.run({ timeoutSeconds: 0.3, pollSeconds: 10 });
  expect(outcome).toMatchObject({
    status: 'failed',
    receipt: {
      status: 'error',
      message: expect.stringContaining('exceeded the 0.3-second job timeout'),
    },
  });
  expect([...job.fake.machines.values()][0].state).toBe('destroyed');
});

it('fails the job at once when its machine exits without a report', async () => {
  const job = await setup((machine) => job.fake.exit(machine.id));
  const started = Date.now();
  const outcome = await job.run({ timeoutSeconds: 60 });
  expect(outcome).toMatchObject({
    status: 'failed',
    receipt: { status: 'error', message: expect.stringMatching(/destroyed without a report/) },
  });
  expect(Date.now() - started).toBeLessThan(5_000);
});

it('rejects forged receipts without disturbing the job, then accepts the genuine one', async () => {
  const job = await setup((machine) => {
    void (async () => {
      const genuine = {
        formatVersion: 1,
        job: JOB,
        status: 'finished',
        receipt: { status: 'up-to-date', output: null, message: 'Nothing changed.' },
        files: [],
      };
      const url = machine.config.env.REFIT_JOB_URL;
      expect((await report(machine, genuine, 'forged-secret')).status).toBe(401);
      expect((await report(machine, genuine, '')).status).toBe(401);
      // Another job's URL with this job's secret is refused alike.
      expect(
        (await post(`${url}/jobs/${JOB + 1}/receipt`, machine.config.env.REFIT_JOB_SECRET, genuine))
          .status,
      ).toBe(401);
      const stolen = await fetch(`${url}/jobs/${JOB}/inputs`, {
        headers: { Authorization: 'Bearer forged-secret' },
      });
      expect(stolen.status).toBe(401);
      expect((await report(machine, genuine)).status).toBe(202);
    })();
  });
  expect(await job.run()).toEqual({
    status: 'finished',
    receipt: { status: 'up-to-date', output: null, message: 'Nothing changed.' },
  });
});

it('fails the job when an authenticated machine returns evidence outside its target', async () => {
  const cases = [
    {
      files: [{ path: '../escaped.json', content: encode('{}') }],
      receipt: { status: 'validated', output: null, message: null },
    },
    {
      files: [{ path: 'github/checkout/.git/config', content: encode('[core]') }],
      receipt: { status: 'validated', output: null, message: null },
    },
    { files: [], receipt: { status: 'validated', output: '/tmp/elsewhere', message: null } },
    { files: [], receipt: { status: 'Validated; DROP', output: null, message: null } },
    { files: [], receipt: { status: 'validated', output: null, message: null }, job: JOB + 1 },
  ];
  for (const { job: reported, ...forged } of cases) {
    let answer: { status: number; body: { error?: string } } | undefined;
    const job = await setup((machine) => {
      void report(machine, {
        formatVersion: 1,
        job: reported ?? JOB,
        status: 'finished',
        ...forged,
      }).then((response) => (answer = response));
    });
    const outcome = await job.run();
    expect(outcome).toMatchObject({
      status: 'failed',
      receipt: {
        status: 'error',
        message: expect.stringMatching(/^Job machine evidence was refused: /),
      },
    });
    expect(answer?.status).toBe(422);
    await expect(stat(join(job.directory, 'targets', 'escaped.json'))).rejects.toThrow('ENOENT');
    await expect(stat(join(job.targetDirectory, 'github'))).rejects.toThrow('ENOENT');
  }
});

it('accepts one report per job', async () => {
  const channel = jobChannel();
  const session = channel.open({
    formatVersion: 1,
    job: JOB,
    deadline: Date.now() + 60_000,
    directory: '/state',
    target: { id: '0123456789abcdef' } as HostedTarget,
    retry: false,
    github: { appId: '1', installationId: 1, token: 'token' },
    files: [],
  });
  const server = createServer((request, response) => {
    void channel.handle(request, response).catch((error: WebhookInputError) => {
      respond(response, error.status, { error: error.message });
      request.resume();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jobs/${JOB}/receipt`;
  const body = {
    formatVersion: 1,
    job: JOB,
    status: 'failed',
    receipt: { status: 'error', output: null, message: 'boom' },
    files: [],
  };
  expect((await post(url, session.secret, body)).status).toBe(202);
  expect(await post(url, session.secret, body)).toEqual({
    status: 409,
    body: { error: 'This job already reported.' },
  });
  expect(await session.report).toEqual({ status: 'failed', receipt: body.receipt });
  session.close();
});

it('caps the evidence a machine can return and the state it receives', async () => {
  let answer: { status: number; body: { error?: string } } | undefined;
  const job = await setup((machine) => {
    const content = 'A'.repeat(MAX_JOB_TRANSFER_BYTES);
    void report(machine, {
      formatVersion: 1,
      job: JOB,
      status: 'finished',
      receipt: { status: 'validated', output: null, message: null },
      files: [{ path: 'runs/huge/blob', content }],
    }).then((response) => (answer = response));
  });
  const outcome = await job.run();
  expect(answer).toEqual({ status: 413, body: { error: 'Request body exceeds 64 MiB.' } });
  expect(outcome).toMatchObject({
    status: 'failed',
    receipt: {
      status: 'error',
      message: 'Job machine evidence was refused: Request body exceeds 64 MiB.',
    },
  });
  await expect(stat(join(job.targetDirectory, 'runs', 'huge'))).rejects.toThrow('ENOENT');
  expect([...job.fake.machines.values()][0].state).toBe('destroyed');

  // State a machine could not accept never starts one.
  await writeFile(
    join(job.targetDirectory, 'state.json'),
    JSON.stringify({ formatVersion: 1, jobs: {}, lastSource: 'large' }),
  );
  await mkdir(join(job.targetDirectory, 'snapshots'), { recursive: true });
  await writeFile(
    join(job.targetDirectory, 'snapshots', 'large.json'),
    Buffer.alloc((MAX_JOB_TRANSFER_BYTES / 4) * 3 + 1),
  );
  const creates = job.fake.calls.filter((call) => call.method === 'POST').length;
  await expect(job.run({ job: JOB + 1 })).rejects.toThrow(
    'Target state exceeds 64 MiB, more than a job machine accepts.',
  );
  expect(job.fake.calls.filter((call) => call.method === 'POST')).toHaveLength(creates);
}, 60_000);

it('reaps job machines that no live job owns', async () => {
  const fake = await fakeFlyMachines({ app: APP, token: FLY_TOKEN });
  cleanups.push(fake.close);
  const machines = flyMachines({ app: APP, token: FLY_TOKEN, api: fake.api });
  const create = (metadata: Record<string, string>) =>
    machines.create({
      region: 'iad',
      image: 'registry.example/refit:job',
      env: {},
      guest: { ...JOB_GUEST },
      metadata,
    });
  const running = await create({ refit: 'job', refit_job: '1' });
  const elsewhere = await create({ refit: 'job', refit_job: '2' });
  const orphan = await create({ refit: 'job', refit_job: '3' });
  const malformed = await create({ refit: 'job', refit_job: 'not-a-job' });
  const unrelated = await create({ purpose: 'something else' });
  const destroyed = await reapJobMachines(machines, (job) => job === 1 || job === 2);
  expect(destroyed.sort()).toEqual([orphan.id, malformed.id].sort());
  expect(
    [running, elsewhere, unrelated].map((machine) => fake.machines.get(machine.id)?.state),
  ).toEqual(['started', 'started', 'started']);
});

it('reuses a receipt only for a finished, ready job on the same commit, approval and build with no fetched contract', () => {
  const revision = 'a'.repeat(40);
  const current = { revision, fingerprint: 'f'.repeat(64), build: 'build-1' };
  const receipt = {
    status: 'needs-review',
    output: '/data/targets/abc/runs/key-1',
    message: 'Operation changes need review.',
    revision,
    readiness: 'ready-for-validation',
    fingerprint: current.fingerprint,
    build: current.build,
    liveContract: false,
  };
  const previous = { job: 7, status: 'finished', receipt };
  const reused = {
    ...receipt,
    message:
      'Reused the receipt of job 7: same commit, approval and worker build, so nothing ran. Operation changes need review.',
    unchangedSince: 7,
  };
  expect(unchangedReceipt(previous, current)).toEqual(reused);
  // A chain of reused receipts keeps pointing at the job that did the work, without repeating it.
  expect(unchangedReceipt({ job: 9, status: 'finished', receipt: reused }, current)).toEqual(
    reused,
  );
  const runs = [
    null,
    { ...previous, receipt: null },
    { ...previous, status: 'failed' },
    { ...previous, status: 'cancelled' },
    { ...previous, receipt: { ...receipt, revision: 'b'.repeat(40) } },
    { ...previous, receipt: { ...receipt, revision: null } },
    { ...previous, receipt: { ...receipt, fingerprint: 'e'.repeat(64) } },
    { ...previous, receipt: { ...receipt, build: 'build-0' } },
    { ...previous, receipt: { ...receipt, build: undefined } },
    { ...previous, receipt: { ...receipt, liveContract: true } },
    { ...previous, receipt: { ...receipt, liveContract: undefined } },
    { ...previous, receipt: { ...receipt, readiness: 'needs-attention' } },
    { ...previous, receipt: { ...receipt, readiness: null } },
  ];
  for (const run of runs) expect(unchangedReceipt(run, current), JSON.stringify(run)).toBeNull();
});
