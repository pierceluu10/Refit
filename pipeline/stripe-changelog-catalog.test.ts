import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import {
  migrationReviewReason,
  REMOVED_REQUEST_PARAMETER_REVIEW_REASON,
} from './migration-review.ts';
import { switchedEnumAdditions, unmappedBreakingChanges } from './openapi-diff.ts';
import { applySourceEdits, editCovers } from './patches.ts';
import {
  findBreakingOperationImpacts,
  validateProviderOperationMappings,
} from './provider-operations.ts';
import { validateProviderMappings } from './providers.ts';
import { removedRequestParameters } from './request-removals.ts';
import { findRemovedProperties, isObject, parseSpecificationInput } from './specifications.ts';
import { repositoryAdapter, stripeOperations } from './stripe-benchmark.ts';
import { withoutRenamedSchemaRemovals } from './stripe-field-moves.ts';
import type { Repository } from './types.ts';

// The Stripe breaking-change catalog (docs/benchmarks/stripe-changelog/catalog/<version>/<slug>.json):
// one entry per change the docs.stripe.com changelog marks Breaking for 2025-03-31.basil,
// 2025-09-30.clover, 2026-03-25.dahlia and 2026-09-30.endive (their monthly releases mark none).
// Each part of an entry runs a minimal fixture through the engine path that handles it.

const CATALOG = resolve('docs/benchmarks/stripe-changelog/catalog');
const HANDLING = ['none', 'stop', 'ai', 'generic', 'rule'] as const;
type Handling = (typeof HANDLING)[number];

interface Part {
  changed: string[];
  handling: Handling;
  how?: string;
  reason?: string;
  fullDiffOnly?: true;
}
interface Entry extends Part {
  version: string;
  title: string;
  source: string;
  checkedAt: string;
  category: 'api' | 'stripejs';
  parts?: Part[];
}

const entries = readdirSync(CATALOG)
  .sort()
  .flatMap((version) =>
    readdirSync(join(CATALOG, version))
      .sort()
      .map((file) => ({
        key: `${version}/${file.replace(/\.json$/, '')}`,
        entry: JSON.parse(readFileSync(join(CATALOG, version, file), 'utf8')) as Entry,
      })),
  );
const partsOf = (entry: Entry): Part[] => entry.parts ?? [entry];

// ---------- A reduced Stripe contract: 2025-02-24.acacia shapes before, endive shapes after ----------

const string = { maxLength: 5000, type: 'string' };
const integer = { type: 'integer' };
const boolean = { type: 'boolean' };
const ref = (schema: string) => ({ $ref: `#/components/schemas/${schema}` });
const nullable = (schema: string) => ({ anyOf: [ref(schema)], nullable: true });
const expandable = (schema: string) => ({
  anyOf: [string, ref(schema)],
  nullable: true,
  'x-expansionResources': { oneOf: [ref(schema)] },
});
const object = (properties: Record<string, unknown>, required?: string[]) => ({
  type: 'object',
  properties,
  ...(required ? { required } : {}),
});
const array = (items: unknown) => ({ type: 'array', items });
const values = (...entries: string[]) => ({ type: 'string', enum: entries });
const list = (schema: string) => object({ has_more: boolean, data: array(ref(schema)) });
const pick = (after: boolean, old: Record<string, unknown>, current: Record<string, unknown>) =>
  after ? current : old;

function schemas(after: boolean): Record<string, unknown> {
  return {
    subscription: object({
      id: string,
      status: string,
      items: list('subscription_item'),
      latest_invoice: expandable('invoice'),
      cancellation_details: nullable('cancellation_details'),
      ...pick(
        after,
        {
          current_period_start: integer,
          current_period_end: integer,
          discount: nullable('discount'),
          billing_thresholds: nullable('subscription_billing_thresholds'),
        },
        { discounts: array(expandable('discount')) },
      ),
    }),
    subscription_billing_thresholds: object({ amount_gte: integer }),
    cancellation_details: object({
      reason: {
        ...values(
          'cancellation_requested',
          'payment_disputed',
          'payment_failed',
          ...(after ? ['canceled_by_retention_policy'] : []),
        ),
        nullable: true,
      },
    }),
    subscription_item: object({
      id: string,
      price: ref('price'),
      ...pick(
        after,
        { billing_thresholds: nullable('subscription_billing_thresholds') },
        { current_period_start: integer, current_period_end: integer },
      ),
    }),
    invoice: object({
      id: string,
      amount_paid: integer,
      lines: list('line_item'),
      ...pick(
        after,
        {
          subscription: expandable('subscription'),
          subscription_details: nullable('subscription_details_data'),
          quote: expandable('quote'),
          subscription_proration_date: integer,
          payment_intent: expandable('payment_intent'),
          charge: expandable('charge'),
          paid: boolean,
          paid_out_of_band: boolean,
          application_fee_amount: { ...integer, nullable: true },
          transfer_data: nullable('invoice_transfer_data'),
          discount: nullable('discount'),
          tax: { ...integer, nullable: true },
          total_tax_amounts: array(ref('invoice_tax_amount')),
        },
        {
          parent: nullable('invoice_parent'),
          confirmation_secret: nullable('invoices_resource_confirmation_secret'),
          total_taxes: array(ref('invoice_tax_amount')),
        },
      ),
    }),
    subscription_details_data: object({ metadata: object({}) }),
    quote: object({ id: string }),
    invoice_transfer_data: object({ destination: string }),
    invoice_tax_amount: object({ amount: integer }),
    invoices_resource_confirmation_secret: object({ client_secret: string }),
    invoice_parent: object({ subscription_details: nullable('subscription_parent') }),
    subscription_parent: object({ subscription: expandable('subscription') }),
    line_item: object({
      id: string,
      subscription: expandable('subscription'),
      ...pick(
        after,
        {
          price: nullable('price'),
          type: values('invoiceitem', 'subscription'),
          subscription_item: expandable('subscription_item'),
          proration: boolean,
          invoice_item: expandable('invoiceitem'),
          tax_amounts: array(ref('invoice_tax_amount')),
          tax_rates: array(ref('tax_rate')),
        },
        { pricing: nullable('pricing'), parent: nullable('line_item_parent') },
      ),
    }),
    line_item_parent: object({ type: string }),
    tax_rate: object({ id: string }),
    invoiceitem: object({
      id: string,
      ...pick(
        after,
        {
          price: nullable('price'),
          unit_amount: { ...integer, nullable: true },
          subscription: expandable('subscription'),
        },
        { pricing: nullable('pricing') },
      ),
    }),
    pricing: object({ type: values('price_details'), price_details: ref('pricing_price_details') }),
    pricing_price_details: object({ price: { anyOf: [string, ref('price')] }, product: string }),
    price: object({ id: string, nickname: string, recurring: nullable('recurring') }),
    recurring: object({
      interval: string,
      ...pick(after, { aggregate_usage: { ...values('sum', 'max'), nullable: true } }, {}),
    }),
    plan: object({
      id: string,
      ...pick(after, { aggregate_usage: { ...values('sum', 'max'), nullable: true } }, {}),
    }),
    'checkout.session': object({
      id: string,
      url: string,
      ui_mode: after
        ? values('elements', 'embedded_page', 'form', 'hosted_page')
        : values('custom', 'embedded', 'hosted'),
      collected_information: nullable('collected_information'),
      currency_conversion: nullable('currency_conversion'),
      ...pick(after, { shipping_details: nullable('shipping') }, {}),
    }),
    collected_information: object({ shipping_details: nullable('address_details') }),
    currency_conversion: object({ amount_total: integer }),
    shipping: object({ address: string, carrier: string, name: string, phone: string }),
    address_details: object({ address: string, name: string }),
    customer: object({ id: string, email: string, discount: nullable('discount') }),
    promotion_code: object({
      id: string,
      code: string,
      ...pick(after, { coupon: ref('coupon') }, { promotion: ref('promotion_code_promotion') }),
    }),
    promotion_code_promotion: object({ type: values('coupon'), coupon: expandable('coupon') }),
    discount: object({
      id: string,
      ...pick(after, { coupon: ref('coupon') }, { source: ref('discount_source') }),
    }),
    deleted_discount: object({
      id: string,
      ...pick(after, { coupon: ref('coupon') }, { source: ref('discount_source') }),
    }),
    discount_source: object({ type: values('coupon'), coupon: expandable('coupon') }),
    coupon: object({ id: string, percent_off: { type: 'number', nullable: true } }),
    credit_note: object({
      id: string,
      ...pick(
        after,
        { refund: expandable('refund'), tax_amounts: array(ref('invoice_tax_amount')) },
        { refunds: array(object({ amount_refunded: integer })) },
      ),
    }),
    refund: object({ id: string }),
    payment_intent: object({
      id: string,
      status: string,
      client_secret: string,
      cancellation_reason: {
        ...values('abandoned', 'automatic', 'duplicate', ...(after ? ['expired'] : [])),
        nullable: true,
      },
      ...pick(after, { invoice: expandable('invoice') }, {}),
    }),
    setup_intent: object({ id: string }),
    charge: object({
      id: string,
      payment_method_details: nullable('payment_method_details'),
      ...pick(after, { invoice: expandable('invoice') }, {}),
    }),
    payment_method_details: object({ card: nullable('payment_method_details_card') }),
    payment_method_details_card: object({
      three_d_secure: nullable('three_d_secure_details_charge'),
    }),
    three_d_secure_details_charge: object({
      result: {
        ...values('authenticated', 'failed', ...(after ? ['data_share_only'] : [])),
        nullable: true,
      },
    }),
    payment_method: object({ id: string }),
    review: object({
      id: string,
      closed_reason: {
        ...values(
          'approved',
          'disputed',
          'refunded',
          ...(after ? ['acknowledged', 'canceled', 'payment_never_settled'] : []),
        ),
        nullable: true,
      },
    }),
    'issuing.authorization': object({
      id: string,
      status: values('closed', 'pending', 'reversed', ...(after ? ['expired'] : [])),
      request_history: array(ref('issuing_authorization_request')),
    }),
    issuing_authorization_request: object({
      reason: values(
        'account_disabled',
        'webhook_approved',
        ...(after ? ['network_fallback'] : []),
      ),
    }),
    'issuing.token': object({ id: string }),
    account: object({ id: string, requirements: ref('account_requirements') }),
    account_requirements: object({
      errors: { ...array(ref('account_requirements_error')), nullable: true },
    }),
    account_requirements_error: object({
      code: values(
        'invalid_address_private_mailbox',
        ...(after
          ? [
              'external_request',
              'information_missing',
              'invalid_address_cmra_address',
              'invalid_address_registered_agent_address',
              'invalid_signator',
              'unsupported_business_type',
              'verification_failed_authorizer_authority',
              'verification_rejected_ownership_exemption_reason',
            ]
          : []),
      ),
      reason: string,
      requirement: string,
    }),
    'financial_connections.session': object({
      id: string,
      filters: ref('bank_connections_resource_link_account_session_filters'),
    }),
    bank_connections_resource_link_account_session_filters: object(
      pick(after, { countries: { ...array(string), nullable: true } }, { country: string }),
    ),
    'radar.payment_evaluation': object({ id: string }),
    subscription_schedule: object({
      id: string,
      phases: array(ref('subscription_schedule_phase_configuration')),
    }),
    subscription_schedule_phase_configuration: object({
      end_date: integer,
      ...pick(
        after,
        { coupon: expandable('coupon') },
        { discounts: array(object({ coupon: string })) },
      ),
    }),
    token: object({ id: string }),
    usage_record: object({ id: string, quantity: integer }),
    'forwarding.request': object({ id: string }),
    dispute: object({ id: string }),
  };
}

interface Operation {
  path: string;
  method: 'get' | 'post';
  // stripe-node's method name as x-stripeOperations records it.
  name: string;
  schema: string;
  operationId: string;
  body?: (after: boolean) => Record<string, unknown>;
  parameters?: (after: boolean) => unknown[];
  // A list endpoint's response is an inline list object, not the schema.
  list?: true;
  // Present only in the before contract.
  removed?: true;
}

const form = (properties: Record<string, unknown>, required?: string[]) =>
  object(properties, required);
const query = (names: string[]) => names.map((name) => ({ in: 'query', name, schema: string }));

const OPERATIONS: Operation[] = [
  {
    path: '/v1/subscriptions/{subscription_exposed_id}',
    method: 'get',
    name: 'retrieve',
    schema: 'subscription',
    operationId: 'GetSubscriptionsSubscriptionExposedId',
  },
  {
    path: '/v1/subscriptions',
    method: 'post',
    name: 'create',
    schema: 'subscription',
    operationId: 'PostSubscriptions',
    body: (after) =>
      form({
        customer: string,
        items: array(object({ price: string })),
        expand: array(string),
        ...pick(
          after,
          {
            coupon: string,
            promotion_code: string,
            billing_thresholds: object({ amount_gte: integer }),
          },
          { discounts: array(object({ coupon: string })) },
        ),
      }),
  },
  {
    path: '/v1/subscriptions/{subscription_exposed_id}',
    method: 'post',
    name: 'update',
    schema: 'subscription',
    operationId: 'PostSubscriptionsSubscriptionExposedId',
    body: (after) =>
      form({
        billing_cycle_anchor: after
          ? object({ type: values('now', 'unchanged') })
          : values('now', 'unchanged'),
        ...pick(
          after,
          { coupon: string, promotion_code: string },
          { discounts: array(object({ coupon: string })) },
        ),
      }),
  },
  {
    path: '/v1/customers',
    method: 'post',
    name: 'create',
    schema: 'customer',
    operationId: 'PostCustomers',
    body: (after) =>
      form({ email: string, ...pick(after, { coupon: string, promotion_code: string }, {}) }),
  },
  {
    path: '/v1/customers/{customer}',
    method: 'get',
    name: 'retrieve',
    schema: 'customer',
    operationId: 'GetCustomersCustomer',
  },
  {
    path: '/v1/invoices/{invoice}',
    method: 'get',
    name: 'retrieve',
    schema: 'invoice',
    operationId: 'GetInvoicesInvoice',
  },
  {
    path: '/v1/invoices/upcoming',
    method: 'get',
    name: 'upcoming',
    schema: 'invoice',
    operationId: 'GetInvoicesUpcoming',
    removed: true,
    parameters: () => query(['customer', 'subscription', 'coupon']),
  },
  {
    path: '/v1/invoices/upcoming/lines',
    method: 'get',
    name: 'upcomingLines',
    schema: 'invoice',
    operationId: 'GetInvoicesUpcomingLines',
    removed: true,
    list: true,
    parameters: () => query(['customer', 'subscription']),
  },
  {
    path: '/v1/invoices/create_preview',
    method: 'post',
    name: 'create_preview',
    schema: 'invoice',
    operationId: 'PostInvoicesCreatePreview',
    body: (after) =>
      form({ customer: string, subscription: string, ...pick(after, { coupon: string }, {}) }),
  },
  {
    path: '/v1/invoices/{invoice}/add_lines',
    method: 'post',
    name: 'add_lines',
    schema: 'invoice',
    operationId: 'PostInvoicesInvoiceAddLines',
    body: (after) =>
      form({
        lines: array(
          object(pick(after, { price: string }, { pricing: object({ price: string }) })),
        ),
      }),
  },
  {
    path: '/v1/invoiceitems',
    method: 'post',
    name: 'create',
    schema: 'invoiceitem',
    operationId: 'PostInvoiceitems',
    body: (after) =>
      form({
        customer: string,
        ...pick(
          after,
          { price: string, unit_amount: integer },
          { pricing: object({ price: string }) },
        ),
      }),
  },
  {
    path: '/v1/checkout/sessions/{session}',
    method: 'get',
    name: 'retrieve',
    schema: 'checkout.session',
    operationId: 'GetCheckoutSessionsSession',
  },
  {
    path: '/v1/checkout/sessions',
    method: 'post',
    name: 'create',
    schema: 'checkout.session',
    operationId: 'PostCheckoutSessions',
    body: (after) =>
      form({
        mode: string,
        success_url: string,
        ui_mode: after
          ? values('elements', 'embedded_page', 'form', 'hosted_page')
          : values('custom', 'embedded', 'hosted'),
        ...pick(
          after,
          { payment_method_types: array(string) },
          { allowed_payment_method_types: array(string) },
        ),
      }),
  },
  {
    path: '/v1/payment_intents/{intent}',
    method: 'get',
    name: 'retrieve',
    schema: 'payment_intent',
    operationId: 'GetPaymentIntentsIntent',
  },
  {
    path: '/v1/payment_intents',
    method: 'post',
    name: 'create',
    schema: 'payment_intent',
    operationId: 'PostPaymentIntents',
    body: (after) =>
      form({
        amount: integer,
        currency: string,
        ...pick(
          after,
          { payment_method_types: array(string) },
          { allowed_payment_method_types: array(string) },
        ),
      }),
  },
  {
    path: '/v1/payment_intents/{intent}',
    method: 'post',
    name: 'update',
    schema: 'payment_intent',
    operationId: 'PostPaymentIntentsIntent',
    body: (after) =>
      form({ metadata: object({}), ...pick(after, { payment_method_types: array(string) }, {}) }),
  },
  {
    path: '/v1/setup_intents',
    method: 'post',
    name: 'create',
    schema: 'setup_intent',
    operationId: 'PostSetupIntents',
    body: (after) =>
      form({
        customer: string,
        ...pick(
          after,
          { payment_method_types: array(string) },
          { allowed_payment_method_types: array(string) },
        ),
      }),
  },
  {
    path: '/v1/charges/{charge}',
    method: 'get',
    name: 'retrieve',
    schema: 'charge',
    operationId: 'GetChargesCharge',
  },
  {
    path: '/v1/promotion_codes',
    method: 'post',
    name: 'create',
    schema: 'promotion_code',
    operationId: 'PostPromotionCodes',
    body: (after) =>
      after
        ? form({ code: string, promotion: object({ type: values('coupon'), coupon: string }) }, [
            'promotion',
          ])
        : form({ code: string, coupon: string }, ['coupon']),
  },
  {
    path: '/v1/promotion_codes/{promotion_code}',
    method: 'get',
    name: 'retrieve',
    schema: 'promotion_code',
    operationId: 'GetPromotionCodesPromotionCode',
  },
  {
    path: '/v1/payment_methods/{payment_method}',
    method: 'post',
    name: 'update',
    schema: 'payment_method',
    operationId: 'PostPaymentMethodsPaymentMethod',
    body: (after) =>
      form({
        metadata: object({}),
        ...pick(
          after,
          { naver_pay: object({ funding: string }), payto: object({ bsb_number: string }) },
          {},
        ),
      }),
  },
  {
    path: '/v1/credit_notes',
    method: 'post',
    name: 'create',
    schema: 'credit_note',
    operationId: 'PostCreditNotes',
    body: (after) =>
      form({
        invoice: string,
        ...pick(after, { refund: string }, { refunds: array(object({ refund: string })) }),
      }),
  },
  {
    path: '/v1/credit_notes/{id}',
    method: 'get',
    name: 'retrieve',
    schema: 'credit_note',
    operationId: 'GetCreditNotesId',
  },
  {
    path: '/v1/credit_notes/preview',
    method: 'get',
    name: 'preview',
    schema: 'credit_note',
    operationId: 'GetCreditNotesPreview',
    parameters: (after) => query(['invoice', after ? 'refunds' : 'refund']),
  },
  {
    path: '/v1/plans',
    method: 'post',
    name: 'create',
    schema: 'plan',
    operationId: 'PostPlans',
    body: (after) =>
      form({ amount: integer, ...pick(after, { aggregate_usage: values('sum', 'max') }, {}) }),
  },
  {
    path: '/v1/plans/{plan}',
    method: 'get',
    name: 'retrieve',
    schema: 'plan',
    operationId: 'GetPlansPlan',
  },
  {
    path: '/v1/prices',
    method: 'post',
    name: 'create',
    schema: 'price',
    operationId: 'PostPrices',
    body: (after) =>
      form({
        unit_amount: integer,
        recurring: object({
          interval: string,
          ...pick(after, { aggregate_usage: values('sum', 'max') }, {}),
        }),
      }),
  },
  {
    path: '/v1/prices/{price}',
    method: 'get',
    name: 'retrieve',
    schema: 'price',
    operationId: 'GetPricesPrice',
  },
  {
    path: '/v1/subscription_items',
    method: 'post',
    name: 'create',
    schema: 'subscription_item',
    operationId: 'PostSubscriptionItems',
    body: (after) =>
      form({
        subscription: string,
        price: string,
        ...pick(after, { billing_thresholds: object({ usage_gte: integer }) }, {}),
      }),
  },
  {
    path: '/v1/subscription_items/{subscription_item}/usage_records',
    method: 'post',
    name: 'create',
    schema: 'usage_record',
    operationId: 'PostSubscriptionItemsSubscriptionItemUsageRecords',
    removed: true,
    body: () => form({ quantity: integer }),
  },
  {
    path: '/v1/subscription_schedules',
    method: 'post',
    name: 'create',
    schema: 'subscription_schedule',
    operationId: 'PostSubscriptionSchedules',
    body: (after) =>
      form({
        customer: string,
        phases: array(
          object(
            pick(
              after,
              { items: array(object({ price: string })), iterations: integer, coupon: string },
              { items: array(object({ price: string })), duration: object({ interval: string }) },
            ),
          ),
        ),
      }),
  },
  {
    path: '/v1/subscription_schedules/{schedule}',
    method: 'get',
    name: 'retrieve',
    schema: 'subscription_schedule',
    operationId: 'GetSubscriptionSchedulesSchedule',
  },
  {
    path: '/v1/tokens',
    method: 'post',
    name: 'create',
    schema: 'token',
    operationId: 'PostTokens',
    body: (after) =>
      form({ person: object({ political_exposure: after ? values('existing', 'none') : string }) }),
  },
  {
    path: '/v1/issuing/authorizations/{authorization}',
    method: 'get',
    name: 'retrieve',
    schema: 'issuing.authorization',
    operationId: 'GetIssuingAuthorizationsAuthorization',
  },
  {
    path: '/v1/issuing/tokens/{token}',
    method: 'get',
    name: 'retrieve',
    schema: 'issuing.token',
    operationId: 'GetIssuingTokensToken',
  },
  {
    path: '/v1/reviews/{review}',
    method: 'get',
    name: 'retrieve',
    schema: 'review',
    operationId: 'GetReviewsReview',
  },
  {
    path: '/v1/accounts/{account}',
    method: 'get',
    name: 'retrieve',
    schema: 'account',
    operationId: 'GetAccountsAccount',
  },
  {
    path: '/v1/accounts/{account}/reject',
    method: 'post',
    name: 'reject',
    schema: 'account',
    operationId: 'PostAccountsAccountReject',
    body: (after) =>
      form({
        reason: after ? values('credit', 'fraud_other', 'other', 'terms_of_service') : string,
      }),
  },
  {
    path: '/v1/financial_connections/sessions',
    method: 'post',
    name: 'create',
    schema: 'financial_connections.session',
    operationId: 'PostFinancialConnectionsSessions',
    body: (after) =>
      form({
        account_holder: object({ type: string }),
        filters: object(pick(after, { countries: array(string) }, { country: string })),
      }),
  },
  {
    path: '/v1/financial_connections/sessions/{session}',
    method: 'get',
    name: 'retrieve',
    schema: 'financial_connections.session',
    operationId: 'GetFinancialConnectionsSessionsSession',
  },
  {
    path: '/v1/radar/payment_evaluations',
    method: 'post',
    name: 'create',
    schema: 'radar.payment_evaluation',
    operationId: 'PostRadarPaymentEvaluations',
    body: () => form({ customer_details: object({ customer: string }) }),
  },
  {
    path: '/v1/coupons',
    method: 'post',
    name: 'create',
    schema: 'coupon',
    operationId: 'PostCoupons',
    body: () => form({ amount_off: integer, currency: string, duration: string }),
  },
  {
    path: '/v1/forwarding/requests',
    method: 'post',
    name: 'create',
    schema: 'forwarding.request',
    operationId: 'PostForwardingRequests',
    body: () => form({ url: string }),
  },
  {
    path: '/v1/disputes/{dispute}',
    method: 'post',
    name: 'update',
    schema: 'dispute',
    operationId: 'PostDisputesDispute',
    body: () => form({ evidence: object({ uncategorized_text: string }) }),
  },
];

function contract(after: boolean) {
  const paths: Record<string, Record<string, unknown>> = {};
  const sdkSchemas = structuredClone(schemas(after)) as Record<string, Record<string, unknown>>;
  for (const operation of OPERATIONS.filter((entry) => !(after && entry.removed))) {
    (paths[operation.path] ??= {})[operation.method] = {
      operationId: operation.operationId,
      ...(operation.parameters ? { parameters: operation.parameters(after) } : {}),
      ...(operation.body
        ? {
            requestBody: {
              content: { 'application/x-www-form-urlencoded': { schema: operation.body(after) } },
            },
          }
        : {}),
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: operation.list ? list(operation.schema) : ref(operation.schema),
            },
          },
        },
      },
    };
    ((sdkSchemas[operation.schema]['x-stripeOperations'] ??= []) as unknown[]).push({
      method_name: operation.name,
      method_on: 'service',
      operation: operation.method,
      path: operation.path,
    });
  }
  const document = {
    openapi: '3.0.0',
    info: { version: after ? '2026-09-30.endive' : '2025-02-24.acacia' },
    paths,
    components: { schemas: schemas(after) },
  };
  return { document, sdk: { components: { schemas: sdkSchemas } } };
}

const BEFORE = contract(false);
const AFTER = contract(true);
const FILE = 'billing.ts';

// The Stripe benchmark's engine path (stripe-benchmark-cli.ts, run.ts) without its file and
// network steps: the generated adapter, contract removals, removed request parameters, the
// invoice preview move, the analyzer, and under fullDiff the oasdiff entries the run gets.
function scan(code: string, oasdiff: Record<string, unknown>[] = []) {
  const content = `import Stripe from 'stripe';\nconst stripe = new Stripe('sk_test', { apiVersion: '2025-02-24.acacia' });\n${code}`;
  const repository: Repository = {
    root: '/catalog',
    files: [{ path: FILE, content }],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  const before = parseSpecificationInput(JSON.stringify(BEFORE.document), 'before.json');
  const after = parseSpecificationInput(JSON.stringify(AFTER.document), 'after.json');
  const { adapter } = repositoryAdapter(repository, stripeOperations(BEFORE.sdk, BEFORE.document));
  validateProviderMappings(adapter, before.schemas);
  const changes = withoutRenamedSchemaRemovals(
    findRemovedProperties(before.schemas, after.schemas, adapter.id),
    before.schemas,
    after.schemas,
  );
  const removals = removedRequestParameters(adapter, before.document, after.document);
  const analysis = analyzeRepository(
    repository,
    changes,
    adapter,
    before.schemas,
    [],
    [],
    [],
    removals,
    {
      invoicePreview: true,
    },
  );
  const diff = {
    engine: 'oasdiff' as const,
    changes: [
      ...oasdiff,
      ...switchedEnumAdditions(analysis.enumChecks, before.schemas, after.schemas),
    ],
  };
  const breaking = unmappedBreakingChanges(
    diff,
    changes,
    analysis.findings,
    [],
    [],
    analysis.expandedFields,
  );
  return {
    ...analysis,
    breaking,
    impacts: findBreakingOperationImpacts(
      diff,
      analysis.calls,
      validateProviderOperationMappings(adapter, before.document),
      breaking,
    ),
    unresolved: analysis.findings.filter(
      (finding) =>
        finding.confidence === 'confirmed' && !editCovers(repository, analysis.edits, finding),
    ),
    review: migrationReviewReason({ findings: analysis.findings, adapter }),
    patched: applySourceEdits(
      content,
      analysis.edits.filter((edit) => edit.file === FILE),
    ),
  };
}

// An oasdiff 1.x entry for a request change, worded as the real Stripe comparisons report it.
const requestChange = (path: string, id: string, text: string) => ({
  id,
  level: 3,
  operation: 'POST',
  path,
  text,
});

type Expectation =
  | { rule: string; patched: string }
  | { unresolved: string[] }
  | { parameter: string }
  | { review: string }
  | { contractReview: string }
  | { impact: string }
  | { enumValues: string[] }
  | { nothing: true };
interface Fixture {
  code: string;
  oasdiff?: Record<string, unknown>[];
  expect: Expectation;
}

const STRIPE_JS = (body: string) =>
  `import { loadStripe } from '@stripe/stripe-js';\nexport async function client() {\n  const browser = await loadStripe('pk_test');\n  ${body}\n}`;
const fn = (body: string) => `export async function handler(id: string) {\n  ${body}\n}`;
const nothing = (code: string): Fixture => ({ code, expect: { nothing: true } });

// Keyed by catalog file, one fixture per part in the entry's order.
const FIXTURES: Record<string, Fixture[]> = {
  // ---------------- 2025-03-31.basil ----------------
  '2025-03-31.basil/deprecate-subscription-current-period-start-and-end': [
    {
      code: fn(
        'const subscription = await stripe.subscriptions.retrieve(id);\n  return subscription.current_period_end;',
      ),
      expect: {
        rule: 'stripe-subscription-periods-helper',
        patched: 'return (getSubscriptionPeriodEnd(subscription));',
      },
    },
    nothing(
      fn(
        "const event = stripe.webhooks.constructEvent(id, 'sig', 'whsec');\n  if (event.type === 'customer.subscription.updated') return event.data.previous_attributes;",
      ),
    ),
  ],
  '2025-03-31.basil/adds-new-parent-field-to-invoicing-objects': [
    {
      code: fn(
        'const invoice = await stripe.invoices.retrieve(id);\n  return invoice.subscription;',
      ),
      expect: {
        rule: 'stripe-invoice-subscription-helper',
        patched: 'return (getInvoiceSubscription(invoice));',
      },
    },
    {
      code: fn(
        'const invoice = await stripe.invoices.retrieve(id);\n  const line = invoice.lines.data[0];\n  return [invoice.subscription_details, line.type, line.proration];',
      ),
      expect: { unresolved: ['.subscription_details', '.type', '.proration'] },
    },
    nothing(
      fn(
        'const invoice = await stripe.invoices.retrieve(id);\n  return invoice.lines.data[0].subscription;',
      ),
    ),
  ],
  '2025-03-31.basil/checkout-session-remove-shipping-details': [
    {
      code: fn(
        'const session = await stripe.checkout.sessions.retrieve(id);\n  return session.shipping_details;',
      ),
      expect: {
        rule: 'stripe-checkout-shipping-details-helper',
        patched: 'return (getCheckoutShippingDetails(session));',
      },
    },
    {
      code: fn(
        'const session = await stripe.checkout.sessions.retrieve(id);\n  return session.shipping_details.phone;',
      ),
      expect: { unresolved: ['.shipping_details'] },
    },
  ],
  '2025-03-31.basil/checkout-legacy-subscription-upgrade': [
    nothing(
      fn(
        "const session = await stripe.checkout.sessions.create({ mode: 'subscription', success_url: 'https://example.com' });\n  return session.url;",
      ),
    ),
  ],
  '2025-03-31.basil/restrict-coupon-duration': [
    nothing(
      fn(
        "return stripe.coupons.create({ amount_off: 500, currency: 'usd', duration: 'forever' });",
      ),
    ),
  ],
  '2025-03-31.basil/deprecate-singular-coupon-promotion-code': [
    {
      code: fn("return stripe.subscriptions.update(id, { coupon: 'SPRING' });"),
      expect: { parameter: 'coupon' },
    },
    nothing(
      fn(
        "return stripe.invoices.createPreview({ customer: 'cus_1', subscription: id, coupon: 'SPRING' });",
      ),
    ),
    {
      code: fn(
        "return stripe.subscriptionSchedules.create({ customer: 'cus_1', phases: [{ items: [{ price: 'price_1' }], coupon: 'SPRING' }] });",
      ),
      oasdiff: [
        requestChange(
          '/v1/subscription_schedules',
          'request-property-removed',
          'removed the request property `phases/items/coupon`',
        ),
      ],
      expect: { impact: 'PostSubscriptionSchedules' },
    },
    {
      code: fn(
        'const customer = await stripe.customers.retrieve(id);\n  const subscription = await stripe.subscriptions.retrieve(id);\n  return [customer.discount, subscription.discount];',
      ),
      expect: { unresolved: ['.discount'] },
    },
  ],
  '2025-03-31.basil/invoice-preview-api-deprecations': [
    {
      code: fn("return stripe.invoices.retrieveUpcoming({ customer: 'cus_1', subscription: id });"),
      expect: { contractReview: 'retrieveUpcoming' },
    },
    {
      code: fn("return stripe.invoices.retrieveUpcoming({ customer: 'cus_1' });"),
      expect: { contractReview: 'retrieveUpcoming' },
    },
    nothing(
      fn("return stripe.invoices.listUpcomingLines({ customer: 'cus_1', subscription: id });"),
    ),
  ],
  '2025-03-31.basil/deprecate-legacy-usage-based-billing': [
    nothing(fn('return stripe.subscriptionItems.createUsageRecord(id, { quantity: 1 });')),
    {
      code: fn(
        "return stripe.subscriptionItems.create({ subscription: id, price: 'price_1', billing_thresholds: { usage_gte: 10 } });",
      ),
      expect: { parameter: 'billing_thresholds' },
    },
    {
      code: fn(
        "return stripe.prices.create({ unit_amount: 100, recurring: { interval: 'month', aggregate_usage: 'sum' } });",
      ),
      oasdiff: [
        requestChange(
          '/v1/prices',
          'request-property-removed',
          'removed the request property `recurring/aggregate_usage`',
        ),
      ],
      expect: { impact: 'PostPrices' },
    },
    {
      code: fn('const plan = await stripe.plans.retrieve(id);\n  return plan.aggregate_usage;'),
      expect: { unresolved: ['.aggregate_usage'] },
    },
    {
      code: fn(
        'const price = await stripe.prices.retrieve(id);\n  return price.recurring.aggregate_usage;',
      ),
      expect: { review: '.aggregate_usage' },
    },
    nothing(
      fn("return stripe.prices.create({ unit_amount: 100, recurring: { interval: 'month' } });"),
    ),
  ],
  '2025-03-31.basil/invoice-pricing-configurations': [
    {
      code: fn(
        'const invoice = await stripe.invoices.retrieve(id);\n  for (const line of invoice.lines.data) return line.price.id;',
      ),
      expect: {
        rule: 'stripe-invoice-price-id-helper',
        patched: 'return (getInvoicePriceId(line));',
      },
    },
    {
      code: fn(
        'const invoice = await stripe.invoices.retrieve(id);\n  for (const line of invoice.lines.data) return line.price.nickname;',
      ),
      expect: { unresolved: ['.price'] },
    },
    nothing(
      fn(
        'const invoice = await stripe.invoices.retrieve(id);\n  return invoice.lines.data[0].plan;',
      ),
    ),
    nothing(
      fn(
        "return stripe.invoiceItems.create({ customer: 'cus_1', price: 'price_1', unit_amount: 500 });",
      ),
    ),
    {
      code: fn("return stripe.invoices.addLines(id, { lines: [{ price: 'price_1' }] });"),
      oasdiff: [
        requestChange(
          '/v1/invoices/{invoice}/add_lines',
          'request-property-removed',
          'removed the request property `lines/items/price`',
        ),
      ],
      expect: { impact: 'PostInvoicesInvoiceAddLines' },
    },
  ],
  '2025-03-31.basil/invoice-tax-configurations': [
    {
      code: fn(
        'const invoice = await stripe.invoices.retrieve(id);\n  const line = invoice.lines.data[0];\n  return [invoice.tax, line.tax_rates];',
      ),
      expect: { unresolved: ['.tax', '.tax_rates'] },
    },
  ],
  '2025-03-31.basil/add-support-for-multiple-partial-payments-on-invoices': [
    {
      code: fn(
        "const invoice = await stripe.invoices.retrieve(id);\n  const subscription = await stripe.subscriptions.create({ customer: 'cus_1', items: [{ price: 'price_1' }], expand: ['latest_invoice.payment_intent'] });\n  return [invoice.paid, invoice.charge, subscription.id];",
      ),
      expect: {
        unresolved: [
          '.paid',
          '.charge',
          "subscriptions.create expand 'latest_invoice.payment_intent'",
        ],
      },
    },
    {
      code: fn("return stripe.creditNotes.create({ invoice: id, refund: 're_1' });"),
      expect: { parameter: 'refund' },
    },
    nothing(fn("return stripe.creditNotes.preview({ invoice: id, refund: 're_1' });")),
    nothing(
      fn('const invoice = await stripe.invoices.retrieve(id);\n  return invoice.amount_paid;'),
    ),
  ],
  '2025-03-31.basil/new-network-fallback-issuing-authorization-reason-code': [
    {
      code: fn(
        "const authorization = await stripe.issuing.authorizations.retrieve(id);\n  for (const request of authorization.request_history) {\n    switch (request.reason) {\n      case 'webhook_approved': return true;\n      default: return false;\n    }\n  }",
      ),
      expect: { enumValues: ['network_fallback'] },
    },
  ],
  '2025-03-31.basil/issuing-json-webhook': [
    nothing(
      fn(
        "const event = stripe.webhooks.constructEvent(id, 'sig', 'whsec');\n  return event.type === 'issuing_authorization.request' ? { approved: true } : undefined;",
      ),
    ),
  ],
  '2025-03-31.basil/issuing-authorizations-expired': [
    {
      code: fn(
        "const authorization = await stripe.issuing.authorizations.retrieve(id);\n  switch (authorization.status) {\n    case 'reversed': return 'released';\n    default: return 'held';\n  }",
      ),
      expect: { enumValues: ['expired'] },
    },
    {
      code: fn(
        "const authorization = await stripe.issuing.authorizations.retrieve(id);\n  return authorization.status === 'reversed';",
      ),
      expect: { enumValues: ['expired'] },
    },
  ],
  '2025-03-31.basil/vault-forward-api-returns-402': [
    nothing(fn("return stripe.forwarding.requests.create({ url: 'https://example.com' });")),
  ],
  '2025-03-31.basil/deprecate-interac-present-manual-capture-method': [
    nothing(fn("return stripe.paymentIntents.create({ amount: 1099, currency: 'cad' });")),
  ],
  '2025-03-31.basil/naver-pay-payment-method': [
    {
      code: fn("return stripe.paymentMethods.update(id, { naver_pay: { funding: 'card' } });"),
      expect: { parameter: 'naver_pay' },
    },
  ],
  '2025-03-31.basil/remove-refund-from-partial-capture-and-payment-cancellation-flow': [
    {
      code: fn(
        "const review = await stripe.reviews.retrieve(id);\n  switch (review.closed_reason) {\n    case 'refunded': return 'refunded';\n    default: return 'open';\n  }",
      ),
      expect: { enumValues: ['canceled'] },
    },
    nothing(fn('const charge = await stripe.charges.retrieve(id);\n  return charge.id;')),
  ],
  '2025-03-31.basil/deprecate-total-count-expansion': [
    nothing(fn("return stripe.subscriptions.retrieve(id, { expand: ['total_count'] });")),
  ],
  '2025-03-31.basil/adds-requirement-error-codes': [
    {
      code: fn(
        "const account = await stripe.accounts.retrieve(id);\n  for (const error of account.requirements.errors) {\n    switch (error.code) {\n      case 'invalid_address_private_mailbox': return error.reason;\n      default: return undefined;\n    }\n  }",
      ),
      expect: { enumValues: ['information_missing', 'invalid_signator'] },
    },
  ],
  '2025-03-31.basil/default-layout-of-payment-element': [
    nothing(
      STRIPE_JS(
        "const elements = browser.elements({ clientSecret: 'cs' });\n  return elements.create('payment');",
      ),
    ),
  ],
  '2025-03-31.basil/political-exposure-persons-api': [
    {
      code: fn("return stripe.tokens.create({ person: { political_exposure: 'none' } });"),
      oasdiff: [
        requestChange(
          '/v1/tokens',
          'request-property-became-enum',
          'request property `person/political_exposure` was restricted to a list of enum values',
        ),
      ],
      expect: { impact: 'PostTokens' },
    },
  ],

  // ---------------- 2025-09-30.clover ----------------
  '2025-09-30.clover/remove-iterations': [
    {
      code: fn(
        "return stripe.subscriptionSchedules.create({ customer: 'cus_1', phases: [{ items: [{ price: 'price_1' }], iterations: 12 }] });",
      ),
      oasdiff: [
        requestChange(
          '/v1/subscription_schedules',
          'request-property-removed',
          'removed the request property `phases/items/iterations`',
        ),
      ],
      expect: { impact: 'PostSubscriptionSchedules' },
    },
    nothing(
      fn(
        "return stripe.invoices.createPreview({ customer: 'cus_1', schedule_details: { phases: [{ items: [{ price: 'price_1' }], iterations: 12 }] } });",
      ),
    ),
  ],
  '2025-09-30.clover/polymorphic-coupon': [
    {
      code: fn("return stripe.promotionCodes.create({ code: 'SPRING', coupon: 'co_1' });"),
      expect: {
        rule: 'stripe-promotion-code-promotion',
        patched: "promotion: { type: 'coupon', coupon: 'co_1' }",
      },
    },
    {
      code: fn(
        'const promotion = await stripe.promotionCodes.retrieve(id);\n  return promotion.coupon.id;',
      ),
      expect: { rule: 'stripe-coupon-id-helper', patched: 'return (getCouponId(promotion));' },
    },
    {
      code: fn(
        'const promotion = await stripe.promotionCodes.retrieve(id);\n  return promotion.coupon.percent_off;',
      ),
      expect: { unresolved: ['.coupon'] },
    },
  ],
  '2025-09-30.clover/add-discount-source-property': [
    {
      code: 'export function couponOf(discount: Stripe.Discount) {\n  return discount.coupon.id;\n}',
      expect: { rule: 'stripe-coupon-id-helper', patched: 'return (getCouponId(discount));' },
    },
    {
      code: 'export function percentOf(discount: Stripe.Discount) {\n  return discount.coupon.percent_off;\n}',
      expect: { unresolved: ['.coupon'] },
    },
  ],
  '2025-09-30.clover/billing-mode-default-flexible': [
    nothing(
      fn(
        "return stripe.subscriptions.create({ customer: 'cus_1', items: [{ price: 'price_1' }] });",
      ),
    ),
  ],
  '2025-09-30.clover/billing-cycle-anchor-resets-during-phase-computation': [
    nothing(fn('return stripe.subscriptionSchedules.retrieve(id);')),
  ],
  '2025-09-30.clover/postal_code_in_card_form_for_non_us_countries': [
    nothing(
      STRIPE_JS(
        "const elements = browser.elements({ clientSecret: 'cs' });\n  return elements.create('payment', { fields: { billingDetails: { address: 'auto' } } });",
      ),
    ),
  ],
  '2025-09-30.clover/remove-checkout-session-currency-conversion-field': [
    nothing(
      fn(
        'const session = await stripe.checkout.sessions.retrieve(id);\n  return session.currency_conversion;',
      ),
    ),
  ],
  '2025-09-30.clover/remove-redirect-to-checkout': [
    nothing(STRIPE_JS("return browser.redirectToCheckout({ sessionId: 'cs_1' });")),
  ],
  '2025-09-30.clover/update-init-checkout-synchronous': [
    nothing(
      STRIPE_JS(
        "const checkout = await browser.initCheckout({ fetchClientSecret: async () => 'cs' });\n  return checkout;",
      ),
    ),
  ],
  '2025-09-30.clover/expanded-risk-requirement-descriptions': [
    {
      code: fn(
        "const account = await stripe.accounts.retrieve(id);\n  for (const error of account.requirements.errors) {\n    switch (error.code) {\n      case 'invalid_address_private_mailbox': return error.reason;\n      default: return undefined;\n    }\n  }",
      ),
      expect: { enumValues: ['external_request'] },
    },
    nothing(
      fn(
        "const account = await stripe.accounts.retrieve(id);\n  return account.requirements.errors.some((error) => error.requirement.includes('other_supportability_inquiry'));",
      ),
    ),
  ],
  '2025-09-30.clover/business-type-error-code': [
    {
      code: fn(
        "const account = await stripe.accounts.retrieve(id);\n  for (const error of account.requirements.errors) {\n    switch (error.code) {\n      case 'invalid_address_private_mailbox': return error.reason;\n      default: return undefined;\n    }\n  }",
      ),
      expect: { enumValues: ['unsupported_business_type'] },
    },
  ],
  '2025-09-30.clover/custom-checkout-saved-payment-method-defaults': [
    nothing(STRIPE_JS("return browser.initCheckout({ fetchClientSecret: async () => 'cs' });")),
  ],
  '2025-09-30.clover/client-secret-reuse': [
    nothing(STRIPE_JS("return browser.elements({ clientSecret: 'pi_1_secret' });")),
  ],
  '2025-09-30.clover/stripejs-deprecated-elements-removal': [
    nothing(
      STRIPE_JS("const elements = browser.elements();\n  return elements.create('idealBank');"),
    ),
  ],
  '2025-09-30.clover/lpm-descriptive-decline-codes': [
    nothing(
      fn(
        "const intent = await stripe.paymentIntents.retrieve(id);\n  return intent.status === 'requires_payment_method';",
      ),
    ),
  ],
  '2025-09-30.clover/stablecoin-payments-processing-status': [
    nothing(
      fn(
        "const intent = await stripe.paymentIntents.retrieve(id);\n  return intent.status === 'succeeded';",
      ),
    ),
  ],
  '2025-09-30.clover/radar-manual-review-enum': [
    {
      code: fn(
        "const review = await stripe.reviews.retrieve(id);\n  switch (review.closed_reason) {\n    case 'approved': return 'ok';\n    default: return 'other';\n  }",
      ),
      expect: { enumValues: ['acknowledged', 'payment_never_settled'] },
    },
  ],
  '2025-09-30.clover/risk-levels-issuing-authorizations': [
    nothing(
      fn(
        'const authorization = await stripe.issuing.authorizations.retrieve(id);\n  return authorization.id;',
      ),
    ),
  ],

  // ---------------- 2026-03-25.dahlia ----------------
  '2026-03-25.dahlia/updates-available-checkout-session-ui-modes': [
    {
      code: fn(
        "return stripe.checkout.sessions.create({ mode: 'payment', success_url: 'https://example.com', ui_mode: 'embedded' });",
      ),
      oasdiff: [
        requestChange(
          '/v1/checkout/sessions',
          'request-property-enum-value-removed',
          'removed the enum value `embedded` of the request property `ui_mode`',
        ),
      ],
      expect: { impact: 'PostCheckoutSessions' },
    },
    {
      code: fn(
        "const session = await stripe.checkout.sessions.retrieve(id);\n  switch (session.ui_mode) {\n    case 'hosted': return session.url;\n    default: return undefined;\n  }",
      ),
      expect: { enumValues: ['elements', 'embedded_page', 'hosted_page'] },
    },
    {
      code: fn(
        "const session = await stripe.checkout.sessions.retrieve(id);\n  return session.ui_mode === 'hosted' ? session.url : undefined;",
      ),
      expect: { enumValues: ['elements', 'embedded_page', 'hosted_page'] },
    },
  ],
  '2026-03-25.dahlia/capabilities-api-risk-requirements': [
    nothing(fn('const account = await stripe.accounts.retrieve(id);\n  return account.id;')),
  ],
  '2026-03-25.dahlia/address-element-getvalue-and-change-event-formatting': [
    nothing(
      STRIPE_JS(
        "const elements = browser.elements();\n  const address = elements.create('address', { mode: 'billing' });\n  return address.getValue();",
      ),
    ),
  ],
  '2026-03-25.dahlia/elements-update-returns-promise': [
    nothing(
      STRIPE_JS(
        "const elements = browser.elements();\n  const result: void = elements.update({ locale: 'fr' });\n  return result;",
      ),
    ),
  ],
  '2026-03-25.dahlia/disallow-booleans-for-radios': [
    nothing(
      STRIPE_JS(
        "const elements = browser.elements();\n  return elements.create('payment', { layout: { type: 'accordion', radios: true } });",
      ),
    ),
  ],
  '2026-03-25.dahlia/remove-legacy-stripejs-methods': [
    nothing(STRIPE_JS("return browser.handleCardPayment('pi_secret');")),
  ],
  '2026-03-25.dahlia/rename-init-checkout-to-init-checkout-elements': [
    nothing(STRIPE_JS("return browser.initCheckout({ clientSecret: 'cs' });")),
  ],
  '2026-03-25.dahlia/rename-init-embedded-checkout-to-create-embedded-checkout-page': [
    nothing(STRIPE_JS("return browser.initEmbeddedCheckout({ clientSecret: 'cs' });")),
  ],
  '2026-03-25.dahlia/visa-card-reference-id-optional': [
    {
      code: fn('const token = await stripe.issuing.tokens.retrieve(id);\n  return token.id;'),
      oasdiff: [
        {
          id: 'response-property-became-nullable',
          level: 2,
          operation: 'GET',
          path: '/v1/issuing/tokens/{token}',
          text: 'the response property `network_data/visa/card_reference_id` became nullable for the status `200`',
        },
      ],
      expect: { impact: 'GetIssuingTokensToken' },
    },
  ],
  '2026-03-25.dahlia/adds-new-cancellation-reason-subscription-test-retention-policy': [
    nothing(
      fn(
        "const subscription = await stripe.subscriptions.retrieve(id);\n  switch (subscription.cancellation_details.reason) {\n    case 'cancellation_requested': return 'customer';\n    default: return 'other';\n  }",
      ),
    ),
  ],
  '2026-03-25.dahlia/updates-eventsfrom-parameter-on-event-destinations': [
    nothing(
      fn(
        "return stripe.v2.core.eventDestinations.create({ name: 'hooks', events_from: ['self'] });",
      ),
    ),
  ],

  // ---------------- 2026-09-30.endive ----------------
  '2026-09-30.endive/polymorphic-billing-cycle-anchor': [
    {
      code: fn("return stripe.subscriptions.update(id, { billing_cycle_anchor: 'now' });"),
      oasdiff: [
        requestChange(
          '/v1/subscriptions/{subscription_exposed_id}',
          'request-property-type-changed',
          'the `billing_cycle_anchor` request property `type` changed from `string` to `object`',
        ),
      ],
      expect: { impact: 'PostSubscriptionsSubscriptionExposedId' },
    },
    nothing(
      fn(
        "return stripe.invoices.createPreview({ customer: 'cus_1', subscription_details: { billing_cycle_anchor: 'now' } });",
      ),
    ),
  ],
  '2026-09-30.endive/address-validation-cmra-registered-agents-accounts-v2': [
    {
      code: fn(
        "const account = await stripe.accounts.retrieve(id);\n  for (const error of account.requirements.errors) {\n    switch (error.code) {\n      case 'invalid_address_private_mailbox': return error.reason;\n      default: return undefined;\n    }\n  }",
      ),
      expect: {
        enumValues: ['invalid_address_cmra_address', 'invalid_address_registered_agent_address'],
      },
    },
    nothing(
      fn(
        "const account = await stripe.v2.core.accounts.retrieve(id, { include: ['requirements'] });\n  return account.requirements;",
      ),
    ),
  ],
  '2026-09-30.endive/rejected-accounts-v2-capabilities': [
    nothing(
      fn(
        "const account = await stripe.v2.core.accounts.retrieve(id, { include: ['configuration.merchant'] });\n  return account.configuration;",
      ),
    ),
  ],
  '2026-09-30.endive/updated-reject-reason-codes': [
    {
      code: fn("return stripe.accounts.reject(id, { reason: 'fraud' });"),
      oasdiff: [
        requestChange(
          '/v1/accounts/{account}/reject',
          'request-property-became-enum',
          'request property `reason` was restricted to a list of enum values',
        ),
      ],
      expect: { impact: 'PostAccountsAccountReject' },
    },
  ],
  '2026-09-30.endive/removes-configurations-parameter-from-v2-core-account-links-api': [
    nothing(
      fn(
        "return stripe.v2.core.accountLinks.create({ account: id, use_case: { type: 'account_onboarding', account_onboarding: { configurations: ['merchant'], refresh_url: 'https://example.com', return_url: 'https://example.com' } } });",
      ),
    ),
  ],
  '2026-09-30.endive/sepa-debit-settings-accounts': [
    nothing(fn('const account = await stripe.accounts.retrieve(id);\n  return account.id;')),
  ],
  '2026-09-30.endive/shows-errors-for-eventually-due-requirements': [
    nothing(
      fn(
        'const account = await stripe.accounts.retrieve(id);\n  return account.requirements.errors.length;',
      ),
    ),
  ],
  '2026-09-30.endive/platform-rejection-reasons': [
    nothing(fn('const account = await stripe.accounts.retrieve(id);\n  return account.id;')),
  ],
  '2026-09-30.endive/rename-financial-connections-countries-filter-to-country': [
    {
      code: fn(
        "return stripe.financialConnections.sessions.create({ account_holder: { type: 'customer' }, filters: { countries: ['US'] } });",
      ),
      oasdiff: [
        requestChange(
          '/v1/financial_connections/sessions',
          'request-property-removed',
          'removed the request property `filters/countries`',
        ),
      ],
      expect: { impact: 'PostFinancialConnectionsSessions' },
    },
    {
      code: fn(
        'const session = await stripe.financialConnections.sessions.retrieve(id);\n  return session.filters.countries;',
      ),
      expect: { unresolved: ['.countries'] },
    },
  ],
  '2026-09-30.endive/financial-connections-session-defaults': [
    nothing(
      fn(
        "return stripe.financialConnections.sessions.create({ account_holder: { type: 'customer' } });",
      ),
    ),
  ],
  '2026-09-30.endive/remove-payment-method-types-checkout-sessions': [
    {
      code: fn(
        "return stripe.checkout.sessions.create({ mode: 'payment', success_url: 'https://example.com', payment_method_types: ['card'] });",
      ),
      expect: { parameter: 'payment_method_types' },
    },
    {
      code: fn(
        "return stripe.checkout.sessions.create({ mode: 'payment', success_url: 'https://example.com', payment_method_types: ['card', 'klarna'] });",
      ),
      expect: { parameter: 'payment_method_types' },
    },
  ],
  '2026-09-30.endive/data-share-only': [
    nothing(
      fn(
        "const charge = await stripe.charges.retrieve(id);\n  switch (charge.payment_method_details.card.three_d_secure.result) {\n    case 'authenticated': return true;\n    default: return false;\n  }",
      ),
    ),
  ],
  '2026-09-30.endive/payment-evaluations-nullable-score': [
    {
      code: fn(
        "return stripe.radar.paymentEvaluations.create({ customer_details: { customer: 'cus_1' } });",
      ),
      oasdiff: [
        {
          id: 'response-property-became-nullable',
          level: 2,
          operation: 'POST',
          path: '/v1/radar/payment_evaluations',
          text: 'the response property `signals/fraudulent_payment/score` became nullable for the status `200`',
        },
      ],
      expect: { impact: 'PostRadarPaymentEvaluations' },
    },
    nothing(
      fn(
        "const evaluation = await stripe.radar.paymentEvaluations.create({ customer_details: { customer: 'cus_1' } });\n  return evaluation.id;",
      ),
    ),
  ],
  '2026-09-30.endive/removed-payto-fields': [
    {
      code: fn("return stripe.paymentMethods.update(id, { payto: { bsb_number: '000000' } });"),
      expect: { parameter: 'payto' },
    },
  ],
  '2026-09-30.endive/removes-the-payment-method-types-parameter-from-payment-intents-and-setup-intents':
    [
      {
        code: fn(
          "return stripe.paymentIntents.create({ amount: 1000, currency: 'usd', payment_method_types: ['card'] });",
        ),
        expect: { parameter: 'payment_method_types' },
      },
      {
        code: fn("return stripe.paymentIntents.update(id, { payment_method_types: ['card'] });"),
        expect: { parameter: 'payment_method_types' },
      },
    ],
  '2026-09-30.endive/blik-granular-decline-codes': [
    nothing(
      fn(
        "const intent = await stripe.paymentIntents.retrieve(id);\n  return intent.status === 'requires_payment_method';",
      ),
    ),
  ],
  '2026-09-30.endive/deprecate-payment-request-button': [
    nothing(
      STRIPE_JS(
        "const elements = browser.elements();\n  return elements.create('paymentRequestButton', { paymentRequest: undefined });",
      ),
    ),
  ],
  '2026-09-30.endive/handle-next-action-mb-way-bizum-ui': [
    nothing(STRIPE_JS("return browser.handleNextAction({ clientSecret: 'pi_secret' });")),
  ],
  '2026-09-30.endive/remove-elements-deferred-intent-payment-method-types': [
    nothing(
      STRIPE_JS(
        "return browser.elements({ mode: 'payment', amount: 1000, currency: 'usd', paymentMethodTypes: ['card'] });",
      ),
    ),
  ],
  '2026-09-30.endive/failed-tax-calculation-error': [
    nothing(fn('const invoice = await stripe.invoices.retrieve(id);\n  return invoice.id;')),
  ],
  '2026-09-30.endive/reserve-release-reason': [
    nothing(
      fn(
        "const release = await stripe.reserve.releases.retrieve(id);\n  return release.reason === 'bulk_hold_expiry';",
      ),
    ),
  ],
  '2026-09-30.endive/settlement-reserve-api': [
    nothing(
      fn('const reserve = await stripe.reserve.plans.retrieve(id);\n  return reserve.destination;'),
    ),
  ],
  '2026-09-30.endive/page-limit-validation-dispute-evidence': [
    nothing(
      fn("return stripe.disputes.update(id, { evidence: { uncategorized_text: 'details' } });"),
    ),
  ],
  '2026-09-30.endive/duplicate-reference-validation-for-india-pending-mandates': [
    nothing(fn("return stripe.paymentIntents.create({ amount: 1000, currency: 'inr' });")),
  ],
  '2026-09-30.endive/surface-india-card-mandate-even-when-inactive': [
    nothing(
      fn(
        'const charge = await stripe.charges.retrieve(id);\n  return charge.payment_method_details.card != null;',
      ),
    ),
  ],
  '2026-09-30.endive/block-custom-checkout-confirmation-pending-updates': [
    nothing(
      STRIPE_JS(
        "const checkout = browser.initCheckoutElementsSdk({ clientSecret: 'cs' });\n  return checkout;",
      ),
    ),
  ],
  '2026-09-30.endive/skip-format-validation-empty-optional-address-fields': [
    nothing(
      STRIPE_JS(
        "const checkout = browser.initCheckoutElementsSdk({ clientSecret: 'cs' });\n  return checkout;",
      ),
    ),
  ],
  '2026-09-30.endive/strict-billing-details-validation': [
    nothing(
      STRIPE_JS(
        "const elements = browser.elements();\n  return elements.create('payment', { fields: { billingDetails: 'never' } });",
      ),
    ),
  ],
};

const KINDS: Record<Handling, (expectation: Expectation, part: Part) => boolean> = {
  rule: (expectation) => 'rule' in expectation,
  ai: (expectation) => 'unresolved' in expectation,
  stop: (expectation, part) =>
    'parameter' in expectation ||
    'review' in expectation ||
    'contractReview' in expectation ||
    ('impact' in expectation && Boolean(part.fullDiffOnly)),
  generic: (expectation, part) => 'enumValues' in expectation && Boolean(part.fullDiffOnly),
  none: (expectation) => 'nothing' in expectation,
};

describe('the Stripe breaking-change catalog', () => {
  it('lists every change the changelog marks Breaking in the four releases', () => {
    const count = (version: string) =>
      entries.filter(({ entry }) => entry.version === version).length;
    expect({
      basil: count('2025-03-31.basil'),
      clover: count('2025-09-30.clover'),
      dahlia: count('2026-03-25.dahlia'),
      endive: count('2026-09-30.endive'),
    }).toEqual({ basil: 22, clover: 18, dahlia: 11, endive: 28 });
    expect(Object.keys(FIXTURES).sort()).toEqual(entries.map(({ key }) => key));
  });

  it.each(entries)('$key is a complete, sourced entry', ({ key, entry }) => {
    const [version, slug] = key.split('/');
    expect(entry.version).toBe(version);
    expect(entry.version).toMatch(/^\d{4}-\d{2}-\d{2}\.(basil|clover|dahlia|endive)$/);
    const [date, release] = entry.version.split('.');
    expect(entry.source).toBe(`https://docs.stripe.com/changelog/${release}/${date}/${slug}`);
    expect(entry.title.trim()).not.toBe('');
    expect(entry.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${entry.checkedAt}T00:00:00Z`).toISOString().slice(0, 10)).toBe(
      entry.checkedAt,
    );
    expect(['api', 'stripejs']).toContain(entry.category);
    const parts = partsOf(entry);
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      expect(HANDLING).toContain(part.handling);
      expect(part.changed.length).toBeGreaterThan(0);
      if (part.handling === 'stop' || part.handling === 'none')
        expect(part.reason?.trim()).toBeTruthy();
      else expect(part.how?.trim()).toBeTruthy();
      if (part.fullDiffOnly) expect(['stop', 'generic']).toContain(part.handling);
    }
    // The entry is handled only as far as its least-handled part.
    const weakest = parts.reduce((low, part) =>
      HANDLING.indexOf(part.handling) < HANDLING.indexOf(low.handling) ? part : low,
    );
    expect(entry.handling).toBe(weakest.handling);
    if (entry.handling === 'stop' || entry.handling === 'none')
      expect(entry.reason).toBe(weakest.reason);
    expect(entry.changed).toEqual(parts.flatMap((part) => part.changed));
    expect(FIXTURES[key]).toHaveLength(parts.length);
  });

  const cases = entries.flatMap(({ key, entry }) =>
    partsOf(entry).map((part, index) => ({ key, index, part, fixture: FIXTURES[key]?.[index] })),
  );

  it.each(cases)('$key part $index runs its fixture through the engine', ({ part, fixture }) => {
    expect(fixture).toBeDefined();
    expect(KINDS[part.handling](fixture!.expect, part)).toBe(true);
    const result = scan(fixture!.code, fixture!.oasdiff);
    const expectation = fixture!.expect;
    if ('rule' in expectation) {
      expect(result.edits.map((edit) => edit.rule)).toContain(expectation.rule);
      expect(result.patched).toContain(expectation.patched);
    } else if ('unresolved' in expectation) {
      for (const expression of expectation.unresolved)
        expect(result.unresolved.map((finding) => finding.expression)).toContain(expression);
      expect(
        result.findings.some((finding) => finding.requestParameter || finding.contractReview),
      ).toBe(false);
    } else if ('parameter' in expectation) {
      expect(
        result.findings.find((finding) => finding.requestParameter)?.requestParameter?.parameter,
      ).toBe(expectation.parameter);
      expect(result.review).toBe(REMOVED_REQUEST_PARAMETER_REVIEW_REASON);
    } else if ('review' in expectation) {
      // Not traceable, so only a review finding: unresolved, and not sent to AI.
      const reads = result.findings.filter((finding) => finding.expression === expectation.review);
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((finding) => finding.confidence === 'review')).toBe(true);
      expect(result.unresolved).toEqual([]);
      expect(result.edits).toEqual([]);
    } else if ('contractReview' in expectation) {
      const finding = result.findings.find((entry) => entry.contractReview);
      expect(finding?.contractReview).toContain(expectation.contractReview);
      expect(result.review).toBe(finding?.contractReview);
      expect(result.edits).toEqual([]);
    } else if ('impact' in expectation) {
      expect(result.impacts.map((impact) => impact.operationId)).toEqual([expectation.impact]);
      expect(result.impacts[0].usages).toHaveLength(1);
      // Without fullDiff the same code reports nothing.
      const direct = scan(fixture!.code);
      expect([direct.findings, direct.edits, direct.breaking]).toEqual([[], [], []]);
    } else if ('enumValues' in expectation) {
      const reported = result.breaking.flatMap((change) =>
        isObject(change) && Array.isArray(change.values) ? change.values : [],
      );
      expect(reported).toEqual(expect.arrayContaining(expectation.enumValues));
      expect(result.findings).toEqual([]);
    } else {
      expect([result.findings, result.edits, result.breaking, result.impacts]).toEqual([
        [],
        [],
        [],
        [],
      ]);
    }
  });
});
