import ts from 'typescript-compiler';
import { TEST_PATH } from './source-paths.ts';

// What an omitted argument or property leaves in a parameter that has no default.
export const ABSENT = Symbol('absent');
export type Injected = ts.Expression | typeof ABSENT;

type Body = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
interface Owner {
  binding: ts.Symbol;
  name: ts.Identifier;
  parameters: ts.NodeArray<ts.ParameterDeclaration>;
  construct: boolean;
  exported: boolean;
  entry: boolean;
}

// Next.js route handlers, which the framework calls with its own arguments.
const ENTRY_POINTS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

// Every value a parameter can hold, from the calls outside test files: the argument in its slot,
// its default where the call leaves it out, or ABSENT. A destructured parameter's properties are
// followed one level, through an object literal argument: `{ stripe: make() }`, `{ stripe }` or
// the property's own default. A parameter is listed only when every reference to its function or
// class outside tests is a direct call (or `new`, or a type, import or export), there is at least
// one such call, and every one of them can be read: a spread argument, an argument that is not an
// object literal for a destructured parameter, a spread or computed property, a default export, a
// route handler name, `.call` or `.apply`, a callback and a subclass all leave the parameter out.
// A function that is only another parameter's default (`{ createStripe = make }`) is called
// wherever that parameter is, provided every call leaves the parameter out.
// An exported function or class of a package that declares the SDK as a peer dependency is a
// library's API: its callers are other applications, so its parameters are left out too.
export function injectedParameters(options: {
  nodes: ts.Node[];
  symbol: (node: ts.Node) => ts.Symbol | undefined;
  // The value a `{ stripe }` shorthand property reads (its own symbol is the property's).
  shorthand: (node: ts.ShorthandPropertyAssignment) => ts.Symbol | undefined;
  file: (node: ts.Node) => string;
  library: (file: string) => boolean;
}) {
  const { nodes, symbol, shorthand, file, library } = options;
  const values = new Map<ts.Symbol, Injected[]>();
  // `{ stripe }` argument names, mapped to the value they read.
  const shorthands = new Map<ts.Identifier, ts.Symbol>();
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
      ? unwrap(node.expression)
      : node;
  const missing = (node: ts.Expression | undefined) => {
    const value = node && unwrap(node);
    return (
      !value || (ts.isIdentifier(value) && value.text === 'undefined') || ts.isVoidExpression(value)
    );
  };
  const modifier = (node: ts.Node, kind: ts.SyntaxKind) =>
    ts.canHaveModifiers(node) &&
    Boolean(ts.getModifiers(node)?.some((entry) => entry.kind === kind));

  const owners: Owner[] = [];
  for (const node of nodes) {
    let name: ts.Identifier | undefined;
    let body: Body | ts.ConstructorDeclaration | undefined;
    let statement: ts.Node | undefined;
    if (ts.isFunctionDeclaration(node) && node.name && node.body && !node.asteriskToken) {
      name = node.name;
      body = node;
      statement = node;
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      !node.initializer.asteriskToken &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.flags & ts.NodeFlags.Const
    ) {
      name = node.name;
      body = node.initializer;
      statement = node.parent.parent;
    } else if (
      ts.isConstructorDeclaration(node) &&
      node.body &&
      ts.isClassDeclaration(node.parent) &&
      node.parent.name
    ) {
      name = node.parent.name;
      body = node;
      statement = node.parent;
    }
    const binding = name && symbol(name);
    if (!name || !body || !binding || !statement) continue;
    const exported = modifier(statement, ts.SyntaxKind.ExportKeyword);
    owners.push({
      binding,
      name,
      parameters: body.parameters,
      construct: ts.isConstructorDeclaration(body),
      exported,
      entry:
        modifier(statement, ts.SyntaxKind.DefaultKeyword) ||
        (exported && ENTRY_POINTS.has(name.text)),
    });
  }
  const wanted = new Set(owners.map((owner) => owner.binding));
  const references = new Map<ts.Symbol, ts.Identifier[]>();
  const index = (node: ts.Identifier) => {
    const binding = symbol(node);
    if (binding) references.set(binding, [...(references.get(binding) ?? []), node]);
  };
  for (const node of nodes) {
    if (!ts.isIdentifier(node)) continue;
    const binding = symbol(node);
    if (binding && wanted.has(binding)) index(node);
  }

  // The argument lists of the calls of `callee` (an owner or a parameter that holds it), or
  // undefined where a reference is not a readable call. `aliases` collects parameters whose
  // default is the owner.
  function calls(
    callee: ts.Symbol,
    name: ts.Identifier,
    construct: boolean,
    aliases?: ts.Symbol[],
  ) {
    const found: ts.NodeArray<ts.Expression>[] = [];
    for (const node of references.get(callee) ?? []) {
      if (node === name) continue;
      let parent = node.parent;
      if (ts.isExportAssignment(parent)) return;
      if (TEST_PATH.test(file(node))) continue;
      if (
        ts.isImportSpecifier(parent) ||
        ts.isImportClause(parent) ||
        ts.isExportSpecifier(parent) ||
        ts.isTypeReferenceNode(parent) ||
        ts.isTypeQueryNode(parent)
      )
        continue;
      if (ts.isExpressionWithTypeArguments(parent)) {
        const clause = parent.parent;
        if (ts.isHeritageClause(clause) && clause.token === ts.SyntaxKind.ImplementsKeyword)
          continue;
        return;
      }
      if (
        aliases &&
        (ts.isParameter(parent) || ts.isBindingElement(parent)) &&
        parent.initializer === node &&
        ts.isIdentifier(parent.name)
      ) {
        const alias = symbol(parent.name);
        if (!alias) return;
        aliases.push(alias);
        continue;
      }
      // `billing.charge(…)` through a namespace import.
      let target: ts.Expression = node;
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
        target = parent;
        parent = parent.parent;
      }
      const call = construct
        ? ts.isNewExpression(parent) && parent
        : ts.isCallExpression(parent) && !parent.questionDotToken && parent;
      if (!call || call.expression !== target) return;
      const args = call.arguments ?? ts.factory.createNodeArray<ts.Expression>();
      if (args.some(ts.isSpreadElement)) return;
      found.push(args);
    }
    return found;
  }

  // A destructured property's value from an object literal argument; undefined where it cannot be
  // read, `default` where the literal leaves it out.
  function property(object: ts.ObjectLiteralExpression, key: string) {
    let value: ts.Expression | 'default' = 'default';
    for (const entry of object.properties) {
      if (ts.isSpreadAssignment(entry) || (entry.name && ts.isComputedPropertyName(entry.name)))
        return;
      const name =
        entry.name && (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name))
          ? entry.name.text
          : undefined;
      if (name !== key) continue;
      if (ts.isPropertyAssignment(entry))
        value = missing(entry.initializer) ? 'default' : entry.initializer;
      else if (ts.isShorthandPropertyAssignment(entry)) {
        const read = shorthand(entry);
        if (!read) return;
        shorthands.set(entry.name, read);
        value = entry.name;
      } else return;
    }
    return value;
  }

  function record(owner: Owner, sites: ts.NodeArray<ts.Expression>[]) {
    owner.parameters.forEach((parameter, position) => {
      if (parameter.dotDotDotToken) return;
      if (ts.isIdentifier(parameter.name)) {
        const binding = symbol(parameter.name);
        if (!binding) return;
        values.set(
          binding,
          sites.map((args) =>
            position < args.length && !missing(args[position])
              ? args[position]
              : (parameter.initializer ?? ABSENT),
          ),
        );
        return;
      }
      if (!ts.isObjectBindingPattern(parameter.name)) return;
      for (const element of parameter.name.elements) {
        const key = element.propertyName ?? element.name;
        if (
          element.dotDotDotToken ||
          !ts.isIdentifier(element.name) ||
          !(ts.isIdentifier(key) || ts.isStringLiteral(key))
        )
          continue;
        const binding = symbol(element.name);
        if (!binding) continue;
        const found: Injected[] = [];
        for (const args of sites) {
          const argument =
            position < args.length && !missing(args[position])
              ? args[position]
              : parameter.initializer;
          const object = argument && unwrap(argument);
          const value = !object
            ? 'default'
            : ts.isObjectLiteralExpression(object)
              ? property(object, key.text)
              : undefined;
          if (!value) break;
          found.push(value === 'default' ? (element.initializer ?? ABSENT) : value);
        }
        if (found.length === sites.length) values.set(binding, found);
      }
    });
  }

  const usable = (owner: Owner) =>
    !owner.entry &&
    !(
      (owner.exported ||
        (references.get(owner.binding) ?? []).some((node) => ts.isExportSpecifier(node.parent))) &&
      library(file(owner.name))
    );
  const deferred: [Owner, ts.Symbol[], ts.NodeArray<ts.Expression>[]][] = [];
  for (const owner of owners) {
    if (!usable(owner)) continue;
    const aliases: ts.Symbol[] = [];
    const sites = calls(owner.binding, owner.name, owner.construct, aliases);
    if (!sites) continue;
    if (aliases.length) deferred.push([owner, aliases, sites]);
    else if (sites.length) record(owner, sites);
  }
  // Calls through a parameter that only ever holds its default: every call of its function left
  // it out, so the default is what it calls.
  const held = new Set(deferred.flatMap(([, aliases]) => aliases));
  if (held.size)
    for (const node of nodes) {
      if (!ts.isIdentifier(node)) continue;
      const binding = symbol(node);
      if (binding && held.has(binding)) index(node);
    }
  for (const [owner, aliases, sites] of deferred) {
    const all = [...sites];
    for (const alias of aliases) {
      const entries = values.get(alias);
      const declaration = alias.valueDeclaration;
      const name =
        declaration && (ts.isParameter(declaration) || ts.isBindingElement(declaration))
          ? declaration.name
          : undefined;
      const through =
        entries &&
        name &&
        ts.isIdentifier(name) &&
        entries.every(
          (entry) => entry !== ABSENT && ts.isIdentifier(entry) && symbol(entry) === owner.binding,
        )
          ? calls(alias, name, owner.construct)
          : undefined;
      if (!through) {
        all.length = 0;
        break;
      }
      all.push(...through);
    }
    if (all.length) record(owner, all);
  }
  return {
    values,
    // The symbol a value names: a `{ stripe }` argument reads the variable, not the property.
    binding: (value: ts.Expression) =>
      ts.isIdentifier(value) ? (shorthands.get(value) ?? symbol(value)) : symbol(value),
  };
}
