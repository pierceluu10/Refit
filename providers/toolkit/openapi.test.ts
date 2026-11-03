import { beforeEach, describe, expect, it } from 'vitest';
import { runPassed } from '../../harness/validators.ts';
import { clearFetchCache } from './fetch.ts';
import {
  checkReport,
  clearSpecMemory,
  createOpenApiTools,
  findOperation,
  lookupReport,
  parseSpec,
  type Spec,
} from './openapi.ts';
import { recorded, recordedFetch } from './testing.ts';

const V3 =
  'https://raw.githubusercontent.com/swagger-api/swagger-petstore/master/src/main/resources/openapi.yaml';
const V2 = 'https://petstore.swagger.io/v2/swagger.json';

beforeEach(() => {
  clearFetchCache();
  clearSpecMemory();
});

describe('parseSpec', () => {
  it('reads the recorded OpenAPI 3 YAML and Swagger 2 JSON specs', () => {
    const v3 = parseSpec(recorded('petstore-openapi.yaml.txt'), V3) as Spec;
    expect(v3).toMatchObject({ format: 'OpenAPI 3', version: '3.0.4', basePaths: ['/api/v3'] });
    const v2 = parseSpec(recorded('petstore-swagger.json'), V2) as Spec;
    expect(v2).toMatchObject({ format: 'Swagger 2', version: '2.0', basePaths: ['/v2'] });
    expect(parseSpec('{"hello": 1}', 'x')).toMatch(/not an OpenAPI or Swagger document/);
    expect(parseSpec('a: [unterminated', 'x')).toMatch(/could not parse/);
  });

  it('matches concrete paths, full URLs with base paths, and operationIds', () => {
    const spec = parseSpec(recorded('petstore-openapi.yaml.txt'), V3) as Spec;
    expect(findOperation(spec, 'GET /pet/42').operation?.operationId).toBe('getPetById');
    expect(
      findOperation(spec, 'GET https://petstore3.swagger.io/api/v3/pet/findByStatus?status=sold')
        .operation?.operationId,
    ).toBe('findPetsByStatus');
    expect(findOperation(spec, 'uploadFile').operation?.path).toBe('/pet/{petId}/uploadImage');
    expect(findOperation(spec, 'DELETE /pet/7').operation?.operationId).toBe('deletePet');
    expect(findOperation(spec, 'GET /nothing/here').operation).toBeUndefined();
  });
});

describe('openapi_lookup', () => {
  it('searches operations and shows one with its params and body', async () => {
    const fetch = recordedFetch();
    const list = await lookupReport({ spec_url: V3, search: 'find pets by status' }, { fetch });
    expect(list).toContain(
      'Spec: Swagger Petstore - OpenAPI 3.0 1.0.30-SNAPSHOT (OpenAPI 3, 3.0.4)',
    );
    expect(list).toMatch(/- GET \/pet\/findByStatus \(findPetsByStatus\)/);
    const one = await lookupReport({ spec_url: V3, operation: 'POST /pet' }, { fetch });
    expect(one).toContain('Operation: POST /pet (addPet)');
    expect(one).toContain('Request body (application/json, required): object');
    expect(one).toContain('- name: string (required)');
    expect(one).toContain('- status: string one of available | pending | sold');
    expect(one).toMatch(/- 200: object with id, name, category, photoUrls, tags, status/);
  });

  it('lists what a Swagger 2 spec marks deprecated', async () => {
    const out = await lookupReport({ spec_url: V2, deprecated: true }, { fetch: recordedFetch() });
    expect(out).toContain('Marked deprecated in this spec (1):');
    expect(out).toContain('- operation GET /pet/findByTags (findPetsByTags) [deprecated]');
  });

  it('says what it could not load', async () => {
    const out = await lookupReport(
      { spec_url: 'https://acme.example.com/openapi.json' },
      { fetch: recordedFetch() },
    );
    expect(out).toContain(
      'Could not use the spec: could not load https://acme.example.com/openapi.json (HTTP 404)',
    );
    expect(await lookupReport({}, { fetch: null })).toContain('Pass "spec_url"');
  });
});

describe('openapi_check', () => {
  it('flags unknown fields, enum mismatches and missing required ones, and the harness grades it failed', async () => {
    const out = await checkReport(
      {
        spec_url: V3,
        operation: 'POST /api/v3/pet',
        params: { name: 'doggie', status: 'gone', colour: 'brown' },
      },
      { fetch: recordedFetch() },
    );
    expect(out).toContain('Operation: POST /pet (addPet)');
    expect(out).toContain('Result: 3 error(s), 0 warning(s).');
    expect(out).toContain('Unknown params: colour');
    expect(out).toContain('Required by the spec but missing: photoUrls');
    expect(out).toContain('Enum mismatch: status = "gone" (allowed: available, pending, sold)');
    expect(runPassed(out)).toBe(false);
  });

  it('passes a request that fits the spec, and the harness grades it passed', async () => {
    const out = await checkReport(
      {
        spec_url: V3,
        operation: 'addPet',
        body: {
          name: 'doggie',
          photoUrls: ['https://example.com/a.png'],
          status: 'available',
          tags: [{ id: 1, name: 'x' }],
        },
      },
      { fetch: recordedFetch() },
    );
    expect(out).toContain('Result: 0 error(s), 0 warning(s).');
    expect(out).toContain('No problems found');
    expect(runPassed(out)).toBe(true);
  });

  it('leaves credentials and transport headers to the client instead of calling them unknown', async () => {
    const out = await checkReport(
      {
        spec_url: V3,
        operation: 'GET /pet/42',
        params: { petId: 42, api_key: 'placeholder', Authorization: 'placeholder' },
      },
      { fetch: recordedFetch() },
    );
    expect(out).toContain('Result: 0 error(s), 0 warning(s).');
    expect(out).toContain(
      'Not checked: api_key (auth or transport header); Authorization (auth or transport header)',
    );
    expect(runPassed(out)).toBe(true);
  });

  it('checks query params by type and enum, with suggestions', async () => {
    const out = await checkReport(
      { spec_url: V3, operation: 'GET /pet/findByStatus', params: { status: 'availble' } },
      { fetch: recordedFetch() },
    );
    expect(out).toContain('Enum mismatch: query param status = "availble"');
    expect(out).toContain('did you mean available?');
  });

  it('treats a deprecated operation and form fields in Swagger 2', async () => {
    const fetch = recordedFetch();
    const deprecated = await checkReport(
      { spec_url: V2, operation: 'GET /v2/pet/findByTags', params: { tags: ['a'] } },
      { fetch },
    );
    expect(deprecated).toContain('Deprecated in the spec: the whole operation.');
    expect(runPassed(deprecated)).toBe(false);
    const form = await checkReport(
      {
        spec_url: V2,
        operation: 'POST /pet/12',
        params: { name: 'x', status: 'sold', nickname: 'y' },
      },
      { fetch },
    );
    expect(form).toContain('Operation: POST /pet/{petId} (updatePetWithForm)');
    expect(form).toContain('Unknown params: nickname');
  });

  it('reports an operation the spec does not have as an error, with the closest ones', async () => {
    const out = await checkReport(
      { spec_url: V3, operation: 'POST /pets/adopt', params: {} },
      { fetch: recordedFetch() },
    );
    expect(out).toContain('Result: 1 error(s)');
    expect(out).toContain('Operation not in this spec: POST /pets/adopt.');
    expect(runPassed(out)).toBe(false);
  });

  it('never counts a check that did not run as a pass', async () => {
    const fetch = recordedFetch();
    for (const out of [
      await checkReport({ spec_url: V3, operation: 'POST /pet' }, { fetch }),
      await checkReport({ operation: 'POST /pet', params: {} }, { fetch }),
      await checkReport(
        { spec_url: 'https://acme.example.com/spec.yaml', operation: 'POST /x', params: {} },
        { fetch },
      ),
    ]) {
      expect(out).toContain('failed to run');
      expect(runPassed(out)).toBe(false);
    }
  });

  it('merges anyOf variants, reads 3.1 null types and lists webhooks (hand-written spec)', async () => {
    const spec = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Example', version: '2026-01-01' },
      paths: {
        '/v1/messages': {
          post: {
            operationId: 'createMessage',
            requestBody: {
              required: true,
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Create' } } },
            },
          },
        },
      },
      webhooks: {
        messageSent: {
          post: {
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Create' } } },
            },
          },
        },
      },
      components: {
        schemas: {
          Create: {
            type: 'object',
            required: ['model'],
            properties: {
              model: { type: 'string' },
              stop: { anyOf: [{ type: 'string' }, { type: 'null' }], deprecated: true },
              tools: { type: ['array', 'null'], items: { $ref: '#/components/schemas/Tool' } },
              metadata: { type: 'object', additionalProperties: { type: 'string' } },
            },
          },
          Tool: {
            oneOf: [{ $ref: '#/components/schemas/Fn' }, { $ref: '#/components/schemas/Web' }],
          },
          Fn: {
            type: 'object',
            properties: { type: { enum: ['function'] }, name: { type: 'string' } },
          },
          Web: {
            type: 'object',
            properties: { type: { enum: ['web_search'] }, max_uses: { type: 'integer' } },
          },
        },
      },
    });
    const url = 'https://acme.example.com/openapi.json';
    const fetch = recordedFetch({
      [url]: { status: 200, body: spec, contentType: 'application/json' },
    });
    const out = await checkReport(
      {
        spec_url: url,
        operation: 'POST /v1/messages',
        body: {
          model: 'm',
          stop: null,
          tools: [{ type: 'web_search', max_uses: 2 }, { type: 'computer' }],
          metadata: { any: 'thing' },
        },
      },
      { fetch },
    );
    expect(out).toContain('Result: 1 error(s), 1 warning(s).');
    expect(out).toContain('Deprecated in the spec: stop');
    expect(out).toContain(
      'Enum mismatch: tools[1].type = "computer" (allowed: function, web_search)',
    );
    const hooks = await lookupReport({ spec_url: url, search: 'message sent' }, { fetch });
    expect(hooks).toContain('- POST webhook messageSent');
  });

  it('is a pair of tools with harness-safe names', async () => {
    const [lookup, check] = createOpenApiTools({ fetch: null });
    expect([lookup.name, check.name]).toEqual(['openapi_lookup', 'openapi_check']);
    expect(await check.run({}, { repoDir: '.' })).toContain('failed to run');
  });
});
