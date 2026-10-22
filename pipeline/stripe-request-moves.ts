import ts from 'typescript-compiler';
import { local } from './request-removals.ts';
import { isObject } from './specifications.ts';

// Removed Stripe request parameters whose documented replacement sends the same request, read on
// 2026-10-22 and checked against both recorded contracts before any edit:
// - clover moved a promotion code's `coupon` into the `promotion` hash, typed `coupon`:
//   https://docs.stripe.com/changelog/clover/2025-09-30/polymorphic-coupon
// - 2024-04-10 renamed a product's `features` to `marketing_features`:
//   https://docs.stripe.com/changelog/2024-04-10/renames-features-attribute-product-object
export const PROMOTION_CODE_PROMOTION_RULE = 'stripe-promotion-code-promotion';
export const PRODUCT_MARKETING_FEATURES_RULE = 'stripe-product-marketing-features';
export const REQUEST_MOVE_RULES = new Set<string>([
  PROMOTION_CODE_PROMOTION_RULE,
  PRODUCT_MARKETING_FEATURES_RULE,
]);
export const REQUEST_MOVE_SOURCES: Record<string, string> = {
  [PROMOTION_CODE_PROMOTION_RULE]:
    'https://docs.stripe.com/changelog/clover/2025-09-30/polymorphic-coupon',
  [PRODUCT_MARKETING_FEATURES_RULE]:
    'https://docs.stripe.com/changelog/2024-04-10/renames-features-attribute-product-object',
};
export const REQUEST_MOVE_WARNINGS: Record<string, string> = {
  [PROMOTION_CODE_PROMOTION_RULE]:
    "Promotion code creation sends the coupon as promotion: { type: 'coupon', coupon }. Promotion codes no longer expand promotion.coupon in responses; reads of the Coupon object need an expand or coupons.retrieve.",
  [PRODUCT_MARKETING_FEATURES_RULE]:
    'Product creation and updates send features as marketing_features, the same list of named features under its new name.',
};

export type RequestMove = 'promotion' | 'marketing_features';

// A schema without its documentation (`description`, `title`), to compare shapes across versions.
// Property names inside `properties` are kept, whatever they are called.
function shape(schema: unknown, document: Record<string, unknown>): unknown {
  if (Array.isArray(schema)) return schema.map((entry) => shape(entry, document));
  const resolved = local(schema, document);
  if (!resolved) return schema;
  return Object.fromEntries(
    Object.entries(resolved)
      .filter(([key]) => key !== 'description' && key !== 'title')
      .map(([key, value]) => [
        key,
        key === 'properties' && isObject(value)
          ? Object.fromEntries(
              Object.entries(value).map(([name, entry]) => [name, shape(entry, document)]),
            )
          : shape(value, document),
      ]),
  );
}

function properties(schema: unknown, document: Record<string, unknown>) {
  const resolved = local(schema, document);
  return resolved && isObject(resolved.properties) ? resolved.properties : undefined;
}

function isString(schema: unknown, document: Record<string, unknown>) {
  const resolved = local(schema, document);
  return Boolean(resolved && resolved.type === 'string' && !resolved.enum);
}

// The reviewed move of a removed parameter: promotion code creation required `coupon` in the before
// body, so any value it sends moves unchanged into an after body's `promotion` whose `type`
// accepts `coupon` and whose `coupon` is a string.
export function requestMove(
  operationId: string,
  parameter: string,
  before: { schema: Record<string, unknown>; document: Record<string, unknown> },
  after: { schema: Record<string, unknown>; document: Record<string, unknown> },
): RequestMove | undefined {
  if (
    (operationId === 'PostProducts' || operationId === 'PostProductsId') &&
    parameter === 'features'
  ) {
    const old = isObject(before.schema.properties) ? before.schema.properties.features : undefined;
    const renamed = isObject(after.schema.properties)
      ? after.schema.properties.marketing_features
      : undefined;
    return old &&
      renamed &&
      JSON.stringify(shape(old, before.document)) === JSON.stringify(shape(renamed, after.document))
      ? 'marketing_features'
      : undefined;
  }
  if (operationId !== 'PostPromotionCodes' || parameter !== 'coupon') return;
  const old = isObject(before.schema.properties) ? before.schema.properties.coupon : undefined;
  const required = Array.isArray(before.schema.required) ? before.schema.required : [];
  const target = isObject(after.schema.properties) ? after.schema.properties : {};
  const promotion = properties(target.promotion, after.document);
  const type = promotion && local(promotion.type, after.document);
  return isString(old, before.document) &&
    required.includes('coupon') &&
    promotion &&
    isString(promotion.coupon, after.document) &&
    type &&
    Array.isArray(type.enum) &&
    type.enum.includes('coupon')
    ? 'promotion'
    : undefined;
}

function staticName(name: ts.PropertyName) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

// The edit that moves `property` (the removed parameter in a direct object-literal body), or why
// it stays for review.
export function requestMoveEdit(
  property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
  move: RequestMove,
):
  | {
      start: number;
      end: number;
      replacement: string;
      rule: typeof PROMOTION_CODE_PROMOTION_RULE | typeof PRODUCT_MARKETING_FEATURES_RULE;
    }
  | { reason: string } {
  const body = property.parent;
  const names: string[] = [];
  for (const sibling of body.properties) {
    const name =
      ts.isPropertyAssignment(sibling) || ts.isShorthandPropertyAssignment(sibling)
        ? staticName(sibling.name)
        : undefined;
    if (name === undefined)
      return { reason: 'Request spreads, methods and computed properties require review.' };
    names.push(name);
  }
  const parameter = staticName(property.name)!;
  if (names.filter((name) => name === parameter).length > 1)
    return { reason: 'Duplicate request properties require review.' };
  if (ts.isShorthandPropertyAssignment(property) && property.objectAssignmentInitializer)
    return { reason: 'Request shorthand initializers require review.' };
  if (move === 'marketing_features') {
    if (names.includes('marketing_features'))
      return { reason: 'The request already sends marketing_features; merging them needs review.' };
    // The same list under its new name: the key changes, the value is kept as written.
    return ts.isShorthandPropertyAssignment(property)
      ? {
          start: property.getStart(),
          end: property.getEnd(),
          replacement: `marketing_features: ${property.name.getText()}`,
          rule: PRODUCT_MARKETING_FEATURES_RULE,
        }
      : {
          start: property.name.getStart(),
          end: property.name.getEnd(),
          replacement: ts.isStringLiteral(property.name)
            ? `${property.name.getText()[0]}marketing_features${property.name.getText()[0]}`
            : 'marketing_features',
          rule: PRODUCT_MARKETING_FEATURES_RULE,
        };
  }
  if (names.includes('promotion'))
    return { reason: 'The request already sends promotion; merging the coupon needs review.' };
  const value = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
  // The body's own quote style: its first string quote, else single quotes.
  const quote = /["']/.exec(body.getText())?.[0] ?? "'";
  return {
    start: property.getStart(),
    end: property.getEnd(),
    replacement: `promotion: { type: ${quote}coupon${quote}, coupon: ${value.getText()} }`,
    rule: PROMOTION_CODE_PROMOTION_RULE,
  };
}
