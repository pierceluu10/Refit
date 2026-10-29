import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { annotateReach } from './operation-reach.ts';
import { validateProviderOperationMappings } from './provider-operations.ts';
import { STRIPE, type ProviderAdapter } from './providers.ts';
import type { Removal, Repository } from './types.ts';

const reader = { $ref: '#/components/schemas/terminal.reader' };
const json = (schema: unknown) => ({
  '200': { content: { 'application/json': { schema } } },
});
// Like endive's POST /v1/terminal/readers/{reader}/cancel_action, whose response became an anyOf
// of the reader and a deleted reader while the reader object kept its properties.
function contract(cancelResponse: unknown, label = true) {
  return {
    openapi: '3.0.0',
    paths: {
      '/v1/terminal/readers/{reader}': {
        get: { operationId: 'GetTerminalReadersReader', responses: json(reader) },
      },
      '/v1/terminal/readers/{reader}/cancel_action': {
        post: {
          operationId: 'PostTerminalReadersReaderCancelAction',
          responses: json(cancelResponse),
        },
      },
    },
    components: {
      schemas: {
        'terminal.reader': {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' }, ...(label ? { label: { type: 'string' } } : {}) },
        },
      },
    },
  };
}
const before = contract(reader);
const provider: ProviderAdapter = {
  ...STRIPE,
  operations: [
    {
      resource: 'terminal.readers',
      method: 'retrieve',
      schema: 'terminal.reader',
      operationId: 'GetTerminalReadersReader',
    },
    {
      resource: 'terminal.readers',
      method: 'cancelAction',
      schema: 'terminal.reader',
      operationId: 'PostTerminalReadersReaderCancelAction',
    },
  ],
};

function reach(source: string, after: Record<string, unknown>) {
  const repository: Repository = {
    root: '/response-reach',
    files: [
      {
        path: 'reader.ts',
        content: `import Stripe from 'stripe';\nconst stripe = new Stripe('sk');\n${source}`,
      },
    ],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  const schemas = before.components.schemas;
  const changes: Record<string, unknown>[] = [
    {
      id: 'response-required-property-removed',
      operation: 'POST',
      path: '/v1/terminal/readers/{reader}/cancel_action',
      text: 'removed the required property `label` from the response with the `200` status',
    },
    {
      id: 'response-body-type-changed',
      operation: 'POST',
      path: '/v1/terminal/readers/{reader}/cancel_action',
      text: "the response's body `type` changed from `object` to `any` for status `200`",
    },
  ];
  annotateReach(changes, {
    repository,
    before,
    after,
    calls: analyzeRepository(repository, [], provider, schemas).calls,
    mappings: validateProviderOperationMappings(provider, before),
    untracedCalls: () => [],
    readFindings: (removals: Removal[]) =>
      analyzeRepository(repository, removals, provider, schemas).findings,
    removals: [],
    edited: () => false,
  });
  return changes.map((change) => change.reach);
}

const retrieve = `export async function name(id: string) {
  const found = await stripe.terminal.readers.retrieve(id);
  return found.label;
}\n`;
const cancelled = contract({ anyOf: [reader, { type: 'object' }] });

it('leaves a change to a response no code requests while the object keeps the property', () => {
  expect(reach(retrieve, cancelled)).toEqual(['unused', 'unused']);
});

it('keeps the change where the code calls that operation', () => {
  const calls = `${retrieve}export const cancel = (id: string) => stripe.terminal.readers.cancelAction(id);\n`;
  expect(reach(calls, cancelled)).toEqual(['reached', 'unknown']);
});

it('keeps the change where the object itself lost the property', () => {
  expect(reach(retrieve, contract({ anyOf: [reader, { type: 'object' }] }, false))[0]).toBe(
    'reached',
  );
});
