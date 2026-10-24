import ts from 'typescript-compiler';
import type { ApiVersionDeclaration } from './api-version.ts';
import { validateApiVersion } from './api-version.ts';
import { unsafeBindings, type BindingReferences } from './mutations.ts';
import type { ProviderAdapter } from './providers.ts';
import { PipelineInputError, type Location } from './types.ts';

type PropertyResult =
  { status: 'present'; expression: ts.Expression } | { status: 'absent' | 'unknown' };

export function declaredApiVersions(options: {
  nodes: ts.Node[];
  mutationNodes: ts.Node[];
  initialUnsafe: Set<ts.Symbol>;
  checker: ts.TypeChecker;
  provider: ProviderAdapter;
  clients: Set<ts.Symbol>;
  creation: (node: ts.Node) => ts.NewExpression | ts.CallExpression | undefined;
  constructorBinding: (node: ts.NewExpression | ts.CallExpression) => ts.Symbol | undefined;
  clientBinding: (node: ts.Node) => ts.Symbol | undefined;
  sdkCall: (node: ts.Node) => { client: ts.Expression; optional: boolean } | undefined;
  symbol: (node: ts.Node) => ts.Symbol | undefined;
  canonical: (symbol: ts.Symbol | undefined) => ts.Symbol | undefined;
  location: (node: ts.Node) => Location;
  references?: BindingReferences;
  // Receives the text span of each literal version, for a patch that bumps it.
  literals?: { file: string; start: number; end: number; value: string }[];
}): ApiVersionDeclaration[] {
  const mapping = options.provider.apiVersion;
  if (!mapping) return [];
  const { nodes, checker, clients, symbol, canonical, location } = options;
  // These recorded option consumers do not expose the options to an unknown application function.
  let unsafe = new Set<ts.Symbol>();
  function unwrap(expression: ts.Expression): ts.Expression {
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    )
      return unwrap(expression.expression);
    return expression;
  }
  function resolve(
    expression: ts.Expression,
    seen = new Set<ts.Symbol>(),
  ): ts.Expression | undefined {
    const current = unwrap(expression);
    if (ts.isIdentifier(current)) return resolveBinding(symbol(current), seen);
    if (ts.isPropertyAccessExpression(current)) {
      const result = property(current.expression, [current.name.text], seen);
      return result.status === 'present' ? resolve(result.expression, seen) : undefined;
    }
    if (
      ts.isObjectLiteralExpression(current) ||
      ts.isStringLiteral(current) ||
      ts.isNoSubstitutionTemplateLiteral(current)
    )
      return current;
    return undefined;
  }
  function resolveBinding(
    binding: ts.Symbol | undefined,
    seen: Set<ts.Symbol>,
  ): ts.Expression | undefined {
    if (!binding || seen.has(binding)) return undefined;
    const declaration = binding.valueDeclaration;
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !declaration.initializer ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      !(declaration.parent.flags & ts.NodeFlags.Const)
    )
      return undefined;
    const value = resolve(declaration.initializer, new Set([...seen, binding]));
    return value &&
      ts.isObjectLiteralExpression(value) &&
      unsafe.has(binding) &&
      !onlyCopied(binding, declaration)
      ? undefined
      : value;
  }
  // The global `undefined`, not a local binding that shadows it.
  function undefinedValue(expression: ts.Expression) {
    const value = unwrap(expression);
    return ts.isIdentifier(value) && value.text === 'undefined' && !symbol(value)?.valueDeclaration;
  }
  function property(
    expression: ts.Expression,
    path: string[],
    seen = new Set<ts.Symbol>(),
  ): PropertyResult {
    // `account ? { stripeAccount: account } : undefined` sets nothing unless a branch does.
    const current = unwrap(expression);
    if (ts.isConditionalExpression(current)) {
      const branches = [current.whenTrue, current.whenFalse].map((branch) => {
        return undefinedValue(branch)
          ? ({ status: 'absent' } as const)
          : property(branch, path, seen);
      });
      return branches.every((branch) => branch.status === 'absent')
        ? { status: 'absent' }
        : { status: 'unknown' };
    }
    const object = resolve(expression, seen);
    if (!object || !ts.isObjectLiteralExpression(object)) return { status: 'unknown' };
    const candidates = object.properties.filter((entry) => {
      if (ts.isSpreadAssignment(entry))
        return spreadProperty(entry.expression, path, seen).status !== 'absent';
      if (ts.isComputedPropertyName(entry.name)) return true;
      return (
        entry.name &&
        (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) &&
        entry.name.text === path[0]
      );
    });
    if (!candidates.length) return { status: 'absent' };
    if (candidates.length !== 1) return { status: 'unknown' };
    const entry = candidates[0];
    let value: ts.Expression | undefined;
    if (ts.isPropertyAssignment(entry) && !ts.isComputedPropertyName(entry.name))
      value = entry.initializer;
    if (ts.isShorthandPropertyAssignment(entry) && !entry.objectAssignmentInitializer)
      value = resolveBinding(canonical(checker.getShorthandAssignmentValueSymbol(entry)), seen);
    if (!value) return { status: 'unknown' };
    return path.length === 1
      ? { status: 'present', expression: value }
      : property(value, path.slice(1), seen);
  }
  // `{ ...price(plan), proration_behavior }`: a spread of a const object, or of a call to a
  // local function whose every return is an object literal, adds only the keys spelled out.
  function spreadProperty(
    expression: ts.Expression,
    path: string[],
    seen: Set<ts.Symbol>,
  ): PropertyResult {
    let current = unwrap(expression);
    if (ts.isIdentifier(current)) {
      const binding = symbol(current);
      const declaration = binding?.valueDeclaration;
      if (
        binding &&
        !seen.has(binding) &&
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        ts.isVariableDeclarationList(declaration.parent) &&
        declaration.parent.flags & ts.NodeFlags.Const &&
        ts.isCallExpression(unwrap(declaration.initializer)) &&
        onlyCopied(binding, declaration)
      ) {
        seen = new Set([...seen, binding]);
        current = unwrap(declaration.initializer);
      }
    }
    if (!ts.isCallExpression(current)) return property(current, path, seen);
    const callee = unwrap(current.expression);
    const binding = ts.isIdentifier(callee) ? symbol(callee) : undefined;
    const returned = binding && !seen.has(binding) ? returnedValues(binding) : undefined;
    if (!returned) return { status: 'unknown' };
    const inner = new Set([...seen, binding!]);
    return returned.every((value) => property(value, path, inner).status === 'absent')
      ? { status: 'absent' }
      : { status: 'unknown' };
  }
  // A value only ever copied by spreads or passed directly to SDK calls, which copy their
  // arguments (`{ ...params }` in stripe-node), cannot gain a key after its declaration.
  function onlyCopied(binding: ts.Symbol, declaration: ts.VariableDeclaration) {
    const statement = declaration.parent.parent;
    if (
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    )
      return false;
    let copied = true;
    const visit = (node: ts.Node): void => {
      if (
        ts.isIdentifier(node) &&
        node !== declaration.name &&
        symbol(node) === binding &&
        !ts.isSpreadAssignment(node.parent) &&
        !(
          ts.isCallExpression(node.parent) &&
          node.parent.arguments.includes(node) &&
          options.sdkCall(node.parent)
        )
      )
        copied = false;
      else ts.forEachChild(node, visit);
    };
    visit(declaration.getSourceFile());
    return copied;
  }
  // Every value a plain synchronous local function returns, or undefined when one is implicit.
  function returnedValues(binding: ts.Symbol): ts.Expression[] | undefined {
    const declaration = binding.valueDeclaration;
    const initializer =
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const
        ? declaration.initializer && unwrap(declaration.initializer)
        : undefined;
    const fn =
      declaration && ts.isFunctionDeclaration(declaration)
        ? declaration
        : initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
          ? initializer
          : undefined;
    if (
      !fn?.body ||
      fn.asteriskToken ||
      fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
      unsafe.has(binding)
    )
      return undefined;
    if (!ts.isBlock(fn.body)) return [fn.body];
    const values: ts.Expression[] = [];
    let implicit = false;
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) {
        if (node.expression) values.push(node.expression);
        else implicit = true;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.body, visit);
    return implicit || !values.length ? undefined : values;
  }
  function version(expression: ts.Expression | undefined): {
    status: 'absent' | 'unknown' | 'literal';
    value: string | null;
    node?: ts.Expression;
  } {
    if (!expression || undefinedValue(expression)) return { status: 'absent', value: null };
    const result = property(expression, mapping!.property.split('.'));
    if (result.status !== 'present') return { status: result.status, value: null };
    const value = resolve(result.expression);
    if (!value || !(ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)))
      return { status: 'unknown', value: null };
    try {
      return { status: 'literal', value: validateApiVersion(value.text)!, node: value };
    } catch (error) {
      if (!(error instanceof PipelineInputError)) throw error;
      return { status: 'unknown', value: null };
    }
  }
  unsafe = unsafeBindings(
    options.mutationNodes.filter((node) => {
      if (options.creation(node) || options.sdkCall(node)) return false;
      if (ts.isPropertyAssignment(node)) {
        const value = resolve(node.initializer);
        if (value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)))
          return false;
      }
      return true;
    }),
    checker,
    clients,
    new Map(),
    canonical,
    options.initialUnsafe,
    undefined,
    undefined,
    undefined,
    options.references,
  );
  const declarations: ApiVersionDeclaration[] = [];
  const literalSpan = (node: ts.Expression, value: string) =>
    options.literals?.push({
      file: location(node).file,
      start: node.getStart() + 1,
      end: node.getEnd() - 1,
      value,
    });
  // stripe-node fixes a client's API version at construction; `setApiVersion`, a write to its
  // private `_api` or a raw `Stripe-Version` header can still change what it sends, so any of them
  // anywhere leaves every Stripe constructor's version unknown.
  const hatch =
    options.provider.packageName === 'stripe' &&
    nodes.some(
      (node) =>
        ts.isSourceFile(node) &&
        /setApiVersion|_setApiField|\b_api\b|_requestSender|Stripe-Version/i.test(node.text),
    );
  for (const node of nodes) {
    const creation = options.creation(node);
    if (creation) {
      const result = version(creation.arguments?.[mapping.constructorArgument]);
      const binding = options.clientBinding(node);
      const uncertain =
        hatch ||
        creation.arguments?.some(ts.isSpreadElement) ||
        unsafe.has(options.constructorBinding(creation)!) ||
        !binding ||
        !clients.has(binding) ||
        unsafe.has(binding);
      if (result.node && !uncertain) literalSpan(result.node, result.value!);
      declarations.push({
        ...location(node),
        kind: 'constructor',
        value: uncertain ? null : result.value,
        status: result.status === 'literal' && !uncertain ? 'literal' : 'unknown',
        reason:
          result.status === 'literal' && !uncertain
            ? 'Literal SDK constructor API-version option.'
            : 'Constructor version is absent or cannot be resolved through immutable local declarations.',
        ...(result.status === 'absent' && !uncertain ? { absent: true as const } : {}),
      });
    }
    if (!ts.isCallExpression(node)) continue;
    const call = options.sdkCall(node);
    if (!call) continue;
    const results = mapping.requestArguments.map((index) => version(node.arguments[index]));
    const literal = results.filter((result) => result.status === 'literal');
    const unknown =
      call.optional ||
      node.arguments.some(ts.isSpreadElement) ||
      results.some((result) => result.status === 'unknown') ||
      new Set(literal.map((result) => result.value)).size > 1;
    for (const result of literal) {
      literalSpan(result.node!, result.value!);
      declarations.push({
        ...location(node),
        kind: 'request',
        value: result.value,
        status: 'literal',
        reason: 'Literal per-request API-version override.',
      });
    }
    if (unknown || !literal.length)
      declarations.push({
        ...location(node),
        kind: 'request',
        value: null,
        status: unknown ? 'unknown' : 'inherited',
        reason: unknown
          ? 'Request options are dynamic, conflicting or optional; the effective override is unverified.'
          : 'No override in the adapter-declared option arguments; inherits the client version.',
      });
  }
  return declarations;
}
