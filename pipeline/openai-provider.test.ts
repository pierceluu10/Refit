import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { runPipeline } from './run.ts';

const execute = promisify(execFile);
const roots: string[] = [];
const FIXTURE = resolve('pipeline/fixtures/openai');
const INSTALL_TIMEOUT_MS = 120_000;
const CONTRACT = {
  openapi: '3.0.3',
  info: { title: 'OpenAI offline conformance fixture', version: 'before' },
  paths: {
    '/models/{model}': {
      parameters: [{ name: 'model', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        responses: {
          '200': {
            description: 'Model',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Model' } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Model: {
        type: 'object',
        required: ['id', 'object', 'created', 'owned_by'],
        properties: {
          id: { type: 'string' },
          object: { type: 'string' },
          created: { type: 'integer' },
          owned_by: { type: 'string' },
        },
      },
    },
  },
};
const CHAT_CONTRACT = {
  openapi: '3.0.3',
  info: { title: 'OpenAI nested SDK simulation', version: 'before' },
  paths: {
    '/chat/completions': {
      post: {
        operationId: 'createChatCompletion',
        responses: {
          '200': {
            description: 'Chat completion',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ChatCompletion' } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      ChatCompletion: {
        type: 'object',
        required: ['id', 'object', 'created', 'model'],
        properties: {
          id: { type: 'string' },
          object: { type: 'string' },
          created: { type: 'integer' },
          model: { type: 'string' },
        },
      },
    },
  },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function inputs(providerConfig = 'provider.json', variant: 'model' | 'chat' = 'model') {
  const root = await mkdtemp(join(tmpdir(), 'refit-openai-provider-'));
  roots.push(root);
  const repository = join(root, 'repository');
  await cp(join(FIXTURE, 'repository'), repository, { recursive: true });
  const contract = variant === 'chat' ? CHAT_CONTRACT : CONTRACT;
  const after = structuredClone(contract);
  const schemaName = variant === 'chat' ? 'ChatCompletion' : 'Model';
  const removed = variant === 'chat' ? 'model' : 'owned_by';
  const replacement = variant === 'chat' ? 'model_id' : 'owner_name';
  const schema = (
    after.components.schemas as Record<
      string,
      { required: string[]; properties: Record<string, unknown> }
    >
  )[schemaName];
  delete schema.properties[removed];
  schema.properties[replacement] = { type: 'string' };
  schema.required = schema.required.filter((field) => field !== removed).concat(replacement);
  const beforePath = join(root, 'before.json');
  const afterPath = join(root, 'after.json');
  await writeFile(beforePath, JSON.stringify(contract));
  await writeFile(afterPath, JSON.stringify(after));
  return {
    repository,
    before: beforePath,
    after: afterPath,
    providerConfig: join(FIXTURE, providerConfig),
    proposePatch: true,
  };
}

async function installFixture(input: Awaited<ReturnType<typeof inputs>>) {
  await execute('git', ['init', input.repository]);
  await execute('git', ['-C', input.repository, 'add', '--force', '.']);
  await execute('git', [
    '-C',
    input.repository,
    '-c',
    'user.name=Refit Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'test: seed OpenAI fixture',
  ]);
  await execute('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: input.repository,
    timeout: INSTALL_TIMEOUT_MS,
  });
  expect(
    JSON.parse(await readFile(join(input.repository, 'node_modules/openai/package.json'), 'utf8'))
      .version,
  ).toBe('7.32.0');
}

it('detects OpenAI usage using configuration and leaves unsupported migration semantics explicit', async () => {
  const report = await runPipeline(await inputs());
  expect(report.provider).toBe('openai');
  expect(report.status).toBe('affected');
  expect(report.findings).toEqual([
    expect.objectContaining({
      file: 'models.js',
      expression: '.owned_by',
      confidence: 'confirmed',
    }),
  ]);
  expect(report.patch.status).toBe('unsupported');
});

it('keeps string-method reads uncertain when schema typing is absent or the response is modified', async () => {
  const input = await inputs();
  const before = JSON.parse(await readFile(input.before, 'utf8'));
  delete before.components.schemas.Model.properties.owned_by.type;
  await writeFile(input.before, JSON.stringify(before));
  expect((await runPipeline(input)).findings[0].confidence).toBe('review');
  before.components.schemas.Model.properties.owned_by.type = 'string';
  await writeFile(input.before, JSON.stringify(before));
  const path = join(input.repository, 'models.js');
  const source = await readFile(path, 'utf8');
  await writeFile(
    path,
    source.replace(
      'return model.owned_by.toLowerCase();',
      "model.owned_by = 'changed'; return model.owned_by.toLowerCase();",
    ),
  );
  expect((await runPipeline(input)).findings.at(-1)?.confidence).toBe('review');
});

it.skipIf(!process.env.REFIT_OPENAI_SDK)(
  'applies a configured rename through real SDK HTTP requests to an offline simulator',
  async () => {
    const input = await inputs();
    await installFixture(input);
    const source = join(input.repository, 'models.js');
    const harness = join(FIXTURE, 'contract.mjs');
    const before = JSON.parse(
      (await execute(process.execPath, [harness, source, 'before'])).stdout,
    );
    expect(before.requests).toEqual([{ method: 'GET', path: '/v1/models/gpt-4.1-mini' }]);
    await expect(execute(process.execPath, [harness, source, 'after'])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('TypeError'),
    });
    const report = await runPipeline(input);
    expect(report.findings[0].confidence).toBe('confirmed');
    expect(report.patch.status).toBe('unsupported');

    const migration = await runPipeline({
      ...input,
      providerConfig: join(FIXTURE, 'provider-renames.json'),
    });
    expect(migration.patch).toMatchObject({ status: 'proposed', edits: 1, unresolvedFindings: 0 });
    if (!('diff' in migration.patch)) throw new Error('Expected configured migration patch');
    expect(migration.patch.diff).toContain('model.owner_name');
    const patch = join(input.repository, '..', 'migration.patch');
    await writeFile(patch, migration.patch.diff);
    await execute('git', ['-C', input.repository, 'apply', '--check', patch]);
    await execute('git', ['-C', input.repository, 'apply', patch]);
    const afterPatched = JSON.parse(
      (await execute(process.execPath, [harness, source, 'after'])).stdout,
    );
    expect(afterPatched).toEqual({
      requests: [{ method: 'GET', path: '/v1/models/gpt-4.1-mini' }],
      owner: 'openai',
    });
  },
  180_000,
);

it.skipIf(!process.env.REFIT_OPENAI_SDK)(
  'migrates a nested shared-client Chat Completions call through actual SDK HTTP against a synthetic field change',
  async () => {
    const input = await inputs('provider-chat-renames.json', 'chat');
    await installFixture(input);
    const source = join(input.repository, 'chat.js');
    const harness = join(FIXTURE, 'contract.mjs');
    const check = (mode: string) => execute(process.execPath, [harness, source, mode, 'chat']);
    const before = JSON.parse((await check('before')).stdout);
    const expected = {
      requests: [
        {
          method: 'POST',
          path: '/v1/chat/completions',
          body: {
            model: 'gpt-4.1-mini',
            messages: [{ role: 'user', content: 'Offline conformance test' }],
            stream: false,
          },
        },
      ],
      model: 'gpt-4.1-mini',
    };
    expect(before).toEqual(expected);
    await expect(check('after')).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('TypeError'),
    });
    const migration = await runPipeline(input);
    expect(migration.calls).toMatchObject([{ method: 'chat.completions.create' }]);
    expect(migration.findings).toMatchObject([
      { file: 'chat.js', expression: '.model', confidence: 'confirmed' },
    ]);
    expect(migration.patch).toMatchObject({ status: 'proposed', edits: 1, unresolvedFindings: 0 });
    if (!('diff' in migration.patch)) throw new Error('Expected nested response rename');
    expect(migration.patch.diff).toContain('completion.model_id');
    const patch = join(input.repository, '..', 'migration.patch');
    await writeFile(patch, migration.patch.diff);
    await execute('git', ['-C', input.repository, 'apply', '--check', patch]);
    await execute('git', ['-C', input.repository, 'apply', patch]);
    expect(JSON.parse((await check('after')).stdout)).toEqual(expected);
  },
  180_000,
);
