import { componentReference, isObject, resolvableComponentSchema } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { STRIPE_PACK } from './rule-pack.ts';

export interface StripeSubscriptionPeriodPolicy {
  priceId: string;
  beforeApiVersion: string;
  afterApiVersion: string;
}

export const SUBSCRIPTION_PERIOD_RULE = 'stripe-subscription-periods-price-id';
// Rules whose edits call the generated helper module: the pack's field moves.
export const HELPER_RULES = new Set<string>(STRIPE_PACK.fieldMoves.map((move) => move.rule));
// The period family also plans item selection and has the price policy beside it.
const BEFORE_VERSION = '2025-02-24.acacia';
const AFTER_VERSION = '2025-03-31.basil';
const MAX_PRICE_ID_LENGTH = 256;
const PERIOD_FIELDS = ['current_period_start', 'current_period_end'] as const;

export function parseStripeSubscriptionPeriodPolicy(
  value: unknown,
): StripeSubscriptionPeriodPolicy {
  if (
    !isObject(value) ||
    Object.keys(value).sort().join(',') !== 'afterApiVersion,beforeApiVersion,priceId' ||
    typeof value.priceId !== 'string' ||
    value.priceId.length > MAX_PRICE_ID_LENGTH ||
    !/^price_[A-Za-z0-9]+$/.test(value.priceId) ||
    value.beforeApiVersion !== BEFORE_VERSION ||
    value.afterApiVersion !== AFTER_VERSION
  )
    throw new PipelineInputError(
      `stripeSubscriptionPeriods requires a literal priceId and the supported incoming versions ${BEFORE_VERSION} → ${AFTER_VERSION}.`,
    );
  return {
    priceId: value.priceId,
    beforeApiVersion: BEFORE_VERSION,
    afterApiVersion: AFTER_VERSION,
  };
}

export function validateStripeSubscriptionPeriodContract(
  policy: StripeSubscriptionPeriodPolicy | undefined,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  if (!policy) return;
  if (
    isObject(before.info) &&
    before.info.version === policy.beforeApiVersion &&
    JSON.stringify(before) === JSON.stringify(after)
  )
    return;
  const schemas = (document: Record<string, unknown>) =>
    isObject(document.components) && isObject(document.components.schemas)
      ? document.components.schemas
      : {};
  const original = schemas(before);
  const changed = schemas(after);
  const properties = (definitions: Record<string, unknown>, value: unknown) => {
    const name =
      typeof value === 'string'
        ? value
        : isObject(value)
          ? componentReference(value.$ref)
          : undefined;
    const resolved = name && resolvableComponentSchema(definitions, name);
    const definition = resolved ? definitions[resolved] : name ? undefined : value;
    return isObject(definition) &&
      !['allOf', 'anyOf', 'oneOf'].some((key) => Object.hasOwn(definition, key)) &&
      isObject(definition.properties)
      ? definition.properties
      : {};
  };
  const oldSubscription = properties(original, 'subscription');
  const newSubscription = properties(changed, 'subscription');
  const item = properties(changed, 'subscription_item');
  const price = properties(changed, 'price');
  const list = properties(changed, newSubscription.items);
  const fieldType = (definition: unknown, type: string) =>
    isObject(definition) && definition.type === type;
  if (
    !isObject(before.info) ||
    before.info.version !== policy.beforeApiVersion ||
    !isObject(after.info) ||
    after.info.version !== policy.afterApiVersion ||
    !PERIOD_FIELDS.every(
      (name) =>
        fieldType(oldSubscription[name], 'integer') &&
        !Object.hasOwn(newSubscription, name) &&
        fieldType(item[name], 'integer'),
    ) ||
    !fieldType(list.has_more, 'boolean') ||
    !isObject(list.data) ||
    list.data.type !== 'array' ||
    !isObject(list.data.items) ||
    list.data.items.$ref !== '#/components/schemas/subscription_item' ||
    !isObject(item.price) ||
    item.price.$ref !== '#/components/schemas/price' ||
    !fieldType(price.id, 'string')
  )
    throw new PipelineInputError(
      'Configured subscription-period policy does not match the recorded incoming versions, field move, complete item list or price identity contract.',
    );
}

export const PERIOD_HELPERS = {
  current_period_start: 'getSubscriptionPeriodStart',
  current_period_end: 'getSubscriptionPeriodEnd',
} as const;
export const INVOICE_SUBSCRIPTION_HELPER = 'getInvoiceSubscription';
export const INVOICE_PRICE_ID_HELPER = 'getInvoicePriceId';
export const CHECKOUT_SHIPPING_HELPER = 'getCheckoutShippingDetails';
export const COUPON_ID_HELPER = 'getCouponId';
export const PRODUCT_FEATURES_HELPER = 'getProductMarketingFeatures';
// Globals the helper bodies read, which a file declaring the same name would shadow.
export const HELPER_GLOBALS: readonly string[] = [
  'Array',
  'NonNullable',
  'Reflect',
  'Set',
  'undefined',
];

// Every helper the generated module can hold, in its order.
export const HELPER_NAMES: readonly string[] = [
  ...Object.values(PERIOD_HELPERS),
  INVOICE_SUBSCRIPTION_HELPER,
  INVOICE_PRICE_ID_HELPER,
  CHECKOUT_SHIPPING_HELPER,
  COUPON_ID_HELPER,
  PRODUCT_FEATURES_HELPER,
];
// The new locations each helper body below reads, as rule targets (schema, then properties). A
// generated field-move rule calls the helper whose reads are exactly its targets
// (pipeline/rule-generation.ts); a move no helper reads stays review-only.
const PERIOD_TARGETS = [
  ['subscription', 'items'],
  ['subscription_item', 'current_period_start'],
  ['subscription_item', 'current_period_end'],
];
export const HELPER_TARGETS: Record<string, string[][]> = {
  [PERIOD_HELPERS.current_period_start]: PERIOD_TARGETS,
  [PERIOD_HELPERS.current_period_end]: PERIOD_TARGETS,
  [INVOICE_SUBSCRIPTION_HELPER]: [['invoice', 'parent', 'subscription_details', 'subscription']],
  [INVOICE_PRICE_ID_HELPER]: [
    ['line_item', 'pricing', 'price_details', 'price'],
    ['invoiceitem', 'pricing', 'price_details', 'price'],
  ],
  [CHECKOUT_SHIPPING_HELPER]: [['checkout.session', 'collected_information', 'shipping_details']],
  [COUPON_ID_HELPER]: [
    ['promotion_code', 'promotion', 'coupon'],
    ['discount', 'source', 'coupon'],
  ],
  [PRODUCT_FEATURES_HELPER]: [['product', 'marketing_features']],
};
