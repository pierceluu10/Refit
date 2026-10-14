import ts from 'typescript-compiler';
import { resolvableComponentSchema } from './specifications.ts';
import type { Location } from './types.ts';

// Snapshot event mappings from stripe-node v19.1.0 types/EventTypes.d.ts.
const EVENT_SCHEMAS: Record<string, string> = Object.fromEntries([
  ...[
    'created',
    'updated',
    'deleted',
    'paused',
    'resumed',
    'trial_will_end',
    'pending_update_applied',
    'pending_update_expired',
  ].map((name) => [`customer.subscription.${name}`, 'subscription']),
  ...[
    'created',
    'succeeded',
    'payment_failed',
    'canceled',
    'processing',
    'requires_action',
    'amount_capturable_updated',
    'partially_funded',
  ].map((name) => [`payment_intent.${name}`, 'payment_intent']),
  ...[
    'created',
    'updated',
    'deleted',
    'finalized',
    'finalization_failed',
    'paid',
    'payment_failed',
    'payment_action_required',
    'payment_succeeded',
    'sent',
    'upcoming',
    'voided',
    'marked_uncollectible',
    'will_be_due',
  ].map((name) => [`invoice.${name}`, 'invoice']),
  ...['completed', 'expired', 'async_payment_succeeded', 'async_payment_failed'].map((name) => [
    `checkout.session.${name}`,
    'checkout.session',
  ]),
  ...['created', 'updated', 'deleted'].flatMap((name) => [
    ['product.' + name, 'product'],
    ['price.' + name, 'price'],
    ['customer.' + name, 'customer'],
  ]),
  ...['succeeded', 'failed', 'updated', 'captured', 'expired', 'refunded', 'pending'].map(
    (name) => ['charge.' + name, 'charge'],
  ),
]);
const CONSTRUCT_METHODS = new Set(['constructEvent', 'constructEventAsync']);
export function stripeWebhookConstructor(call: { resource: string; method: string } | undefined) {
  return Boolean(call && call.resource === 'webhooks' && CONSTRUCT_METHODS.has(call.method));
}
export const WEBHOOK_REVIEW_REASON =
  'Webhook payload reads require separate incoming API-version and migration-policy review. SDK request versions do not establish webhook versions; automatic patching, AI and publication are blocked.';

function unwrap(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
    ? unwrap(expression.expression)
    : expression;
}

function member(expression: ts.Expression) {
  const value = unwrap(expression);
  if (ts.isPropertyAccessExpression(value))
    return { owner: value.expression, name: value.name.text };
  if (ts.isElementAccessExpression(value) && ts.isStringLiteral(value.argumentExpression))
    return { owner: value.expression, name: value.argumentExpression.text };
}

function exits(node: ts.Node): boolean {
  if (ts.isBlock(node)) return Boolean(node.statements.length && exits(node.statements.at(-1)!));
  return (
    ts.isReturnStatement(node) ||
    ts.isThrowStatement(node) ||
    (ts.isBreakStatement(node) && !node.label)
  );
}

export function stripeWebhookPayloads(options: {
  nodes: ts.Node[];
  symbol: (node: ts.Node) => ts.Symbol | undefined;
  sdkCall: (node: ts.Node) => { resource: string; method: string; optional: boolean } | undefined;
  schemas: Record<string, unknown>;
  location: (node: ts.Node) => Location;
  iterationSource: (declaration: ts.Declaration) => ts.Expression | undefined;
}) {
  const { nodes, symbol, sdkCall, schemas, location } = options;
  const events = new Map<ts.Symbol, ts.CallExpression>();
  const unsafeEvents = new Set<ts.Symbol>();
  const initializations = new Set<ts.Node>();
  const writes = new Map<ts.Symbol, Array<{ value: ts.Expression; node: ts.Node }>>();
  function write(name: ts.Identifier, value: ts.Expression, node: ts.Node) {
    const binding = symbol(name);
    if (!binding) return;
    const entries = writes.get(binding) ?? [];
    entries.push({ value, node });
    writes.set(binding, entries);
  }
  for (const node of nodes) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      write(node.name, node.initializer, node);
    if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      write(node.left, node.right, node);
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
    )
      write(node.operand, node.operand, node);
  }
  for (const [binding, entries] of writes) {
    const declaration = binding.valueDeclaration;
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !ts.isVariableDeclarationList(declaration.parent)
    )
      continue;
    for (const entry of entries) {
      let value = unwrap(entry.value);
      const awaited = ts.isAwaitExpression(value);
      if (ts.isAwaitExpression(value)) value = unwrap(value.expression);
      const call = sdkCall(value);
      if (!ts.isCallExpression(value) || !call || !stripeWebhookConstructor(call)) continue;
      if (
        ts.isBinaryExpression(entry.node) &&
        (!ts.isExpressionStatement(entry.node.parent) ||
          entry.node.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
      )
        continue;
      events.set(binding, value);
      if (
        entries.length !== 1 ||
        call.optional ||
        (call.method === 'constructEventAsync' && !awaited) ||
        value.arguments.length < 3 ||
        value.arguments.some(ts.isSpreadElement)
      )
        unsafeEvents.add(binding);
      if (entries.length === 1 && ts.isBinaryExpression(entry.node))
        initializations.add(entry.node);
      break;
    }
  }
  function projection(
    expression: ts.Expression,
    seen = new Set<ts.Symbol>(),
  ): { binding: ts.Symbol; path: string[] } | undefined {
    const value = unwrap(expression);
    const access = member(value);
    if (access) {
      const owner = projection(access.owner, seen);
      return owner ? { ...owner, path: [...owner.path, access.name] } : undefined;
    }
    if (!ts.isIdentifier(value)) return;
    const binding = symbol(value);
    if (!binding || seen.has(binding)) return;
    if (events.has(binding)) return { binding, path: [] };
    let declaration = binding.valueDeclaration;
    const path: string[] = [];
    while (declaration && ts.isBindingElement(declaration)) {
      if (
        declaration.dotDotDotToken ||
        declaration.initializer ||
        !ts.isObjectBindingPattern(declaration.parent)
      )
        return;
      const name = declaration.propertyName ?? declaration.name;
      if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) return;
      path.unshift(name.text);
      declaration = declaration.parent.parent;
    }
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !declaration.initializer ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      !(declaration.parent.flags & ts.NodeFlags.Const)
    )
      return;
    const owner = projection(declaration.initializer, new Set([...seen, binding]));
    return owner ? { ...owner, path: [...owner.path, ...path] } : undefined;
  }
  function event(expression: ts.Expression) {
    const source = projection(expression);
    return source?.path.length === 0 ? source.binding : undefined;
  }
  function payloadEvent(expression: ts.Expression) {
    const source = projection(expression);
    return source?.path.length === 2 && source.path[0] === 'data' && source.path[1] === 'object'
      ? source.binding
      : undefined;
  }
  function typeEvent(expression: ts.Expression): ts.Symbol | undefined {
    const source = projection(expression);
    return source?.path.length === 1 && source.path[0] === 'type' ? source.binding : undefined;
  }
  function types(
    condition: ts.Expression,
    binding: ts.Symbol,
    positive: boolean,
  ): string[] | undefined {
    const value = unwrap(condition);
    if (!ts.isBinaryExpression(value)) return;
    if (positive && value.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      const left = types(value.left, binding, true),
        right = types(value.right, binding, true);
      return left && right ? [...left, ...right] : undefined;
    }
    if (positive && value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      const left = types(value.left, binding, true),
        right = types(value.right, binding, true);
      if (left && right) return left.filter((name) => right.includes(name));
      return left ?? right;
    }
    const expected = positive
      ? ts.SyntaxKind.EqualsEqualsEqualsToken
      : ts.SyntaxKind.ExclamationEqualsEqualsToken;
    if (value.operatorToken.kind !== expected) return;
    if (typeEvent(value.left) === binding && ts.isStringLiteral(value.right))
      return [value.right.text];
    if (typeEvent(value.right) === binding && ts.isStringLiteral(value.left))
      return [value.left.text];
  }
  function narrow(node: ts.Node, binding: ts.Symbol): string[] | undefined {
    let current = node;
    while (current.parent) {
      const parent = current.parent;
      if (ts.isIfStatement(parent)) {
        const names = types(parent.expression, binding, current === parent.thenStatement);
        if (names) return names;
      }
      if (
        ts.isCaseClause(parent) &&
        ts.isSwitchStatement(parent.parent.parent) &&
        typeEvent(parent.parent.parent.expression) === binding
      ) {
        const clauses = parent.parent.clauses;
        let index = clauses.indexOf(parent);
        const names: string[] = [];
        while (index >= 0) {
          const clause = clauses[index];
          if (!ts.isCaseClause(clause) || !ts.isStringLiteral(clause.expression)) return;
          names.push(clause.expression.text);
          if (index === 0) break;
          const previous = clauses[index - 1];
          if (previous.statements.length) {
            if (!exits(previous.statements.at(-1)!)) return;
            break;
          }
          index--;
        }
        return names;
      }
      if (ts.isBlock(parent)) {
        const index = parent.statements.indexOf(current as ts.Statement);
        for (const previous of (index < 0 ? [] : parent.statements.slice(0, index)).reverse()) {
          if (
            !ts.isIfStatement(previous) ||
            previous.elseStatement ||
            !exits(previous.thenStatement)
          )
            continue;
          const names = types(previous.expression, binding, false);
          if (names) return names;
        }
      }
      if (ts.isFunctionLike(parent)) return;
      current = parent;
    }
  }
  function mappedEvent(binding: ts.Symbol, expression: ts.Expression) {
    const eventTypes = narrow(expression, binding);
    if (!eventTypes?.length) return;
    const mapped = eventTypes.map((name) =>
      Object.hasOwn(EVENT_SCHEMAS, name) ? EVENT_SCHEMAS[name] : undefined,
    );
    const name = mapped[0];
    if (!name || !mapped.every((schema) => schema === name)) return;
    const resolved = resolvableComponentSchema(schemas, name);
    return {
      schema: resolved ?? name,
      contractResolved: Boolean(resolved),
      eventTypes: [...new Set(eventTypes)].sort(),
      binding,
      origin: location(events.get(binding)!),
    };
  }
  function mappedPayload(expression: ts.Expression) {
    const binding = payloadEvent(expression);
    return binding ? mappedEvent(binding, expression) : undefined;
  }
  function payload(expression: ts.Expression) {
    const mapped = mappedPayload(expression);
    return mapped?.contractResolved ? mapped : undefined;
  }
  function schema(expression: ts.Expression) {
    return mappedPayload(expression)?.schema;
  }
  function origin(
    expression: ts.Expression,
    seen = new Set<ts.Symbol>(),
  ):
    | {
        schema?: string;
        eventTypes: string[];
        binding: ts.Symbol;
        origin: Location;
      }
    | undefined {
    const snapshot = payload(expression);
    if (snapshot) return snapshot;
    const projected = projection(expression);
    const binding = projected?.binding;
    if (projected && projected.path[0] === 'data' && projected.path[1] === 'object') {
      const mapped = mappedEvent(projected.binding, expression);
      if (mapped?.contractResolved) return mapped;
    }
    if (binding)
      return {
        eventTypes: [...new Set(narrow(expression, binding) ?? [])].sort(),
        binding,
        origin: location(events.get(binding)!),
      };
    const value = unwrap(expression);
    if (ts.isIdentifier(value)) {
      const alias = symbol(value);
      if (!alias || seen.has(alias)) return;
      let declaration = alias.valueDeclaration;
      const iteration = declaration && options.iterationSource(declaration);
      if (iteration) return origin(iteration, new Set([...seen, alias]));
      while (declaration && ts.isBindingElement(declaration))
        declaration = declaration.parent.parent;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer)
        return origin(declaration.initializer, new Set([...seen, alias]));
    }
    const access = member(expression);
    const owner =
      access?.owner ?? (ts.isElementAccessExpression(value) ? value.expression : undefined);
    return owner ? origin(owner, seen) : undefined;
  }
  return { events, unsafeEvents, initializations, event, schema, origin };
}
