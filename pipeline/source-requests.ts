import ts from 'typescript-compiler';

// Next.js route handlers (`app/**/route.ts`), Next.js and Vercel API functions (`pages/api/**`,
// `api/**`) and Express route methods.
const ROUTE_EXPORTS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ROUTE_FILE = /(^|\/)app\/(.+\/)?route\.[cm]?[jt]sx?$/;
const API_FILE = /^(.+\/)?api\/.+\.[cm]?[jt]sx?$/;
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all']);
const RESPONSE_METHODS = new Set(['status', 'json', 'send', 'end', 'setHeader', 'writeHead']);
// Array methods whose callback receives the elements (`reduce` passes them second), and those
// that return an element or a copy holding the same elements.
const ELEMENT_CALLBACKS = new Map([
  ...['find', 'findLast', 'filter', 'map', 'forEach', 'some', 'every', 'findIndex', 'flatMap'].map(
    (name) => [name, 0] as const,
  ),
  ['reduce', 1],
]);
const ELEMENT_RESULTS = new Set(['find', 'findLast', 'at']);
const COPIES = new Set(['filter', 'slice', 'toSorted', 'toReversed', 'concat']);
// The only built-in methods that change a parsed JSON value: a request body has no methods of
// its own.
const MUTATORS = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
]);
// Global functions that read their arguments and keep no reference to them.
const PURE = new Set([
  'Number',
  'String',
  'Boolean',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURIComponent',
  'Date',
  'Math.round',
  'Math.floor',
  'Math.ceil',
  'Math.max',
  'Math.min',
  'Math.abs',
  'JSON.stringify',
  'JSON.parse',
  'Array.isArray',
  'Object.keys',
  'console.log',
  'console.error',
  'console.warn',
  'console.info',
]);
const WEBHOOK = /stripe-signature|constructEvent/i;
type Path = string[];
// `[]` stands for any element or computed key.
const within = (prefix: Path, path: Path) =>
  prefix.length <= path.length &&
  prefix.every((hop, index) => hop === path[index] || hop === '[]' || path[index] === '[]');

// The data an HTTP request handler parses from the request it receives is what the sender
// posted, not a Stripe object: `await request.json()` in an exported `POST` (or other method) of
// a Next.js `route` file, and `req.body` in a callback of an Express app's or router's route
// method or in the default-exported `handler(req, res)` of a Next.js or Vercel API file. A handler that verifies a Stripe signature or reads `stripe-signature` receives a Stripe
// event, so its body is never proven. A Stripe event that reaches a handler without a signature
// check is still only its top-level fields and `request`, which no Stripe version removes; the
// objects it carries are under `data`, so a value reached through `data` is never proven.
// Proving the rest is as strict as for rows and literals: a value is proven only when nothing can
// have put another object where it sits. Every alias of the body (consts, destructured consts,
// `for…of` consts, element callback parameters) is followed; a value on the way to the read that
// is passed to a function, placed in another value, returned, assigned to a mutable binding or
// assigned into, or an array on the way that is changed (`push`, `splice`, …), leaves the read
// for review. Values below the read's receiver may go anywhere: they cannot replace it.
export function sourceRequests(options: {
  symbol: (node: ts.Node) => ts.Symbol | undefined;
  nodes: ts.Node[];
  references: Map<ts.Symbol, ts.Identifier[]>;
  file: (node: ts.Node) => string;
}) {
  const { symbol, nodes, references, file } = options;
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
      ? unwrap(node.expression)
      : node;
  const transparent = (node: ts.Node) =>
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node);
  const assignment = (node: ts.Node): node is ts.BinaryExpression =>
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  const constant = (declaration: ts.VariableDeclaration) =>
    ts.isVariableDeclarationList(declaration.parent) &&
    Boolean(declaration.parent.flags & ts.NodeFlags.Const);
  const name = (expression: ts.Expression): string | undefined =>
    ts.isIdentifier(expression)
      ? expression.text
      : ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
        ? `${expression.expression.text}.${expression.name.text}`
        : undefined;
  // A global (`Number`, `Math.round`): its name resolves to no declaration in the source.
  const pure = (callee: ts.Expression) => {
    const full = name(callee);
    const head = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
    return Boolean(full && PURE.has(full) && !symbol(head)?.declarations?.length);
  };

  // Middleware that writes `req.body`, or merges into a request, could put anything there.
  const bodyWrites = nodes.some((node) => {
    if (assignment(node)) {
      const target = unwrap(node.left);
      const member =
        (ts.isPropertyAccessExpression(target) && target.name.text === 'body') ||
        (ts.isElementAccessExpression(target) &&
          ts.isStringLiteralLike(target.argumentExpression) &&
          target.argumentExpression.text === 'body');
      if (!member) return false;
      // `options.body = JSON.stringify(…)` on a `const options = { … }` is a fetch option.
      const owner = unwrap((target as ts.PropertyAccessExpression).expression);
      const declaration = ts.isIdentifier(owner) ? symbol(owner)?.valueDeclaration : undefined;
      return !(
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        constant(declaration) &&
        declaration.initializer &&
        ts.isObjectLiteralExpression(unwrap(declaration.initializer))
      );
    }
    // `Object.assign({}, a, b)` builds a new object; into anything else, it may be a request.
    return (
      ts.isCallExpression(node) &&
      ['Object.assign', 'Object.defineProperty', 'Object.defineProperties', 'Reflect.set'].includes(
        name(node.expression) ?? '',
      ) &&
      !(node.arguments[0] && ts.isObjectLiteralExpression(unwrap(node.arguments[0])))
    );
  });
  const jsonWrites = nodes.some(
    (node) =>
      assignment(node) &&
      ts.isPropertyAccessExpression(unwrap(node.left)) &&
      (unwrap(node.left) as ts.PropertyAccessExpression).name.text === 'json',
  );

  // `express` from the express package: its default import or `require('express')`.
  function expressImport(expression: ts.Expression) {
    if (!ts.isIdentifier(expression)) return false;
    const declaration = symbol(expression)?.declarations?.[0];
    if (!declaration) return false;
    const fromExpress = (node: ts.Node) =>
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === 'express';
    if (ts.isImportClause(declaration)) return fromExpress(declaration.parent);
    if (ts.isNamespaceImport(declaration)) return fromExpress(declaration.parent.parent);
    const value =
      ts.isVariableDeclaration(declaration) &&
      constant(declaration) &&
      declaration.initializer &&
      unwrap(declaration.initializer);
    return Boolean(
      value &&
      ts.isCallExpression(value) &&
      ts.isIdentifier(value.expression) &&
      value.expression.text === 'require' &&
      value.arguments.length === 1 &&
      ts.isStringLiteralLike(value.arguments[0]) &&
      value.arguments[0].text === 'express',
    );
  }
  // A const created by `express()` or `express.Router()`.
  function expressApp(expression: ts.Expression) {
    const current = unwrap(expression);
    if (!ts.isIdentifier(current)) return false;
    const declaration = symbol(current)?.valueDeclaration;
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !constant(declaration) ||
      !declaration.initializer
    )
      return false;
    const value = unwrap(declaration.initializer);
    if (!ts.isCallExpression(value)) return false;
    const callee = unwrap(value.expression);
    return (
      expressImport(callee) ||
      (ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'Router' &&
        expressImport(unwrap(callee.expression)))
    );
  }
  // `app.post('/path', …, handler)`: the handler is an argument after a literal path.
  const registration = (argument: ts.Node) => {
    const call = argument.parent;
    return (
      ts.isCallExpression(call) &&
      call.arguments.indexOf(argument as ts.Expression) > 0 &&
      ts.isStringLiteralLike(call.arguments[0]) &&
      ts.isPropertyAccessExpression(call.expression) &&
      ROUTE_METHODS.has(call.expression.name.text) &&
      expressApp(call.expression.expression)
    );
  };
  type Handler = ts.FunctionLikeDeclaration & { body: ts.Node };
  // The function a request handler is, and the kind of body it reads.
  function handler(parameter: ts.ParameterDeclaration): 'json' | 'body' | undefined {
    const fn = parameter.parent;
    if (
      !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ||
      fn.parameters[0] !== parameter ||
      !fn.body ||
      WEBHOOK.test((fn as Handler).body.getText())
    )
      return;
    // `export async function POST(request)` or `export const POST = async (request) => …`.
    const exported = (node: ts.Node) =>
      Boolean(
        ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
      );
    const holder = ts.isFunctionDeclaration(fn)
      ? fn
      : ts.isVariableDeclaration(fn.parent) && fn.parent.initializer === fn
        ? fn.parent
        : undefined;
    const label = holder?.name && ts.isIdentifier(holder.name) ? holder.name.text : undefined;
    if (
      label &&
      ROUTE_EXPORTS.has(label) &&
      ROUTE_FILE.test(file(fn)) &&
      (ts.isFunctionDeclaration(holder!)
        ? exported(holder!)
        : ts.isVariableDeclaration(holder!) && constant(holder!) && exported(holder!.parent.parent))
    )
      return 'json';
    if (bodyWrites) return;
    if (registration(fn)) return 'body';
    // `export default async function handler(req, res)` in an API directory, answering through
    // `res`, that nothing in the source calls.
    const response =
      fn.parameters[1] && ts.isIdentifier(fn.parameters[1].name) && symbol(fn.parameters[1].name);
    if (
      fn.parameters.length === 2 &&
      API_FILE.test(file(fn)) &&
      ts.isFunctionDeclaration(fn) &&
      exported(fn) &&
      ts.getModifiers(fn)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) &&
      response &&
      (references.get(response) ?? []).some(
        (reference) =>
          ts.isPropertyAccessExpression(reference.parent) &&
          RESPONSE_METHODS.has(reference.parent.name.text) &&
          ts.isCallExpression(reference.parent.parent),
      ) &&
      (!fn.name ||
        (references.get(symbol(fn.name)!) ?? []).every(
          (reference) =>
            reference === fn.name ||
            ts.isImportClause(reference.parent) ||
            ts.isExportSpecifier(reference.parent) ||
            ts.isExportAssignment(reference.parent),
        ))
    )
      return 'body';
    return undefined;
  }

  // Every value of the body: the node, its path below the body, and the body it belongs to.
  const sites = new Map<ts.Node, { root: ts.Node; path: Path }>();
  // Where something may have replaced a value of each body, and at which path.
  const unsafe = new Map<ts.Node, { path: Path; node?: ts.Node }[]>();
  // The handler each body belongs to, and the element callbacks run on its arrays.
  const handlers = new Map<ts.Node, ts.Node>();
  const callbacks = new Set<ts.Node>();
  const followed = new Set<ts.Symbol>();
  const mark = (root: ts.Node, path: Path, node?: ts.Node) =>
    unsafe.get(root)!.push({ path, node });
  function binding(name: ts.BindingName, root: ts.Node, path: Path, declaration: boolean) {
    if (ts.isIdentifier(name)) {
      const bound = symbol(name);
      if (!bound || !declaration || followed.has(bound)) {
        if (!declaration) mark(root, path, name);
        return;
      }
      followed.add(bound);
      for (const reference of references.get(bound) ?? []) {
        if (reference === name) continue;
        // A reassigned parameter no longer holds the element.
        if (assignment(reference.parent) && reference.parent.left === reference) {
          mark(root, path);
          continue;
        }
        value(reference, root, path);
      }
      return;
    }
    if (ts.isArrayBindingPattern(name)) {
      for (const element of name.elements)
        if (ts.isBindingElement(element)) {
          if (element.dotDotDotToken) mark(root, path, element);
          else binding(element.name, root, [...path, '[]'], declaration);
        }
      return;
    }
    for (const element of name.elements) {
      const key = element.propertyName ?? element.name;
      const hop =
        element.dotDotDotToken || !(ts.isIdentifier(key) || ts.isStringLiteral(key))
          ? undefined
          : key.text;
      // `{ ...rest }` holds the other properties.
      if (hop === undefined) {
        mark(root, path, element);
        continue;
      }
      binding(element.name, root, [...path, hop], declaration);
    }
  }
  // Records a value of the body and follows where it goes.
  function value(node: ts.Expression, root: ts.Node, path: Path) {
    // Reached twice (`cond ? body.a : body.b`): the value is not one known place of one body.
    const seen = sites.get(node);
    if (seen) {
      if (seen.root !== root || seen.path.join('.') !== path.join('.')) {
        mark(root, []);
        mark(seen.root, []);
      }
      return;
    }
    sites.set(node, { root, path });
    let current: ts.Node = node;
    while (transparent(current.parent) || ts.isAwaitExpression(current.parent)) {
      current = current.parent;
      sites.set(current, { root, path });
    }
    const parent = current.parent;
    const escape = () => mark(root, path, current);
    // `X.name`, `X[index]`.
    if (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === current
    ) {
      const hop = ts.isPropertyAccessExpression(parent)
        ? parent.name.text
        : ts.isStringLiteralLike(parent.argumentExpression)
          ? parent.argumentExpression.text
          : '[]';
      const call = parent.parent;
      if (
        ts.isCallExpression(call) &&
        call.expression === parent &&
        ts.isPropertyAccessExpression(parent)
      ) {
        if (MUTATORS.has(hop)) return escape();
        const index = ELEMENT_CALLBACKS.get(hop);
        const callback = call.arguments[0] && unwrap(call.arguments[0]);
        if (index !== undefined) {
          // A named callback, or one that takes the array itself (`(item, i, list) => …`), gets
          // the elements or the array where this code cannot follow them.
          if (
            !callback ||
            !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ||
            callback.parameters.length > index + 2
          )
            return escape();
          callbacks.add(callback);
          const element = callback.parameters[index];
          if (element && !element.dotDotDotToken)
            binding(element.name, root, [...path, '[]'], true);
        }
        if (ELEMENT_RESULTS.has(hop)) value(call, root, [...path, '[]']);
        else if (COPIES.has(hop)) value(call, root, path);
        // Other built-in methods read their receiver: `price.toFixed(2)`, `items.map(…)`.
        return;
      }
      const write =
        (assignment(parent.parent) && parent.parent.left === parent) ||
        ts.isDeleteExpression(parent.parent) ||
        ((ts.isPrefixUnaryExpression(parent.parent) ||
          ts.isPostfixUnaryExpression(parent.parent)) &&
          [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
            parent.parent.operator,
          ));
      if (write) mark(root, [...path, hop], parent);
      else value(parent, root, [...path, hop]);
      return;
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === current)
      return binding(parent.name, root, path, constant(parent));
    if (ts.isForOfStatement(parent) && parent.expression === current) {
      const [declaration] = ts.isVariableDeclarationList(parent.initializer)
        ? parent.initializer.declarations
        : [];
      if (declaration && constant(declaration))
        return binding(declaration.name, root, [...path, '[]'], true);
      return mark(root, [...path, '[]'], current);
    }
    // `body.items ?? []`, `cond ? body.a : b`: the value flows on.
    if (
      (ts.isBinaryExpression(parent) &&
        [
          ts.SyntaxKind.QuestionQuestionToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.AmpersandAmpersandToken,
        ].includes(parent.operatorToken.kind)) ||
      (ts.isConditionalExpression(parent) && parent.condition !== current)
    )
      return value(parent, root, path);
    if (assignment(parent)) return escape();
    if (ts.isCallExpression(parent) && parent.arguments.includes(current as ts.Expression)) {
      if (!pure(parent.expression)) escape();
      return;
    }
    // Tests, comparisons, arithmetic, templates and conditions only read the value.
    if (
      ts.isBinaryExpression(parent) ||
      ts.isPrefixUnaryExpression(parent) ||
      ts.isTypeOfExpression(parent) ||
      (ts.isTemplateSpan(parent) && !ts.isTaggedTemplateExpression(parent.parent.parent)) ||
      ts.isIfStatement(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isSwitchStatement(parent) ||
      ts.isCaseClause(parent) ||
      (ts.isConditionalExpression(parent) && parent.condition === current) ||
      ts.isExpressionStatement(parent)
    )
      return;
    escape();
  }
  // Whether every run of the handler evaluates the read before the escape, so the escape cannot
  // have changed what the read sees: both are in the handler itself (the read may be in an element
  // callback on the body, which runs in place), the read ends before the escape starts, the escape
  // is in no function declaration (hoisted, so callable earlier), and no loop or callback around
  // the escape also runs the read.
  function before(read: ts.Node, escape: ts.Node | undefined, handler: ts.Node) {
    if (
      !escape ||
      read.getSourceFile() !== escape.getSourceFile() ||
      read.getEnd() > escape.getStart()
    )
      return false;
    for (let node = read.parent; node !== handler; node = node.parent)
      if (!node || ts.isSourceFile(node) || (ts.isFunctionLike(node) && !callbacks.has(node)))
        return false;
    for (let node = escape.parent; node !== handler; node = node.parent) {
      if (!node || ts.isSourceFile(node) || ts.isFunctionDeclaration(node) || ts.isClassLike(node))
        return false;
      if (
        (ts.isIterationStatement(node, false) || ts.isFunctionLike(node)) &&
        node.getStart() <= read.getStart() &&
        read.getEnd() <= node.getEnd()
      )
        return false;
    }
    return true;
  }

  for (const node of nodes) {
    if (!ts.isParameter(node) || !ts.isIdentifier(node.name)) continue;
    const kind = handler(node);
    if (!kind) continue;
    const request = symbol(node.name);
    if (!request) continue;
    const uses = references.get(request) ?? [];
    if (
      uses.some((reference) => assignment(reference.parent) && reference.parent.left === reference)
    )
      continue;
    // `req.body` is one object however often it is read: the parameter stands for it.
    if (kind === 'body') {
      unsafe.set(node, []);
      handlers.set(node, node.parent);
    }
    for (const reference of uses) {
      if (reference === node.name) continue;
      let current: ts.Node = reference;
      while (transparent(current.parent)) current = current.parent;
      const access = current.parent;
      if (kind === 'body') {
        if (ts.isPropertyAccessExpression(access) && access.expression === current) {
          if (access.name.text === 'body') value(access, node, []);
        } else if (
          ts.isVariableDeclaration(access) &&
          access.initializer === current &&
          ts.isObjectBindingPattern(access.name)
        ) {
          // `const { body, query } = req`.
          for (const element of access.name.elements) {
            const key = element.propertyName ?? element.name;
            if (element.dotDotDotToken) mark(node, [], element);
            else if (ts.isIdentifier(key) && key.text === 'body')
              binding(element.name, node, [], constant(access));
          }
        } else
          // Handed anywhere, the request may get another body.
          mark(node, [], current);
        continue;
      }
      if (
        !ts.isPropertyAccessExpression(access) ||
        access.expression !== current ||
        access.name.text !== 'json' ||
        jsonWrites ||
        !ts.isCallExpression(access.parent) ||
        access.parent.expression !== access ||
        access.parent.arguments.length ||
        !ts.isAwaitExpression(access.parent.parent)
      )
        continue;
      // Each `await request.json()` parses a new object only this code holds.
      const root = access.parent.parent;
      unsafe.set(root, []);
      handlers.set(root, node.parent);
      value(root, root, []);
    }
  }

  return {
    value(expression: ts.Expression) {
      const site = sites.get(expression) ?? sites.get(unwrap(expression));
      return Boolean(
        site &&
        site.path[0] !== 'data' &&
        !unsafe
          .get(site.root)!
          .some(
            (entry) =>
              within(entry.path, site.path) &&
              !before(expression, entry.node, handlers.get(site.root)!),
          ),
      );
    },
  };
}
