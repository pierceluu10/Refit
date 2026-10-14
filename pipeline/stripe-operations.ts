import { MAX_OPERATIONS, type ProviderAdapter } from './providers.ts';
import { isObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

export interface StripeOperation {
  resource: string;
  method: string;
  schema: string;
  operationId?: string;
}

function camel(value: string) {
  return value.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

function returnedSchema(operation: Record<string, unknown>) {
  const responses = isObject(operation.responses) ? operation.responses : {};
  const ok = isObject(responses['200']) ? responses['200'] : undefined;
  const json = ok && isObject(ok.content) ? ok.content['application/json'] : undefined;
  const schema = isObject(json) ? json.schema : undefined;
  // A union such as Customer | DeletedCustomer does not establish one response shape.
  const reference = isObject(schema) ? schema.$ref : undefined;
  return typeof reference === 'string' && reference.startsWith('#/components/schemas/')
    ? reference.slice('#/components/schemas/'.length)
    : undefined;
}

// stripe-node method names follow Stripe's URL shapes: `GET /v1/customers/{id}` is
// `customers.retrieve`, `POST /v1/payment_intents/{id}/cancel` is `paymentIntents.cancel`.
// Verified against x-stripeOperations in Stripe's SDK spec by stripe-operations.test.ts.
function sdkMethod(path: string, httpMethod: string) {
  const segments = path.split('/').slice(2);
  const parameter = segments.findIndex((segment) => segment.startsWith('{'));
  const resourceSegments = parameter < 0 ? segments : segments.slice(0, parameter);
  const trailing = parameter < 0 ? [] : segments.slice(parameter + 1);
  if (!resourceSegments.length || trailing.length > 1) return undefined;
  const resource = resourceSegments.map(camel).join('.');
  if (trailing.length === 1)
    return httpMethod === 'post' && !trailing[0].startsWith('{')
      ? { resource, method: camel(trailing[0]) }
      : undefined;
  // `GET /v1/balance` returns one object (lists have no schema reference and are skipped).
  if (parameter < 0)
    return httpMethod === 'post'
      ? { resource, method: 'create' }
      : httpMethod === 'get'
        ? { resource, method: 'retrieve' }
        : undefined;
  if (parameter !== segments.length - 1) return undefined;
  const method = { get: 'retrieve', post: 'update', delete: 'del' }[httpMethod];
  return method ? { resource, method } : undefined;
}

// stripe-node names that differ from the URL convention (`subscriptions.del` became `cancel`).
const ALIASES: Record<string, string[]> = { 'subscriptions.del': ['cancel'] };

export function stripeContractOperations(document: Record<string, unknown>): StripeOperation[] {
  const operations = new Map<string, StripeOperation>();
  for (const [path, item] of Object.entries(isObject(document.paths) ? document.paths : {})) {
    if (!isObject(item)) continue;
    for (const [httpMethod, operation] of Object.entries(item)) {
      if (!isObject(operation)) continue;
      const sdk = sdkMethod(path, httpMethod);
      const schema = returnedSchema(operation);
      if (!sdk || !schema) continue;
      const key = `${sdk.resource}.${sdk.method}`;
      for (const method of [sdk.method, ...(ALIASES[key] ?? [])])
        if (!operations.has(`${sdk.resource}.${method}`))
          operations.set(`${sdk.resource}.${method}`, {
            resource: sdk.resource,
            method,
            schema,
            ...(typeof operation.operationId === 'string'
              ? { operationId: operation.operationId }
              : {}),
          });
    }
  }
  return [...operations.values()];
}

// The built-in Stripe adapter, extended with the contract's operations the application calls.
export function stripeAdapterFor(
  base: ProviderAdapter,
  document: Record<string, unknown>,
  calledMethods: Set<string>,
): ProviderAdapter {
  const existing = new Set(
    base.operations.map((operation) => `${operation.resource}.${operation.method}`),
  );
  const added = stripeContractOperations(document).filter(
    (operation) =>
      calledMethods.has(`${operation.resource}.${operation.method}`) &&
      !existing.has(`${operation.resource}.${operation.method}`),
  );
  const operations = [...base.operations, ...added];
  if (operations.length > MAX_OPERATIONS)
    throw new PipelineInputError(
      `Stripe scan needs ${operations.length} mapped operations, exceeding the ${MAX_OPERATIONS}-operation limit. Split this integration into narrower profiles; no operations were silently discarded.`,
    );
  return { ...base, operations };
}
