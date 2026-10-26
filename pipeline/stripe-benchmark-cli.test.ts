import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { validateRunDirectory } from '../scripts/benchmark-results.mjs';
import { HOSTED_REPAIR_ATTEMPTS } from './validation-options.ts';

// End to end through `npm run benchmark:stripe` on a tiny root built like the setup script's:
// pinned checkouts, contracts and an SDK spec that maps `paymentIntents.retrieve`.
const execute = promisify(execFile);
const cli = resolve('pipeline/stripe-benchmark-cli.ts');
const roots: string[] = [];
const BEFORE = '2022-08-01';
const AFTER = '2022-11-15';
const PATH = '/v1/payment_intents/{intent}';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const retrieve = {
  get: {
    operationId: 'GetPaymentIntentsIntent',
    responses: {
      200: {
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/payment_intent' } },
        },
      },
    },
  },
};

async function checkout(directory: string, files: Record<string, string>) {
  const git = (...args: string[]) => execute('git', ['-C', directory, ...args]);
  await mkdir(directory, { recursive: true });
  await git('init', '-q');
  for (const [path, content] of Object.entries(files))
    await writeFile(join(directory, path), content);
  await git('add', '-A');
  await git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'pinned');
  return (await git('rev-parse', 'HEAD')).stdout.trim();
}

async function benchmarkRoot() {
  const root = await mkdtemp(join(tmpdir(), 'refit-stripe-benchmark-test-'));
  roots.push(root);
  await mkdir(join(root, 'specs'), { recursive: true });
  for (const [version, fixture] of [
    [BEFORE, 'before'],
    [AFTER, 'after'],
  ]) {
    const spec = JSON.parse(await readFile(`pipeline/fixtures/${fixture}.json`, 'utf8'));
    await writeFile(
      join(root, 'specs', `${version}.json`),
      JSON.stringify({ ...spec, paths: { [PATH]: retrieve } }),
    );
  }
  await writeFile(
    join(root, 'specs', `sdk-${AFTER}.json`),
    JSON.stringify({
      components: {
        schemas: {
          payment_intent: {
            'x-stripeOperations': [
              { method_on: 'service', path: PATH, operation: 'get', method_name: 'retrieve' },
            ],
          },
        },
      },
    }),
  );
  await writeFile(
    join(root, 'needed-specs.json'),
    JSON.stringify([{ version: BEFORE }, { version: AFTER }]),
  );
  const fixture = 'pipeline/fixtures/repository';
  const affected = await checkout(join(root, 'repos', 'acme__history'), {
    'billing.ts': await readFile(join(fixture, 'billing.ts'), 'utf8'),
    'package.json': await readFile(join(fixture, 'package.json'), 'utf8'),
  });
  const quiet = await checkout(join(root, 'repos', 'acme__quiet'), {
    'index.ts': 'export const answer = 42;\n',
  });
  // A fetch that failed after `git init`: the setup script leaves exactly this behind.
  await mkdir(join(root, 'repos', 'acme__broken'), { recursive: true });
  await execute('git', ['-C', join(root, 'repos', 'acme__broken'), 'init', '-q']);
  const entry = (repo: string, commit: string) => ({
    repo,
    stars: 1,
    commit,
    before: BEFORE,
    beforeSource: 'apiVersion pin',
    stripeDependency: '^10.0.0',
    packageManager: 'npm',
  });
  await writeFile(
    join(root, 'selected.json'),
    JSON.stringify([
      entry('acme/history', affected),
      entry('acme/broken', 'c'.repeat(40)),
      entry('acme/quiet', quiet),
    ]),
  );
  return root;
}

const run = (root: string, output: string, ...args: string[]) =>
  execute(
    process.execPath,
    ['--import', 'tsx', cli, '--root', root, '--output', output, '--allow-dirty', ...args],
    { maxBuffer: 16 * 1024 * 1024 },
  );
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
// Timing is measured, not decided by the run.
// Timings depend on host load, so only the outcomes are compared.
const outcomes = (rows: Record<string, unknown>[]) =>
  rows.map(({ seconds: _seconds, stageSeconds: _stageSeconds, ...row }) => row);

it('records the run, classifies clone failures, orders rows and resumes the same run only', async () => {
  const root = await benchmarkRoot();
  const first = join(root, 'out-1');
  await run(root, first);
  const harness = await read(join(first, 'harness.json'));
  const { stdout: head } = await execute('git', ['rev-parse', 'HEAD']);
  expect(harness).toMatchObject({
    formatVersion: 1,
    format: 'stripe-results',
    refit: { commit: head.trim(), source: 'git', allowDirty: true },
    list: { path: 'selected.json' },
    options: {},
    node: process.version,
    docker: null,
  });
  expect(validateRunDirectory(first)).toEqual({
    format: 'stripe-results',
    errors: [],
    predates: [],
  });
  const rows = await read(join(first, 'results.json'));
  expect(rows.map((row: { repo: string }) => row.repo)).toEqual([
    'acme/history',
    'acme/broken',
    'acme/quiet',
  ]);
  expect(rows[0]).toMatchObject({
    read: 'ok',
    mappedMethods: 1,
    fullAdapter: { confirmed: 1 },
    outcomeClass: 'repository',
  });
  expect(rows[1]).toEqual({
    repo: 'acme/broken',
    stars: 1,
    commit: 'c'.repeat(40),
    before: BEFORE,
    beforeSource: 'apiVersion pin',
    after: AFTER,
    packageManager: 'npm',
    infrastructure: {
      kind: 'clone',
      message: 'the directory is not a checkout with a commit of its own (the fetch failed)',
    },
    seconds: expect.any(Number),
    outcomeClass: 'infrastructure',
  });
  expect(rows[2]).toMatchObject({ read: 'ok', mappedMethods: 0, outcomeClass: 'repository' });
  const summary = await readFile(join(first, 'summary.md'), 'utf8');
  expect(summary).toContain('Repositories: 2. Affected in either mode: 1.');
  expect(summary).toContain(
    '| acme/broken | clone | the directory is not a checkout with a commit of its own (the fetch failed) |',
  );

  // Concurrency changes the schedule, not the rows.
  const parallel = join(root, 'out-3');
  await run(root, parallel, '--concurrency', '3');
  expect(outcomes(await read(join(parallel, 'results.json')))).toEqual(outcomes(rows));

  // An interrupted run: the last repository never finished. Resuming keeps finished results,
  // reruns the infrastructure error and the unfinished repository, and records the resume.
  await writeFile(join(first, 'results.json'), JSON.stringify([rows[0], rows[1], null]));
  const resumed = await run(root, first, '--resume');
  expect(resumed.stderr).toContain('[1/3] acme/history: finished before resuming');
  expect(resumed.stderr).toContain('[2/3] acme/broken: clone failure');
  expect(resumed.stderr).not.toContain('[3/3] acme/quiet: finished before resuming');
  expect(outcomes(await read(join(first, 'results.json')))).toEqual(outcomes(rows));
  expect((await read(join(first, 'harness.json'))).resumes).toHaveLength(1);

  await expect(run(root, first, '--resume', '--limit', '2')).rejects.toMatchObject({
    stderr: expect.stringContaining(
      `Refusing to resume ${first}: options differ from the run it started. Use a new output.`,
    ),
  });
  await expect(run(root, first)).rejects.toMatchObject({
    stderr: expect.stringContaining('EEXIST'),
  });
  // A changed frozen list is a different run.
  const list = await read(join(root, 'selected.json'));
  await writeFile(join(root, 'selected.json'), JSON.stringify(list.reverse()));
  await expect(run(root, first, '--resume')).rejects.toMatchObject({
    stderr: expect.stringContaining('list differ from the run it started'),
  });
});

it('needs --validate and an --env with a key and model for --behaviour-tests, before any repository runs', async () => {
  const root = await benchmarkRoot();
  const env = join(root, 'ai.env');
  await writeFile(env, 'OPENAI_MODEL=gpt-6.1-sol\n');
  const message =
    '--behaviour-tests needs --validate and --env with OPENAI_API_KEY and OPENAI_MODEL.';
  await expect(
    run(root, join(root, 'out-a'), '--behaviour-tests', '--validate'),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining(message),
  });
  await expect(
    run(root, join(root, 'out-b'), '--behaviour-tests', '--env', env),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining(message),
  });
  await expect(
    run(root, join(root, 'out-c'), '--behaviour-tests', '--env', env, '--validate'),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('AI operations require OPENAI_API_KEY and OPENAI_MODEL.'),
  });
});

it.skipIf(!process.env.REFIT_DOCKER_IMAGE)(
  'records --behaviour-tests and its model without turning on AI patches',
  async () => {
    const root = await benchmarkRoot();
    const env = join(root, 'ai.env');
    // Never sent: no repository here reaches validation, and AI patches stay off.
    await writeFile(env, 'OPENAI_API_KEY=unused-test-key\nOPENAI_MODEL=gpt-6.1-sol\n');
    const output = join(root, 'out');
    const { stderr } = await run(root, output, '--behaviour-tests', '--env', env, '--validate');
    expect(stderr).toContain('acme/history: affected (1 usages), AI not requested');
    const harness = await read(join(output, 'harness.json'));
    expect(harness.options).toMatchObject({
      'behaviour-tests': true,
      validate: true,
      environment: { OPENAI_MODEL: 'gpt-6.1-sol' },
    });
    expect(JSON.stringify(harness)).not.toContain('unused-test-key');
    const [history] = await read(join(output, 'results.json'));
    expect(history.ai).toBeUndefined();
  },
);

it('needs --validate for --behaviour-tests-dry-run and refuses it beside --behaviour-tests', async () => {
  const root = await benchmarkRoot();
  const message = '--behaviour-tests-dry-run needs --validate and replaces --behaviour-tests.';
  await expect(run(root, join(root, 'out-a'), '--behaviour-tests-dry-run')).rejects.toMatchObject({
    stderr: expect.stringContaining(message),
  });
  const env = join(root, 'ai.env');
  await writeFile(env, 'OPENAI_API_KEY=unused-test-key\nOPENAI_MODEL=gpt-6.1-sol\n');
  await expect(
    run(
      root,
      join(root, 'out-b'),
      '--behaviour-tests',
      '--behaviour-tests-dry-run',
      '--env',
      env,
      '--validate',
    ),
  ).rejects.toMatchObject({ stderr: expect.stringContaining(message) });
});

it.skipIf(!process.env.REFIT_DOCKER_IMAGE)(
  'accounts for every repository in a behaviour-test dry run, with no key',
  async () => {
    const root = await benchmarkRoot();
    const output = join(root, 'out');
    await run(root, output, '--behaviour-tests-dry-run', '--validate');
    const rows = await read(join(output, 'results.json'));
    expect(rows.map((row: Record<string, unknown>) => row.behaviourTestWriter)).toEqual([
      {
        status: 'dry-run',
        wouldRun: false,
        reason: 'There is no root lockfile that declares stripe, so validation does not run.',
      },
      { status: 'dry-run', wouldRun: false, reason: 'The repository could not be cloned.' },
      { status: 'dry-run', wouldRun: false, reason: 'No Stripe method is mapped.' },
    ]);
    expect((await read(join(output, 'harness.json'))).options).toMatchObject({
      'behaviour-tests-dry-run': true,
    });
  },
);

it('needs --behaviour-tests or --behaviour-tests-dry-run for --behaviour-test-stubs, before any repository runs', async () => {
  const root = await benchmarkRoot();
  await expect(
    run(root, join(root, 'out'), '--behaviour-test-stubs', '--validate'),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining(
      '--behaviour-test-stubs needs --behaviour-tests or --behaviour-tests-dry-run.',
    ),
  });
});

it.skipIf(!process.env.REFIT_DOCKER_IMAGE)(
  'records --behaviour-test-stubs on the run and on every row',
  async () => {
    const root = await benchmarkRoot();
    const output = join(root, 'out');
    await run(root, output, '--behaviour-tests-dry-run', '--behaviour-test-stubs', '--validate');
    const rows = await read(join(output, 'results.json'));
    expect(rows.map((row: Record<string, unknown>) => row.behaviourTestStubs)).toEqual([
      true,
      true,
      true,
    ]);
    expect((await read(join(output, 'harness.json'))).options).toMatchObject({
      'behaviour-tests-dry-run': true,
      'behaviour-test-stubs': true,
    });
  },
);

it('repairs as often as the hosted worker by default and checks --repair-attempts before any repository runs', async () => {
  const flags = (await readFile('fly.toml', 'utf8')).match(/REFIT_HOSTED_FLAGS = "([^"]*)"/)?.[1];
  expect(flags).toContain('--ai-patch');
  expect(flags).toContain(`--repair-attempts ${HOSTED_REPAIR_ATTEMPTS}`);
  const root = await benchmarkRoot();
  await expect(run(root, join(root, 'out-a'), '--repair-attempts', '1')).rejects.toMatchObject({
    stderr: expect.stringContaining('Repair attempts require --ai-patch.'),
  });
  await expect(
    run(root, join(root, 'out-b'), '--ai', '--repair-attempts', '3'),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('Repair attempts must be an integer from 0 to 2.'),
  });
});
