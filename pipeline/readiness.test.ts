import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { inspectRepositoryReadiness } from './readiness.ts';
import { renderReadiness } from './readiness-presentation.ts';
import { digest, stripeSpecificationUrl } from './specifications.ts';

const execute = promisify(execFile);
const roots: string[] = [];
const fixture = resolve('pipeline/fixtures/endpoint-replacement');
const bin = resolve('bin/refit.mjs');
const imageId = `sha256:${'a'.repeat(64)}`;

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(options: { prepareDependencies?: boolean; latestStripe?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'refit-readiness-'));
  roots.push(root);
  const repository = join(root, 'repository');
  await cp(join(fixture, 'repository'), repository, { recursive: true });
  for (const file of ['before.json', 'after.json', 'provider.json'])
    await cp(join(fixture, file), join(repository, file));
  if (options.latestStripe) {
    const content = await readFile(resolve('pipeline/fixtures/before.json'), 'utf8');
    const revision = 'b'.repeat(40);
    await writeFile(
      join(repository, 'before.json'),
      JSON.stringify({
        formatVersion: 1,
        kind: 'refit-snapshot',
        provider: 'stripe',
        revision,
        url: stripeSpecificationUrl(revision),
        hash: digest(content),
        content,
      }),
    );
    await writeFile(
      join(repository, 'src/items.ts'),
      `import Stripe from 'stripe';\nconst stripe = new Stripe('private-value');\nawait stripe.paymentIntents.retrieve('pi_1');`,
    );
  }
  const configuration = {
    formatVersion: 1,
    before: './before.json',
    ...(options.latestStripe ? { latestStripe: true } : { after: './after.json' }),
    image: 'local-test-image',
    ...(options.latestStripe ? {} : { providerConfig: './provider.json' }),
    apiVersion: options.latestStripe ? '2022-08-01' : '1',
    prepareDependencies: options.prepareDependencies ?? false,
    command: [
      'node',
      '-e',
      `require('fs').writeFileSync('application-executed', 'private-command-value')`,
    ],
  };
  await writeFile(join(repository, '.refit.json'), JSON.stringify(configuration));
  const binaries = join(root, 'binaries');
  await mkdir(binaries);
  const log = join(root, 'tool-calls.jsonl');
  for (const tool of ['docker', 'oasdiff'])
    await writeFile(
      join(binaries, tool),
      `#!${process.execPath}
require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({tool: ${JSON.stringify(tool)}, args: process.argv.slice(2)}) + '\\n');
${tool === 'docker' ? `if (process.argv.slice(2).join(' ') !== 'image inspect --format {{.Id}} local-test-image') process.exit(90); console.log(${JSON.stringify(imageId)});` : `console.log(process.argv[2] === '--version' ? 'oasdiff-test' : '[]');`}
`,
      { mode: 0o755 },
    );
  vi.stubEnv('PATH', `${binaries}:${process.env.PATH}`);
  await execute('git', ['-C', repository, 'init', '-b', 'main']);
  await commit(repository);
  return { root, repository, configuration, log, binaries };
}

async function commit(repository: string) {
  await execute('git', ['-C', repository, 'add', '.']);
  await execute('git', [
    '-C',
    repository,
    '-c',
    'user.name=Refit Tests',
    '-c',
    'user.email=tests@refit.local',
    'commit',
    '-m',
    'test: seed readiness repository',
  ]);
}

it('inspects a committed repository configuration and never executes app code, installs or makes requests', async () => {
  const sample = await setup();
  const fetch = vi.fn(() => {
    throw new Error('Readiness must not make HTTP requests');
  });
  vi.stubGlobal('fetch', fetch);
  const result = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(result).toMatchObject({
    status: 'ready-for-validation',
    provider: { id: 'catalog-endpoint-example', packageName: '@example/catalog' },
    image: imageId,
    currentSourceChecked: true,
    sdkCoverage: { observedCalls: 1, mappedCalls: 1, unmappedMethods: [] },
  });
  expect(result.revision).toMatch(/^[a-f0-9]{40}$/);
  expect(fetch).not.toHaveBeenCalled();
  await expect(readFile(join(sample.repository, 'application-executed'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect((await execute('git', ['-C', sample.repository, 'status', '--porcelain'])).stdout).toBe(
    '',
  );
  const calls = (await readFile(sample.log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(calls.filter((call) => call.tool === 'docker')).toEqual([
    { tool: 'docker', args: ['image', 'inspect', '--format', '{{.Id}}', 'local-test-image'] },
  ]);
  expect(JSON.stringify(result)).not.toContain('private-command-value');
  expect(renderReadiness(result)).toContain('ready to attempt validation');
  expect(renderReadiness(result)).toContain('not approved or activated');
});

it('aggregates dirty Git, API-version and Docker setup failures with actionable checks', async () => {
  const sample = await setup();
  await writeFile(
    join(sample.repository, '.refit.json'),
    JSON.stringify({ ...sample.configuration, apiVersion: 'wrong-version' }),
  );
  await writeFile(join(sample.binaries, 'docker'), `#!${process.execPath}\nprocess.exit(1);`, {
    mode: 0o755,
  });
  const result = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(result.status).toBe('needs-attention');
  expect(
    result.checks.filter((check) => check.status === 'blocked').map((check) => check.id),
  ).toEqual(['repository', 'api-version', 'docker']);
  expect(
    result.checks.filter((check) => check.status === 'blocked').every((check) => check.action),
  ).toBe(true);
});

it('reports unmapped calls on the same shared client without claiming complete integration coverage', async () => {
  const sample = await setup();
  await writeFile(
    join(sample.repository, 'src/other.ts'),
    `import { catalog } from './client.ts';\nawait catalog.orders.create({});`,
  );
  await commit(sample.repository);
  const result = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(result.sdkCoverage).toMatchObject({
    observedCalls: 2,
    mappedCalls: 1,
    unmappedMethods: ['orders.create'],
  });
  expect(result.checks.find((check) => check.id === 'sdk-coverage')).toMatchObject({
    status: 'review',
  });
  expect(renderReadiness(result)).toContain('Unmapped SDK methods: orders.create');
  expect(renderReadiness(result)).toContain('outside automatic coverage');
});

it('blocks a profile whose observed calls do not have any configured mappings', async () => {
  const sample = await setup();
  await writeFile(
    join(sample.repository, 'src/items.ts'),
    `import { catalog } from './client.ts';\nawait catalog.orders.create({});`,
  );
  await commit(sample.repository);
  const result = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(result.status).toBe('needs-attention');
  expect(result.sdkCoverage).toMatchObject({ observedCalls: 1, mappedCalls: 0 });
  expect(result.checks.find((check) => check.id === 'sdk-coverage')?.status).toBe('blocked');
});

it('checks committed npm inputs through the same preparation gate without installing packages', async () => {
  const sample = await setup({ prepareDependencies: true });
  const manifest = JSON.parse(await readFile(join(sample.repository, 'package.json'), 'utf8'));
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: manifest.dependencies },
      'node_modules/@example/catalog': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/@example/catalog/-/catalog-1.0.0.tgz',
        integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      },
    },
  };
  await writeFile(join(sample.repository, 'package-lock.json'), JSON.stringify(lock));
  await commit(sample.repository);
  const accepted = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(accepted.checks.find((check) => check.id === 'dependencies')).toMatchObject({
    status: 'passed',
    detail: expect.stringContaining('Installation and engine compatibility were not tested'),
  });
  await writeFile(
    join(sample.repository, 'package-lock.json'),
    JSON.stringify({ ...lock, packages: { ...lock.packages, '': { dependencies: {} } } }),
  );
  await commit(sample.repository);
  const rejected = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(rejected.status).toBe('needs-attention');
  expect(rejected.checks.find((check) => check.id === 'dependencies')).toMatchObject({
    status: 'blocked',
    detail: expect.stringContaining('differ from the committed root lockfile'),
  });
});

it('leaves latest Stripe discovery untouched and clearly identifies a baseline-only inspection', async () => {
  const sample = await setup({ latestStripe: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No source download expected');
    }),
  );
  const result = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(result.currentSourceChecked).toBe(false);
  expect(result.status).toBe('ready-for-validation');
  expect(result.checks.find((check) => check.id === 'analysis')?.detail).toContain(
    'only the baseline was inspected',
  );
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('blocks an unpinned live baseline and rejects a custom adapter combined with latest Stripe', async () => {
  const sample = await setup({ latestStripe: true });
  await cp(resolve('pipeline/fixtures/before.json'), join(sample.repository, 'before.json'));
  await commit(sample.repository);
  const unpinned = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(unpinned.checks.find((check) => check.id === 'source-baseline')?.status).toBe('blocked');
  await writeFile(
    join(sample.repository, '.refit.json'),
    JSON.stringify({ ...sample.configuration, providerConfig: './provider.json' }),
  );
  const conflicting = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(conflicting.checks).toMatchObject([
    {
      id: 'configuration',
      status: 'blocked',
      detail: expect.stringContaining('cannot be combined with a custom provider'),
    },
  ]);
});

it('does not expose credential values from invalid configuration fields', async () => {
  const sample = await setup();
  await writeFile(
    join(sample.repository, '.refit.json'),
    JSON.stringify({ ...sample.configuration, apiKey: 'private-credential-value' }),
  );
  const result = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(result.status).toBe('needs-attention');
  expect(JSON.stringify(result)).not.toContain('private-credential-value');
  expect(renderReadiness(result)).toContain('Unknown run configuration fields: apiKey');
});

it('keeps unsupported breaking changes blocked even when an SDK call is mapped', async () => {
  const sample = await setup();
  await writeFile(
    join(sample.binaries, 'oasdiff'),
    `#!${process.execPath}\nconsole.log(process.argv[2] === '--version' ? 'oasdiff-test' : JSON.stringify([{id:'request-body-required', text:'request body became required', level:3, path:'/legacy/items/{id}', operation:'GET'}]));`,
    { mode: 0o755 },
  );
  const result = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(result.status).toBe('needs-attention');
  expect(result.checks.find((check) => check.id === 'migration-coverage')?.status).toBe('blocked');
});

it('reports missing configuration and does not inspect tools before a workflow is selected', async () => {
  const sample = await setup();
  const result = await inspectRepositoryReadiness({ config: join(sample.root, 'missing.json') });
  expect(result.status).toBe('needs-attention');
  expect(result.checks).toHaveLength(1);
  expect(result.checks[0]).toMatchObject({ id: 'configuration', status: 'blocked' });
  await expect(readFile(sample.log)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('routes human and JSON diagnostics outside the repository and returns exit 2 for setup failures', async () => {
  const sample = await setup();
  await writeFile(join(sample.root, 'tsconfig.json'), 'not valid JSON');
  const argumentsList = [bin, 'doctor', '--config', join(sample.repository, '.refit.json')];
  const human = await execute(process.execPath, argumentsList, { cwd: sample.root });
  expect(human.stdout).toContain('Refit is ready to attempt validation');
  const json = await execute(process.execPath, [...argumentsList, '--json'], { cwd: sample.root });
  expect(JSON.parse(json.stdout).sdkCoverage).toMatchObject({ observedCalls: 1, mappedCalls: 1 });
  await writeFile(
    join(sample.repository, '.refit.json'),
    JSON.stringify({ ...sample.configuration, apiVersion: 'wrong' }),
  );
  await expect(
    execute(process.execPath, [...argumentsList, '--json'], { cwd: sample.root }),
  ).rejects.toMatchObject({ code: 2, stdout: expect.stringContaining('needs-attention') });
  await expect(
    execute(process.execPath, [...argumentsList, '--ai-patch'], { cwd: sample.root }),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Unknown option') });
});
