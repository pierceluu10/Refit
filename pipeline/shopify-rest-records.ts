import ts from 'typescript-compiler';
import {
  assigned,
  declarationScope,
  followBody,
  propertyName,
  references,
  unwrap,
  unwrapParent,
  type Read,
} from './shopify-rest-rewrite.ts';

// A REST resource record built and saved in one scope (`const page = new admin.rest.resources.Page({
// session }); page.title = …; await page.save()`), traced for the versioned contract check in
// pipeline/shopify-rest-contract.ts. `save` sends the record's fields as the resource's request
// body (POST for a new record, PUT for one with an id; @shopify/shopify-api 12.3.0
// dist/cjs/rest/base.js), so every field the code assigns is a body key, and every field it reads
// back is a read. A record that leaves the scope (returned, passed to a function, stored) may get
// fields Refit cannot see, so it stops.

// Calls that only serialize a record (its toJSON()), which reads every field and writes none.
const SERIALIZERS =
  /^(?:console\.\w+|JSON\.stringify|json|Response\.json|NextResponse\.json|res\.json|res\.send)$/;

export interface RecordTrace {
  body: string[][];
  reads: Read[];
  saved: boolean;
}

export function traceRecord(construction: ts.NewExpression): RecordTrace | string {
  const options = construction.arguments?.[0] && unwrap(construction.arguments[0]);
  if (
    construction.arguments?.length !== 1 ||
    !options ||
    !ts.isObjectLiteralExpression(options) ||
    options.properties.some((entry) => propertyName(entry) !== 'session')
  )
    return 'The record is built with options other than `session`, so Refit cannot see every field it sends.';
  const declaration = unwrapParent(construction).parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    !(declaration.parent.flags & ts.NodeFlags.BlockScoped)
  )
    return 'The record is not held in a const or let Refit can follow.';
  const uses = references(declaration.name, declarationScope(declaration.parent));
  if (!uses) return `Another declaration shadows \`${declaration.name.text}\`.`;
  const trace: RecordTrace = { body: [], reads: [], saved: false };
  for (const use of uses) {
    if (assigned(use)) return `\`${use.text}\` is reassigned.`;
    const parent = use.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === use) {
      const name = parent.name.text;
      const outer = unwrapParent(parent);
      const called = ts.isCallExpression(outer.parent) && outer.parent.expression === outer;
      if (called) {
        if (name !== 'save')
          return `The code calls \`${use.text}.${name}()\`, which Refit does not trace for records.`;
        const saveOptions = outer.parent.arguments[0] && unwrap(outer.parent.arguments[0]);
        if (
          outer.parent.arguments.length > 1 ||
          (saveOptions &&
            (!ts.isObjectLiteralExpression(saveOptions) ||
              saveOptions.properties.some((entry) => propertyName(entry) !== 'update')))
        )
          return 'The record is saved with options other than `update`.';
        trace.saved = true;
        continue;
      }
      const write = outer.parent;
      if (
        ts.isBinaryExpression(write) &&
        write.left === outer &&
        write.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        write.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        trace.body.push([name]);
        // `x.a ??= v` and `x.a += v` also read the field.
        if (write.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
          trace.reads.push({ path: [name], whole: true });
        continue;
      }
      const followed = followBody(use, []);
      if (followed.stops.length) return followed.stops[0];
      trace.reads.push(...followed.reads);
      continue;
    }
    // The record itself: only serializing it or testing that it exists keeps it in this scope.
    let at: ts.Node = unwrapParent(use);
    while (
      ts.isShorthandPropertyAssignment(at.parent) ||
      (ts.isPropertyAssignment(at.parent) && at.parent.initializer === at) ||
      ts.isObjectLiteralExpression(at.parent) ||
      ts.isParenthesizedExpression(at.parent)
    )
      at = at.parent;
    if (ts.isCallExpression(at.parent) && at.parent.arguments.includes(at as ts.Expression)) {
      const callee = at.parent.expression.getText().replace(/\s+/g, '');
      if (SERIALIZERS.test(callee)) {
        if (!/^console\./.test(callee)) trace.reads.push({ path: [], whole: true });
        continue;
      }
    }
    if (
      at === unwrapParent(use) &&
      ((ts.isPrefixUnaryExpression(at.parent) &&
        at.parent.operator === ts.SyntaxKind.ExclamationToken) ||
        (ts.isIfStatement(at.parent) && at.parent.expression === at))
    )
      continue;
    return `The record is passed on (\`${at.parent.getText().replace(/\s+/g, ' ').slice(0, 60)}\`), so Refit cannot see every field it sends.`;
  }
  return trace;
}

// The record each `new <shopify>.rest.<Resource>(…)` entry of one file builds, traced.
export function traceFileRecords<
  Entry extends { line: number; column: number; expression: string },
>(file: string, content: string, entries: Entry[]) {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    /\.[cm]?tsx?$/.test(file)
      ? file.endsWith('x')
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.TS
      : file.endsWith('x')
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS,
  );
  const traces = new Map<Entry, RecordTrace | string>();
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node)) {
      const at = source.getLineAndCharacterOfPosition(node.getStart());
      const entry = entries.find(
        (item) =>
          item.line === at.line + 1 &&
          item.column === at.character + 1 &&
          item.expression === node.expression.getText(),
      );
      if (entry) traces.set(entry, traceRecord(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return traces;
}
