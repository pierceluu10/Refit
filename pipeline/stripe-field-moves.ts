import ts from 'typescript-compiler';
import { isObject, resolvableComponentSchema } from './specifications.ts';
import type { Removal, SourceEdit } from './types.ts';

// A receiver that can be repeated without side effects: `invoice`, `this.invoice`, `data.items[0]`.
function plainReceiver(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression) || expression.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isNonNullExpression(expression) || ts.isParenthesizedExpression(expression))
    return plainReceiver(expression.expression);
  if (ts.isPropertyAccessExpression(expression)) return plainReceiver(expression.expression);
  if (ts.isElementAccessExpression(expression))
    return (
      ts.isLiteralExpression(expression.argumentExpression) && plainReceiver(expression.expression)
    );
  return false;
}

// Rewrites a direct `receiver.property` or `receiver?.property` read; longer optional chains,
// element access and destructuring stay with review or AI.
export function movedReadEdit(
  node: ts.Node,
  file: string,
  changeId: string,
  rule: NonNullable<SourceEdit['rule']>,
  replacement: (receiver: string) => string,
): SourceEdit | undefined {
  if (!ts.isPropertyAccessExpression(node) || !plainReceiver(node.expression)) return;
  if (!node.questionDotToken && node.flags & ts.NodeFlags.OptionalChain) return;
  const receiver = node.expression.getText();
  const value = replacement(receiver);
  return {
    file,
    start: node.getStart(),
    end: node.getEnd(),
    replacement: node.questionDotToken
      ? `(${receiver} == null ? undefined : ${value})`
      : `(${value})`,
    changeId,
    rule,
  };
}

export function propertyExists(schemas: Record<string, unknown>, path: string[]) {
  let schema: string | undefined = path[0];
  for (const property of path.slice(1)) {
    const name: string | undefined = schema && resolvableComponentSchema(schemas, schema);
    const definition: unknown = name ? schemas[name] : undefined;
    const value: unknown =
      isObject(definition) && isObject(definition.properties)
        ? definition.properties[property]
        : undefined;
    if (!isObject(value)) return false;
    const reference: unknown = Array.isArray(value.anyOf) ? value.anyOf[0] : value;
    schema =
      isObject(reference) && typeof reference.$ref === 'string'
        ? reference.$ref.replace('#/components/schemas/', '')
        : undefined;
  }
  return true;
}

const PRICING_REVIEW =
  'Stripe 2025-03-31.basil replaced this full Price object with pricing.price_details.price, which holds only the price ID unless pricing.price_details.price is expanded (check pricing.type is price_details first). Reading other Price fields needs that expand or a prices.retrieve call, so Refit does not rewrite it. Source: https://docs.stripe.com/changelog/basil/2025-03-31/invoice-pricing-configurations';

// Removed Stripe reads whose new location is not a behaviour-preserving read; they stay unresolved
// with this reason. Source: docs/benchmarks/stripe-changelog/ pages, captured 2026-10-15.
export const STRIPE_MOVE_REVIEW: Record<string, string> = {
  'line_item.type':
    'Stripe 2025-03-31.basil replaced line_item.type (invoiceitem or subscription) with line_item.parent.type (invoice_item_details or subscription_item_details; parent can be null). Stripe documents no mapping between the values, so Refit does not rewrite it. Source: https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects',
  'line_item.price': PRICING_REVIEW,
  'invoiceitem.price': PRICING_REVIEW,
  'promotion_code.coupon':
    'Stripe 2025-09-30.clover moved the auto-expanded promotion code coupon to promotion.coupon, which holds only the coupon ID unless promotion.coupon is expanded. Reading other Coupon fields needs that expand or a coupons.retrieve call. Refit does not rewrite these reads. Source: https://docs.stripe.com/changelog/clover/2025-09-30/polymorphic-coupon',
  'discount.coupon':
    'Stripe 2025-09-30.clover moved the auto-expanded discount coupon to source.coupon, which holds only the coupon ID unless source.coupon is expanded. Reading other Coupon fields needs that expand or a coupons.retrieve call. Refit does not rewrite these reads. Source: https://docs.stripe.com/changelog/clover/2025-09-30/add-discount-source-property',
  'invoice.payment_intent':
    'Stripe 2025-03-31.basil removed invoice.payment_intent: an invoice can have several payments, listed in invoice.payments (expand payments) or the Invoice Payments API. Picking one PaymentIntent changes behaviour, so Refit does not rewrite it. For a Payment Element client secret, Stripe documents invoice.confirmation_secret.client_secret (expand confirmation_secret). Source: https://docs.stripe.com/changelog/basil/2025-03-31/add-support-for-multiple-partial-payments-on-invoices',
};

// Stripe schema names reused for a different object, whose old object lives on under a new name.
// 2024-04-10 renamed Product `features` to `marketing_features`: its items, `product_feature`
// ({ name }) until then, are `product_marketing_feature` from then on, and `product_feature` names
// the Entitlements attachment. Source, read 2026-10-24:
// https://docs.stripe.com/changelog/2024-04-10/renames-features-attribute-product-object
const RENAMED_SCHEMAS = [
  {
    schema: 'product_feature',
    renamed: 'product_marketing_feature',
    owner: 'product',
    from: 'features',
    to: 'marketing_features',
  },
];

function itemsRef(schemas: Record<string, unknown>, schema: string, property: string) {
  const owner = schemas[schema];
  const value =
    isObject(owner) && isObject(owner.properties) ? owner.properties[property] : undefined;
  const items = isObject(value) && isObject(value.items) ? value.items : undefined;
  return items && typeof items.$ref === 'string' ? items.$ref : undefined;
}

// Without descriptions, which change between versions without changing the value.
function shape(schema: unknown): string {
  return JSON.stringify(schema, (key, value: unknown) =>
    key === 'description' ? undefined : value,
  );
}

// Drops removals that only follow a reused schema name: the field still exists, with the same shape,
// on the renamed schema that the same owner field (renamed with it) now lists. The owner field's
// own removal stays, so reads of it are still reported.
export function withoutRenamedSchemaRemovals(
  changes: Removal[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  return changes.filter((change) => {
    const rename = RENAMED_SCHEMAS.find((entry) => entry.schema === change.schema);
    if (
      !rename ||
      itemsRef(before, rename.owner, rename.from) !== `#/components/schemas/${rename.schema}` ||
      itemsRef(after, rename.owner, rename.to) !== `#/components/schemas/${rename.renamed}`
    )
      return true;
    const old = before[rename.schema];
    const current = after[rename.renamed];
    const property = (schema: unknown) =>
      isObject(schema) && isObject(schema.properties)
        ? schema.properties[change.property]
        : undefined;
    return !(property(old) !== undefined && shape(property(old)) === shape(property(current)));
  });
}
