import ts from 'typescript-compiler';
import { analyzeRepository } from './analyzer.ts';
import { applySourceEdits } from './patches.ts';
import type { ProviderAdapter } from './providers.ts';
import {
  CHECKOUT_SHIPPING_HELPER,
  COUPON_ID_HELPER,
  INVOICE_PRICE_ID_HELPER,
  INVOICE_SUBSCRIPTION_HELPER,
  PERIOD_HELPERS,
  PRODUCT_FEATURES_HELPER,
} from './stripe-subscription-periods.ts';
import type { Finding, Removal, Repository, SourceEdit } from './types.ts';

// Owner policies an AI patch must follow. A patch that breaks one stops for review, and the model
// gets no corrected request: the policy, not the model, decides these cases (docs/AI-PATCH-GUARD.md).

// Generated helpers that read the old shape when present and the new one otherwise.
const VERSION_TOLERANT_HELPERS = new Set<string>([
  ...Object.values(PERIOD_HELPERS),
  INVOICE_SUBSCRIPTION_HELPER,
  INVOICE_PRICE_ID_HELPER,
  CHECKOUT_SHIPPING_HELPER,
  COUPON_ID_HELPER,
  PRODUCT_FEATURES_HELPER,
]);
const SUPPRESSION = /@ts-(?:ignore|expect-error|nocheck)\b|eslint-disable\b/g;

const parse = (path: string, content: string) =>
  ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ||
  ts.isNonNullExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isSatisfiesExpression(node) ||
  ts.isTypeAssertionExpression(node)
    ? unwrap(node.expression)
    : node;

const lineOf = (source: ts.SourceFile, node: ts.Node) =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

function contentOf(repository: Repository, path: string) {
  return repository.files.find((file) => file.path === path)?.content;
}

// String literals used as event types: case labels and comparisons with a `.type` property.
function eventTypeLiterals(path: string, content: string) {
  const source = parse(path, content);
  const literals: string[] = [];
  const isType = (node: ts.Node) =>
    ts.isPropertyAccessExpression(node) && node.name.text === 'type';
  const visit = (node: ts.Node) => {
    const parent = node.parent;
    if (
      ts.isStringLiteralLike(node) &&
      ((ts.isCaseClause(parent) && parent.expression === node) ||
        (ts.isBinaryExpression(parent) &&
          [
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsEqualsToken,
            ts.SyntaxKind.EqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsToken,
          ].includes(parent.operatorToken.kind) &&
          isType(parent.left === node ? parent.right : parent.left)))
    )
      literals.push(node.text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return literals;
}

// Webhook event type literals the rules' code compares with and the AI's code no longer does.
export function changedEventTypes(before: Repository, after: Repository, files: Set<string>) {
  return [...files].flatMap((path) => {
    const original = contentOf(before, path);
    if (original === undefined) return [];
    const remaining = eventTypeLiterals(path, contentOf(after, path)!);
    return eventTypeLiterals(path, original).filter((literal) => {
      const index = remaining.indexOf(literal);
      if (index >= 0) remaining.splice(index, 1);
      return index < 0;
    });
  });
}

// Calls of the generated period helpers that pass a plan-item selector as their second argument,
// and period reads from one item the code picks, such as `subscription.items.data[0]`, directly,
// through a variable holding it or by destructuring it.
function periodItemChoices(path: string, content: string) {
  const source = parse(path, content);
  let count = 0;
  const period = (name: string) => /^current_period_(?:start|end)$/.test(name);
  // `<x>.items.data`, the list an item is picked from.
  const itemList = (node: ts.Expression) => {
    const list = unwrap(node);
    return (
      ts.isPropertyAccessExpression(list) &&
      list.name.text === 'data' &&
      ts.isPropertyAccessExpression(unwrap(list.expression)) &&
      (unwrap(list.expression) as ts.PropertyAccessExpression).name.text === 'items'
    );
  };
  const pickedItem = (node: ts.Expression) => {
    const item = unwrap(node);
    if (ts.isElementAccessExpression(item)) return itemList(item.expression);
    return (
      ts.isCallExpression(item) &&
      ts.isPropertyAccessExpression(item.expression) &&
      ['at', 'find'].includes(item.expression.name.text) &&
      itemList(item.expression.expression)
    );
  };
  // Variables holding a picked item: `const item = s.items.data[0]`, `const [item] = s.items.data`.
  const picked = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.arguments.length > 1) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name
        : node.expression;
      if (ts.isIdentifier(callee) && /^getSubscriptionPeriod(?:Start|End)$/.test(callee.text))
        count++;
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name) && pickedItem(node.initializer)) picked.add(node.name.text);
      if (ts.isArrayBindingPattern(node.name) && itemList(node.initializer)) {
        const [first] = node.name.elements;
        if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name))
          picked.add(first.name.text);
      }
      if (ts.isObjectBindingPattern(node.name) && pickedItem(node.initializer))
        count += node.name.elements.filter((element) =>
          period((element.propertyName ?? element.name).getText(source)),
        ).length;
    }
    if (ts.isPropertyAccessExpression(node) && period(node.name.text)) {
      const receiver = unwrap(node.expression);
      if (pickedItem(receiver) || (ts.isIdentifier(receiver) && picked.has(receiver.text))) count++;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return count;
}

// Files where the AI's code chooses a subscription item for the billing period more often than
// the rules' code. Whole files are compared, so an alias declared in one edit and read in another
// still counts.
export function addedItemChoices(before: Repository, after: Repository, files: Set<string>) {
  return [...files].filter(
    (path) =>
      periodItemChoices(path, contentOf(after, path)!) >
      periodItemChoices(path, contentOf(before, path) ?? ''),
  );
}

interface RequestPath {
  call: string;
  path: string;
  line: number;
}

// What each traced SDK call sends: its arguments, the property names of object-literal arguments,
// nested and inside arrays (`line_items[].price`), spreads, and string elements of arrays
// (`expand[]='data.customer'`). Values other than array strings are not compared.
function requestPaths(
  repository: Repository,
  path: string,
  sdkCalls: ReturnType<typeof analyzeRepository>['sdkCalls'],
) {
  const content = contentOf(repository, path);
  const calls = sdkCalls.filter((call) => call.file === path);
  if (content === undefined || !calls.length) return [];
  const source = parse(path, content);
  const starts = new Map(
    calls.map((call) => [
      source.getPositionOfLineAndCharacter(call.line - 1, call.column - 1),
      call,
    ]),
  );
  // `const params = { ... }; stripe.x.create(params)`: a body declared once in the file.
  const declared = new Map<string, ts.Expression | null>();
  const declarations = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      declared.set(node.name.text, declared.has(node.name.text) ? null : node.initializer);
    ts.forEachChild(node, declarations);
  };
  declarations(source);
  const paths: RequestPath[] = [];
  const visit = (node: ts.Node) => {
    const call = ts.isCallExpression(node) ? starts.get(node.getStart(source)) : undefined;
    // A chained call such as `.then()` starts at the same position; the method name picks the
    // traced one.
    if (
      call &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === call.method
    ) {
      const name = `${call.resource}.${call.method}`;
      const add = (value: string, at: ts.Node) =>
        paths.push({ call: name, path: value, line: lineOf(source, at) });
      const sent = (expression: ts.Expression, prefix: string) => {
        const value = unwrap(expression);
        if (ts.isObjectLiteralExpression(value))
          for (const property of value.properties) {
            if (ts.isSpreadAssignment(property)) {
              add(`${prefix}...${property.expression.getText(source)}`, property);
              continue;
            }
            const key = property.name;
            if (
              !key ||
              !(ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key))
            )
              continue;
            const keyPath = prefix ? `${prefix}.${key.text}` : key.text;
            add(keyPath, property);
            if (ts.isPropertyAssignment(property)) sent(property.initializer, keyPath);
          }
        else if (ts.isArrayLiteralExpression(value))
          for (const element of value.elements)
            if (ts.isStringLiteralLike(element)) add(`${prefix}[]='${element.text}'`, element);
            else sent(element, `${prefix}[]`);
      };
      node.arguments.forEach((argument, index) => {
        add(`argument ${index + 1}`, argument);
        const value = unwrap(argument);
        sent(
          (ts.isIdentifier(value) && declared.get(value.text)) || argument,
          index ? `argument ${index + 1}` : '',
        );
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return paths;
}

// Request parameters and arguments a traced SDK call sends in the rules' code and no longer sends
// in the AI's code, counted per file and method so moved or reordered calls still match.
export function droppedRequestPaths(
  before: Repository,
  after: Repository,
  files: Set<string>,
  provider: ProviderAdapter,
) {
  const beforeCalls = analyzeRepository(before, [], provider).sdkCalls;
  const afterCalls = analyzeRepository(after, [], provider).sdkCalls;
  const dropped: (RequestPath & { file: string })[] = [];
  for (const file of files) {
    const remaining = requestPaths(after, file, afterCalls);
    for (const sent of requestPaths(before, file, beforeCalls)) {
      const index = remaining.findIndex(
        (candidate) => candidate.call === sent.call && candidate.path === sent.path,
      );
      if (index >= 0) remaining.splice(index, 1);
      else dropped.push({ ...sent, file });
    }
  }
  return dropped;
}

// Type-only escapes: `any` types, `as unknown as` double assertions and comments that turn checks
// off. They make a broken read compile instead of migrating it.
function typeEscapes(path: string, content: string) {
  const source = parse(path, content);
  const escapes: { construct: string; line: number }[] = [];
  const visit = (node: ts.Node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword)
      escapes.push({ construct: 'any', line: lineOf(source, node) });
    let inner = ts.isAsExpression(node) ? node.expression : undefined;
    while (inner && ts.isParenthesizedExpression(inner)) inner = inner.expression;
    if (inner && ts.isAsExpression(inner) && inner.type.kind === ts.SyntaxKind.UnknownKeyword)
      escapes.push({ construct: 'as unknown as', line: lineOf(source, node) });
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const match of content.matchAll(SUPPRESSION))
    escapes.push({
      construct: match[0],
      line: source.getLineAndCharacterOfPosition(match.index).line + 1,
    });
  return escapes;
}

// Type escapes the AI's code has more of than the rules' code, per file and construct.
export function addedTypeEscapes(before: Repository, after: Repository, files: Set<string>) {
  return [...files].flatMap((path) => {
    const original = typeEscapes(path, contentOf(before, path) ?? '');
    return typeEscapes(path, contentOf(after, path)!)
      .filter((escape) => {
        const index = original.findIndex((candidate) => candidate.construct === escape.construct);
        if (index >= 0) original.splice(index, 1);
        return index < 0;
      })
      .map((escape) => ({ ...escape, file: path }));
  });
}

// An expression's text without optional chaining, non-null assertions or whitespace, so
// `session?.x` and `session!.x` name the same receiver.
const receiverText = (source: ts.SourceFile, node: ts.Expression) =>
  unwrap(node)
    .getText(source)
    .replace(/\s+/g, '')
    .replace(/\?\./g, '.')
    .replace(/!(?=[.[)\]]|$)/g, '');

// The receiver of the innermost read of `property` at `offset`: `session` in
// `session?.shipping_details?.address` and in `const { shipping_details } = session`.
function readReceiver(source: ts.SourceFile, offset: number, property: string) {
  let receiver: { text: string; width: number } | undefined;
  const visit = (node: ts.Node) => {
    if (offset < node.getStart(source) || offset >= node.getEnd()) return;
    const declaration = node.parent?.parent;
    const expression =
      ts.isPropertyAccessExpression(node) && node.name.text === property
        ? node.expression
        : ts.isElementAccessExpression(node) &&
            ts.isStringLiteralLike(node.argumentExpression) &&
            node.argumentExpression.text === property
          ? node.expression
          : ts.isBindingElement(node) &&
              (node.propertyName ?? node.name).getText(source) === property &&
              declaration &&
              ts.isVariableDeclaration(declaration) &&
              declaration.initializer
            ? declaration.initializer
            : undefined;
    const width = node.getEnd() - node.getStart(source);
    if (expression && (!receiver || width < receiver.width))
      receiver = { text: receiverText(source, expression), width };
    ts.forEachChild(node, visit);
  };
  visit(source);
  return receiver?.text;
}

// Whether code in [start, end) still reads `property` from `receiver`, or from a variable the
// code assigns it to there: by property access, string key, Reflect.get or destructuring, or
// through a generated helper that reads both shapes.
function readsOldShape(
  source: ts.SourceFile,
  start: number,
  end: number,
  receiver: string,
  property: string,
) {
  let found = false;
  const receivers = new Set([receiver]);
  const from = (expression: ts.Expression) => receivers.has(receiverText(source, expression));
  const visit = (node: ts.Node) => {
    if (found || node.getEnd() <= start || node.getStart(source) >= end) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      from(node.initializer)
    )
      receivers.add(node.name.text);
    if (
      (ts.isPropertyAccessExpression(node) &&
        node.name.text === property &&
        from(node.expression)) ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === property &&
        from(node.expression)) ||
      (ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        from(node.initializer) &&
        node.name.elements.some(
          (element) => (element.propertyName ?? element.name).getText(source) === property,
        ))
    )
      found = true;
    else if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : node.expression.getText(source);
      const [object, key] = node.arguments;
      if (
        VERSION_TOLERANT_HELPERS.has(callee) ||
        (node.expression.getText(source) === 'Reflect.get' &&
          object &&
          from(object) &&
          key &&
          ts.isStringLiteralLike(key) &&
          key.text === property)
      )
        found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// Reads of webhook payloads (or values known only from their Stripe type) that an AI edit rewrote
// without keeping the old shape. A payload arrives at the webhook endpoint's API version, which
// moves independently of the client, so a read must work for both shapes.
export function newShapeOnlyReads(
  repository: Repository,
  edits: SourceEdit[],
  findings: Finding[],
  changes: Removal[],
) {
  const patched = new Map<string, ts.SourceFile>();
  return findings.flatMap((finding) => {
    const change = changes.find((candidate) => candidate.id === finding.changeId);
    const content = contentOf(repository, finding.file);
    if (!change || !(finding.webhook || finding.declaredType) || content === undefined) return [];
    const fileEdits = edits.filter((edit) => edit.file === finding.file);
    const at =
      content
        .split('\n')
        .slice(0, finding.line - 1)
        .reduce((size, line) => size + line.length + 1, 0) +
      finding.column -
      1;
    const edit = fileEdits.find((candidate) => candidate.start <= at && at < candidate.end);
    if (!edit) return [];
    // The edit's place in the patched file: earlier edits shift it by their change in length.
    const start = fileEdits
      .filter((candidate) => candidate.start < edit.start)
      .reduce(
        (position, candidate) =>
          position + candidate.replacement.length - (candidate.end - candidate.start),
        edit.start,
      );
    const receiver = readReceiver(parse(finding.file, content), at, change.property);
    if (!patched.has(finding.file))
      patched.set(finding.file, parse(finding.file, applySourceEdits(content, fileEdits)));
    return receiver &&
      readsOldShape(
        patched.get(finding.file)!,
        start,
        start + edit.replacement.length,
        receiver,
        change.property,
      )
      ? []
      : [
          {
            file: finding.file,
            line: finding.line,
            schema: change.schema,
            property: change.property,
          },
        ];
  });
}
