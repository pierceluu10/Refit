import { analyzeRepository } from './analyzer.ts';
import { STRIPE, type ProviderAdapter } from './providers.ts';
import { isObject } from './specifications.ts';
import type { Repository } from './types.ts';

// Refit adapters accept at most 100 operations; Stripe exposes far more, so each repository
// gets the operations its own traced calls use.
const MAX_ADAPTER_OPERATIONS = 100;

export interface StripeOperation {
  resource: string;
  method: string;
  schema: string;
  operationId?: string;
}

function camel(value: string) {
  return value.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

function responseSchema(spec: Record<string, unknown>, path: string, operation: string) {
  const paths = spec.paths;
  if (!isObject(paths) || !isObject(paths[path])) return undefined;
  const entry = (paths[path] as Record<string, unknown>)[operation];
  if (!isObject(entry) || !isObject(entry.responses)) return undefined;
  const ok = (entry.responses as Record<string, unknown>)['200'];
  const json = isObject(ok) && isObject(ok.content) ? ok.content['application/json'] : undefined;
  const schema = isObject(json) ? json.schema : undefined;
  // `customers.retrieve` returns `anyOf: [customer, deleted_customer]`; keep each referenced object.
  const options = isObject(schema) && Array.isArray(schema.anyOf) ? schema.anyOf : [schema];
  const schemas = options
    .map((option) => (isObject(option) ? option.$ref : undefined))
    .filter(
      (reference): reference is string =>
        typeof reference === 'string' && reference.startsWith('#/components/schemas/'),
    )
    .map((reference) => reference.slice('#/components/schemas/'.length));
  return schemas.length
    ? {
        schemas,
        operationId: typeof entry.operationId === 'string' ? entry.operationId : undefined,
      }
    : undefined;
}

// Maps stripe-node methods to the object schemas they return, using the x-stripeOperations
// metadata in Stripe's SDK spec (spec3.sdk.json). Only operations whose 200 response is that
// same schema in the application's own (before) contract are kept.
export function stripeOperations(
  sdkSpec: Record<string, unknown>,
  beforeSpec: Record<string, unknown>,
): StripeOperation[] {
  const schemas = isObject(sdkSpec.components) ? sdkSpec.components.schemas : undefined;
  if (!isObject(schemas)) return [];
  const operations = new Map<string, StripeOperation>();
  for (const [schema, definition] of Object.entries(schemas)) {
    const declared = isObject(definition) ? definition['x-stripeOperations'] : undefined;
    if (!Array.isArray(declared)) continue;
    for (const entry of declared) {
      if (!isObject(entry) || entry.method_on !== 'service') continue;
      const { path, operation, method_name: name } = entry;
      if (typeof path !== 'string' || typeof operation !== 'string' || typeof name !== 'string')
        continue;
      const response = responseSchema(beforeSpec, path, operation);
      if (!response?.schemas.includes(schema)) continue;
      const segments = path.split('/').slice(2);
      const parameter = segments.findIndex((segment) => segment.startsWith('{'));
      const resource = (parameter < 0 ? segments : segments.slice(0, parameter))
        .map(camel)
        .join('.');
      // stripe-node exposes HTTP DELETE as `del`.
      const method = name === 'delete' ? 'del' : camel(name);
      const trailing = parameter < 0 ? [] : segments.slice(parameter + 1);
      // Nested sub-resources (`/customers/{id}/cash_balance`) use other SDK method names; keep
      // only the object path itself and single actions such as `/payment_intents/{id}/cancel`.
      if (trailing.length > 1 || (trailing.length === 1 && camel(trailing[0]) !== method)) continue;
      const key = `${resource}.${method}`;
      if (resource && !operations.has(key))
        operations.set(key, {
          resource,
          method,
          schema,
          ...(response.operationId ? { operationId: response.operationId } : {}),
        });
    }
  }
  return [...operations.values()];
}

export function repositoryAdapter(repository: Repository, operations: StripeOperation[]) {
  const called = new Set(
    analyzeRepository(repository, [], STRIPE).sdkCalls.map(
      (call) => `${call.resource}.${call.method}`,
    ),
  );
  const used = operations.filter((operation) =>
    called.has(`${operation.resource}.${operation.method}`),
  );
  // The built-in `stripe` id is reserved, so the generated adapter uses its own id for the
  // same package, constructor and API-version option.
  const adapter: ProviderAdapter = {
    ...STRIPE,
    id: 'stripe-full',
    operations: used.slice(0, MAX_ADAPTER_OPERATIONS),
  };
  return { adapter, calledMethods: called.size, mappedMethods: used.length };
}
