import { expect, it } from 'vitest';
import { compareOpenApi } from './openapi-diff.ts';
import { equivalentChange, FORMAT_ANNOTATION, RENAMED_SUBSCHEMA } from './schema-equivalence.ts';

type Json = Record<string, any>;

// `address` on POST /v1/customers/{customer}, from Stripe's spec3.json at stripe/openapi v208
// (2022-11-15) and v2526 (2026-09-30.endive): only the member's title and description changed.
const line = { maxLength: 5000, type: 'string' };
const address = (title: string, extra: Json = {}) => ({
  anyOf: [
    {
      properties: {
        city: line,
        country: line,
        line1: line,
        line2: line,
        postal_code: line,
        state: line,
        ...extra,
      },
      title,
      type: 'object',
    },
    { enum: [''], type: 'string' },
  ],
  description: `The customer's address (${title}).`,
});
const contract = (properties: Json, schemas: Json = {}, queryCurrency: Json = { type: 'string' }) =>
  JSON.parse(
    JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Stripe', version: 'test' },
      paths: {
        '/v1/customers/{customer}': {
          post: {
            operationId: 'PostCustomersCustomer',
            parameters: [
              { in: 'path', name: 'customer', required: true, schema: { type: 'string' } },
              { in: 'query', name: 'currency', schema: queryCurrency },
            ],
            requestBody: {
              content: {
                'application/x-www-form-urlencoded': { schema: { type: 'object', properties } },
              },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
      components: { schemas },
    }),
  ) as Json;
const requestSchema = (document: Json) =>
  document.paths['/v1/customers/{customer}'].post.requestBody.content[
    'application/x-www-form-urlencoded'
  ].schema.properties;
const removed = {
  id: 'request-property-any-of-removed',
  level: 3,
  operation: 'POST',
  path: '/v1/customers/{customer}',
  text: 'removed `subschema #1: optional_fields_address` from the `address` request property `anyOf` list',
};
const formatChange = {
  id: 'request-property-type-changed',
  level: 3,
  operation: 'POST',
  path: '/v1/customers/{customer}',
  text: 'the `currency` request property `format` changed from `none` to `currency`',
};

it('passes a subschema replaced by one with the same shape, in any order', () => {
  const before = contract({ address: address('optional_fields_address') });
  const after = contract({ address: address('optional_fields_customer_address') });
  expect(equivalentChange(removed, before, after)).toEqual({
    equivalence: RENAMED_SUBSCHEMA,
    reach: 'compatible',
    reachReason: expect.stringContaining('same shape'),
  });
  requestSchema(after).address.anyOf.reverse();
  expect(equivalentChange(removed, before, after)?.equivalence).toBe(RENAMED_SUBSCHEMA);
});

it.each([
  // stripe/openapi v2526: bacs_debit's new member adds `mandate_options` and `target_date`.
  ['an added property', { target_date: line }],
  ['a tighter maxLength', { city: { maxLength: 500, type: 'string' } }],
  ['a new type', { city: { type: 'integer' } }],
  ['a nullable property', { city: { ...line, nullable: true } }],
  ['an enum', { state: { ...line, enum: ['CA'] } }],
  ['a nested property', { city: { type: 'object', properties: { name: line } } }],
])('keeps blocking a replacement subschema with %s', (_name, extra) => {
  const before = contract({ address: address('optional_fields_address') });
  const after = contract({ address: address('optional_fields_customer_address', extra) });
  expect(equivalentChange(removed, before, after)).toBeUndefined();
});

it('keeps blocking a replacement that changes required properties or additionalProperties', () => {
  const before = contract({ address: address('a') });
  for (const change of [{ required: ['city'] }, { additionalProperties: false }]) {
    const after = contract({ address: address('b') });
    Object.assign(requestSchema(after).address.anyOf[0], change);
    expect(equivalentChange(removed, before, after)).toBeUndefined();
  }
});

it('compares referenced components by shape, with cycle protection', () => {
  const node = (name: string, extra: Json = {}) => ({
    title: name,
    type: 'object',
    properties: {
      id: { type: 'string' },
      parent: { $ref: `#/components/schemas/${name}` },
      ...extra,
    },
  });
  const property = (name: string) => ({ anyOf: [{ $ref: `#/components/schemas/${name}` }] });
  const change = {
    ...removed,
    text: 'removed `subschema #1: old_node` from the `address` request property `anyOf` list',
  };
  const before = contract({ address: property('old_node') }, { old_node: node('old_node') });
  const after = contract({ address: property('new_node') }, { new_node: node('new_node') });
  expect(equivalentChange(change, before, after)?.equivalence).toBe(RENAMED_SUBSCHEMA);
  const deeper = contract(
    { address: property('new_node') },
    { new_node: node('new_node', { name: line }) },
  );
  expect(equivalentChange(change, before, deeper)).toBeUndefined();
  // A property named like an annotation keyword is still compared.
  const described = contract(
    { address: property('new_node') },
    { new_node: node('new_node', { description: line }) },
  );
  expect(equivalentChange(change, before, described)).toBeUndefined();
});

it('passes a currency or unix-time format added to the type it annotates, and no other format', () => {
  const currency = { type: 'string', description: 'Three-letter ISO currency code, in lowercase.' };
  const before = contract({ currency });
  expect(
    equivalentChange(
      formatChange,
      before,
      contract({ currency: { ...currency, format: 'currency' } }),
    ),
  ).toEqual({
    equivalence: FORMAT_ANNOTATION,
    reach: 'compatible',
    reachReason: expect.stringContaining('https://docs.stripe.com/currencies'),
  });
  // The query parameter form oasdiff reports for GET /v1/prices.
  const query = {
    ...formatChange,
    id: 'request-parameter-type-changed',
    text: 'for the `query` request parameter `currency`, the `format` was changed from `none` to `currency`',
  };
  expect(
    equivalentChange(
      query,
      before,
      contract({ currency }, {}, { type: 'string', format: 'currency' }),
    )?.equivalence,
  ).toBe(FORMAT_ANNOTATION);
  for (const changed of [
    { ...currency, format: 'email' },
    { ...currency, format: 'date-time' },
    { ...currency, format: 'currency', maxLength: 3 },
    { type: 'integer', format: 'currency' },
  ])
    expect(equivalentChange(formatChange, before, contract({ currency: changed }))).toBeUndefined();
  // `start_date/anyOf[subschema #1]/` on POST /v1/subscription_schedules gains `unix-time`.
  const start = (format?: string) => ({
    anyOf: [
      { type: 'integer', ...(format && { format }) },
      { enum: ['now'], maxLength: 5000, type: 'string' },
    ],
  });
  const startChange = {
    ...formatChange,
    text: 'the `start_date/anyOf[subschema #1]/` request property `format` changed from `none` to `unix-time`',
  };
  expect(
    equivalentChange(
      startChange,
      contract({ start_date: start() }),
      contract({ start_date: start('unix-time') }),
    )?.equivalence,
  ).toBe(FORMAT_ANNOTATION);
});

it('leaves changes it cannot locate or does not classify alone', () => {
  const before = contract({ address: address('a') });
  const after = contract({ address: address('b') });
  expect(equivalentChange({ ...removed, path: '/v1/missing' }, before, after)).toBeUndefined();
  expect(
    equivalentChange({ ...removed, id: 'request-property-removed' }, before, after),
  ).toBeUndefined();
});

it.skipIf(!process.env.REFIT_OASDIFF)(
  'lists a renamed subschema oasdiff reports as compatible',
  async () => {
    const report = await compareOpenApi(
      contract({ address: address('optional_fields_address') }),
      contract({ address: address('optional_fields_customer_address') }),
    );
    const change = report.changes.find((entry) => entry.id === 'request-property-any-of-removed');
    expect(change).toMatchObject({ equivalence: RENAMED_SUBSCHEMA, reach: 'compatible' });
  },
);
