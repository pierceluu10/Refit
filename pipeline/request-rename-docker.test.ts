import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { runWorkflow } from './workflow.ts';
import { verifyArtifacts } from './verification.ts';
import { runPipeline } from './run.ts';
import { renderWorkflowResult } from './workflow-presentation.ts';

const execute = promisify(execFile);
const FIXTURE = resolve('pipeline/fixtures/request-renames');
const IMAGE = process.env.REFIT_DOCKER_IMAGE;
const roots: string[] = [];
const OPENAI_SDK = '7.32.0';

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scenario() {
  const root = await mkdtemp(join(tmpdir(), 'refit-request-docker-'));
  roots.push(root);
  const repository = join(root, 'repository');
  await cp(join(FIXTURE, 'repository'), repository, { recursive: true });
  const git = (args: string[]) =>
    execute('git', ['-c', 'commit.gpgsign=false', '-C', repository, ...args]);
  await git(['init', '-b', 'main']);
  const commit = async () => {
    await git(['add', '.']);
    await git([
      '-c',
      'user.name=Refit Tests',
      '-c',
      'user.email=tests@refit.local',
      'commit',
      '-m',
      'test: simulated request application',
    ]);
  };
  await commit();
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  return {
    root,
    repository,
    git,
    commit,
    fetcher,
    options: {
      repository,
      before: join(FIXTURE, 'before.json'),
      after: join(FIXTURE, 'after.json'),
      providerConfig: join(FIXTURE, 'provider.json'),
      apiVersion: '1',
      fullDiff: true,
      image: IMAGE!,
      output: join(root, 'run'),
      baselineCommand: ['node', '--experimental-strip-types', 'simulator/check.mjs', 'before'],
      command: ['node', '--experimental-strip-types', 'simulator/check.mjs', 'after'],
      aiPatch: { apiKey: 'unused-private-key', model: 'unused' },
      repairAttempts: 2,
    },
  };
}

it.skipIf(!IMAGE || !process.env.REFIT_OASDIFF)(
  'demonstrates the request failure then validates the generic migration with unchanged values, options and errors',
  async () => {
    const sample = await scenario();
    const original = await readFile(join(sample.repository, 'src/items.ts'), 'utf8');
    expect(
      (
        await execute(process.execPath, sample.options.baselineCommand.slice(1), {
          cwd: sample.repository,
        })
      ).stdout,
    ).toContain('contract passed');
    await expect(
      execute(process.execPath, sample.options.command.slice(1), { cwd: sample.repository }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Missing required item name'),
    });
    const result = await runWorkflow({ ...sample.options, apiVersionPolicy: 'source-verified' });
    expect(result.manifest.status).toBe('validated');
    const report = JSON.parse(await readFile(join(result.directory, 'report.json'), 'utf8'));
    expect(report.requestChanges).toMatchObject([
      { supported: true, removed: 'legacy_name', replacement: 'display_name' },
    ]);
    expect(report.operationImpacts).toEqual([]);
    expect(report.patch).toMatchObject({ generator: 'deterministic', unresolvedFindings: 0 });
    expect(report.validation).toMatchObject({
      baseline: { status: 'passed' },
      patched: { status: 'passed' },
      repair: { requested: 0, stopReason: 'configured-request-rename' },
    });
    expect(report.validation.patched.stdout).toContain(
      'exact body values, options, version and propagated 503',
    );
    expect(report.publicationFiles.map((file: { path: string }) => file.path)).toEqual([
      'src/items.ts',
    ]);
    expect(await readFile(join(result.directory, 'pull-request.md'), 'utf8')).toContain(
      'Renames request field `legacy_name` to `display_name` in `items.create`.',
    );
    expect(await renderWorkflowResult(result)).toContain(
      'items.create argument[0]: legacy_name → display_name',
    );
    expect(await readFile(join(sample.repository, 'src/items.ts'), 'utf8')).toBe(original);
    expect((await sample.git(['status', '--porcelain'])).stdout).toBe('');
    expect(sample.fetcher).not.toHaveBeenCalled();
    expect((await verifyArtifacts(result.directory)).status).toBe('integrity-verified');
  },
  60_000,
);

it.skipIf(!IMAGE || !process.env.REFIT_OASDIFF)(
  'stops a mixed supported/dynamic request before any paid work or validation',
  async () => {
    const sample = await scenario();
    await writeFile(
      join(sample.repository, 'src/dynamic.ts'),
      "import { catalog } from './client.js'; export async function dynamic(body: unknown) { return await catalog.items.create(body); }",
    );
    await sample.commit();
    const result = await runWorkflow(sample.options);
    expect(result.manifest).toMatchObject({ status: 'needs-review', stage: 'scan' });
    expect(result.manifest.files.some((file) => file.path === 'report.json')).toBe(false);
    const scan = await runPipeline({ ...sample.options, aiPatch: undefined, proposePatch: true });
    expect(scan.requestChanges).toMatchObject([{ supported: false }]);
    expect(scan.patch).toMatchObject({ unresolvedFindings: 1 });
    expect(sample.fetcher).not.toHaveBeenCalled();
  },
  60_000,
);

it.skipIf(!IMAGE || !process.env.REFIT_OASDIFF)(
  'does not use AI repairs to change an explicit request contract after failing patched checks',
  async () => {
    const sample = await scenario();
    const result = await runWorkflow({
      ...sample.options,
      command: ['node', '-e', 'process.exit(1)'],
    });
    expect(result.manifest.status).toBe('validation-failed');
    const report = JSON.parse(await readFile(join(result.directory, 'report.json'), 'utf8'));
    expect(report.validation.repair).toMatchObject({
      requested: 0,
      stopReason: 'configured-request-rename',
    });
    expect(sample.fetcher).not.toHaveBeenCalled();
  },
  60_000,
);

it
  .skipIf(
    !IMAGE ||
      !process.env.REFIT_OASDIFF ||
      !process.env.REFIT_OPENAI_SDK ||
      !process.env.REFIT_NPM_PREPARE,
  )
  .each(['named', 'default', 'commonjs'])(
  'validates request serialization with real OpenAI %s client modules in offline Docker',
  async (format) => {
    const sample = await scenario();
    await rm(sample.repository, { recursive: true });
    await mkdir(join(sample.repository, 'src'), { recursive: true });
    await mkdir(join(sample.repository, 'simulator'));
    await cp(
      resolve('pipeline/fixtures/openai/repository/client.js'),
      join(sample.repository, 'src/client.js'),
    );
    await cp(join(FIXTURE, 'openai-check.mjs'), join(sample.repository, 'simulator/check.mjs'));
    await writeFile(
      join(sample.repository, 'package.json'),
      JSON.stringify({
        name: 'refit-openai-request-conformance',
        private: true,
        type: 'module',
        dependencies: { openai: OPENAI_SDK },
      }),
    );
    await execute(
      'npm',
      ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: sample.repository, timeout: 120_000 },
    );
    await writeFile(
      join(sample.repository, 'src/billing.js'),
      "import { client } from './client.js'; const MODEL = 'gpt-4.1-mini'; export async function createCompletion(prompt, requestId) { const completion = await client.chat.completions.create({ model: MODEL, messages: [{ role: 'user', content: prompt }], stream: false }, { headers: { 'x-request-id': requestId } }); return completion.id; }",
    );
    const commonjs = format === 'commonjs';
    const extension = commonjs ? 'cjs' : 'js';
    if (format !== 'named') {
      const clientPath = join(sample.repository, 'src/client.js');
      const originalClient = await readFile(clientPath, 'utf8');
      await writeFile(
        join(sample.repository, `src/client.${extension}`),
        commonjs
          ? originalClient
              .replace("import OpenAI from 'openai';", "const OpenAI = require('openai').OpenAI;")
              .replace('export const client', 'const client') + '\nmodule.exports = {client};\n'
          : originalClient.replace('export const client', 'const client') +
              '\nexport default client;\n',
      );
      const billingPath = join(sample.repository, 'src/billing.js');
      const originalBilling = await readFile(billingPath, 'utf8');
      await writeFile(
        join(sample.repository, `src/billing.${extension}`),
        commonjs
          ? originalBilling
              .replace(
                "import { client } from './client.js';",
                "const {client} = require('./client.cjs');",
              )
              .replace('export async function', 'async function') +
              '\nexports.createCompletion = createCompletion;\n'
          : originalBilling.replace('import { client }', 'import client'),
      );
      if (commonjs) {
        await rm(clientPath);
        await rm(billingPath);
        const harness = join(sample.repository, 'simulator/check.mjs');
        await writeFile(
          harness,
          (await readFile(harness, 'utf8')).replace('../src/billing.js', '../src/billing.cjs'),
        );
      }
    }
    const before = JSON.parse(await readFile(sample.options.before, 'utf8'));
    before.paths = {
      '/chat/completions': {
        post: {
          operationId: 'createChatCompletion',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' } },
            },
          },
          responses: {
            '200': {
              description: 'Completion',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ChatCompletion' } },
              },
            },
          },
        },
      },
    };
    before.components.schemas = {
      ChatRequest: {
        type: 'object',
        required: ['model'],
        properties: {
          model: { type: 'string' },
          messages: { type: 'array', items: { type: 'object' } },
          stream: { type: 'boolean' },
        },
      },
      ChatCompletion: { type: 'object', properties: { id: { type: 'string' } } },
    };
    const after = structuredClone(before);
    after.info.version = '2';
    after.components.schemas.ChatRequest.properties.model_id =
      after.components.schemas.ChatRequest.properties.model;
    delete after.components.schemas.ChatRequest.properties.model;
    after.components.schemas.ChatRequest.required = ['model_id'];
    for (const [name, document] of [
      ['before', before],
      ['after', after],
    ])
      await writeFile(join(sample.root, `${name}.json`), JSON.stringify(document));
    const provider = {
      id: 'openai',
      packageName: 'openai',
      defaultImport: true,
      namedExport: 'OpenAI',
      operations: [
        {
          resource: 'chat.completions',
          method: 'create',
          schema: 'ChatCompletion',
          operationId: 'createChatCompletion',
        },
      ],
      requestPropertyRenames: [
        {
          resource: 'chat.completions',
          method: 'create',
          argumentIndex: 0,
          removed: 'model',
          replacement: 'model_id',
        },
      ],
    };
    await writeFile(join(sample.root, 'provider.json'), JSON.stringify(provider));
    await sample.git(['init', '-b', 'main']);
    await sample.commit();
    const incompatible = await runWorkflow({
      ...sample.options,
      before: join(sample.root, 'before.json'),
      after: join(sample.root, 'after.json'),
      providerConfig: join(sample.root, 'provider.json'),
      prepareDependencies: true,
      output: join(sample.root, 'original-after'),
      baselineCommand: sample.options.command,
    });
    expect(incompatible.manifest.status).toBe('validation-failed');
    const failure = JSON.parse(await readFile(join(incompatible.directory, 'report.json'), 'utf8'));
    expect(failure.validation.baseline.status).toBe('failed');
    expect(failure.validation.baseline.stderr).toContain('Missing required model field');
    expect(failure.validation.patched.status).toBe('not-run');
    const result = await runWorkflow({
      ...sample.options,
      before: join(sample.root, 'before.json'),
      after: join(sample.root, 'after.json'),
      providerConfig: join(sample.root, 'provider.json'),
      prepareDependencies: true,
    });
    expect(result.manifest.status).toBe('validated');
    const report = JSON.parse(await readFile(join(result.directory, 'report.json'), 'utf8'));
    expect(report.requestChanges).toMatchObject([
      { supported: true, resource: 'chat.completions' },
    ]);
    expect(report.validation.baseline.stdout).toContain(
      'exact nested SDK body, headers and propagated 400',
    );
    expect(report.validation.patched.stdout).toContain(
      'exact nested SDK body, headers and propagated 400',
    );
    expect(report.repository.dependencies[0].lock.version).toBe(OPENAI_SDK);
    expect(report.publicationFiles.map((file: { path: string }) => file.path)).toEqual([
      `src/billing.${extension}`,
    ]);
    expect(sample.fetcher).not.toHaveBeenCalled();
    expect((await sample.git(['status', '--porcelain'])).stdout).toBe('');
    expect((await verifyArtifacts(result.directory)).status).toBe('integrity-verified');
  },
  120_000,
);
