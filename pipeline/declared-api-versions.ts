import ts from 'typescript-compiler';
import type { ApiVersionDeclaration } from './api-version.ts';
import { validateApiVersion } from './api-version.ts';
import { unsafeBindings } from './mutations.ts';
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
  clientBinding: (node: ts.Node) => ts.Symbol | undefined;
  sdkCall: (node: ts.Node) => { client: ts.Identifier; optional: boolean } | undefined;
  symbol: (node: ts.Node) => ts.Symbol | undefined;
  canonical: (symbol: ts.Symbol | undefined) => ts.Symbol | undefined;
  location: (node: ts.Node) => Location;
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
    return value && ts.isObjectLiteralExpression(value) && unsafe.has(binding) ? undefined : value;
  }
  function property(
    expression: ts.Expression,
    path: string[],
    seen = new Set<ts.Symbol>(),
  ): PropertyResult {
    const object = resolve(expression, seen);
    if (!object || !ts.isObjectLiteralExpression(object)) return { status: 'unknown' };
    const candidates = object.properties.filter((entry) => {
      if (ts.isSpreadAssignment(entry) || ts.isComputedPropertyName(entry.name)) return true;
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
  function version(expression: ts.Expression | undefined): {
    status: 'absent' | 'unknown' | 'literal';
    value: string | null;
  } {
    if (!expression) return { status: 'absent', value: null };
    const result = property(expression, mapping!.property.split('.'));
    if (result.status !== 'present') return { status: result.status, value: null };
    const value = resolve(result.expression);
    if (!value || !(ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)))
      return { status: 'unknown', value: null };
    try {
      return { status: 'literal', value: validateApiVersion(value.text)! };
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
  );
  const declarations: ApiVersionDeclaration[] = [];
  for (const node of nodes) {
    const creation = options.creation(node);
    if (creation) {
      const result = version(creation.arguments?.[mapping.constructorArgument]);
      const binding = options.clientBinding(node);
      const uncertain =
        creation.arguments?.some(ts.isSpreadElement) ||
        unsafe.has(symbol(creation.expression)!) ||
        !binding ||
        !clients.has(binding) ||
        unsafe.has(binding);
      declarations.push({
        ...location(node),
        kind: 'constructor',
        value: uncertain ? null : result.value,
        status: result.status === 'literal' && !uncertain ? 'literal' : 'unknown',
        reason:
          result.status === 'literal' && !uncertain
            ? 'Literal SDK constructor API-version option.'
            : 'Constructor version is absent or cannot be resolved through immutable local declarations.',
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
    for (const result of literal)
      declarations.push({
        ...location(node),
        kind: 'request',
        value: result.value,
        status: 'literal',
        reason: 'Literal per-request API-version override.',
      });
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
