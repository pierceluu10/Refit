import ts from 'typescript-compiler';
import { componentReference, isObject, resolvableComponentSchema } from './specifications.ts';
import { PipelineInputError, type Finding, type Removal, type SourceEdit } from './types.ts';
import type { stripeWebhookPayloads } from './stripe-webhook-payloads.ts';
import { movedReadEdit } from './stripe-field-moves.ts';

export interface StripeSubscriptionPeriodPolicy {
  priceId: string;
  beforeApiVersion: string;
  afterApiVersion: string;
}

export const SUBSCRIPTION_PERIOD_RULE = 'stripe-subscription-periods-price-id';
export const SUBSCRIPTION_PERIOD_ITEMS_RULE = 'stripe-subscription-periods-items';
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

// SDK responses and Stripe.Subscription values follow the outgoing apiVersion, which the same patch
// bumps; signed webhook payloads keep their endpoint's version and stay with the price-ID policy.
// When items share one billing period this equals the old subscription-level value; otherwise it
// is the widest period (earliest start, latest end).
export function subscriptionPeriodReadEdit(node: ts.Node, file: string, changeId: string) {
  if (!ts.isPropertyAccessExpression(node)) return;
  const field = node.name.text;
  if (field !== PERIOD_FIELDS[0] && field !== PERIOD_FIELDS[1]) return;
  const aggregate = field === PERIOD_FIELDS[0] ? 'min' : 'max';
  return movedReadEdit(
    node,
    file,
    changeId,
    SUBSCRIPTION_PERIOD_ITEMS_RULE,
    (subscription) =>
      `Math.${aggregate}(...${subscription}.items.data.map((item) => item.${field}))`,
  );
}
