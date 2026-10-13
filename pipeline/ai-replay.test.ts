import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { openAiReplayFixture, runAiReplay } from './ai-replay.ts';

const execute = promisify(execFile);
const roots: string[] = [];
const SDK_VERSION = '7.32.0';
const INSTALL_TIMEOUT_MS = 120_000;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('replays the bundled synthetic retirement and registers CLI output with no-overwrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-ai-replay-cli-'));
  roots.push(root);
  const output = join(root, 'report.json');
  await execute(
    process.execPath,
    [resolve('bin/refit.mjs'), 'ai-replay', '--propose-patch', '--output', output],
    { cwd: root },
  );
  const report = JSON.parse(await readFile(output, 'utf8'));
  expect(report).toMatchObject({
    provider: 'openai',
    sdkVersion: SDK_VERSION,
    status: 'affected',
    snapshot: {
      source: 'https://fixture.invalid/openai/deprecations',
    },
    patch: { status: 'proposed' },
  });
  expect(report.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        modelId: 'fixture-openai-retired-model',
        confidence: 'confirmed',
      }),
      expect.objectContaining({
        modelId: 'fixture-openai-retired-model',
        confidence: 'needs-review',
      }),
    ]),
  );
  await expect(
    execute(process.execPath, [resolve('bin/refit.mjs'), 'ai-replay', '--output', output], {
      cwd: root,
    }),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringMatching(/EEXIST|file already exists/i),
  });
});

it.skipIf(process.env.REFIT_OPENAI_SDK !== '1')(
  'migrates a pinned real OpenAI SDK completion across a synthetic model retirement',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'refit-openai-completions-'));
    roots.push(root);
    const repository = join(root, 'repository');
    await cp(openAiReplayFixture('openai-completions/repository'), repository, {
      recursive: true,
    });
    await execute('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: repository,
      timeout: INSTALL_TIMEOUT_MS,
    });
    const installed = JSON.parse(
      await readFile(join(repository, 'node_modules/openai/package.json'), 'utf8'),
    );
    expect(installed.version).toBe(SDK_VERSION);

    const harness = openAiReplayFixture('openai-completions/contract.mjs');
    const live = JSON.parse(
      (await execute(process.execPath, [harness, repository, 'live'])).stdout,
    );
    expect(live.requests).toHaveLength(3);
    expect(live.requests.map((request: { body: { model: string } }) => request.body.model)).toEqual(
      [
        'fixture-openai-retired-model',
        'fixture-openai-retired-model',
        'fixture-openai-retired-model',
      ],
    );
    await expect(execute(process.execPath, [harness, repository, 'retired'])).rejects.toMatchObject(
      {
        code: 1,
        stderr: expect.stringContaining('"code":"model_not_found"'),
      },
    );

    const report = await runAiReplay({ proposePatch: true });
    expect(report.sdkVersion).toBe(SDK_VERSION);
    expect(report.repository.dependencies).toEqual([
      expect.objectContaining({
        file: 'package.json',
        section: 'dependencies',
        version: SDK_VERSION,
      }),
    ]);
    expect(report.patch).toMatchObject({ status: 'proposed' });
    if (!('diff' in report.patch)) throw new Error('Expected OpenAI model migration proposal.');
    const patch = join(root, 'migration.patch');
    await writeFile(patch, report.patch.diff);
    await execute('git', ['apply', '--check', patch], { cwd: repository });
    await execute('git', ['apply', patch], { cwd: repository });

    const patched = JSON.parse(
      (await execute(process.execPath, [harness, repository, 'patched'])).stdout,
    );
    expect(patched.requests).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/v1/completions',
        body: expect.objectContaining({ model: 'fixture-openai-replacement-model' }),
      }),
    ]);
  },
  180_000,
);
