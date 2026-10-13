import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { runWorkflow } from './workflow.ts';
import { verifyArtifacts } from './verification.ts';

const execute = promisify(execFile);
const FIXTURE = resolve('pipeline/fixtures/endpoint-replacement');
const DOCKER_IMAGE = process.env.REFIT_DOCKER_IMAGE;
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scenario(mapping?: {
  resource: string;
  replacementResource: string;
  replacementMethod: string;
}) {
  const root = await mkdtemp(join(tmpdir(), 'refit-endpoint-docker-'));
  roots.push(root);
  const repository = join(root, 'repository');
  await cp(join(FIXTURE, 'repository'), repository, { recursive: true });
  let providerConfig = join(FIXTURE, 'provider.json');
  if (mapping) {
    const provider = JSON.parse(await readFile(providerConfig, 'utf8'));
    const source = join(repository, 'src/items.ts');
    await writeFile(
      source,
      (await readFile(source, 'utf8')).replace(
        'catalog.items.retrieveLegacy',
        `catalog.${mapping.resource}.retrieveLegacy`,
      ),
    );
    provider.operations[0].resource = mapping.resource;
    Object.assign(provider.operationReplacements[0], mapping);
    providerConfig = join(root, 'provider.json');
    await writeFile(providerConfig, JSON.stringify(provider));
  }
  const git = (arguments_: string[]) => execute('git', ['-C', repository, ...arguments_]);
  await git(['init', '-b', 'main']);
  await git(['add', '.']);
  await git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'test: independent simulated catalog app',
  ]);
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const output = join(root, 'run');
  return {
    root,
    repository,
    git,
    fetcher,
    output,
    options: {
      repository,
      before: join(FIXTURE, 'before.json'),
      after: join(FIXTURE, 'after.json'),
      providerConfig,
      apiVersion: '1',
      fullDiff: true,
      output,
      image: DOCKER_IMAGE!,
      baselineCommand: ['node', '--experimental-strip-types', 'simulator/check.mjs', 'before'],
      command: ['node', '--experimental-strip-types', 'simulator/check.mjs', 'after'],
      aiPatch: { apiKey: 'unused', model: 'unused' },
      repairAttempts: 2,
    },
  };
}

it.skipIf(!DOCKER_IMAGE || !process.env.REFIT_OASDIFF)(
  'validates a generic endpoint migration with real oasdiff and offline HTTP checks in Docker',
  async () => {
    const { repository, git, fetcher, output, options } = await scenario();
    const original = await readFile(join(repository, 'src/items.ts'), 'utf8');
    const result = await runWorkflow(options);
    expect(result.manifest).toMatchObject({ status: 'validated', stage: 'validation' });
    expect(fetcher).not.toHaveBeenCalled();
    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    expect(report.patch).toMatchObject({ generator: 'deterministic', unresolvedFindings: 0 });
    expect(report.operationChanges).toMatchObject([{ supported: true }]);
    expect(report.validation.baseline.status).toBe('passed');
    expect(report.validation.patched.status).toBe('passed');
    expect(report.validation.repair).toMatchObject({
      requested: 0,
      stopReason: 'configured-endpoint-replacement',
    });
    expect(report.publicationFiles.map((file: { path: string }) => file.path)).toEqual([
      'src/items.ts',
    ]);
    const body = await readFile(join(output, 'pull-request.md'), 'utf8');
    expect(body).toContain('`items.retrieveLegacy` → `items.retrieve`');
    expect(body).toContain('`GET /legacy/items/{id}`');
    expect(body).toContain('`GET /items/{id}`');
    expect(await readFile(join(repository, 'src/items.ts'), 'utf8')).toBe(original);
    expect((await git(['status', '--porcelain'])).stdout).toBe('');
    expect(await verifyArtifacts(output)).toMatchObject({ status: 'integrity-verified' });
  },
  60_000,
);

it.skipIf(!DOCKER_IMAGE || !process.env.REFIT_OASDIFF)(
  'validates a nested resource migration through real oasdiff and offline Docker without requesting AI',
  async () => {
    const { repository, git, fetcher, output, options } = await scenario({
      resource: 'inventory.legacy.items',
      replacementResource: 'inventory.current.products',
      replacementMethod: 'get',
    });
    const original = await readFile(join(repository, 'src/items.ts'), 'utf8');
    const result = await runWorkflow(options);
    expect(result.manifest.status).toBe('validated');
    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    expect(report.sdkCalls).toMatchObject([
      { resource: 'inventory.legacy.items', method: 'retrieveLegacy' },
    ]);
    expect(report.validation.baseline.status).toBe('passed');
    expect(report.validation.patched.status).toBe('passed');
    expect(report.validation.repair.requested).toBe(0);
    expect(report.patch.generator).toBe('deterministic');
    expect(fetcher).not.toHaveBeenCalled();
    const body = await readFile(join(output, 'pull-request.md'), 'utf8');
    expect(body).toContain('`inventory.legacy.items.retrieveLegacy`');
    expect(body).toContain('`inventory.current.products.get`');
    expect(await readFile(join(repository, 'src/items.ts'), 'utf8')).toBe(original);
    expect((await git(['status', '--porcelain'])).stdout).toBe('');
    expect((await verifyArtifacts(output)).status).toBe('integrity-verified');
  },
  60_000,
);

it.skipIf(!DOCKER_IMAGE || !process.env.REFIT_OASDIFF)(
  'records a missing replacement SDK method as a regression without paid repair or publication',
  async () => {
    const { root, output, options, fetcher } = await scenario();
    const provider = JSON.parse(await readFile(options.providerConfig, 'utf8'));
    provider.operationReplacements[0].replacementMethod = 'missingMethod';
    const providerConfig = join(root, 'invalid-sdk-target.json');
    await writeFile(providerConfig, JSON.stringify(provider));
    const result = await runWorkflow({ ...options, providerConfig });
    expect(result.manifest.status).toBe('validation-failed');
    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    expect(report.validation.baseline.status).toBe('passed');
    expect(report.validation.patched.status).toBe('failed');
    expect(report.validation.patched.stderr).toContain('missingMethod is not a function');
    expect(report.validation.repair.requested).toBe(0);
    expect(result.manifest.files.some((file) => file.path === 'publication.json')).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  },
  60_000,
);
