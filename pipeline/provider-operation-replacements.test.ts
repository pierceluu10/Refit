import { expect, it } from 'vitest';
import { parseProviderAdapter } from './providers.ts';
import { validateOperationReplacements } from './provider-operation-replacements.ts';

const provider = {
  id: 'catalog-example',
  packageName: '@example/catalog',
  defaultImport: false,
  namedExport: 'Catalog',
  operations: [
    {
      resource: 'items',
      method: 'retrieveLegacy',
      schema: 'Item',
      operationId: 'retrieveLegacyItem',
    },
  ],
  operationReplacements: [
    {
      resource: 'items',
      method: 'retrieveLegacy',
      replacementResource: 'items',
      replacementMethod: 'retrieve',
      replacementOperationId: 'retrieveItem',
    },
  ],
};

function contracts() {
  const response = {
    description: 'Item',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } },
  };
  const source: Record<string, unknown> = {
    operationId: 'retrieveLegacyItem',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    responses: { '200': response, '404': { description: 'Not found' } },
  };
  const before = {
    openapi: '3.0.3',
    info: { title: 'Catalog', version: '1' },
    paths: { '/legacy/items/{id}': { get: source } } as Record<string, Record<string, unknown>>,
    components: {
      schemas: {
        Item: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } } },
      } as Record<string, unknown>,
    },
  };
  const after = {
    ...structuredClone(before),
    info: { title: 'Catalog', version: '2' },
    paths: {
      '/items/{id}': { get: { ...structuredClone(source), operationId: 'retrieveItem' } },
    } as Record<string, Record<string, unknown>>,
  };
  return { before, after };
}

function validate({ before, after }: ReturnType<typeof contracts>) {
  return validateOperationReplacements(
    parseProviderAdapter(provider),
    before,
    after,
    before.components.schemas,
    after.components.schemas,
  );
}

it('records an explicit endpoint replacement only after comparing the full referenced contract', () => {
  const documents = contracts();
  expect(validate(documents)).toMatchObject([
    {
      resource: 'items',
      method: 'retrieveLegacy',
      operationId: 'retrieveLegacyItem',
      path: '/legacy/items/{id}',
      httpMethod: 'GET',
      replacementPath: '/items/{id}',
      replacementResource: 'items',
      replacementMethod: 'retrieve',
      replacementOperationId: 'retrieveItem',
      contractHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  ]);
  expect(validate(documents)[0].id).toBe(validate(documents)[0].id);
});

it('supports an operation ID moving to a new path', () => {
  const documents = contracts();
  (documents.after.paths['/items/{id}'].get as Record<string, unknown>).operationId =
    'retrieveLegacyItem';
  const configured = parseProviderAdapter({
    ...provider,
    operationReplacements: [
      { ...provider.operationReplacements[0], replacementOperationId: 'retrieveLegacyItem' },
    ],
  });
  expect(
    validateOperationReplacements(
      configured,
      documents.before,
      documents.after,
      documents.before.components.schemas,
      documents.after.components.schemas,
    ),
  ).toHaveLength(1);
});

it('keeps a configured replacement inactive while the old endpoint is still present', () => {
  const documents = contracts();
  documents.after.paths['/legacy/items/{id}'] = structuredClone(
    documents.before.paths['/legacy/items/{id}'],
  );
  expect(validate(documents)).toEqual([]);
});

it.each([
  [
    'response schema definition',
    (documents: ReturnType<typeof contracts>) => {
      documents.after.components.schemas.Item = {
        type: 'object',
        properties: { id: { type: 'string' }, label: { type: 'integer' } },
      };
    },
  ],
  [
    'request body',
    (documents: ReturnType<typeof contracts>) => {
      (documents.after.paths['/items/{id}'].get as Record<string, unknown>).requestBody = {
        required: true,
        content: { 'application/json': { schema: { type: 'string' } } },
      };
    },
  ],
  [
    'request parameters',
    (documents: ReturnType<typeof contracts>) => {
      (documents.after.paths['/items/{id}'].get as Record<string, unknown>).parameters = [
        { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      ];
    },
  ],
  [
    'inherited parameters',
    (documents: ReturnType<typeof contracts>) => {
      documents.after.paths['/items/{id}'].parameters = [
        { name: 'revision', in: 'query', required: true, schema: { type: 'string' } },
      ];
    },
  ],
  [
    'server',
    (documents: ReturnType<typeof contracts>) => {
      documents.after.paths['/items/{id}'].servers = [{ url: 'https://different.example' }];
    },
  ],
  [
    'security',
    (documents: ReturnType<typeof contracts>) => {
      (documents.after.paths['/items/{id}'].get as Record<string, unknown>).security = [
        { token: [] },
      ];
    },
  ],
  [
    'HTTP method',
    (documents: ReturnType<typeof contracts>) => {
      documents.after.paths['/items/{id}'] = { post: documents.after.paths['/items/{id}'].get };
    },
  ],
  [
    'path parameter names',
    (documents: ReturnType<typeof contracts>) => {
      documents.after.paths['/items/{itemId}'] = documents.after.paths['/items/{id}'];
      delete documents.after.paths['/items/{id}'];
    },
  ],
])('rejects a replacement with a changed %s', (_label, mutate) => {
  const documents = contracts();
  mutate(documents);
  expect(() => validate(documents)).toThrow(/changes its recorded request, response/);
});

it('rejects pre-existing and ambiguous replacement endpoints', () => {
  const preexisting = contracts();
  preexisting.before.paths['/items/{id}'] = structuredClone(preexisting.after.paths['/items/{id}']);
  expect(() => validate(preexisting)).toThrow(/newly introduced endpoint/);
  const ambiguous = contracts();
  ambiguous.after.paths['/other/{id}'] = structuredClone(ambiguous.after.paths['/items/{id}']);
  expect(() => validate(ambiguous)).toThrow(/resolve exactly once/);
});

it('resolves nested and recursive local references without ignoring schema changes', () => {
  const documents = contracts();
  documents.before.components.schemas.Item = {
    type: 'object',
    properties: { detail: { $ref: '#/components/schemas/Detail' } },
  };
  documents.before.components.schemas.Detail = {
    type: 'object',
    properties: { text: { type: 'string' }, parent: { $ref: '#/components/schemas/Detail' } },
  };
  documents.after.components.schemas = structuredClone(documents.before.components.schemas);
  expect(validate(documents)).toHaveLength(1);
  documents.after.components.schemas.Detail = {
    type: 'object',
    properties: { text: { type: 'integer' }, parent: { $ref: '#/components/schemas/Detail' } },
  };
  expect(() => validate(documents)).toThrow(/changes its recorded request, response/);
});

it('rejects ambiguous success responses and references with sibling fields', () => {
  const documents = contracts();
  const operation = documents.after.paths['/items/{id}'].get as Record<string, unknown>;
  operation.responses = {
    '200': {
      description: 'Item',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } },
    },
    '204': { description: 'No content' },
  };
  expect(() => validate(documents)).toThrow(/one JSON success response/);
  const siblings = contracts();
  (siblings.after.paths['/items/{id}'].get as Record<string, unknown>).parameters = [
    { $ref: '#/components/parameters/id', description: 'Sibling' },
  ];
  expect(() => validate(siblings)).toThrow(/without sibling fields/);
});

it('rejects invalid or colliding SDK replacements before scanning', () => {
  expect(() =>
    parseProviderAdapter({
      ...provider,
      operationReplacements: [
        { ...provider.operationReplacements[0], replacementMethod: 'retrieveLegacy' },
      ],
    }),
  ).toThrow(/new, distinct SDK/);
  expect(() =>
    parseProviderAdapter({
      ...provider,
      operations: [{ resource: 'items', method: 'retrieveLegacy', schema: 'Item' }],
    }),
  ).toThrow(/operationId mapping/);
  expect(() =>
    parseProviderAdapter({
      ...provider,
      operationReplacements: [...provider.operationReplacements, provider.operationReplacements[0]],
    }),
  ).toThrow(/must be unique/);
});
