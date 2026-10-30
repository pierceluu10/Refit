import ts from 'typescript-compiler';
import { componentReference, isObject, resolvableComponentSchema } from './specifications.ts';
import { PipelineInputError, type Finding, type Removal, type SourceEdit } from './types.ts';
import type { stripeWebhookPayloads } from './stripe-webhook-payloads.ts';
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
export const SUBSCRIPTION_PERIOD_HELPER_RULE = STRIPE_PACK.fieldMoves.find(
  (move) => move.family === 'period-helper',
)!.rule;
const BEFORE_VERSION = '2025-02-24.acacia';
const AFTER_VERSION = '2025-03-31.basil';
const MAX_PRICE_ID_LENGTH = 256;
const PERIOD_FIELDS = ['current_period_start', 'current_period_end'] as const;
const PERIOD_BINDING = 'refitSubscriptionPeriod';
const HANDLER_STATEMENTS = 5;
const GENERATED_BINDINGS = new Set([
  'startField',
  'endField',
  'items',
  'selected',
  'item',
  'price',
  'start',
  'end',
  'Reflect',
  'Array',
  'Number',
]);

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

function binding(statement: ts.Statement) {
  if (
    !ts.isVariableStatement(statement) ||
    !(statement.declarationList.flags & ts.NodeFlags.Const) ||
    statement.declarationList.declarations.length !== 1
  )
    return;
  const declaration = statement.declarationList.declarations[0];
  return ts.isIdentifier(declaration.name) && declaration.initializer ? declaration : undefined;
}

export function subscriptionPeriodEdit(options: {
  source: ts.SourceFile;
  nodes: ts.Node[];
  findings: Finding[];
  changes: Removal[];
  policy: StripeSubscriptionPeriodPolicy;
  webhooks: ReturnType<typeof stripeWebhookPayloads>;
  symbol: (node: ts.Node) => ts.Symbol | undefined;
  unsafe: Set<ts.Symbol>;
  file: string;
}): { edit: SourceEdit; findings: Finding[] } | undefined {
  const { source, nodes, findings, changes, policy, webhooks, symbol, unsafe, file } = options;
  if (nodes.some((node) => ts.isIdentifier(node) && node.text === PERIOD_BINDING)) return;
  if (
    nodes.some(
      (node) =>
        ts.isIdentifier(node) &&
        ['Reflect', 'Array', 'Number', 'Error'].includes(node.text) &&
        symbol(node)?.valueDeclaration,
    )
  )
    return;
  const candidates = source.statements.filter(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && Boolean(node.body),
  );
  for (const handler of candidates) {
    const statements = handler.body!.statements;
    if (statements.length !== HANDLER_STATEMENTS) continue;
    const event = binding(statements[0]);
    const subscription = binding(statements[2]);
    const guard = statements[3];
    const returned = statements[4];
    if (
      !event ||
      !subscription ||
      !ts.isIdentifier(event.name) ||
      !ts.isIdentifier(subscription.name) ||
      !ts.isReturnStatement(returned) ||
      !returned.expression ||
      !ts.isObjectLiteralExpression(returned.expression) ||
      !ts.isIfStatement(guard) ||
      guard.elseStatement ||
      !ts.isBlock(guard.thenStatement) ||
      guard.thenStatement.statements.length !== 1 ||
      !ts.isThrowStatement(guard.thenStatement.statements[0])
    )
      continue;
    if (GENERATED_BINDINGS.has(event.name.text) || GENERATED_BINDINGS.has(subscription.name.text))
      continue;
    if (
      !returned.expression.properties.every(
        (property) =>
          ts.isPropertyAssignment(property) &&
          ts.isPropertyAccessExpression(property.initializer) &&
          ((symbol(property.initializer.expression) === symbol(subscription.name) &&
            ['id', ...PERIOD_FIELDS].includes(property.initializer.name.text)) ||
            (symbol(property.initializer.expression) === symbol(event.name) &&
              property.initializer.name.text === 'api_version')),
      )
    )
      continue;
    const eventSymbol = symbol(event.name);
    const subscriptionSymbol = symbol(subscription.name);
    const origin = webhooks.origin(subscription.name);
    if (
      !eventSymbol ||
      !subscriptionSymbol ||
      origin?.binding !== eventSymbol ||
      origin.schema !== 'subscription' ||
      !origin.eventTypes.length ||
      !origin.eventTypes.every((name) => name.startsWith('customer.subscription.')) ||
      !webhooks.events.has(eventSymbol) ||
      unsafe.has(eventSymbol) ||
      unsafe.has(subscriptionSymbol)
    )
      continue;
    if (
      !ts.isPropertyAccessExpression(subscription.initializer!) ||
      subscription.initializer!.name.text !== 'object' ||
      !ts.isPropertyAccessExpression(subscription.initializer!.expression) ||
      subscription.initializer!.expression.name.text !== 'data' ||
      symbol(subscription.initializer!.expression.expression) !== eventSymbol
    )
      continue;
    const thrown = guard.thenStatement.statements[0].expression;
    if (
      !thrown ||
      !ts.isNewExpression(thrown) ||
      !ts.isIdentifier(thrown.expression) ||
      !thrown.arguments?.every(ts.isStringLiteral)
    )
      continue;
    const errorClass = symbol(thrown.expression)?.valueDeclaration;
    if (
      !errorClass ||
      !ts.isClassDeclaration(errorClass) ||
      errorClass.parent !== source ||
      errorClass.members.length ||
      errorClass.heritageClauses?.length !== 1 ||
      errorClass.heritageClauses[0].types.length !== 1 ||
      errorClass.heritageClauses[0].types[0].expression.getText() !== 'Error'
    )
      continue;
    if (symbol(errorClass.heritageClauses[0].types[0].expression)?.valueDeclaration) continue;
    const numberGuard = (node: ts.Expression, field: string) =>
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
      ts.isTypeOfExpression(node.left) &&
      ts.isPropertyAccessExpression(node.left.expression) &&
      node.left.expression.name.text === field &&
      symbol(node.left.expression.expression) === subscriptionSymbol &&
      ts.isStringLiteral(node.right) &&
      node.right.text === 'number';
    if (
      !ts.isBinaryExpression(guard.expression) ||
      guard.expression.operatorToken.kind !== ts.SyntaxKind.BarBarToken ||
      !numberGuard(guard.expression.left, PERIOD_FIELDS[0]) ||
      !numberGuard(guard.expression.right, PERIOD_FIELDS[1])
    )
      continue;
    const reads = nodes.filter(
      (node): node is ts.PropertyAccessExpression =>
        ts.isPropertyAccessExpression(node) &&
        symbol(node.expression) === subscriptionSymbol &&
        PERIOD_FIELDS.some((field) => field === node.name.text),
    );
    if (
      reads.length !== 4 ||
      reads.some(
        (node) =>
          node.getStart() < guard.getStart() ||
          node.getEnd() > returned.getEnd() ||
          node.questionDotToken,
      )
    )
      continue;
    const selected = findings.filter(
      (finding) =>
        finding.file === file &&
        reads.some((node) => {
          const position = source.getLineAndCharacterOfPosition(node.getStart());
          return position.line + 1 === finding.line && position.character + 1 === finding.column;
        }),
    );
    if (
      selected.length !== reads.length ||
      selected.some(
        (finding) =>
          finding.confidence !== 'confirmed' || finding.webhook?.schema !== 'subscription',
      )
    )
      continue;
    const change = changes.find((entry) => entry.id === selected[0].changeId);
    if (!change) continue;
    const newline = source.text.includes('\r\n') ? '\r\n' : '\n';
    const indentation = source.text.slice(
      source.text.lastIndexOf('\n', statements[2].getStart()) + 1,
      statements[2].getStart(),
    );
    const failure = `throw ${thrown.getText()};`;
    const startField = JSON.stringify(PERIOD_FIELDS[0]);
    const endField = JSON.stringify(PERIOD_FIELDS[1]);
    const helper = [
      `const ${PERIOD_BINDING} = (() => {`,
      `  const startField = ${startField};`,
      `  const endField = ${endField};`,
      `  if (${event.name.text}.api_version === ${JSON.stringify(policy.beforeApiVersion)}) {`,
      `    return { start: Reflect.get(${subscription.name.text}, startField), end: Reflect.get(${subscription.name.text}, endField) };`,
      '  }',
      `  if (${event.name.text}.api_version !== ${JSON.stringify(policy.afterApiVersion)}) { ${failure} }`,
      `  const items = ${subscription.name.text}.items;`,
      `  if (!items || items.has_more !== false || !Array.isArray(items.data)) { ${failure} }`,
      `  let selected${/\.[cm]?tsx?$/.test(file) ? ': object | undefined' : ''};`,
      '  for (const item of items.data) {',
      `    if (!item || typeof item !== 'object') { ${failure} }`,
      "    const price = Reflect.get(item, 'price');",
      `    if (!price || typeof price !== 'object' || typeof Reflect.get(price, 'id') !== 'string') { ${failure} }`,
      `    if (Reflect.get(price, 'id') === ${JSON.stringify(policy.priceId)}) {`,
      `      if (selected) { ${failure} }`,
      '      selected = item;',
      '    }',
      '  }',
      `  if (!selected) { ${failure} }`,
      '  const start = Reflect.get(selected, startField);',
      '  const end = Reflect.get(selected, endField);',
      `  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) { ${failure} }`,
      '  return { start, end };',
      '})();',
    ].join(newline + indentation);
    const edits = reads.map((node) => ({
      start: node.getStart(),
      end: node.getEnd(),
      text: `${PERIOD_BINDING}.${node.name.text === PERIOD_FIELDS[0] ? 'start' : 'end'}`,
    }));
    edits.push({
      start: statements[2].getEnd(),
      end: statements[2].getEnd(),
      text: newline + indentation + helper,
    });
    let content = source.text;
    for (const edit of edits.sort((a, b) => b.start - a.start))
      content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
    return {
      edit: {
        file,
        start: 0,
        end: source.text.length,
        replacement: content,
        changeId: change.id,
        rule: SUBSCRIPTION_PERIOD_RULE,
      },
      findings: selected,
    };
  }
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
export type PeriodRareCase = 'item-in-code' | 'price-policy' | 'flagged';

const HELPER_BODY = (typed: boolean) => {
  const t = (annotation: string) => (typed ? annotation : '');
  return `${
    typed
      ? `type PeriodItem = { price?: { id?: string } | null };
type PeriodField = 'current_period_start' | 'current_period_end';
type PlanItem = (items: PeriodItem[]) => PeriodItem | undefined;

// Typed like the removed field, which was also absent at runtime when Stripe omitted it.
`
      : ''
  }function subscriptionPeriod(subscription${t(': object')}, field${t(': PeriodField')}, planItem${t('?: PlanItem')})${t(': number')} {
  const legacy${t(': unknown')} = Reflect.get(subscription, field);
  if (typeof legacy === 'number') return legacy;
  const list${t(': unknown')} = Reflect.get(subscription, 'items');
  const data${t(': unknown')} = list && typeof list === 'object' ? Reflect.get(list, 'data') : undefined;
  const items = (Array.isArray(data) ? data : []).filter(
    (item)${t(': item is PeriodItem')} => typeof item === 'object' && item !== null,
  );
  const periods = new Set(items.map((item) => Reflect.get(item, field)));
  const chosen = periods.size === 1 ? items[0] : planItem?.(items);
  const value${t(': unknown')} = chosen ? Reflect.get(chosen, field) : undefined;
  return ${typed ? '(' : ''}typeof value === 'number' ? value : undefined${typed ? ') as number' : ''};
}
`;
};

// Only the helpers the patch calls, so the module adds no unused code to the repository. Inline
// helpers go into the one file that calls them, so they export nothing.
export function subscriptionPeriodHelperModule(
  kind: 'ts' | 'esm' | 'cjs',
  helpers: readonly string[],
  inline = false,
) {
  const typed = kind === 'ts';
  const t = (annotation: string) => (typed ? annotation : '');
  const exported = kind === 'cjs' || inline ? '' : 'export ';
  const parameters = typed ? 'subscription: object, planItem?: PlanItem' : 'subscription, planItem';
  const result = typed ? ': number' : '';
  const sections: [string, string][] = [
    [
      PERIOD_HELPERS.current_period_start,
      `${exported}function getSubscriptionPeriodStart(${parameters})${result} {
  return subscriptionPeriod(subscription, 'current_period_start', planItem);
}
`,
    ],
    [
      PERIOD_HELPERS.current_period_end,
      `${exported}function getSubscriptionPeriodEnd(${parameters})${result} {
  return subscriptionPeriod(subscription, 'current_period_end', planItem);
}
`,
    ],
    [
      INVOICE_SUBSCRIPTION_HELPER,
      `${
        typed
          ? `// Typed like the removed field under old stripe types, like the new location under new ones.
type InvoiceSubscription<T> = T extends { subscription: infer S }
  ? S
  : T extends { parent: infer P }
    ? NonNullable<P> extends { subscription_details: infer D }
      ? NonNullable<D> extends { subscription: infer S }
        ? S | null
        : string | null
      : string | null
    : string | null;

`
          : ''
      }// The old top-level field when present (old-version payloads), otherwise the new location.
${exported}function getInvoiceSubscription${typed ? '<T extends object>(invoice: T): InvoiceSubscription<T>' : '(invoice)'} {
  const legacy${t(': unknown')} = Reflect.get(invoice, 'subscription');
  const parent${t(': unknown')} = Reflect.get(invoice, 'parent');
  const details${t(': unknown')} =
    parent && typeof parent === 'object' ? Reflect.get(parent, 'subscription_details') : undefined;
  const moved${t(': unknown')} =
    details && typeof details === 'object' ? Reflect.get(details, 'subscription') : undefined;
  return (legacy !== undefined ? legacy : (moved ?? null))${typed ? ' as InvoiceSubscription<T>' : ''};
}
`,
    ],
    [
      INVOICE_PRICE_ID_HELPER,
      `// The old Price object's ID when present (old-version payloads), otherwise the price at
// pricing.price_details: an ID, or a Price when expanded.
${exported}function getInvoicePriceId(line${t(': object')})${t(': string | undefined')} {
  const legacy${t(': unknown')} = Reflect.get(line, 'price');
  const pricing${t(': unknown')} = legacy === undefined ? Reflect.get(line, 'pricing') : undefined;
  const details${t(': unknown')} =
    pricing && typeof pricing === 'object' && Reflect.get(pricing, 'type') === 'price_details'
      ? Reflect.get(pricing, 'price_details')
      : undefined;
  const price${t(': unknown')} =
    legacy !== undefined ? legacy : details && typeof details === 'object' ? Reflect.get(details, 'price') : undefined;
  const id${t(': unknown')} = price && typeof price === 'object' ? Reflect.get(price, 'id') : price;
  return typeof id === 'string' ? id : undefined;
}
`,
    ],
    [
      CHECKOUT_SHIPPING_HELPER,
      `${
        typed
          ? `// Typed like the removed field under old stripe types, like the new location under new ones.
type CheckoutShippingDetails<T> = T extends { shipping_details: infer S }
  ? S
  : T extends { collected_information: infer C }
    ? NonNullable<C> extends { shipping_details: infer S }
      ? S | null
      : null
    : null;

`
          : ''
      }// The old top-level field when present (old-version payloads), otherwise
// collected_information.shipping_details, which holds only address and name.
${exported}function getCheckoutShippingDetails${typed ? '<T extends object>(session: T): CheckoutShippingDetails<T>' : '(session)'} {
  const legacy${t(': unknown')} = Reflect.get(session, 'shipping_details');
  const collected${t(': unknown')} = Reflect.get(session, 'collected_information');
  const moved${t(': unknown')} =
    collected && typeof collected === 'object' ? Reflect.get(collected, 'shipping_details') : undefined;
  return (legacy !== undefined ? legacy : (moved ?? null))${typed ? ' as CheckoutShippingDetails<T>' : ''};
}
`,
    ],
    [
      COUPON_ID_HELPER,
      `// The old auto-expanded Coupon's ID when present (old-version payloads), otherwise the coupon a
// promotion code's promotion or a discount's source holds: an ID, or a Coupon when expanded.
${exported}function getCouponId(value${t(': object')})${t(': string | undefined')} {
  const legacy${t(': unknown')} = Reflect.get(value, 'coupon');
  const holder${t(': unknown')} =
    legacy === undefined ? (Reflect.get(value, 'promotion') ?? Reflect.get(value, 'source')) : undefined;
  const moved${t(': unknown')} =
    holder && typeof holder === 'object' && Reflect.get(holder, 'type') === 'coupon'
      ? Reflect.get(holder, 'coupon')
      : undefined;
  const coupon${t(': unknown')} = legacy !== undefined ? legacy : moved;
  const id${t(': unknown')} = coupon && typeof coupon === 'object' ? Reflect.get(coupon, 'id') : coupon;
  return typeof id === 'string' ? id : undefined;
}
`,
    ],
    [
      PRODUCT_FEATURES_HELPER,
      `${
        typed
          ? `// Typed like the removed field under old stripe types, like the new name under new ones.
type ProductMarketingFeatures<T> = T extends { features: infer F }
  ? F
  : T extends { marketing_features: infer M }
    ? M
    : { name?: string }[];

`
          : ''
      }// The old features list when present (old-version payloads), otherwise marketing_features.
${exported}function getProductMarketingFeatures${typed ? '<T extends object>(product: T): ProductMarketingFeatures<T>' : '(product)'} {
  const legacy${t(': unknown')} = Reflect.get(product, 'features');
  return (legacy !== undefined ? legacy : Reflect.get(product, 'marketing_features'))${typed ? ' as ProductMarketingFeatures<T>' : ''};
}
`,
    ],
  ];
  const emitted = sections.filter(([name]) => helpers.includes(name));
  const periods = Object.values(PERIOD_HELPERS).some((name) => helpers.includes(name));
  return `${[...(periods ? [HELPER_BODY(typed)] : []), ...emitted.map(([, text]) => text)].join('\n')}${
    kind === 'cjs' && !inline
      ? `\nmodule.exports = { ${emitted.map(([name]) => name).join(', ')} };\n`
      : ''
  }`;
}
