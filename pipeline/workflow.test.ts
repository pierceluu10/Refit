import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runWorkflow } from './workflow.ts';
import { validateMigration } from './validation.ts';
import { publishDraft } from './publication.ts';
import { digest } from './specifications.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

vi.mock('./validation.ts', () => ({ validateMigration: vi.fn() }));
vi.mock('./publication.ts', () => ({ publishDraft: vi.fn() }));
const roots: string[] = [];
const fixture = (name: string) => resolve('pipeline/fixtures', name);

async function options() {
  const root = await mkdtemp(join(tmpdir(), 'refit-workflow-test-'));
  roots.push(root);
  return {
    repository: fixture('repository'),
    before: fixture('before.json'),
    after: fixture('after.json'),
    output: join(root, 'run'),
    image: 'node:22-alpine',
    command: ['node', '--version'],
  };
}

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('records no-match evidence as review-required without calling a model, Docker or publisher', async () => {
  const input = await options();
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const result = await runWorkflow({
    ...input,
    after: input.before,
    aiPatch: { apiKey: 'private-key', model: 'test-model' },
    publication: { repository: 'owner/repo', base: 'main', token: 'private-token' },
  });
  expect(result.manifest).toMatchObject({
    status: 'needs-review',
    stage: 'scan',
    baselineAdvanced: false,
  });
  expect(validateMigration).not.toHaveBeenCalled();
  expect(publishDraft).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
  const manifest = await readFile(join(input.output, 'manifest.json'), 'utf8');
  expect(manifest).not.toContain('private-');
  for (const file of result.manifest.files)
    expect(digest(await readFile(join(input.output, file.path)))).toBe(file.sha256);
});

it('retains a pinned custom adapter and stops when no deterministic migration exists', async () => {
  const input = await options();
  const result = await runWorkflow({
    ...input,
    repository: fixture('catalog/repository'),
    before: fixture('catalog/before.json'),
    after: fixture('catalog/after.json'),
    providerConfig: fixture('catalog/provider.json'),
  });
  expect(result.manifest.status).toBe('needs-review');
  expect(result.manifest.reason).toContain('no deterministic migration rule');
  expect(JSON.parse(await readFile(join(input.output, 'adapter.json'), 'utf8')).id).toBe(
    'catalog-example',
  );
  expect(validateMigration).not.toHaveBeenCalled();
});

it('retains completed scan evidence when validation setup fails and never publishes', async () => {
  const input = await options();
  vi.mocked(validateMigration).mockRejectedValueOnce(new Error('Docker image is unavailable'));
  const result = await runWorkflow(input);
  expect(result.manifest).toMatchObject({
    status: 'error',
    stage: 'validation',
    error: { message: 'Docker image is unavailable' },
  });
  expect(JSON.parse(await readFile(join(input.output, 'scan.json'), 'utf8')).status).toBe(
    'affected',
  );
  expect(publishDraft).not.toHaveBeenCalled();
  await expect(runWorkflow(input)).rejects.toMatchObject({ code: 'EEXIST' });
});

it('rejects ambiguous discovery options and raw discovery baselines', async () => {
  const input = await options();
  await expect(runWorkflow({ ...input, latestStripe: true })).rejects.toThrow(/exactly one/);
  const result = await runWorkflow({ ...input, after: undefined, latestStripe: true });
  expect(result.manifest).toMatchObject({ status: 'error', stage: 'inputs' });
  expect(result.manifest.error?.message).toContain('pinned Refit baseline');
  expect(validateMigration).not.toHaveBeenCalled();
});

it('returns exit 2 and machine-readable evidence for a CLI run requiring review', async () => {
  const input = await options();
  const result = promisify(execFile)(process.execPath, [
    '--import',
    'tsx',
    'pipeline/workflow-cli.ts',
    '--repository',
    input.repository,
    '--before',
    input.before,
    '--after',
    input.before,
    '--output',
    input.output,
    '--image',
    input.image,
    '--command',
    JSON.stringify(input.command),
  ]);
  await expect(result).rejects.toMatchObject({ code: 2, stderr: '' });
  const manifest = JSON.parse(await readFile(join(input.output, 'manifest.json'), 'utf8'));
  expect(manifest.status).toBe('needs-review');
});
