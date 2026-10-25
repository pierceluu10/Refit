import { listOpenApiOperations } from './openapi-operations.ts';
import type { ProviderAdapter } from './providers.ts';
import { isObject } from './specifications.ts';
import { requestMove, type RequestMove } from './stripe-request-moves.ts';

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
  // An owner-approved replacement for exactly `['card']` (docs/STRIPE-PAYMENT-METHOD-TYPES.md).
  cardReplacement?: string;
  // Keep a literal list of `card` plus other methods under the replacement too, and move any other
  // value expression (the default since 2026-10-24; `stripePaymentMethodTypes: "keep-listed"`).
  keepListed?: boolean;
  // A reviewed move to the parameter's documented replacement (stripe-request-moves.ts).
  move?: RequestMove;
}

// Why Refit leaves a removed parameter for the owner, shown in [Needs review] drafts.
// Source: Stripe OpenAPI 2026-09-30.endive request bodies of POST /v1/checkout/sessions,
// /v1/payment_intents and /v1/setup_intents, 2026-10-16.
export const REMOVED_PARAMETER_NOTES: Record<string, string> = {
  // Source: https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-singular-coupon-promotion-code
  // and https://docs.stripe.com/changelog/clover/2025-09-30/polymorphic-coupon, read 2026-10-22.
  coupon:
    "Stripe replaced the singular `coupon` with `discounts: [{ coupon }]` on subscriptions, subscription schedules and invoice previews (2025-03-31.basil), and with `promotion: { type: 'coupon', coupon }` on promotion code creation (2025-09-30.clover); customers have no replacement. On a subscription update, a populated `discounts` array overwrites every discount the subscription has, so decide which discounts it should keep.",
  promotion_code:
    'Stripe replaced the singular `promotion_code` with `discounts: [{ promotion_code }]` on subscriptions (2025-03-31.basil); customers have no replacement. On a subscription update, a populated `discounts` array overwrites every discount the subscription has, so decide which discounts it should keep.',
  payment_method_types:
    "Stripe's new `allowed_payment_method_types` is not a drop-in replacement: it filters the payment methods Stripe computes dynamically (from your Dashboard settings, currency and amount) instead of being the static list `payment_method_types` was, so swapping one for the other can change which payment methods customers are offered. Decide per call whether to drop the parameter and use dynamic payment methods, or move the list to `allowed_payment_method_types` and confirm the methods offered are still the ones you expect.",
};

export const CARD_PAYMENT_METHOD_RULE = 'stripe-card-allowed-payment-method-types';
export const LISTED_PAYMENT_METHODS_RULE = 'stripe-listed-allowed-payment-method-types';
// A computed list, a spread or a list without `card`, moved with its expression unchanged.
export const MOVED_PAYMENT_METHODS_RULE = 'stripe-moved-allowed-payment-method-types';
// Every rename rides with the endive pin and, for TypeScript, the stripe-node upgrade.
export const PAYMENT_METHOD_RENAME_RULES = new Set<string>([
  CARD_PAYMENT_METHOD_RULE,
  LISTED_PAYMENT_METHODS_RULE,
  MOVED_PAYMENT_METHODS_RULE,
]);
const CARD_REPLACEMENT = 'allowed_payment_method_types';
const CARD_OPERATIONS = new Set(['PostCheckoutSessions', 'PostPaymentIntents', 'PostSetupIntents']);

const MAX_REFERENCE_HOPS = 8;
const PATH_PARAMETER = /\{[^}]+\}/g;

export function local(value: unknown, document: Record<string, unknown>) {
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

// The schema of the single request body media type, or undefined when the body is absent, has
// several media types or is not a plain object schema.
export function bodySchema(operation: Record<string, unknown>, document: Record<string, unknown>) {
  const body = local(operation.requestBody, document);
  const content = body && isObject(body.content) ? Object.values(body.content) : [];
  if (content.length !== 1 || !isObject(content[0])) return undefined;
  const schema = local(content[0].schema, document);
  return schema && isObject(schema.properties) ? schema : undefined;
}

export function removedRequestParameters(
  provider: ProviderAdapter,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  options: { keepListedPaymentMethods?: boolean } = {},
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
    const oldSchema = bodySchema(source.operation, before);
    const newSchema = bodySchema(target.operation, after);
    if (!oldSchema || !newSchema) continue;
    const old = new Set(Object.keys(oldSchema.properties as Record<string, unknown>));
    const current = new Set(Object.keys(newSchema.properties as Record<string, unknown>));
    for (const parameter of old)
      if (!current.has(parameter)) {
        const move =
          provider.packageName === 'stripe'
            ? requestMove(
                mapping.operationId!,
                parameter,
                { schema: oldSchema, document: before },
                { schema: newSchema, document: after },
              )
            : undefined;
        removals.push({
          id: `request-parameter:${mapping.operationId}.${parameter}`,
          resource: mapping.resource,
          method: mapping.method,
          operationId: mapping.operationId!,
          parameter,
          argumentIndex: source.path.match(PATH_PARAMETER)?.length ?? 0,
          ...(provider.packageName === 'stripe' &&
          parameter === 'payment_method_types' &&
          CARD_OPERATIONS.has(mapping.operationId!) &&
          current.has(CARD_REPLACEMENT)
            ? {
                cardReplacement: CARD_REPLACEMENT,
                // Owner decision (Pierce, 2026-10-24, Push 279 decision 2): keep-listed is the
                // default; only an explicit `false` keeps the card-only rule.
                ...(options.keepListedPaymentMethods !== false ? { keepListed: true } : {}),
              }
            : {}),
          ...(move ? { move } : {}),
        });
      }
  }
  return removals;
}
