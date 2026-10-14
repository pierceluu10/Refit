import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { parseProviderAdapter } from './providers.ts';
import {
  isHandledRequestRename,
  requestRenameEvidence,
  validateRequestPropertyRenames,
} from './provider-request-renames.ts';

const fixture = 'pipeline/fixtures/request-renames';
const provider = JSON.parse(await readFile(`${fixture}/provider.json`, 'utf8'));
type Contract = Record<string, any>;
async function contracts(): Promise<{ before: Contract; after: Contract }> {
  return {
    before: JSON.parse(await readFile(`${fixture}/before.json`, 'utf8')),
    after: JSON.parse(await readFile(`${fixture}/after.json`, 'utf8')),
  };
}

it('verifies the full operation after normalizing only explicitly configured request names', async () => {
  const { before, after } = await contracts();
  const original = JSON.stringify(before);
  const result = validateRequestPropertyRenames(parseProviderAdapter(provider), before, after);
  expect(result).toMatchObject([
    {
      schema: 'CreateItem',
      removed: 'legacy_name',
      replacement: 'display_name',
      argumentIndex: 0,
      operationId: 'createItem',
      path: '/items',
      httpMethod: 'POST',
      contractHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  ]);
  expect(JSON.stringify(before)).toBe(original);
  expect(validateRequestPropertyRenames(parseProviderAdapter(provider), before, before)).toEqual(
    [],
  );
});

it('validates several configured renames as one request contract', async () => {
  const { before, after } = await contracts();
  const schema = after.components.schemas.CreateItem;
  schema.properties.units = schema.properties.quantity;
  delete schema.properties.quantity;
  const configured = parseProviderAdapter({
    ...provider,
    requestPropertyRenames: [
      ...provider.requestPropertyRenames,
      { ...provider.requestPropertyRenames[0], removed: 'quantity', replacement: 'units' },
    ],
  });
  const result = validateRequestPropertyRenames(configured, before, after);
  expect(result).toHaveLength(2);
  expect(result[0].contractHash).toBe(result[1].contractHash);
  expect(result[0].id).not.toBe(result[1].id);
  expect(() =>
    validateRequestPropertyRenames(parseProviderAdapter(provider), before, after),
  ).toThrow(/beyond the configured field names/);
});

it('resolves local request-body references and object-schema aliases', async () => {
  const { before, after } = await contracts();
  for (const document of [before, after]) {
    document.components.requestBodies = { ItemBody: document.paths['/items'].post.requestBody };
    document.paths['/items'].post.requestBody = { $ref: '#/components/requestBodies/ItemBody' };
    document.components.schemas.BodyAlias = { $ref: '#/components/schemas/CreateItem' };
    document.components.requestBodies.ItemBody.content['application/json'].schema.$ref =
      '#/components/schemas/BodyAlias';
  }
  expect(
    validateRequestPropertyRenames(parseProviderAdapter(provider), before, after)[0].schema,
  ).toBe('CreateItem');
});

it.each([
  [
    'field type',
    (document: Contract) => {
      document.components.schemas.CreateItem.properties.display_name.type = 'integer';
    },
  ],
  [
    'field bound',
    (document: Contract) => {
      document.components.schemas.CreateItem.properties.display_name.minLength = 5;
    },
  ],
  [
    'field nullable',
    (document: Contract) => {
      document.components.schemas.CreateItem.properties.display_name.nullable = true;
    },
  ],
  [
    'requiredness',
    (document: Contract) => {
      document.components.schemas.CreateItem.required = [];
    },
  ],
  [
    'additional fields',
    (document: Contract) => {
      document.components.schemas.CreateItem.additionalProperties = true;
    },
  ],
  [
    'response',
    (document: Contract) => {
      document.components.schemas.Item.properties.id.type = 'integer';
    },
  ],
  [
    'security',
    (document: Contract) => {
      document.paths['/items'].post.security = [{ changed: [] }];
    },
  ],
  [
    'server',
    (document: Contract) => {
      document.servers = [{ url: 'https://changed.example.com' }];
    },
  ],
  [
    'parameter',
    (document: Contract) => {
      document.paths['/items'].post.parameters = [
        { name: 'required-query', in: 'query', required: true, schema: { type: 'string' } },
      ];
    },
  ],
])('rejects a simultaneous %s change', async (_name, mutate) => {
  const { before, after } = await contracts();
  mutate(after);
  expect(() =>
    validateRequestPropertyRenames(parseProviderAdapter(provider), before, after),
  ).toThrow(/changes constraints/);
});

it.each([
  [
    'operation removed',
    (_before: Contract, after: Contract) => {
      delete after.paths['/items'];
    },
  ],
  [
    'operation ID moved',
    (_before: Contract, after: Contract) => {
      after.paths['/other'] = after.paths['/items'];
      delete after.paths['/items'];
    },
  ],
  [
    'operation ID duplicated',
    (_before: Contract, after: Contract) => {
      after.paths['/other'] = structuredClone(after.paths['/items']);
    },
  ],
  [
    'replacement missing',
    (_before: Contract, after: Contract) => {
      delete after.components.schemas.CreateItem.properties.display_name;
    },
  ],
  [
    'replacement already existed',
    (before: Contract) => {
      before.components.schemas.CreateItem.properties.display_name = { type: 'string' };
    },
  ],
  [
    'source missing',
    (before: Contract) => {
      delete before.components.schemas.CreateItem.properties.legacy_name;
    },
  ],
  [
    'media type',
    (_before: Contract, after: Contract) => {
      after.paths['/items'].post.requestBody.content['application/xml'] =
        after.paths['/items'].post.requestBody.content['application/json'];
    },
  ],
  [
    'inline body',
    (before: Contract) => {
      before.paths['/items'].post.requestBody.content['application/json'].schema =
        before.components.schemas.CreateItem;
    },
  ],
  [
    'reference siblings',
    (before: Contract) => {
      before.paths['/items'].post.requestBody.content['application/json'].schema.nullable = true;
    },
  ],
])('refuses unsupported request mapping: %s', async (_name, mutate) => {
  const { before, after } = await contracts();
  mutate(before, after);
  expect(() =>
    validateRequestPropertyRenames(parseProviderAdapter(provider), before, after),
  ).toThrow();
});

it('requires one body argument, unique mapping names and an existing operationId', () => {
  const rule = provider.requestPropertyRenames[0];
  for (const requestPropertyRenames of [
    'invalid',
    [{ ...rule, argumentIndex: -1 }],
    [{ ...rule, argumentIndex: 17 }],
    [{ ...rule, argumentIndex: '0' }],
    [{ ...rule, removed: '__proto__' }],
    [{ ...rule, replacement: '__proto__' }],
    [{ ...rule, extra: true }],
    [rule, rule],
    [rule, { ...rule, removed: 'other' }],
    [rule, { ...rule, argumentIndex: 1, removed: 'quantity', replacement: 'units' }],
  ])
    expect(() => parseProviderAdapter({ ...provider, requestPropertyRenames })).toThrow();
  expect(() =>
    parseProviderAdapter({
      ...provider,
      operations: [{ ...provider.operations[0], operationId: undefined }],
    }),
  ).toThrow(/operationId/);
});

it('covers only exact known request-field changelog entries on the reviewed operation', async () => {
  const { before, after } = await contracts();
  const replacements = validateRequestPropertyRenames(
    parseProviderAdapter(provider),
    before,
    after,
  );
  const call = {
    file: 'billing.ts',
    line: 1,
    column: 1,
    method: 'items.create',
    operationId: 'createItem',
  };
  const evidence = requestRenameEvidence(replacements, [call], []);
  expect(evidence[0].supported).toBe(true);
  const removed = {
    id: 'request-property-removed',
    text: 'removed the request property `legacy_name`',
    path: '/items',
    operation: 'POST',
  };
  const added = {
    ...removed,
    id: 'new-required-request-property',
    text: 'added the new required request property `display_name`',
  };
  expect(isHandledRequestRename(removed, evidence)).toBe(true);
  expect(isHandledRequestRename(added, evidence)).toBe(true);
  for (const change of [
    { ...removed, path: '/other' },
    { ...removed, operation: 'GET' },
    { ...removed, text: 'removed the request property `quantity`' },
    { ...removed, id: 'response-required-property-removed' },
  ])
    expect(isHandledRequestRename(change, evidence)).toBe(false);
  const uncertain = requestRenameEvidence(
    replacements,
    [call],
    [
      {
        ...call,
        expression: 'items.create',
        changeId: replacements[0].id,
        confidence: 'review',
        reason: 'Dynamic request',
      },
    ],
  );
  expect(isHandledRequestRename(removed, uncertain)).toBe(false);
  expect(requestRenameEvidence(replacements, [], [])[0].supported).toBe(false);
});
