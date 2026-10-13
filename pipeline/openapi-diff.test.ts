import { expect, it } from 'vitest';
import { compareOpenApi, unmappedBreakingChanges } from './openapi-diff.ts';

const CONTRACT = {
  openapi: '3.0.3',
  info: { title: 'Provider-independent example', version: '1' },
  paths: {
    '/models': {
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
        required: ['id', 'owned_by'],
        properties: { id: { type: 'string' }, owned_by: { type: 'string' } },
      },
    },
  },
};

it.skipIf(!process.env.REFIT_OASDIFF)(
  'uses the actual shared engine for response fields, types and endpoint removals',
  async () => {
    const after = structuredClone(CONTRACT);
    delete (after.components.schemas.Model.properties as Record<string, unknown>).owned_by;
    after.components.schemas.Model.required = ['id'];
    after.components.schemas.Model.properties.id.type = 'integer';
    const report = await compareOpenApi(CONTRACT, after);
    expect(report.engine).toBe('oasdiff');
    expect(
      report.changes.some((change) => change.id === 'response-required-property-removed'),
    ).toBe(true);
    expect(
      report.changes.find((change) => change.id === 'response-required-property-removed'),
    ).toMatchObject({
      responseSchema: 'Model',
      removedProperty: 'owned_by',
    });
    expect(report.changes.some((change) => String(change.id).includes('type-changed'))).toBe(true);
    const removed = await compareOpenApi(CONTRACT, { ...CONTRACT, paths: {} });
    expect(removed.changes.some((change) => String(change.id).includes('removed'))).toBe(true);
  },
);

it.skipIf(!process.env.REFIT_OASDIFF)(
  'refuses external references instead of fetching documents named by a specification',
  async () => {
    const unsafe = {
      ...CONTRACT,
      components: { schemas: { Model: { $ref: 'https://127.0.0.1/secret.yaml' } } },
    };
    await expect(compareOpenApi(unsafe, CONTRACT)).rejects.toThrow(
      /external specification references/,
    );
  },
);

it('keeps type, endpoint and unrelated property changes out of automatic response-field publication', () => {
  const changes = [
    {
      id: 'owner-removal',
      schema: 'Model',
      property: 'owner',
      pointer: '/components/schemas/Model/properties/owner',
    },
  ];
  const findings = [
    {
      file: 'models.ts',
      line: 1,
      column: 1,
      expression: '.owner',
      confidence: 'confirmed' as const,
      reason: 'Traced response',
      changeId: 'owner-removal',
    },
  ];
  const known = {
    id: 'response-required-property-removed',
    level: 3,
    text: 'removed the required property `owner`',
    responseSchema: 'Model',
    removedProperty: 'owner',
  };
  expect(
    unmappedBreakingChanges({ engine: 'oasdiff', changes: [known] }, changes, findings),
  ).toEqual([]);
  const extra = { id: 'response-property-type-changed', level: 3, text: 'changed `id` to integer' };
  expect(
    unmappedBreakingChanges({ engine: 'oasdiff', changes: [known, extra] }, changes, findings),
  ).toEqual([extra]);
  expect(
    unmappedBreakingChanges(
      { engine: 'oasdiff', changes: [{ ...known, removedProperty: 'another_field' }] },
      changes,
      findings,
    ),
  ).toHaveLength(1);
  expect(
    unmappedBreakingChanges(
      { engine: 'oasdiff', changes: [{ ...known, responseSchema: 'AnotherModel' }] },
      changes,
      findings,
    ),
  ).toHaveLength(1);
  expect(
    unmappedBreakingChanges(
      { engine: 'oasdiff', changes: [{ ...known, responseSchema: undefined }] },
      changes,
      findings,
    ),
  ).toHaveLength(1);
});
