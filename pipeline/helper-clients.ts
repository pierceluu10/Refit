import ts from 'typescript-compiler';

type Helper = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
type Creation = ts.NewExpression | ts.CallExpression;
interface Source {
  binding?: ts.Symbol;
  creation?: Creation;
}
interface Flow {
  binding: ts.Symbol;
  parameter: ts.ParameterDeclaration;
  helper: Helper;
  call: ts.CallExpression;
  sources: Map<ts.Symbol | Creation, Source>;
}

export function helperClients(options: {
  nodes: ts.Node[];
  clients: Set<ts.Symbol>;
  checker: ts.TypeChecker;
  symbol: (node: ts.Node) => ts.Symbol | undefined;
  clientBinding: (node: ts.Expression) => ts.Symbol | undefined;
  creation: (node: ts.Node) => Creation | undefined;
}) {
  const { nodes, clients, checker, symbol, clientBinding, creation } = options;
  const helpers = new Map<ts.Symbol, Helper>();
  const flows = new Map<ts.Symbol, Flow>();
  const invocations = new Map<Helper, ts.CallExpression[]>();
  const unsafe = new Set<ts.Symbol>();
  // Unsafe flows whose argument may reach code Refit does not see: a rebindable helper, one that
  // reads `arguments` or `eval`, a rest parameter or a call that spreads or optionally chains.
  const opaque = new Set<ts.Symbol>();
  const aliases: [ts.Symbol, ts.Symbol][] = [];
  const creations = new Map<ts.Node, ts.Symbol>();
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
  function source(expression: ts.Expression): Source | undefined {
    const value = unwrap(expression);
    const sdk = creation(value);
    if (sdk) return { creation: sdk };
    const binding = clientBinding(value);
    return binding && clients.has(binding) ? { binding } : undefined;
  }
  const declarations = nodes.filter(
    (node): node is ts.VariableDeclaration & { name: ts.Identifier; initializer: ts.Expression } =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      Boolean(node.initializer) &&
      ts.isVariableDeclarationList(node.parent) &&
      Boolean(node.parent.flags & ts.NodeFlags.Const),
  );
  for (const node of nodes) {
    let name: ts.Identifier | undefined;
    let helper: Helper | undefined;
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      name = node.name;
      helper = node;
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer))
    ) {
      name = node.name;
      helper = node.initializer;
    }
    const binding = name && symbol(name);
    if (
      binding &&
      helper &&
      !helper.parameters.some(
        (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === 'this',
      )
    )
      helpers.set(binding, helper);
  }
  for (const node of nodes) {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) continue;
    const helper = helpers.get(symbol(node.expression)!);
    if (helper) invocations.set(helper, [...(invocations.get(helper) ?? []), node]);
  }
  let previous = -1;
  while (previous !== clients.size) {
    previous = clients.size;
    for (const declaration of declarations) {
      const binding = clientBinding(unwrap(declaration.initializer));
      if (binding && clients.has(binding)) {
        const target = symbol(declaration.name);
        if (target) clients.add(target);
      }
    }
    for (const [helper, calls] of invocations) {
      for (const call of calls) {
        for (let index = 0; index < helper.parameters.length; index++) {
          const parameter = helper.parameters[index];
          const argument = call.arguments[index];
          const binding = ts.isIdentifier(parameter.name) ? symbol(parameter.name) : undefined;
          if (!binding || !argument || ts.isSpreadElement(argument)) continue;
          const origin = source(argument);
          if (!origin) continue;
          const flow = flows.get(binding) ?? {
            binding,
            parameter,
            helper,
            call,
            sources: new Map(),
          };
          flow.sources.set(origin.binding ?? origin.creation!, origin);
          flows.set(binding, flow);
          clients.add(binding);
        }
      }
    }
  }
  for (const [functionBinding, helper] of helpers) {
    const parameters = [...flows.values()].filter((flow) => flow.helper === helper);
    if (!parameters.length) continue;
    const declaration = functionBinding.valueDeclaration;
    const rebindable = Boolean(
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      (!ts.isVariableDeclarationList(declaration.parent) ||
        !(declaration.parent.flags & ts.NodeFlags.Const)),
    );
    let uncertain = rebindable;
    let hidden = rebindable;
    const module = checker.getSymbolAtLocation(helper.getSourceFile());
    if (module)
      for (let entry of checker.getExportsOfModule(module)) {
        if (entry.flags & ts.SymbolFlags.Alias) entry = checker.getAliasedSymbol(entry);
        if (entry === functionBinding) uncertain = true;
      }
    for (const node of nodes) {
      if (!ts.isIdentifier(node) || symbol(node) !== functionBinding) continue;
      if (
        (ts.isFunctionDeclaration(node.parent) &&
          node.parent === helper &&
          node.parent.name === node) ||
        (ts.isVariableDeclaration(node.parent) &&
          node.parent.initializer === helper &&
          node.parent.name === node)
      )
        continue;
      if (!ts.isCallExpression(node.parent) || node.parent.expression !== node) uncertain = true;
    }
    const inspect = (node: ts.Node) => {
      if (ts.isIdentifier(node) && (node.text === 'arguments' || node.text === 'eval'))
        uncertain = hidden = true;
      ts.forEachChild(node, inspect);
    };
    if (helper.body) inspect(helper.body);
    for (const flow of parameters) {
      const index = helper.parameters.indexOf(flow.parameter);
      if (
        uncertain ||
        flow.parameter.initializer ||
        flow.parameter.dotDotDotToken ||
        flow.parameter.questionToken ||
        flow.sources.size !== 1 ||
        (invocations.get(helper) ?? []).some(
          (call) =>
            call.questionDotToken ||
            call.arguments.some(ts.isSpreadElement) ||
            !call.arguments[index] ||
            !source(call.arguments[index]),
        )
      )
        unsafe.add(flow.binding);
      if (
        hidden ||
        flow.parameter.dotDotDotToken ||
        (invocations.get(helper) ?? []).some(
          (call) => call.questionDotToken || call.arguments.some(ts.isSpreadElement),
        )
      )
        opaque.add(flow.binding);
      for (const origin of flow.sources.values()) {
        if (origin.binding) aliases.push([flow.binding, origin.binding]);
        if (origin.creation) creations.set(origin.creation, flow.binding);
      }
    }
  }
  function root(binding: ts.Symbol, seen = new Set<ts.Symbol>()): ts.Symbol {
    if (seen.has(binding)) return binding;
    const declaration = binding.valueDeclaration;
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !declaration.initializer ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      !(declaration.parent.flags & ts.NodeFlags.Const)
    )
      return binding;
    const value = unwrap(declaration.initializer);
    const next = clientBinding(value);
    return next ? root(next, new Set([...seen, binding])) : binding;
  }
  function flowParameter(node: ts.CallExpression | ts.NewExpression, argument: ts.Expression) {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
    const helper = helpers.get(symbol(node.expression)!);
    const parameter = helper?.parameters[node.arguments.indexOf(argument)];
    const binding =
      parameter && ts.isIdentifier(parameter.name) ? symbol(parameter.name) : undefined;
    return binding && flows.has(binding) ? binding : undefined;
  }
  return {
    flows,
    unsafe,
    opaque,
    aliases,
    creations,
    client(expression: ts.Expression) {
      const binding = clientBinding(unwrap(expression));
      if (!binding) return;
      const origin = root(binding);
      return (
        flows.get(origin) ??
        [...flows.values()].find((flow) =>
          [...flow.sources.values()].some(
            (source) => source.binding && root(source.binding) === origin,
          ),
        )
      );
    },
    localArgument(node: ts.CallExpression | ts.NewExpression, argument: ts.Expression) {
      const binding = flowParameter(node, argument);
      return Boolean(binding && !unsafe.has(binding));
    },
    // A client passed to a helper whose parameter Refit traces stays in code Refit sees, even
    // where other callers or exports make the helper's responses unsafe to migrate.
    visibleArgument(node: ts.CallExpression | ts.NewExpression, argument: ts.Expression) {
      const binding = flowParameter(node, argument);
      return Boolean(binding && !opaque.has(binding));
    },
  };
}
