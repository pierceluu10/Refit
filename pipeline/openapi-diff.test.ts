import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import {
  adapterContract,
  compareOpenApi,
  expansionLocation,
  switchedEnumAdditions,
  unmappedBreakingChanges,
} from './openapi-diff.ts';
import { STRIPE } from './providers.ts';

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

it('keeps only the operations an adapter maps and the components they reference', () => {
  const document = {
    openapi: '3.0.3',
    info: { title: 'Example', version: '1' },
    paths: {
      '/items/{id}': {
        parameters: [{ $ref: '#/components/parameters/Id' }],
        get: {
          operationId: 'GetItem',
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: { anyOf: [{ $ref: '#/components/schemas/item' }, { type: 'string' }] },
                },
              },
            },
          },
        },
        delete: { operationId: 'DeleteItem', responses: {} },
      },
      '/orders': { get: { operationId: 'ListOrders', responses: {} } },
    },
    components: {
      parameters: { Id: { name: 'id', in: 'path', schema: { type: 'string' } } },
      schemas: {
        item: { properties: { owner: { $ref: '#/components/schemas/owner' } } },
        owner: { properties: { name: { type: 'string' } } },
        order: { properties: {} },
      },
      securitySchemes: { basic: { type: 'http', scheme: 'basic' } },
    },
  };
  const pruned = adapterContract(document, {
    id: 'example',
    packageName: 'example',
    defaultImport: true,
    namedExport: null,
    operations: [{ resource: 'items', method: 'retrieve', schema: 'item' }],
  });
  expect(Object.keys(pruned.paths)).toEqual(['/items/{id}']);
  expect(Object.keys(pruned.paths['/items/{id}'])).toEqual(['parameters', 'get']);
  expect(Object.keys(pruned.components.schemas).sort()).toEqual(['item', 'owner']);
  expect(Object.keys(pruned.components.parameters)).toEqual(['Id']);
  expect(pruned.components.securitySchemes).toEqual(document.components.securitySchemes);
});

const statusSchemas = (values: string[]) => ({
  subscription: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: values },
      collection_method: { anyOf: [{ type: 'string', enum: ['charge_automatically'] }] },
    },
  },
});

it('reports new enum values only on fields the code checks exhaustively', () => {
  const before = statusSchemas(['active', 'canceled']);
  const after = statusSchemas(['active', 'canceled', 'paused']);
  const check = { file: 'billing.ts', line: 4, column: 3, schema: 'subscription' };
  expect(switchedEnumAdditions([{ ...check, property: 'status' }], before, after)).toMatchObject([
    {
      id: 'response-property-enum-value-added',
      level: 3,
      responseSchema: 'subscription',
      property: 'status',
      values: ['paused'],
      usage: { file: 'billing.ts', line: 4 },
    },
  ]);
  expect(switchedEnumAdditions([{ ...check, property: 'status' }], before, before)).toEqual([]);
  expect(switchedEnumAdditions([{ ...check, property: 'id' }], before, after)).toEqual([]);
  expect(
    switchedEnumAdditions([{ ...check, property: 'collection_method' }], before, {
      subscription: {
        ...after.subscription,
        properties: {
          ...after.subscription.properties,
          collection_method: { anyOf: [{ type: 'string', enum: ['charge_automatically', 'x'] }] },
        },
      },
    }),
  ).toMatchObject([{ property: 'collection_method', values: ['x'] }]);
});

it('records switches and never-checks over traced Stripe fields as enum checks', () => {
  const repository = {
    root: '/enum-checks',
    files: [
      {
        path: 'billing.ts',
        content: `import Stripe from 'stripe';
const stripe = new Stripe('sk');
export async function access(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id);
  switch (subscription.status) { case 'active': return true; default: return false; }
}
export function label(subscription: Stripe.Subscription) {
  const status = subscription.status;
  if (status === 'active') return 'on';
  const unhandled: never = status;
  return unhandled;
}
export function other(value: { status: string }) { switch (value.status) { default: return 0; } }`,
      },
    ],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  const provider = {
    ...STRIPE,
    operations: [{ resource: 'subscriptions', method: 'retrieve', schema: 'subscription' }],
  };
  const result = analyzeRepository(repository, [], provider, statusSchemas(['active']));
  expect(result.enumChecks).toEqual([
    { file: 'billing.ts', line: 5, column: 3, schema: 'subscription', property: 'status' },
    { file: 'billing.ts', line: 10, column: 9, schema: 'subscription', property: 'status' },
  ]);
});

it.skipIf(!process.env.REFIT_OASDIFF)(
  'omits Stripe response enum additions and informational entries from the blocking report',
  async () => {
    const contract = (values: string[]) => ({
      ...CONTRACT,
      components: {
        schemas: {
          Model: {
            ...CONTRACT.components.schemas.Model,
            properties: {
              ...CONTRACT.components.schemas.Model.properties,
              status: { type: 'string', enum: values },
              note: { type: 'string' },
            },
          },
        },
      },
    });
    const before = contract(['ready']);
    const after = contract(['ready', 'archived']);
    delete (after.components.schemas.Model.properties as Record<string, unknown>).note;
    const generic = await compareOpenApi(before, after);
    expect(
      generic.changes.some((change) => change.id === 'response-property-enum-value-added'),
    ).toBe(true);
    const stripe = await compareOpenApi(before, after, { openResponseEnums: true });
    expect(
      stripe.changes.some((change) => change.id === 'response-property-enum-value-added'),
    ).toBe(false);
    expect(stripe.changes).toContainEqual(
      expect.objectContaining({
        id: 'response-optional-property-removed',
        removedProperty: 'note',
      }),
    );
    expect(stripe.coverage).toContain('Stripe response enum additions');
  },
);

// Shapes follow Stripe's expandable fields: `anyOf: [ID string, object]` with expansion metadata.
const EXPANDABLE_CONTRACT = {
  openapi: '3.0.0',
  paths: {
    '/v1/invoices/{invoice}': {
      get: {
        responses: {
          '200': {
            description: 'Invoice',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/invoice' } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      invoice: {
        type: 'object',
        properties: {
          paid: { type: 'boolean' },
          customer: {
            anyOf: [{ type: 'string' }, { $ref: '#/components/schemas/customer' }],
            'x-expansionResources': { oneOf: [{ $ref: '#/components/schemas/customer' }] },
          },
          account_tax_ids: {
            type: 'array',
            items: {
              anyOf: [{ type: 'string' }, { $ref: '#/components/schemas/tax_id' }],
              'x-expansionResources': { oneOf: [{ $ref: '#/components/schemas/tax_id' }] },
            },
          },
          rendering: { anyOf: [{ $ref: '#/components/schemas/rendering' }], nullable: true },
        },
      },
      customer: { type: 'object', properties: { legacy: { type: 'string' } } },
      tax_id: { type: 'object', properties: { legacy: { type: 'string' } } },
      rendering: { type: 'object', properties: { legacy: { type: 'string' } } },
    },
  },
};

function removal(property: string) {
  return {
    id: 'response-required-property-removed',
    level: 3,
    path: '/v1/invoices/{invoice}',
    operation: 'GET',
    text: `removed the required property \`${property}\` from the response with the \`200\` status`,
  };
}

it('names the expandable fields a removed response property lies inside', () => {
  const cases: [string, unknown][] = [
    ['customer/anyOf[subschema #2: Customer]/legacy', { expansions: ['customer'] }],
    [
      'account_tax_ids/items/anyOf[subschema #2: tax_id]/legacy',
      { expansions: ['account_tax_ids'] },
    ],
    ['paid', undefined],
    ['rendering/anyOf[subschema #1: rendering]/legacy', undefined],
    ['customer/anyOf[subschema #1]/legacy', undefined],
    ['customer/anyOf[subschema #2: Customer]/missing', undefined],
    ['missing/anyOf[subschema #2: Customer]/legacy', undefined],
  ];
  for (const [property, expected] of cases)
    expect(expansionLocation(removal(property), EXPANDABLE_CONTRACT), property).toEqual(expected);
});

it('stops blocking on removals inside expansions only when no request expands them', () => {
  const diff = {
    engine: 'oasdiff',
    changes: [
      { ...removal('customer/anyOf[subschema #2: Customer]/legacy'), expansions: ['customer'] },
      removal('paid'),
    ],
  };
  const blocking = (expanded?: string[]) =>
    unmappedBreakingChanges(diff, [], [], [], [], expanded).map((entry) =>
      String((entry as { text: string }).text),
    );
  expect(blocking([])).toEqual([removal('paid').text]);
  expect(blocking(['line_items'])).toEqual([removal('paid').text]);
  expect(blocking(['customer'])).toHaveLength(2);
  expect(blocking(['*'])).toHaveLength(2);
  expect(blocking()).toHaveLength(2);
});

it('records literal expansions and treats any other expand mention as expanding everything', () => {
  const fields = (source: string) =>
    analyzeRepository(
      {
        root: '/repository',
        files: [{ path: 'billing.ts', content: source }],
        dependencies: [],
      } as never,
      [],
      STRIPE,
    ).expandedFields;
  expect(
    fields("stripe.invoices.retrieve(id, { expand: ['customer', 'lines.data.price'] });"),
  ).toEqual(['customer', 'data', 'lines', 'price']);
  expect(fields("stripe.invoices.retrieve(id, { 'expand': ['customer'] });")).toEqual(['customer']);
  expect(fields('stripe.invoices.retrieve(id);')).toEqual([]);
  for (const source of [
    'stripe.invoices.retrieve(id, { expand });',
    'stripe.invoices.retrieve(id, { expand: fields });',
    'options.expand = fields;',
    "options['expand'] = fields;",
    "stripe.invoices.retrieve(id, { expand: [...fields, 'customer'] });",
  ])
    expect(fields(source), source).toContain('*');
});
