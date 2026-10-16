import { listOpenApiOperations } from './openapi-operations.ts';
import type { ProviderAdapter } from './providers.ts';
import { isObject } from './specifications.ts';

// A top-level request body parameter that a mapped SDK operation accepts in the before contract and
// no longer accepts in the after contract. Code that still sends it has no reviewed replacement.
export interface RequestParameterRemoval {
  id: string;
  resource: string;
  method: string;
  operationId: string;
  parameter: string;
  // SDK methods take path parameters positionally before the body (`update(id, params)`).
  argumentIndex: number;
}

// Why Refit leaves a removed parameter for the owner, shown in [Needs review] drafts.
// Source: Stripe OpenAPI 2026-09-30.endive request bodies of POST /v1/checkout/sessions,
// /v1/payment_intents and /v1/setup_intents, 2026-10-16.
export const REMOVED_PARAMETER_NOTES: Record<string, string> = {
  payment_method_types:
    "Stripe's new `allowed_payment_method_types` is not a drop-in replacement: it filters the payment methods Stripe computes dynamically (from your Dashboard settings, currency and amount) instead of being the static list `payment_method_types` was, so swapping one for the other can change which payment methods customers are offered. Decide per call whether to drop the parameter and use dynamic payment methods, or move the list to `allowed_payment_method_types` and confirm the methods offered are still the ones you expect.",
};

const MAX_REFERENCE_HOPS = 8;
const PATH_PARAMETER = /\{[^}]+\}/g;

function local(value: unknown, document: Record<string, unknown>) {
  let current = value;
  for (let hop = 0; hop < MAX_REFERENCE_HOPS && isObject(current); hop++) {
    const reference = current.$ref;
    if (typeof reference !== 'string') return current;
    if (!reference.startsWith('#/')) return undefined;
    current = reference
      .slice(2)
      .split('/')
      .reduce<unknown>(
        (node, key) =>
          isObject(node) ? node[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined,
        document,
      );
  }
  return isObject(current) && current.$ref === undefined ? current : undefined;
}

// Property names of the single request body media type, or undefined when the body is absent,
// has several media types or is not a plain object schema.
function bodyParameters(operation: Record<string, unknown>, document: Record<string, unknown>) {
  const body = local(operation.requestBody, document);
  const content = body && isObject(body.content) ? Object.values(body.content) : [];
  if (content.length !== 1 || !isObject(content[0])) return undefined;
  const schema = local(content[0].schema, document);
  return schema && isObject(schema.properties)
    ? new Set(Object.keys(schema.properties))
    : undefined;
}

export function removedRequestParameters(
  provider: ProviderAdapter,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): RequestParameterRemoval[] {
  const operations = (document: Record<string, unknown>) =>
    new Map(
      listOpenApiOperations(document)
        .filter((entry) => typeof entry.operation.operationId === 'string')
        .map((entry) => [entry.operation.operationId as string, entry]),
    );
  const baseline = operations(before);
  const revised = operations(after);
  const removals: RequestParameterRemoval[] = [];
  for (const mapping of provider.operations) {
    const source = mapping.operationId ? baseline.get(mapping.operationId) : undefined;
    const target = mapping.operationId ? revised.get(mapping.operationId) : undefined;
    // A missing operation is an endpoint change, handled by operation replacements and the diff.
    if (!source || !target) continue;
    const old = bodyParameters(source.operation, before);
    const current = bodyParameters(target.operation, after);
    if (!old || !current) continue;
    for (const parameter of old)
      if (!current.has(parameter))
        removals.push({
          id: `request-parameter:${mapping.operationId}.${parameter}`,
          resource: mapping.resource,
          method: mapping.method,
          operationId: mapping.operationId!,
          parameter,
          argumentIndex: source.path.match(PATH_PARAMETER)?.length ?? 0,
        });
  }
  return removals;
}
