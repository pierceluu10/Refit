import { readFileSync } from 'node:fs';
import ts from 'typescript-compiler';
import { resolvableComponentSchema } from './specifications.ts';

// Stripe object types that application code states explicitly: `Stripe.*` type annotations and
// assertions. These are declared-type hints; signed webhook tracing is handled separately. Types map to
// contract schemas through pipeline/stripe-sdk-metadata.json, generated from Stripe's SDK spec.

const metadata = JSON.parse(
  readFileSync(new URL('./stripe-sdk-metadata.json', import.meta.url), 'utf8'),
) as { classes: Record<string, string> };

type Resolve = (node: ts.Node) => ts.Symbol | undefined;

function unwrap(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isAwaitExpression(expression)
    ? unwrap(expression.expression)
    : expression;
}

function qualifiedParts(name: ts.EntityName): ts.Identifier[] {
  return ts.isIdentifier(name) ? [name] : [...qualifiedParts(name.left), name.right];
}

export class StripeTypes {
  private readonly namespaces = new Set<ts.Symbol>();
  readonly typed = new Map<ts.Symbol, string>();
  readonly typedArrays = new Map<ts.Symbol, string>();
  private readonly returns = new Map<ts.Symbol, string>();

  constructor(
    nodes: ts.Node[],
    private readonly symbol: Resolve,
    private readonly schemas: Record<string, unknown>,
    packageName: string,
  ) {
    // `Stripe` (or any local name) bound to the stripe package by import or require.
    for (const node of nodes) {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === packageName &&
        node.importClause
      ) {
        const clause = node.importClause;
        if (clause.name) this.addNamespace(clause.name);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) this.addNamespace(bindings.name);
        if (bindings && ts.isNamedImports(bindings))
          for (const element of bindings.elements)
            if ((element.propertyName ?? element.name).text === 'Stripe')
              this.addNamespace(element.name);
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === 'require' &&
        node.initializer.arguments.length === 1 &&
        ts.isStringLiteralLike(node.initializer.arguments[0]) &&
        node.initializer.arguments[0].text === packageName
      )
        this.addNamespace(node.name);
    }
    for (const node of nodes) {
      if (!(ts.isVariableDeclaration(node) || ts.isParameter(node)) || !ts.isIdentifier(node.name))
        continue;
      const target = this.symbol(node.name);
      if (!target) continue;
      const schema = node.type ? this.typeSchema(node.type) : undefined;
      if (schema) this.typed.set(target, schema);
      const item = node.type ? this.arrayTypeSchema(node.type) : undefined;
      if (item) this.typedArrays.set(target, item);
    }
    // Functions declared to return a Stripe object: `(): Promise<Stripe.Subscription | null>`.
    for (const node of nodes) {
      const name =
        ts.isFunctionDeclaration(node) && node.name
          ? node.name
          : ts.isVariableDeclaration(node) &&
              ts.isIdentifier(node.name) &&
              node.initializer &&
              (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
            ? node.name
            : undefined;
      const fn = ts.isFunctionDeclaration(node)
        ? node
        : ts.isVariableDeclaration(node) &&
            node.initializer &&
            (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
          ? node.initializer
          : undefined;
      const target = name ? this.symbol(name) : undefined;
      const schema = fn?.type ? this.typeSchema(fn.type) : undefined;
      if (target && schema) this.returns.set(target, schema);
    }
    // `const session = event.data.object` or `let sub = x as Stripe.Subscription`, when never
    // reassigned, holds that object for every later read.
    const reassigned = new Set<ts.Symbol>();
    for (const node of nodes)
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        const target = this.symbol(node.left);
        if (target) reassigned.add(target);
      }
    for (const node of nodes) {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer)
        continue;
      const target = this.symbol(node.name);
      if (!target || reassigned.has(target) || this.typed.has(target)) continue;
      const schema = this.expressionSchema(node.initializer);
      if (schema) this.typed.set(target, schema);
    }
  }

  // The object an expression is stated to be: a `Stripe.*` assertion or a narrowed event object.
  expressionSchema(expression: ts.Expression): string | undefined {
    const value = ts.isParenthesizedExpression(expression) ? expression.expression : expression;
    if (
      ts.isAsExpression(value) ||
      ts.isTypeAssertionExpression(value) ||
      ts.isSatisfiesExpression(value)
    )
      return this.typeSchema(value.type) ?? this.expressionSchema(value.expression);
    const call = unwrap(value);
    if (ts.isCallExpression(call) && ts.isIdentifier(call.expression)) {
      const callee = this.symbol(call.expression);
      const schema = callee ? this.returns.get(callee) : undefined;
      if (schema) return schema;
    }
    return undefined;
  }

  // `Stripe.Subscription[]`, `readonly Stripe.Invoice[]`, `Array<Stripe.Price>`.
  arrayTypeSchema(type: ts.TypeNode): string | undefined {
    if (ts.isParenthesizedTypeNode(type)) return this.arrayTypeSchema(type.type);
    if (ts.isTypeOperatorNode(type)) return this.arrayTypeSchema(type.type);
    if (ts.isArrayTypeNode(type)) return this.typeSchema(type.elementType);
    if (
      ts.isTypeReferenceNode(type) &&
      ts.isIdentifier(type.typeName) &&
      ['Array', 'ReadonlyArray'].includes(type.typeName.text) &&
      type.typeArguments?.length === 1
    )
      return this.typeSchema(type.typeArguments[0]);
    return undefined;
  }

  private addNamespace(name: ts.Identifier) {
    const target = this.symbol(name);
    if (target) this.namespaces.add(target);
  }

  private known(schema: string | undefined) {
    return typeof schema === 'string'
      ? (resolvableComponentSchema(this.schemas, schema) ?? schema)
      : undefined;
  }

  // `Stripe.Subscription`, `Stripe.Checkout.Session`, `Stripe.Subscription | null`,
  // `Stripe.Response<Stripe.Invoice>`; undefined for anything else or for ambiguous unions.
  typeSchema(type: ts.TypeNode): string | undefined {
    if (ts.isParenthesizedTypeNode(type)) return this.typeSchema(type.type);
    if (ts.isUnionTypeNode(type)) {
      const members = type.types.filter(
        (member) =>
          !(
            member.kind === ts.SyntaxKind.NullKeyword ||
            member.kind === ts.SyntaxKind.UndefinedKeyword ||
            (ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword)
          ),
      );
      const schemas = new Set(members.map((member) => this.typeSchema(member)));
      return schemas.size === 1 ? [...schemas][0] : undefined;
    }
    if (!ts.isTypeReferenceNode(type)) return undefined;
    if (
      ts.isIdentifier(type.typeName) &&
      type.typeName.text === 'Promise' &&
      type.typeArguments?.length === 1
    )
      return this.typeSchema(type.typeArguments[0]);
    const parts = qualifiedParts(type.typeName);
    const root = this.symbol(parts[0]);
    if (parts.length < 2 || !root || !this.namespaces.has(root)) return undefined;
    const name = parts
      .slice(1)
      .map((part) => part.text)
      .join('.');
    if (name === 'Response' && type.typeArguments?.length === 1)
      return this.typeSchema(type.typeArguments[0]);
    return this.known(metadata.classes[name]);
  }
}
