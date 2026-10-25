import ts from 'typescript-compiler';
import { sourceRows } from './source-rows.ts';

// Read-only array methods: they return an element, a copy or a value, and never change the array.
const ELEMENT_METHODS = new Set(['find', 'findLast', 'at']);
const COPY_METHODS = new Set(['filter', 'slice', 'toSorted', 'toReversed']);
const READ_METHODS = new Set([
  ...ELEMENT_METHODS,
  ...COPY_METHODS,
  'map',
  'forEach',
  'some',
  'every',
  'findIndex',
  'findLastIndex',
  'indexOf',
  'includes',
  'join',
  'reduce',
  'flatMap',
]);
// Callback parameters that receive the array's elements.
const ELEMENT_CALLBACKS = new Set([
  'find',
  'findLast',
  'filter',
  'map',
  'forEach',
  'some',
  'every',
  'findIndex',
  'findLastIndex',
  'flatMap',
]);

// Values that are objects written as object literals in the application's own source, so a read
// on them is never a read of a Stripe object: a `const` bound to an object literal (it always holds
// that object), an element of a `const` array literal of object literals, or a property of a
// `const` object literal that is itself one. A constant whose elements or properties are read must
// stay untouched everywhere it is referenced: only read through properties, indexes, `for…of` and
// read-only array methods, exported or imported, never assigned into, deleted, placed in another
// value or passed anywhere, so nothing can put a Stripe object into it. So must an element taken out
// of it (a `find` result or a copy, a `for…of` variable, a callback's parameter): it is only read
// through its properties, or, for a `find` result or a copy, returned. Anything else is not proven.
export function sourceLiterals(options: {
  nodes: ts.Node[];
  symbol: (node: ts.Node) => ts.Symbol | undefined;
}) {
  const { nodes, symbol } = options;
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
      ? unwrap(node.expression)
      : node;
  const references = new Map<ts.Symbol, ts.Identifier[]>();
  // Names used where they resolve to no declaration in the scanned source: an import Refit could
  // not resolve, a global, `require(…).NAME`. A constant of that name may be changed there unseen.
  const unresolved = new Set<string>();
  // `{ plan }` resolves to the property, not to the constant it places in the object.
  const shorthand = new Set<string>();
  for (const node of nodes) {
    if (!ts.isIdentifier(node)) continue;
    if (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node)
      shorthand.add(node.text);
    const binding = symbol(node);
    if (binding) references.set(binding, [...(references.get(binding) ?? []), node]);
    const declaration = binding?.declarations?.[0];
    if (
      !declaration ||
      ts.isImportSpecifier(declaration) ||
      ts.isImportClause(declaration) ||
      ts.isNamespaceImport(declaration) ||
      ts.isImportEqualsDeclaration(declaration) ||
      ts.isBindingElement(declaration)
    )
      unresolved.add(node.text);
  }
  const untouched = new Map<ts.Symbol, boolean>();
  // Every reference only reads the constant.
  function readOnly(binding: ts.Symbol) {
    if (untouched.has(binding)) return untouched.get(binding)!;
    untouched.set(binding, false);
    const result =
      !unresolved.has(binding.name) &&
      !shorthand.has(binding.name) &&
      (references.get(binding) ?? []).every((reference) => {
        const parent = reference.parent;
        if (
          (ts.isVariableDeclaration(parent) && parent.name === reference) ||
          ts.isImportSpecifier(parent) ||
          ts.isImportClause(parent) ||
          ts.isExportSpecifier(parent)
        )
          return true;
        let read: ts.Expression = reference;
        while (ts.isParenthesizedExpression(read.parent) || ts.isNonNullExpression(read.parent))
          read = read.parent;
        const outer = read.parent;
        if (ts.isForOfStatement(outer) && outer.expression === read)
          return elementVariable(outer.initializer);
        // `X.property`, `X[index]`, or `X.find(…)` and the other read-only methods.
        if (
          !(ts.isPropertyAccessExpression(outer) && outer.expression === read) &&
          !(ts.isElementAccessExpression(outer) && outer.expression === read)
        )
          return false;
        if (ts.isPropertyAccessExpression(outer) && ts.isCallExpression(outer.parent)) {
          const call = outer.parent;
          if (call.expression !== outer) return false;
          if (!READ_METHODS.has(outer.name.text)) return false;
          // An element or a copy of the elements leaves the call: it must only be read.
          if (
            (ELEMENT_METHODS.has(outer.name.text) || COPY_METHODS.has(outer.name.text)) &&
            !accessed(call) &&
            !returned(call) &&
            !(ELEMENT_METHODS.has(outer.name.text) && bound(call))
          )
            return false;
          const callback = call.arguments[0] && unwrap(call.arguments[0]);
          const element =
            ELEMENT_CALLBACKS.has(outer.name.text) &&
            callback &&
            (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
              ? callback.parameters[0]
              : undefined;
          if (element && !(ts.isIdentifier(element.name) && readThrough(element.name)))
            return false;
        }
        return !written(outer);
      });
    untouched.set(binding, result);
    return result;
  }
  // A `for…of` variable that receives the elements, read only through its properties.
  function elementVariable(initializer: ts.ForInitializer) {
    const [declaration] = ts.isVariableDeclarationList(initializer) ? initializer.declarations : [];
    return Boolean(
      declaration && ts.isIdentifier(declaration.name) && readThrough(declaration.name),
    );
  }
  // Every use of a name that holds an element reads a property of it and changes nothing: it is
  // never bound, passed or placed anywhere, where the element could be changed unseen.
  function readThrough(name: ts.Identifier) {
    const binding = symbol(name);
    return Boolean(
      binding &&
      (references.get(binding) ?? []).every(
        (reference) => reference === name || accessed(reference),
      ),
    );
  }
  // `const plan = isSubscribed ? PLANS.find(…) : null`: an element held by a constant that is only
  // read through its properties or spread into a copy, like `...PLANS[0]`.
  function bound(value: ts.Expression) {
    let current = value;
    for (;;) {
      const parent = current.parent;
      if (
        ts.isParenthesizedExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isAsExpression(parent) ||
        (ts.isConditionalExpression(parent) && parent.condition !== current) ||
        (ts.isBinaryExpression(parent) &&
          [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
            parent.operatorToken.kind,
          ))
      )
        current = parent;
      else break;
    }
    const declaration = current.parent;
    if (
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer !== current ||
      !ts.isIdentifier(declaration.name) ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      !(declaration.parent.flags & ts.NodeFlags.Const) ||
      shorthand.has(declaration.name.text)
    )
      return false;
    const binding = symbol(declaration.name);
    return Boolean(
      binding &&
      (references.get(binding) ?? []).every((reference) => {
        if (reference === declaration.name || accessed(reference)) return true;
        let read: ts.Node = reference;
        while (ts.isParenthesizedExpression(read.parent)) read = read.parent;
        return ts.isSpreadAssignment(read.parent) || ts.isSpreadElement(read.parent);
      }),
    );
  }
  // The value is returned: directly, as a conditional's branch or in a returned object literal.
  function returned(value: ts.Expression) {
    let current = value;
    for (;;) {
      const parent = current.parent;
      if (
        ts.isParenthesizedExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        (ts.isConditionalExpression(parent) && parent.condition !== current)
      )
        current = parent;
      else if (ts.isPropertyAssignment(parent) && parent.initializer === current)
        current = parent.parent;
      else
        return (
          ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === current)
        );
    }
  }
  // The value is read through a property or an index that nothing assigns into or changes.
  function accessed(value: ts.Expression) {
    let current = value;
    while (ts.isParenthesizedExpression(current.parent) || ts.isNonNullExpression(current.parent))
      current = current.parent;
    const parent = current.parent;
    return (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === current &&
      !changed(parent)
    );
  }
  const outermost = (access: ts.Expression) => {
    let current: ts.Expression = access;
    while (
      (ts.isPropertyAccessExpression(current.parent) ||
        ts.isElementAccessExpression(current.parent)) &&
      current.parent.expression === current
    )
      current = current.parent;
    return current;
  };
  // `X.a = …`, `X.a++`, `delete X.a`, `X.a.b = …`, destructuring targets and a method call that is
  // not a read-only one change X.
  function changed(access: ts.Expression): boolean {
    const current = outermost(access);
    const parent = current.parent;
    if (
      (ts.isBinaryExpression(parent) &&
        parent.left === current &&
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator)) ||
      ts.isDeleteExpression(parent) ||
      ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) &&
        parent.initializer === current)
    )
      return true;
    // `X.list.find(…)`: a method call on a nested value must be a read-only one.
    return (
      ts.isCallExpression(parent) &&
      parent.expression === current &&
      !(ts.isPropertyAccessExpression(current) && READ_METHODS.has(current.name.text))
    );
  }
  function written(access: ts.Expression): boolean {
    if (changed(access)) return true;
    const current = outermost(access);
    const parent = current.parent;
    if (ts.isCallExpression(parent) && parent.expression === current) return false;
    // A nested object or array handed anywhere (a variable, an argument, another value) could be
    // changed through that alias; a primitive leaf or a spread copy cannot.
    return !ts.isSpreadAssignment(parent) && !ts.isSpreadElement(parent) && container(current);
  }
  // Whether the value a reference chain reads from its constant's literal is, or may be, an
  // object or an array. A primitive written in the literal is not.
  function container(chain: ts.Expression): boolean {
    const hops: (string | number | undefined)[] = [];
    let current: ts.Expression = chain;
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      hops.unshift(
        ts.isPropertyAccessExpression(current)
          ? current.name.text
          : ts.isStringLiteral(current.argumentExpression)
            ? current.argumentExpression.text
            : ts.isNumericLiteral(current.argumentExpression)
              ? Number(current.argumentExpression.text)
              : undefined,
      );
      current = unwrap(current.expression);
    }
    const declaration = ts.isIdentifier(current) ? symbol(current)?.valueDeclaration : undefined;
    let value =
      declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
        ? unwrap(declaration.initializer)
        : undefined;
    for (const hop of hops) {
      if (!value) return true;
      if (typeof hop === 'number' && ts.isArrayLiteralExpression(value))
        value = value.elements[hop] && unwrap(value.elements[hop]);
      else if (typeof hop === 'string' && ts.isObjectLiteralExpression(value)) {
        const property = value.properties.find(
          (entry) =>
            ts.isPropertyAssignment(entry) &&
            (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) &&
            entry.name.text === hop,
        );
        value =
          property && ts.isPropertyAssignment(property) ? unwrap(property.initializer) : undefined;
      } else return true;
    }
    return (
      !value ||
      ts.isObjectLiteralExpression(value) ||
      ts.isArrayLiteralExpression(value) ||
      ts.isIdentifier(value) ||
      ts.isPropertyAccessExpression(value) ||
      ts.isElementAccessExpression(value) ||
      ts.isCallExpression(value) ||
      ts.isConditionalExpression(value)
    );
  }
  // An object literal with no spreads, accessors or methods: a plain value written in code.
  const plainObject = (node: ts.Expression) =>
    ts.isObjectLiteralExpression(node) &&
    node.properties.every(
      (property) => ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property),
    );
  function constant(expression: ts.Expression, contents = true) {
    const current = unwrap(expression);
    if (!ts.isIdentifier(current)) return;
    const binding = symbol(current);
    const declaration = binding?.valueDeclaration;
    if (
      !binding ||
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !ts.isIdentifier(declaration.name) ||
      !declaration.initializer ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      !(declaration.parent.flags & ts.NodeFlags.Const) ||
      (contents && !readOnly(binding))
    )
      return;
    return unwrap(declaration.initializer);
  }
  // The array literal of plain objects an expression evaluates to, or a copy of its elements.
  function literalArray(expression: ts.Expression): boolean {
    const current = unwrap(expression);
    if (ts.isArrayLiteralExpression(current))
      return current.elements.every((element) => literalObject(element));
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      COPY_METHODS.has(current.expression.name.text)
    )
      return literalArray(current.expression.expression);
    const value = constant(current);
    return Boolean(value && ts.isArrayLiteralExpression(value) && literalArray(value));
  }
  function literalObject(expression: ts.Expression): boolean {
    const current = unwrap(expression);
    if (plainObject(current)) return true;
    // `PLANS.find((plan) => …)` or `PLANS[0]`: an element of the array.
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ELEMENT_METHODS.has(current.expression.name.text)
    )
      return literalArray(current.expression.expression);
    if (ts.isElementAccessExpression(current))
      return (
        literalArray(current.expression) ||
        literalProperty(current.expression, current.argumentExpression)
      );
    if (ts.isPropertyAccessExpression(current))
      return literalProperty(current.expression, current.name);
    if (!ts.isIdentifier(current)) return false;
    const value = constant(current);
    if (value && plainObject(value)) return true;
    // A callback parameter that receives the elements of a literal array.
    const declaration = symbol(current)?.valueDeclaration;
    if (
      declaration &&
      ts.isParameter(declaration) &&
      ts.isIdentifier(declaration.name) &&
      !declaration.dotDotDotToken &&
      !declaration.initializer &&
      (ts.isArrowFunction(declaration.parent) || ts.isFunctionExpression(declaration.parent)) &&
      declaration.parent.parameters[0] === declaration &&
      ts.isCallExpression(declaration.parent.parent) &&
      declaration.parent.parent.arguments[0] === declaration.parent &&
      ts.isPropertyAccessExpression(declaration.parent.parent.expression) &&
      ELEMENT_CALLBACKS.has(declaration.parent.parent.expression.name.text) &&
      !parameterWritten(symbol(current)!)
    )
      return literalArray(declaration.parent.parent.expression.expression);
    // `for (const plan of PLANS)`.
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const &&
      ts.isForOfStatement(declaration.parent.parent)
    )
      return literalArray(declaration.parent.parent.expression);
    return false;
  }
  // A parameter reassigned inside its callback no longer holds the element.
  function parameterWritten(binding: ts.Symbol) {
    return (references.get(binding) ?? []).some((reference) => {
      const parent = reference.parent;
      return (
        (ts.isBinaryExpression(parent) &&
          parent.left === reference &&
          parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
        ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
          [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator))
      );
    });
  }
  // `PRICES.MICRO` where the literal's `MICRO` is itself a plain object (or a literal array's
  // element through an index).
  function literalProperty(owner: ts.Expression, name: ts.Expression | ts.MemberName): boolean {
    const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
    if (key === undefined) return false;
    const object = literalSource(owner);
    if (!object) return false;
    const property = object.properties.find(
      (entry) =>
        ts.isPropertyAssignment(entry) &&
        (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) &&
        entry.name.text === key,
    );
    return Boolean(
      property && ts.isPropertyAssignment(property) && literalObject(property.initializer),
    );
  }
  // The object literal an expression is written as, when it is a constant or a property of one.
  function literalSource(expression: ts.Expression): ts.ObjectLiteralExpression | undefined {
    const current = unwrap(expression);
    if (plainObject(current)) return current as ts.ObjectLiteralExpression;
    const value = constant(current);
    if (value && plainObject(value)) return value as ts.ObjectLiteralExpression;
    if (ts.isPropertyAccessExpression(current)) {
      const owner = literalSource(current.expression);
      const property = owner?.properties.find(
        (entry) =>
          ts.isPropertyAssignment(entry) &&
          (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) &&
          entry.name.text === current.name.text,
      );
      return property && ts.isPropertyAssignment(property)
        ? literalSource(property.initializer)
        : undefined;
    }
    return undefined;
  }
  const rows = sourceRows({ symbol, nodes, references, shorthand });
  // Rows a database client returns are not Stripe objects either (`pipeline/source-rows.ts`).
  return {
    literalObject: (expression: ts.Expression) => literalObject(expression) || rows.row(expression),
  };
}
