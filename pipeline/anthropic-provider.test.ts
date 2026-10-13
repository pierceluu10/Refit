import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runDeprecationPipeline } from './deprecated-models.ts';
import { readDeprecationSnapshot } from './deprecation-snapshots.ts';
import { readProviderAdapter } from './providers.ts';

const execute = promisify(execFile);
const roots: string[] = [];
const fixture = resolve('pipeline/fixtures/anthropic-messages');
const adapterPath = resolve('pipeline/fixtures/anthropic/provider.json');
const snapshotPath = resolve('pipeline/fixtures/anthropic/deprecation-snapshot.json');
const SDK_VERSION = '0.71.2';
const retiredModel = 'fixture-anthropic-retired-model';
const replacementModel = 'fixture-anthropic-replacement-model';
const INSTALL_TIMEOUT_MS = 120_000;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Anthropic provider fixtures', () => {
  it('loads the messages.create adapter and strictly synthetic deprecation snapshot', async () => {
    const [adapter, snapshot] = await Promise.all([
      readProviderAdapter(adapterPath),
      readDeprecationSnapshot(snapshotPath),
    ]);

    expect(adapter).toEqual({
      id: 'anthropic',
      packageName: '@anthropic-ai/sdk',
      defaultImport: true,
      namedExport: 'Anthropic',
      operations: [
        {
          resource: 'messages',
          method: 'create',
          requestChecks: [{ argument: 'model', kind: 'model-id' }],
        },
      ],
    });
    expect(snapshot).toMatchObject({
      provider: 'anthropic',
      source: { url: 'https://fixture.invalid/anthropic/deprecations' },
      models: [
        {
          id: retiredModel,
          shutdownDate: null,
          replacement: replacementModel,
          sourceNote: expect.stringMatching(/^Synthetic test fixture only;/),
        },
      ],
    });
  });

  it('finds and proposes a deterministic replacement for the fixture app', async () => {
    const report = await runDeprecationPipeline({
      repository: join(fixture, 'repository'),
      providerConfig: adapterPath,
      snapshot: snapshotPath,
      proposePatch: true,
    });

    expect(report).toMatchObject({
      provider: 'anthropic',
      status: 'affected',
      repository: {
        dependencies: [
          {
            file: 'package.json',
            section: 'dependencies',
            version: SDK_VERSION,
          },
        ],
      },
      findings: [
        {
          kind: 'deprecated-model',
          provider: 'anthropic',
          modelId: retiredModel,
          confidence: 'confirmed',
          call: 'client.messages.create',
        },
      ],
      patch: { status: 'proposed', edits: 1, unresolvedFindings: 0 },
    });
  });
});

it.skipIf(process.env.REFIT_ANTHROPIC_SDK !== '1')(
  'migrates a pinned real Anthropic SDK message across a synthetic model retirement',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'refit-anthropic-messages-'));
    roots.push(root);
    const repository = join(root, 'repository');
    await cp(join(fixture, 'repository'), repository, { recursive: true });
    await execute('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: repository,
      timeout: INSTALL_TIMEOUT_MS,
    });
    const installed = JSON.parse(
      await readFile(join(repository, 'node_modules/@anthropic-ai/sdk/package.json'), 'utf8'),
    );
    expect(installed.version).toBe(SDK_VERSION);

    const harness = join(fixture, 'contract.mjs');
    const live = JSON.parse(
      (await execute(process.execPath, [harness, repository, 'live'])).stdout,
    );
    expect(live.result).toBe('fixture message');
    expect(live.requests).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/v1/messages',
        body: expect.objectContaining({ model: retiredModel }),
      }),
    ]);

    await expect(execute(process.execPath, [harness, repository, 'retired'])).rejects.toMatchObject(
      {
        code: 1,
        stderr: expect.stringContaining('"status":404,"errorType":"not_found_error"'),
      },
    );

    const report = await runDeprecationPipeline({
      repository: join(fixture, 'repository'),
      providerConfig: adapterPath,
      snapshot: snapshotPath,
      proposePatch: true,
    });
    expect(report.patch).toMatchObject({ status: 'proposed' });
    if (!('diff' in report.patch)) throw new Error('Expected Anthropic model migration proposal.');
    const patch = join(root, 'migration.patch');
    await writeFile(patch, report.patch.diff);
    await execute('git', ['apply', '--check', patch], { cwd: repository });
    await execute('git', ['apply', patch], { cwd: repository });

    const patched = JSON.parse(
      (await execute(process.execPath, [harness, repository, 'patched'])).stdout,
    );
    expect(patched.result).toBe('fixture message');
    expect(patched.requests).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/v1/messages',
        body: expect.objectContaining({ model: replacementModel }),
      }),
    ]);
  },
  180_000,
);
