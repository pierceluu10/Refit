import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runPipeline } from './run.ts';
import { flattenAllOfSchemas, parseSpecification } from './specifications.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('merges allOf compositions of plain object schemas and leaves every other composition', () => {
  const schemas = {
    Base: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    Extra: {
      allOf: [{ $ref: '#/components/schemas/Base' }],
      properties: { note: { type: 'string' } },
    },
    Response: {
      title: 'Response',
      allOf: [
        { $ref: '#/components/schemas/Extra' },
        { type: 'object', required: ['status'], properties: { status: { type: 'string' } } },
      ],
    },
    // A part that is a union, a conflicting property and a non-object part are not merged.
    Union: { allOf: [{ $ref: '#/components/schemas/Base' }, { anyOf: [{ type: 'string' }] }] },
    Conflict: {
      allOf: [
        { $ref: '#/components/schemas/Base' },
        { type: 'object', properties: { id: { type: 'integer' } } },
      ],
    },
    Scalar: { allOf: [{ type: 'string' }] },
  };
  const flattened = flattenAllOfSchemas(schemas);
  expect(flattened.Response).toEqual({
    title: 'Response',
    type: 'object',
    properties: { id: { type: 'string' }, note: { type: 'string' }, status: { type: 'string' } },
    required: ['id', 'status'],
  });
  expect(flattened.Extra).toMatchObject({ properties: { id: {}, note: {} }, required: ['id'] });
  expect(flattened.Union).toBe(schemas.Union);
  expect(flattened.Conflict).toBe(schemas.Conflict);
  expect(flattened.Scalar).toBe(schemas.Scalar);
  expect(flattened.Base).toBe(schemas.Base);
  // The parsed document keeps the original composition for oasdiff.
  const parsed = parseSpecification(
    JSON.stringify({ openapi: '3.1.0', paths: {}, components: { schemas } }),
    'test',
  );
  expect(parsed.schemas.Response).toEqual(flattened.Response);
  expect(
    (parsed.document.components as { schemas: Record<string, unknown> }).schemas.Response,
  ).toEqual(schemas.Response);
  expect(flattenAllOfSchemas({ Base: schemas.Base })).toEqual({ Base: schemas.Base });
});

// The shapes are those of OpenAI's published OpenAPI document (openai/openai-openapi, info.version
// 2.3.0): Response is an allOf of ModelResponseProperties, ResponseProperties and its own fields.
// The removal is simulated, not an announced OpenAI change.
function openAiContract(withPreviousResponse: boolean) {
  const response = (schema: string) => ({
    '200': {
      description: schema,
      content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } },
    },
  });
  const object = (properties: string[]) => ({
    type: 'object',
    properties: Object.fromEntries(properties.map((name) => [name, { type: 'string' }])),
  });
  return {
    openapi: '3.1.0',
    info: { title: 'OpenAI API (trimmed)', version: '2.3.0' },
    paths: {
      '/models/{model}': { get: { operationId: 'retrieveModel', responses: response('Model') } },
      '/chat/completions': {
        post: {
          operationId: 'createChatCompletion',
          responses: response('CreateChatCompletionResponse'),
        },
      },
      '/responses': { post: { operationId: 'createResponse', responses: response('Response') } },
      '/embeddings': {
        post: { operationId: 'createEmbedding', responses: response('CreateEmbeddingResponse') },
      },
    },
    components: {
      schemas: {
        Model: object(['id', 'object', 'owned_by']),
        CreateChatCompletionResponse: object(['id', 'model']),
        CreateEmbeddingResponse: object(['model', 'object']),
        ModelResponseProperties: object(['metadata', 'temperature']),
        ResponseProperties: object([
          'model',
          'instructions',
          ...(withPreviousResponse ? ['previous_response_id'] : []),
        ]),
        Response: {
          title: 'The response object',
          allOf: [
            { $ref: '#/components/schemas/ModelResponseProperties' },
            { $ref: '#/components/schemas/ResponseProperties' },
            object(['id', 'status', 'output_text']),
          ],
        },
      },
    },
  };
}

it('maps responses.create in the shipped OpenAI adapter through the allOf Response schema', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-openai-responses-'));
  roots.push(root);
  const repository = join(root, 'repository');
  await mkdir(join(repository, 'src'), { recursive: true });
  await writeFile(
    join(repository, 'package.json'),
    JSON.stringify({ name: 'app', dependencies: { openai: '6.0.0' } }),
  );
  await writeFile(
    join(repository, 'src/reply.ts'),
    [
      "import OpenAI from 'openai';",
      'const client = new OpenAI();',
      'export async function reply(input: string) {',
      "  const response = await client.responses.create({ model: 'gpt-5.6-sol', input });",
      '  return [response.output_text, response.previous_response_id];',
      '}',
    ].join('\n'),
  );
  await writeFile(join(root, 'before.json'), JSON.stringify(openAiContract(true)));
  await writeFile(join(root, 'after.json'), JSON.stringify(openAiContract(false)));
  const report = await runPipeline({
    repository,
    before: join(root, 'before.json'),
    after: join(root, 'after.json'),
    providerConfig: resolve('examples/openai.provider.json'),
  });
  expect(report.provider).toBe('openai');
  expect(report.status).toBe('affected');
  expect(report.findings).toEqual([
    expect.objectContaining({ file: 'src/reply.ts', line: 5, expression: '.previous_response_id' }),
  ]);
});
