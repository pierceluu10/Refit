import ts from 'typescript-compiler';
import { isObject, resolvableComponentSchema } from './specifications.ts';
import type { SourceEdit } from './types.ts';

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

const PRICING_SOURCE =
  'https://docs.stripe.com/changelog/basil/2025-03-31/invoice-pricing-configurations';
const PRICING_REVIEW =
  'Stripe 2025-03-31.basil replaced this full Price object with pricing.price_details.price, which holds only the price ID unless pricing.price_details.price is expanded (check pricing.type is price_details first). Reading other Price fields needs that expand or a prices.retrieve call, so Refit does not rewrite it. Source: https://docs.stripe.com/changelog/basil/2025-03-31/invoice-pricing-configurations';

const PAYMENTS =
  'https://docs.stripe.com/changelog/basil/2025-03-31/add-support-for-multiple-partial-payments-on-invoices';
const PARENT =
  'https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects';
const DISCOUNTS =
  'https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-singular-coupon-promotion-code';
const TAXES = 'https://docs.stripe.com/changelog/basil/2025-03-31/invoice-tax-configurations';
const DISCOUNT_REVIEW = `Stripe 2025-03-31.basil removed the singular discount; read discounts, a list of discount IDs (expand discounts for the objects) that can hold several. Which discount does this code mean when there are several? Refit does not pick one. Source: ${DISCOUNTS}`;
const INVOICE_LOOKUP_REVIEW = `Stripe 2025-03-31.basil removed the invoice field from PaymentIntents and Charges: an invoice can now be paid by several payments. Find the invoice with the List Invoice Payments endpoint (payment[type]=payment_intent, payment[payment_intent]=<id>); that is an extra API call, so Refit does not rewrite this read. Source: ${PAYMENTS}`;
const parentReview = (field: string, path: string, type: string) =>
  `Stripe 2025-03-31.basil moved ${field} to ${path}, which is set only when parent.type is ${type}. Refit has no helper for this field yet, so replace the read by hand and check parent.type. Source: ${PARENT}`;

// Removed Stripe reads whose new location is not a behaviour-preserving read; they stay unresolved
// with this reason and, where the code must decide, the question it must answer. Sources:
// docs/benchmarks/stripe-changelog/ pages, captured 2026-10-15, and the pages above, read
// 2026-10-24.
export const STRIPE_MOVE_REVIEW: Record<string, string> = {
  'line_item.type':
    'Stripe 2025-03-31.basil replaced line_item.type (invoiceitem or subscription) with line_item.parent.type (invoice_item_details or subscription_item_details; parent can be null). Stripe documents no mapping between the values, so Refit does not rewrite it. Source: https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects',
  'line_item.price': PRICING_REVIEW,
  'invoiceitem.price': PRICING_REVIEW,
  'promotion_code.coupon':
    'Stripe 2025-09-30.clover moved the auto-expanded promotion code coupon to promotion.coupon, which holds only the coupon ID unless promotion.coupon is expanded. Reading other Coupon fields needs that expand or a coupons.retrieve call. Refit does not rewrite these reads. Source: https://docs.stripe.com/changelog/clover/2025-09-30/polymorphic-coupon',
  'discount.coupon':
    'Stripe 2025-09-30.clover moved the auto-expanded discount coupon to source.coupon, which holds only the coupon ID unless source.coupon is expanded. Reading other Coupon fields needs that expand or a coupons.retrieve call. Refit does not rewrite these reads. Source: https://docs.stripe.com/changelog/clover/2025-09-30/add-discount-source-property',
  'subscription.discount': DISCOUNT_REVIEW,
  'invoice.discount': DISCOUNT_REVIEW,
  'subscription_schedule_phase_configuration.coupon': `Stripe 2025-03-31.basil removed the singular coupon from subscription schedule phases; read discounts, a list that can hold several. Which discount does this code mean when there are several? Refit does not pick one. Source: ${DISCOUNTS}`,
  'deleted_discount.coupon':
    'Stripe 2025-09-30.clover moved the auto-expanded discount coupon to source.coupon, which holds only the coupon ID unless source.coupon is expanded. Reading other Coupon fields needs that expand or a coupons.retrieve call. Refit does not rewrite these reads. Source: https://docs.stripe.com/changelog/clover/2025-09-30/add-discount-source-property',
  'payment_intent.invoice': INVOICE_LOOKUP_REVIEW,
  'charge.invoice': INVOICE_LOOKUP_REVIEW,
  'invoice.charge': `Stripe 2025-03-31.basil removed invoice.charge: an invoice can be paid by several payments, listed in invoice.payments (expand payments) or the Invoice Payments API. Which payment does this code mean when there are several? Refit does not pick one. Source: ${PAYMENTS}`,
  'invoice.paid': `Stripe 2025-03-31.basil removed invoice.paid and documents no boolean replacement; invoice.payments lists the payments, and Stripe's own out-of-band checks use invoice.status (paid) and the amounts. Decide which condition this code means. Source: ${PAYMENTS}`,
  'invoice.paid_out_of_band': `Stripe 2025-03-31.basil removed invoice.paid_out_of_band. Stripe documents expanding amount_paid_off_stripe and checking it is greater than 0 (any out-of-band payment) or equal to amount_paid (fully out of band). Decide which this code means. Source: ${PAYMENTS}`,
  'invoice.application_fee_amount': `Stripe 2025-03-31.basil removed invoice.application_fee_amount. For payments made on Stripe it is on each payment's PaymentIntent (expand payments.data.payment.payment_intent), and an invoice can have several. Which payment does this code mean? Source: ${PAYMENTS}`,
  'invoice.transfer_data': `Stripe 2025-03-31.basil removed invoice.transfer_data. For payments made on Stripe it is on each payment's PaymentIntent (expand payments.data.payment.payment_intent), and an invoice can have several. Which payment does this code mean? Source: ${PAYMENTS}`,
  'credit_note.refund': `Stripe 2025-03-31.basil replaced credit_note.refund with the refunds list, which can hold several. Which refund does this code mean? Source: ${PAYMENTS}`,
  'invoice.tax': `Stripe 2025-03-31.basil removed invoice.tax. Tax totals are in invoice.total_taxes, a list whose entries have a type; Stripe documents no single replacement for the old sum. Decide which entries this code should add up. Source: ${TAXES}`,
  'invoice.total_tax_amounts': `Stripe 2025-03-31.basil replaced invoice.total_tax_amounts with total_taxes: total_tax_amounts[0].amount becomes total_taxes[0].amount after checking total_taxes[0].type is tax_rate_details. The list can mix types, so Refit does not rewrite it. Source: ${TAXES}`,
  'line_item.tax_rates': `Stripe 2025-03-31.basil replaced line_item.tax_rates with taxes: tax_rates[0] becomes taxes[0].tax_rate_details.tax_rate after checking taxes[0].type is tax_rate_details. The list can mix types, so Refit does not rewrite it. Source: ${TAXES}`,
  'line_item.tax_amounts': `Stripe 2025-03-31.basil replaced line_item.tax_amounts with taxes: tax_amounts[0].amount becomes taxes[0].amount. The list can mix types, so Refit does not rewrite it. Source: ${TAXES}`,
  'invoiceitem.unit_amount': `Stripe 2025-03-31.basil moved invoice item unit amounts to pricing.unit_amount_decimal, a decimal string rather than an integer, so the read needs an explicit conversion. Source: ${PRICING_SOURCE}`,
  'invoiceitem.unit_amount_decimal': `Stripe 2025-03-31.basil moved invoice item unit amounts to pricing.unit_amount_decimal; pricing can be null. Source: ${PRICING_SOURCE}`,
  'invoice.subscription_details': parentReview(
    'invoice.subscription_details',
    'invoice.parent.subscription_details',
    'subscription_details',
  ),
  'invoice.quote': parentReview(
    'invoice.quote',
    'invoice.parent.quote_details.quote',
    'quote_details',
  ),
  'invoice.subscription_proration_date': parentReview(
    'invoice.subscription_proration_date',
    'invoice.parent.subscription_details.subscription_proration_date',
    'subscription_details',
  ),
  'invoiceitem.subscription': parentReview(
    'invoiceitem.subscription',
    'invoiceitem.parent.subscription_details.subscription',
    'subscription_details',
  ),
  'invoiceitem.subscription_item': parentReview(
    'invoiceitem.subscription_item',
    'invoiceitem.parent.subscription_details.subscription_item',
    'subscription_details',
  ),
  'line_item.subscription_item': parentReview(
    'line_item.subscription_item',
    'line_item.parent.subscription_item_details.subscription_item',
    'subscription_item_details',
  ),
  'line_item.proration': parentReview(
    'line_item.proration',
    'line_item.parent.subscription_item_details.proration (or invoice_item_details.proration)',
    'subscription_item_details or invoice_item_details',
  ),
  'invoice.payment_intent':
    'Stripe 2025-03-31.basil removed invoice.payment_intent: an invoice can have several payments, listed in invoice.payments (expand payments) or the Invoice Payments API. Picking one PaymentIntent changes behaviour, so Refit does not rewrite it. For a Payment Element client secret, Stripe documents invoice.confirmation_secret.client_secret (expand confirmation_secret). Source: https://docs.stripe.com/changelog/basil/2025-03-31/add-support-for-multiple-partial-payments-on-invoices',
};
