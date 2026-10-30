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
  // Receives the text span of each literal version, for a patch that bumps it. `endpoint` marks a
  // literal that also sets a webhook endpoint's api_version, so moving it changes that endpoint.
  // `declaration` names the untraced constructor a literal belongs to.
  literals?: {
    file: string;
    start: number;
    end: number;
    value: string;
    endpoint?: true;
    declaration?: number;
  }[];
  // Receives the declaration indexes that decide each client binding's and each SDK call's
  // version, so a caller can check one request's own path.
  paths?: { clients: Map<ts.Symbol, number[]>; calls: Map<ts.CallExpression, number[]> };
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
  // The repository default of `process.env.NAME ?? '2023-10-16'` (or `||`) resolves to its literal;
  // this records NAME for each such literal, as the deployment environment can override it.
  const environmentDefaults = new Map<ts.Expression, string>();
  function resolve(
    expression: ts.Expression,
    seen = new Set<ts.Symbol>(),
  ): ts.Expression | undefined {
    const current = unwrap(expression);
    if (
      ts.isBinaryExpression(current) &&
      [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
        current.operatorToken.kind,
      )
    ) {
      const name = environmentVariable(current.left, seen);
      const value = name ? resolve(current.right, seen) : undefined;
      if (value && name) environmentDefaults.set(value, name);
      return value;
    }
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
  // NAME in `process.env.NAME` or `process.env['NAME']`, read directly or through immutable
  // bindings and properties, where `process` is the global.
  function environmentVariable(
    expression: ts.Expression,
    seen = new Set<ts.Symbol>(),
  ): string | undefined {
    const current = unwrap(expression);
    const name = ts.isPropertyAccessExpression(current)
      ? current.name.text
      : ts.isElementAccessExpression(current) && ts.isStringLiteralLike(current.argumentExpression)
        ? current.argumentExpression.text
        : undefined;
    const env =
      name !== undefined ? unwrap((current as ts.AccessExpression).expression) : undefined;
    if (
      env &&
      ts.isPropertyAccessExpression(env) &&
      env.name.text === 'env' &&
      ts.isIdentifier(env.expression) &&
      env.expression.text === 'process' &&
      !symbol(env.expression)?.valueDeclaration
    )
      return name;
    if (ts.isIdentifier(current)) {
      const binding = symbol(current);
      const declaration = binding?.valueDeclaration;
      return binding &&
        !seen.has(binding) &&
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        ts.isVariableDeclarationList(declaration.parent) &&
        declaration.parent.flags & ts.NodeFlags.Const
        ? environmentVariable(declaration.initializer, new Set([...seen, binding]))
        : undefined;
    }
    if (ts.isPropertyAccessExpression(current)) {
      const result = property(current.expression, [current.name.text], seen);
      return result.status === 'present' ? environmentVariable(result.expression, seen) : undefined;
    }
    return undefined;
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
  // `params.cancellation_reason = …`: a plain assignment to another named key cannot set the
  // version option, the only key read here.
  const versionKey = mapping.property.split('.')[0];
  const otherKeyWrite = (node: ts.Identifier) =>
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.expression === node &&
    node.parent.name.text !== versionKey &&
    ts.isBinaryExpression(node.parent.parent) &&
    node.parent.parent.left === node.parent &&
    node.parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isExpressionStatement(node.parent.parent.parent);
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
        ) &&
        !otherKeyWrite(node)
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
    environment?: string;
  } {
    if (!expression || undefinedValue(expression)) return { status: 'absent', value: null };
    const result = property(expression, mapping!.property.split('.'));
    if (result.status !== 'present') return { status: result.status, value: null };
    const value = resolve(result.expression);
    // stripe-node sends `apiVersion || DEFAULT_API_VERSION` (11.18.0 to 23.0.0), so null is unset.
    if (
      options.provider.packageName === 'stripe' &&
      (value ?? unwrap(result.expression)).kind === ts.SyntaxKind.NullKeyword
    )
      return { status: 'absent', value: null };
    const environment =
      (value && environmentDefaults.get(value)) ?? environmentVariable(result.expression);
    if (!value || !(ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)))
      return { status: 'unknown', value: null, ...(environment ? { environment } : {}) };
    try {
      return {
        status: 'literal',
        value: validateApiVersion(value.text)!,
        node: value,
        ...(environment ? { environment } : {}),
      };
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
  // shortcut: only `api_version: <expression>` is followed, not `{ api_version }` shorthand.
  const endpointLiterals = new Set(
    nodes
      .filter(
        (node): node is ts.PropertyAssignment =>
          ts.isPropertyAssignment(node) &&
          (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
          node.name.text === 'api_version',
      )
      .map((node) => resolve(node.initializer)),
  );
  const literalSpan = (node: ts.Expression, value: string, declaration?: number) =>
    options.literals?.push({
      file: location(node).file,
      start: node.getStart() + 1,
      end: node.getEnd() - 1,
      value,
      ...(endpointLiterals.has(node) ? { endpoint: true as const } : {}),
      ...(declaration === undefined ? {} : { declaration }),
    });
  // Untraced constructors' literal pins, checked once every traced pin is known (below).
  // `untraced`: the construction's own version is a literal and only its client is untraced.
  const untracedPins: {
    node: ts.Expression;
    value: string;
    declaration: number;
    untraced?: true;
  }[] = [];
  const endpoint = (node: ts.Expression | undefined) =>
    node && endpointLiterals.has(node) ? { endpoint: true as const } : {};
  // stripe-node fixes a client's API version at construction; `setApiVersion`, a write to its
  // private `_api` or a raw `Stripe-Version` header can still change what it sends, so any of them
  // anywhere leaves every Stripe constructor's version unknown. Only a header being sent counts
  // (an object key or the name given to `set`/`append`), not reading an incoming one.
  const sendsVersionHeader = (node: ts.Node) =>
    ts.isStringLiteralLike(node) &&
    node.text.toLowerCase() === 'stripe-version' &&
    ((ts.isPropertyAssignment(node.parent) && node.parent.name === node) ||
      (ts.isCallExpression(node.parent) &&
        node.parent.arguments[0] === node &&
        ts.isPropertyAccessExpression(node.parent.expression) &&
        ['set', 'append'].includes(node.parent.expression.name.text)));
  const hatch =
    options.provider.packageName === 'stripe' &&
    nodes.some(
      (node) =>
        (ts.isSourceFile(node) &&
          /\.(?:setApiVersion|_setApiField|_api|_requestSender)\b/i.test(node.text)) ||
        sendsVersionHeader(node),
    );
  const versionOption =
    options.provider.packageName === 'stripe' &&
    nodes.some(
      (node) =>
        ts.isSourceFile(node) && /\b(?:apiVersion|stripeVersion|stripe_version)\b/.test(node.text),
    );
  for (const node of nodes) {
    const creation = options.creation(node);
    if (creation) {
      const result = version(creation.arguments?.[mapping.constructorArgument]);
      const binding = options.clientBinding(node);
      const constructed =
        creation.arguments?.some(ts.isSpreadElement) ||
        unsafe.has(options.constructorBinding(creation)!);
      const unresolved = constructed || !binding || !clients.has(binding) || unsafe.has(binding);
      const uncertain = hatch || unresolved;
      if (result.node && !uncertain) literalSpan(result.node, result.value!);
      else if (result.node && result.value)
        untracedPins.push({
          node: result.node,
          value: result.value,
          declaration: declarations.length,
          ...(!hatch && !constructed && result.status === 'literal' && !result.environment
            ? { untraced: true as const }
            : {}),
        });
      if (binding && options.paths)
        options.paths.clients.set(binding, [
          ...(options.paths.clients.get(binding) ?? []),
          declarations.length,
        ]);
      declarations.push({
        ...location(node),
        kind: 'constructor',
        // An escape hatch keeps the literal, so a pin that conflicts with it still stops.
        value: unresolved ? null : result.value,
        status: result.status === 'literal' && !uncertain ? 'literal' : 'unknown',
        reason:
          result.status === 'literal' && !uncertain
            ? 'Literal SDK constructor API-version option.'
            : hatch && !unresolved
              ? 'setApiVersion, a write to the private _api field or a raw Stripe-Version header elsewhere in the repository can change the version this client sends.'
              : result.environment && !uncertain
                ? `Constructor version comes only from the deployment environment variable ${result.environment}.`
                : 'Constructor version is absent or cannot be resolved through immutable local declarations.',
        // A constructor without the option sends stripe-node's pinned version wherever its client
        // goes afterwards. Where Refit cannot follow the client, a request through it could still
        // send its own version, so that needs no file to name a version option at all.
        ...(result.status === 'absent' &&
        (!uncertain ||
          (!hatch &&
            !versionOption &&
            !creation.arguments?.some(ts.isSpreadElement) &&
            !unsafe.has(options.constructorBinding(creation)!)))
          ? { absent: true as const }
          : {}),
        ...(result.environment && !uncertain ? { environment: result.environment } : {}),
        ...endpoint(result.node),
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
    const first = declarations.length;
    for (const result of literal) {
      literalSpan(result.node!, result.value!);
      declarations.push({
        ...location(node),
        kind: 'request',
        value: result.value,
        status: 'literal',
        reason: 'Literal per-request API-version override.',
        ...(result.environment ? { environment: result.environment } : {}),
        ...endpoint(result.node),
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
    options.paths?.calls.set(
      node,
      Array.from({ length: declarations.length - first }, (_, index) => first + index),
    );
  }
  // Founder decision (2026-10-28, docs/AI-REPAIR.md): the version move updates every `apiVersion`
  // string literal in a file that loads stripe, not only traced clients' pins. Outside a traced
  // pin only a dated version with its release name, or a value a traced pin sends, counts, so
  // another SDK's dated `apiVersion` is never moved.
  if (options.provider.packageName === 'stripe' && options.literals) {
    const traced = new Set(options.literals.map((literal) => literal.value));
    const property = mapping.property.split('.').at(-1);
    // A literal the code always sends: not a deployment environment variable's default.
    const resolvedLiteral = (expression: ts.Expression) => {
      const value = resolve(expression);
      return Boolean(
        value &&
        (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) &&
        !environmentDefaults.has(value) &&
        !environmentVariable(expression),
      );
    };
    const stripeVersion = (node: ts.Expression, value: string) =>
      (/^\d{4}-\d{2}-\d{2}\.[a-z]+$/.test(value) || traced.has(value)) &&
      /(?:from\s*|require\(\s*|import\(\s*)['"]stripe['"]/.test(node.getSourceFile().text);
    // A version option anywhere in a Stripe file whose value is not a literal (or a constant one).
    const unreadOption = nodes.some(
      (node) =>
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        node.name.text === property &&
        /(?:from\s*|require\(\s*|import\(\s*)['"]stripe['"]/.test(node.getSourceFile().text) &&
        !resolvedLiteral(ts.isPropertyAssignment(node) ? node.initializer : node.name),
    );
    for (const pin of untracedPins)
      if (stripeVersion(pin.node, pin.value)) {
        literalSpan(pin.node, pin.value, pin.declaration);
        // stripe-node fixes the version at construction, so wherever this client goes it sends the
        // literal written there, which the version move updates, unless a request overrides it
        // with an option Refit cannot read (`unreadOption`).
        if (pin.untraced && !unreadOption)
          declarations[pin.declaration] = { ...declarations[pin.declaration], untracedPin: true };
      }
    for (const node of nodes) {
      if (
        !ts.isPropertyAssignment(node) ||
        !(ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ||
        node.name.text !== property
      )
        continue;
      const value = unwrap(node.initializer);
      if (
        (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) &&
        value.text === value.text.trim() &&
        stripeVersion(value, value.text)
      )
        literalSpan(value, value.text);
    }
  }
  return declarations;
}
