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
export const SUBSCRIPTION_PERIOD_HELPER_RULE = 'stripe-subscription-periods-helper';
export const INVOICE_SUBSCRIPTION_HELPER_RULE = 'stripe-invoice-subscription-helper';
export const INVOICE_PRICE_ID_HELPER_RULE = 'stripe-invoice-price-id-helper';
export const CHECKOUT_SHIPPING_HELPER_RULE = 'stripe-checkout-shipping-details-helper';
export const COUPON_ID_HELPER_RULE = 'stripe-coupon-id-helper';
export const PRODUCT_FEATURES_HELPER_RULE = 'stripe-product-features-helper';
// Rules whose edits call the generated helper module.
export const HELPER_RULES = new Set<string>([
  SUBSCRIPTION_PERIOD_HELPER_RULE,
  INVOICE_SUBSCRIPTION_HELPER_RULE,
  INVOICE_PRICE_ID_HELPER_RULE,
  CHECKOUT_SHIPPING_HELPER_RULE,
  COUPON_ID_HELPER_RULE,
  PRODUCT_FEATURES_HELPER_RULE,
]);
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
// Fields of the old Shipping object that the new checkout address details no longer carry.
const DROPPED_SHIPPING_FIELDS = new Set(['carrier', 'phone', 'tracking_number']);
export type PeriodRareCase = 'item-in-code' | 'price-policy' | 'flagged';
type HelperLocal = { helper: string; rule: NonNullable<SourceEdit['rule']> };

// Replaces a period read with the generated helper; `plan` selects the item for subscriptions whose
// items have different periods.
export function subscriptionPeriodHelperEdit(
  node: ts.Node,
  file: string,
  changeId: string,
  plan: string | undefined,
) {
  if (!ts.isPropertyAccessExpression(node) || !Object.hasOwn(PERIOD_HELPERS, node.name.text))
    return;
  const helper = PERIOD_HELPERS[node.name.text as keyof typeof PERIOD_HELPERS];
  return movedReadEdit(
    node,
    file,
    changeId,
    SUBSCRIPTION_PERIOD_HELPER_RULE,
    (subscription) => `${helper}(${subscription}${plan ? `, ${plan}` : ''})`,
  );
}

// Replaces an `invoice.subscription` read, which moved to `parent.subscription_details.subscription`.
export function invoiceSubscriptionHelperEdit(
  node: ts.Node,
  file: string,
  changeId: string,
): SourceEdit[] | undefined {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'subscription') return;
  const local: HelperLocal = {
    helper: INVOICE_SUBSCRIPTION_HELPER,
    rule: INVOICE_SUBSCRIPTION_HELPER_RULE,
  };
  // Plain JavaScript does not narrow, so each read can call the helper.
  if (/\.[cm]?tsx?$/.test(file) && typeofGuarded(node)) {
    const scoped = receiverReads(node);
    return scoped && localReadEdits(node, scoped, file, changeId, local);
  }
  const hoisted = narrowedReadEdits(node, file, changeId, local);
  if (hoisted) return hoisted;
  const edit = movedReadEdit(
    node,
    file,
    changeId,
    INVOICE_SUBSCRIPTION_HELPER_RULE,
    (invoice) => `${INVOICE_SUBSCRIPTION_HELPER}(${invoice})`,
  );
  return edit && [edit];
}

// `typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription.id`
// narrows the field for the reads it guards; separate helper calls would not be narrowed, so the
// patched code would not compile.
function typeofGuarded(read: ts.PropertyAccessExpression) {
  const text = read.getText();
  let scope: ts.Node = read;
  while (!ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)
      ? unwrap(node.expression)
      : node;
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isTypeOfExpression(node) && unwrap(node.expression).getText() === text) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

// A truthiness, null or typeof test of the read or of a member chain on it (`if (x.f)`,
// `x.f?.address ? x.f.name : ''`, `!x.f`, `x.f && …`, `x.f === null`), which narrows later reads.
function tested(read: ts.Expression) {
  let node: ts.Node = read;
  for (;;) {
    const parent = node.parent;
    if (
      (ts.isPropertyAccessExpression(parent) && parent.expression === node) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent)
    ) {
      node = parent;
      continue;
    }
    if (ts.isTypeOfExpression(parent)) return true;
    if (ts.isPrefixUnaryExpression(parent))
      return parent.operator === ts.SyntaxKind.ExclamationToken;
    if (ts.isBinaryExpression(parent)) {
      const operator = parent.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.AmpersandAmpersandToken ||
        operator === ts.SyntaxKind.BarBarToken
      ) {
        if (parent.left === node) return true;
        node = parent;
        continue;
      }
      return [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(operator);
    }
    return (
      ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) &&
        parent.expression === node) ||
      (ts.isForStatement(parent) && parent.condition === node) ||
      (ts.isConditionalExpression(parent) && parent.condition === node)
    );
  }
}

// TypeScript narrows a tested field for the reads after the test, but not separate helper calls, so
// `if (session.shipping_details) use(session.shipping_details.address)` would stop compiling. A
// test narrows reads in the block holding it (a case clause shares its switch's scope, so the block
// around the switch), so the reads in the largest such block around this read share one local,
// declared as `receiverReads` and `localReadEdits` allow; otherwise each read calls the helper.
function narrowedReadEdits(
  read: ts.PropertyAccessExpression,
  file: string,
  changeId: string,
  local: HelperLocal,
  keep: (read: ts.PropertyAccessExpression) => boolean = () => true,
) {
  if (!/\.[cm]?tsx?$/.test(file)) return;
  const scoped = receiverReads(read);
  if (!scoped) return;
  const within = (node: ts.Node, outer: ts.Node) =>
    outer.getStart() <= node.getStart() && node.getEnd() <= outer.getEnd();
  let region: ts.Node | undefined;
  for (const test of scoped.reads.filter(tested)) {
    let block: ts.Node = test.parent;
    while (
      !ts.isBlock(block) &&
      !ts.isSourceFile(block) &&
      !(ts.isCaseClause(block) && block === scoped.scope)
    )
      block = block.parent;
    if (within(read, block) && (!region || within(region, block))) region = block;
  }
  const reads = region ? scoped.reads.filter((node) => within(node, region)) : [];
  if (reads.length < 2 || !reads.every(keep)) return;
  return localReadEdits(read, { reads, scope: scoped.scope }, file, changeId, local);
}

// Every read of `receiver.field` in the block, loop or function that declares the receiver once,
// as a parameter or a `const`, or none when the receiver or the field is written there.
function receiverReads(read: ts.PropertyAccessExpression) {
  const receiver = read.expression;
  if (!ts.isIdentifier(receiver)) return;
  const declares = (node: ts.Node) =>
    (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
    ts.isIdentifier(node.name) &&
    node.name.text === receiver.text;
  let scope: ts.Node | undefined = read.parent;
  while (scope && !scopeDeclares(scope, declares)) scope = scope.parent;
  if (!scope) return;
  const text = read.getText();
  const reads: ts.PropertyAccessExpression[] = [];
  let declarations = 0;
  let constant = true;
  let written = false;
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)
      ? unwrap(node.expression)
      : node;
  // The receiver, the field, or a computed member of the receiver that may be the field.
  const writes = (target: ts.Expression) => {
    const value = unwrap(target);
    if (value.getText() === receiver.text) return true;
    if (!ts.isPropertyAccessExpression(value) && !ts.isElementAccessExpression(value)) return false;
    if (unwrap(value.expression).getText() !== receiver.text) return false;
    return ts.isPropertyAccessExpression(value)
      ? value.name.text === read.name.text
      : !ts.isStringLiteralLike(value.argumentExpression) ||
          value.argumentExpression.text === read.name.text;
  };
  const visit = (node: ts.Node) => {
    if (declares(node)) {
      declarations++;
      if (
        ts.isVariableDeclaration(node) &&
        !(ts.isVariableDeclarationList(node.parent) && node.parent.flags & ts.NodeFlags.Const)
      )
        constant = false;
    }
    if (ts.isPropertyAccessExpression(node) && node.getText() === text) reads.push(node);
    const target =
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        ? node.left
        : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
            (node.operator === ts.SyntaxKind.PlusPlusToken ||
              node.operator === ts.SyntaxKind.MinusMinusToken)
          ? node.operand
          : ts.isDeleteExpression(node)
            ? node.expression
            : undefined;
    if (target && writes(target)) written = true;
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return declarations === 1 && constant && !written ? { reads, scope } : undefined;
}

function scopeDeclares(scope: ts.Node, declares: (node: ts.Node) => boolean) {
  if (ts.isFunctionLike(scope)) return scope.parameters.some(declares);
  if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isCaseClause(scope))
    return scope.statements.some(
      (statement) =>
        ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declares),
    );
  if (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope))
    return (
      !!scope.initializer &&
      ts.isVariableDeclarationList(scope.initializer) &&
      scope.initializer.declarations.some(declares)
    );
  return false;
}

// One local that every read uses narrows like the field did. It is declared before the statement
// holding the first read, in the innermost block of the receiver's scope holding them all, and is
// named after the receiver (`invoiceSubscription`, `sessionShippingDetails`), so locals for two
// receivers in one block never clash. Not when the receiver itself is used between the
// declaration and the last read (`await save(session)`), since that call could change the field.
// shortcut: a call can still change the field through an alias made before the declaration;
// upgrade if a repository mutates payloads that way.
function localReadEdits(
  read: ts.PropertyAccessExpression,
  { reads, scope }: { reads: ts.PropertyAccessExpression[]; scope: ts.Node },
  file: string,
  changeId: string,
  { helper, rule }: HelperLocal,
): SourceEdit[] | undefined {
  if (reads.some((node) => node.questionDotToken)) return;
  const source = read.getSourceFile();
  const first = reads.reduce((left, right) => (right.getStart() < left.getStart() ? right : left));
  const last = reads.reduce((left, right) => (right.getEnd() > left.getEnd() ? right : left));
  let anchor: ts.Node = first;
  while (
    anchor.parent &&
    !(
      (ts.isBlock(anchor.parent) ||
        ts.isSourceFile(anchor.parent) ||
        ts.isCaseClause(anchor.parent)) &&
      reads.every(
        (node) =>
          anchor.parent.getStart() <= node.getStart() && node.getEnd() <= anchor.parent.getEnd(),
      )
    )
  )
    anchor = anchor.parent;
  const declaration = read.expression.getText();
  const lineStart = source.text.lastIndexOf('\n', anchor.getStart()) + 1;
  const indentation = source.text.slice(lineStart, anchor.getStart());
  if (
    !anchor.parent ||
    anchor.parent.getStart() < scope.getStart() ||
    anchor.parent.getEnd() > scope.getEnd() ||
    anchor.getStart() === first.getStart() ||
    /\S/.test(indentation) ||
    (ts.isVariableStatement(anchor) &&
      anchor.declarationList.declarations.some(
        (entry) => ts.isIdentifier(entry.name) && entry.name.text === declaration,
      ))
  )
    return;
  let escapes = false;
  const visit = (node: ts.Node) => {
    if (escapes || node.getEnd() <= anchor.getStart() || node.getStart() >= last.getEnd()) return;
    if (
      ts.isIdentifier(node) &&
      node.text === declaration &&
      !(
        (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node
      ) &&
      !(
        (ts.isPropertyAccessExpression(node.parent) || ts.isPropertyAssignment(node.parent)) &&
        node.parent.name === node
      )
    )
      escapes = true;
    ts.forEachChild(node, visit);
  };
  visit(anchor.parent);
  if (escapes) return;
  const field = read.name.text.replace(/_(\w)/g, (_match, letter: string) => letter.toUpperCase());
  const base = `${declaration}${field[0].toUpperCase()}${field.slice(1)}`;
  let name = base;
  for (let suffix = 2; new RegExp(`\\b${name}\\b`).test(source.text); suffix++)
    name = `${base}${suffix}`;
  const imports = source.statements.filter(ts.isImportDeclaration);
  const semicolon = !imports.length || imports[0].getText().endsWith(';') ? ';' : '';
  const newline = source.text.includes('\r\n') ? '\r\n' : '\n';
  return [
    {
      file,
      start: anchor.getStart(),
      end: anchor.getStart(),
      replacement: `const ${name} = ${helper}(${declaration})${semicolon}${newline}${indentation}`,
      changeId,
      rule,
    },
    {
      file,
      start: read.getStart(),
      end: read.getEnd(),
      replacement: name,
      changeId,
      rule,
    },
  ];
}

// Replaces a `line.price.id` read on an invoice line item or invoice item: the Price object moved to
// `pricing.price_details.price`, which holds its ID. Other `price` reads need the full Price.
export function invoicePriceIdHelperEdit(node: ts.Node, file: string, changeId: string) {
  const read = node.parent;
  if (
    !ts.isPropertyAccessExpression(node) ||
    node.name.text !== 'price' ||
    !ts.isPropertyAccessExpression(read) ||
    read.expression !== node ||
    read.name.text !== 'id' ||
    // `line.price?.id.length` short-circuits on a missing price; the helper result would not.
    ((read.questionDotToken || node.questionDotToken) &&
      (ts.isPropertyAccessExpression(read.parent) ||
        ts.isElementAccessExpression(read.parent) ||
        ts.isCallExpression(read.parent)) &&
      read.parent.expression === read)
  )
    return;
  const edit = movedReadEdit(
    node,
    file,
    changeId,
    INVOICE_PRICE_ID_HELPER_RULE,
    (line) => `${INVOICE_PRICE_ID_HELPER}(${line})`,
  );
  return edit && { ...edit, end: read.getEnd() };
}

// Replaces `promotionCode.coupon.id` and `discount.coupon.id`: clover moved the auto-expanded
// Coupon to `promotion.coupon` and `source.coupon`, an ID unless expanded. Other Coupon fields need
// an expand or coupons.retrieve and stay with review. Sources, read 2026-10-22:
// https://docs.stripe.com/changelog/clover/2025-09-30/polymorphic-coupon and
// https://docs.stripe.com/changelog/clover/2025-09-30/add-discount-source-property
export function couponIdHelperEdit(node: ts.Node, file: string, changeId: string) {
  const read = node.parent;
  if (
    !ts.isPropertyAccessExpression(node) ||
    node.name.text !== 'coupon' ||
    !ts.isPropertyAccessExpression(read) ||
    read.expression !== node ||
    read.name.text !== 'id' ||
    // `discount.coupon?.id.length` short-circuits on a missing coupon; the helper result would not.
    ((read.questionDotToken || node.questionDotToken) &&
      (ts.isPropertyAccessExpression(read.parent) ||
        ts.isElementAccessExpression(read.parent) ||
        ts.isCallExpression(read.parent)) &&
      read.parent.expression === read)
  )
    return;
  const edit = movedReadEdit(
    node,
    file,
    changeId,
    COUPON_ID_HELPER_RULE,
    (value) => `${COUPON_ID_HELPER}(${value})`,
  );
  return edit && { ...edit, end: read.getEnd() };
}

// Replaces a product `features` read: 2024-04-10 renamed it `marketing_features`, the same list of
// named features. Writes stay with review. Source, read 2026-10-22:
// https://docs.stripe.com/changelog/2024-04-10/renames-features-attribute-product-object
export function productFeaturesHelperEdit(node: ts.Node, file: string, changeId: string) {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'features') return;
  const parent = node.parent;
  if (
    (ts.isBinaryExpression(parent) &&
      parent.left === node &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
    ts.isDeleteExpression(parent)
  )
    return;
  return movedReadEdit(
    node,
    file,
    changeId,
    PRODUCT_FEATURES_HELPER_RULE,
    (product) => `${PRODUCT_FEATURES_HELPER}(${product})`,
  );
}

// Replaces a Checkout Session `shipping_details` read, which moved to
// `collected_information.shipping_details`. Its new object holds only `address` and `name`, so a
// read of `carrier`, `phone` or `tracking_number` stays with review. Source, read 2026-10-24:
// https://docs.stripe.com/changelog/basil/2025-03-31/checkout-session-remove-shipping-details
export function checkoutShippingHelperEdit(
  node: ts.Node,
  file: string,
  changeId: string,
): SourceEdit[] | undefined {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'shipping_details') return;
  const dropped = (read: ts.PropertyAccessExpression) =>
    ts.isPropertyAccessExpression(read.parent) &&
    read.parent.expression === read &&
    DROPPED_SHIPPING_FIELDS.has(read.parent.name.text);
  if (dropped(node)) return;
  const hoisted = narrowedReadEdits(
    node,
    file,
    changeId,
    { helper: CHECKOUT_SHIPPING_HELPER, rule: CHECKOUT_SHIPPING_HELPER_RULE },
    (read) => !dropped(read),
  );
  if (hoisted) return hoisted;
  const edit = movedReadEdit(
    node,
    file,
    changeId,
    CHECKOUT_SHIPPING_HELPER_RULE,
    (session) => `${CHECKOUT_SHIPPING_HELPER}(${session})`,
  );
  return edit && [edit];
}

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

export function subscriptionPeriodHelperModule(kind: 'ts' | 'esm' | 'cjs') {
  const typed = kind === 'ts';
  const t = (annotation: string) => (typed ? annotation : '');
  const exported = kind === 'cjs' ? '' : 'export ';
  const parameters = typed ? 'subscription: object, planItem?: PlanItem' : 'subscription, planItem';
  const result = typed ? ': number' : '';
  return `${HELPER_BODY(typed)}
${exported}function getSubscriptionPeriodStart(${parameters})${result} {
  return subscriptionPeriod(subscription, 'current_period_start', planItem);
}

${exported}function getSubscriptionPeriodEnd(${parameters})${result} {
  return subscriptionPeriod(subscription, 'current_period_end', planItem);
}

${
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

// The old Price object's ID when present (old-version payloads), otherwise the price at
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

${
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

// The old auto-expanded Coupon's ID when present (old-version payloads), otherwise the coupon a
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

${
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
${kind === 'cjs' ? '\nmodule.exports = { getSubscriptionPeriodStart, getSubscriptionPeriodEnd, getInvoiceSubscription, getInvoicePriceId, getCheckoutShippingDetails, getCouponId, getProductMarketingFeatures };\n' : ''}`;
}
