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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function inputs() {
  const root = await mkdtemp(join(tmpdir(), 'refit-openai-provider-'));
  roots.push(root);
  const repository = join(root, 'repository');
  await cp(join(FIXTURE, 'repository'), repository, { recursive: true });
  const after = structuredClone(CONTRACT);
  delete (after.components.schemas.Model.properties as Record<string, unknown>).owned_by;
  after.components.schemas.Model.required = ['id', 'object', 'created'];
  const beforePath = join(root, 'before.json');
  const afterPath = join(root, 'after.json');
  await writeFile(beforePath, JSON.stringify(CONTRACT));
  await writeFile(afterPath, JSON.stringify(after));
  return {
    repository,
    before: beforePath,
    after: afterPath,
    providerConfig: join(FIXTURE, 'openapi-provider.json'),
    proposePatch: true,
  };
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
  'observes the same incompatibility through real SDK HTTP requests to an offline simulator',
  async () => {
    const input = await inputs();
    await execute('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: input.repository,
      timeout: INSTALL_TIMEOUT_MS,
    });
    expect(
      JSON.parse(await readFile(join(input.repository, 'node_modules/openai/package.json'), 'utf8'))
        .version,
    ).toBe('7.32.0');
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
  },
  180_000,
);
