import { diffLines } from 'diff';
import ts from 'typescript-compiler';
import { analyzeRepository } from './analyzer.ts';
import { applySourceEdits } from './patches.ts';
import type { ProviderAdapter } from './providers.ts';
import { TEST_PATH } from './source-paths.ts';
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

// Generated helpers that read the old shape when present and the new one otherwise, with the
// removed field each one reads from its first argument.
const VERSION_TOLERANT_HELPERS = new Map<string, { schema: string; property: string }>([
  ...Object.entries(PERIOD_HELPERS).map(
    ([property, helper]) => [helper, { schema: 'subscription', property }] as const,
  ),
  [INVOICE_SUBSCRIPTION_HELPER, { schema: 'invoice', property: 'subscription' }],
  [INVOICE_PRICE_ID_HELPER, { schema: 'line_item', property: 'price' }],
  [CHECKOUT_SHIPPING_HELPER, { schema: 'checkout.session', property: 'shipping_details' }],
  [COUPON_ID_HELPER, { schema: 'discount', property: 'coupon' }],
  [PRODUCT_FEATURES_HELPER, { schema: 'product', property: 'features' }],
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

// The name a property access or string-keyed element access reads: `data` in `x.data` and
// `x['data']`.
const accessedName = (node: ts.Node) =>
  ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
      ? node.argumentExpression.text
      : undefined;

// Calls of the generated period helpers that pass a plan-item selector as their second argument
// (`selectors`), and period reads from one item the code picks (`picks`), such as
// `subscription.items.data[0]`: directly, through a variable holding the item or the list, by
// destructuring or by `Reflect.get`. Reading other fields from a picked item is not a choice.
function periodItemChoices(path: string, content: string) {
  const source = parse(path, content);
  const choices = { selectors: 0, picks: 0 };
  const period = (name: string | undefined) =>
    !!name && /^current_period_(?:start|end)$/.test(name);
  // Variables holding an item list (`const items = s.items.data`, `const { data } = s.items`) or a
  // picked item (`const item = s.items.data[0]`, `const [item] = s.items.data`).
  const lists = new Set<string>();
  const picked = new Set<string>();
  const named = (node: ts.Expression, names: Set<string>) => {
    const value = unwrap(node);
    return ts.isIdentifier(value) && names.has(value.text);
  };
  // `<x>.items.data`, `items.data` after `const { items } = x`, or a variable holding the list.
  const itemList = (node: ts.Expression) => {
    const list = unwrap(node);
    if (named(list, lists)) return true;
    if (accessedName(list) !== 'data') return false;
    const items = unwrap(
      (list as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression,
    );
    return accessedName(items) === 'items' || (ts.isIdentifier(items) && items.text === 'items');
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
  const fromItem = (node: ts.Expression) => pickedItem(node) || named(node, picked);
  const bound = (pattern: ts.ObjectBindingPattern, name: (text: string) => boolean) =>
    pattern.elements.filter((element) =>
      name((element.propertyName ?? element.name).getText(source)),
    );
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.arguments.length > 1) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name
        : node.expression;
      if (ts.isIdentifier(callee) && /^getSubscriptionPeriod(?:Start|End)$/.test(callee.text))
        choices.selectors++;
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name) && pickedItem(node.initializer)) picked.add(node.name.text);
      if (ts.isIdentifier(node.name) && itemList(node.initializer)) lists.add(node.name.text);
      if (ts.isArrayBindingPattern(node.name) && itemList(node.initializer)) {
        const [first] = node.name.elements;
        if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name))
          picked.add(first.name.text);
      }
      if (ts.isObjectBindingPattern(node.name)) {
        if (accessedName(unwrap(node.initializer)) === 'items')
          for (const element of bound(node.name, (text) => text === 'data'))
            if (ts.isIdentifier(element.name)) lists.add(element.name.text);
        if (fromItem(node.initializer)) choices.picks += bound(node.name, period).length;
      }
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      period(accessedName(node)) &&
      fromItem(node.expression)
    )
      choices.picks++;
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'Reflect.get' &&
      node.arguments.length > 1 &&
      fromItem(node.arguments[0]) &&
      ts.isStringLiteralLike(node.arguments[1]) &&
      period(node.arguments[1].text)
    )
      choices.picks++;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return choices;
}

// Files where the AI's code has more selector calls or more picked-item period reads than the
// rules' code; each kind is counted on its own, so replacing a reviewed selector with a pick still
// counts. Whole files are compared, so an alias declared in one edit and read in another counts.
export function addedItemChoices(before: Repository, after: Repository, files: Set<string>) {
  return [...files].filter((path) => {
    const added = periodItemChoices(path, contentOf(after, path)!);
    const original = periodItemChoices(path, contentOf(before, path) ?? '');
    return added.selectors > original.selectors || added.picks > original.picks;
  });
}

interface RequestPath {
  call: string;
  path: string;
  line: number;
}

// The values a function body returns, not counting nested functions.
function returnedValues(body: ts.ConciseBody) {
  if (!ts.isBlock(body)) return [body];
  const values: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isReturnStatement(node) && node.expression) values.push(node.expression);
    else if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return values;
}

// The declaration `name` refers to at `node`: the nearest variable or function of that name
// declared in an enclosing block, case clause or the file. A parameter of that name shadows it.
function declarationOf(source: ts.SourceFile, name: string, node: ts.Node) {
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (
      ts.isFunctionLike(scope) &&
      scope.parameters.some((parameter) => parameter.name.getText(source) === name)
    )
      return undefined;
    if (
      !ts.isBlock(scope) &&
      !ts.isSourceFile(scope) &&
      !ts.isModuleBlock(scope) &&
      !ts.isCaseOrDefaultClause(scope)
    )
      continue;
    for (const statement of scope.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name)
            return declaration;
    }
  }
  return undefined;
}

// Keys a body gets after its declaration, `params.locale = 'zh'` or `params['locale'] = 'zh'`,
// anywhere in the block that declares it.
function assignedKeys(declaration: ts.VariableDeclaration, name: string) {
  const keys: { key: string; value: ts.Expression; at: ts.Node }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = unwrap(node.left);
      const key = accessedName(target);
      if (
        key !== undefined &&
        ts.isIdentifier(unwrap((target as ts.PropertyAccessExpression).expression)) &&
        (unwrap((target as ts.PropertyAccessExpression).expression) as ts.Identifier).text === name
      )
        keys.push({ key, value: node.right, at: node });
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.parent.parent.parent);
  return keys;
}

// A value that sends nothing for its key: `undefined`, `void 0` and `null`, which Stripe reads as
// unset.
const unset = (node: ts.Expression) => {
  const value = unwrap(node);
  return (
    (ts.isIdentifier(value) && value.text === 'undefined') ||
    ts.isVoidExpression(value) ||
    value.kind === ts.SyntaxKind.NullKeyword
  );
};
const UNSET = '=unset';

// What each traced SDK call sends: its arguments, the property names of object-literal arguments,
// nested and inside arrays (`line_items[].price`), spreads, and literal values (`mode='payment'`,
// `expand[]='data.customer'`). A body passed by name is followed to its declaration in scope, with
// the keys assigned to it later; so is a body a function in the file returns and a spread of
// either. A key whose value unsets it is recorded as `key=unset`, not as sent. Other values, such
// as variables, are not compared.
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
      // Declarations already being followed, so a body that spreads itself ends.
      const following = new Set<ts.Node>();
      const key = (prefix: string, text: string) => (prefix ? `${prefix}.${text}` : text);
      const sentKey = (keyPath: string, value: ts.Expression | undefined, at: ts.Node) => {
        if (value && unset(value)) return add(`${keyPath}${UNSET}`, at);
        add(keyPath, at);
        if (value) sent(value, keyPath);
      };
      // The bodies an expression names: a variable's initializer and its later keys, or what a
      // function declared in the file returns.
      const followed = (expression: ts.Expression, prefix: string) => {
        const value = unwrap(expression);
        const named = ts.isIdentifier(value)
          ? value
          : ts.isCallExpression(value) && ts.isIdentifier(value.expression)
            ? value.expression
            : undefined;
        const declaration = named && declarationOf(source, named.text, value);
        if (!declaration || following.has(declaration)) return false;
        following.add(declaration);
        if (ts.isIdentifier(value) && ts.isVariableDeclaration(declaration)) {
          if (!declaration.initializer) return false;
          if (!followed(declaration.initializer, prefix)) sent(declaration.initializer, prefix);
          for (const assigned of assignedKeys(declaration, value.text))
            sentKey(key(prefix, assigned.key), assigned.value, assigned.at);
          return true;
        }
        const builder = ts.isFunctionDeclaration(declaration)
          ? declaration
          : ts.isVariableDeclaration(declaration) && declaration.initializer
            ? unwrap(declaration.initializer)
            : undefined;
        if (
          !ts.isCallExpression(value) ||
          !builder ||
          !(
            ts.isFunctionDeclaration(builder) ||
            ts.isArrowFunction(builder) ||
            ts.isFunctionExpression(builder)
          ) ||
          !builder.body
        )
          return false;
        for (const built of returnedValues(builder.body)) sent(built, prefix);
        return true;
      };
      const sent = (expression: ts.Expression, prefix: string) => {
        const value = unwrap(expression);
        const literal = ts.isStringLiteralLike(value)
          ? `'${value.text}'`
          : ts.isNumericLiteral(value) ||
              [
                ts.SyntaxKind.TrueKeyword,
                ts.SyntaxKind.FalseKeyword,
                ts.SyntaxKind.NullKeyword,
              ].includes(value.kind)
            ? value.getText(source)
            : undefined;
        if (literal) add(`${prefix || 'argument 1'}=${literal}`, value);
        else if (ts.isObjectLiteralExpression(value))
          for (const property of value.properties) {
            if (ts.isSpreadAssignment(property)) {
              // Without whitespace, so reflowing a spread over several lines still matches.
              add(
                `${prefix}...${property.expression.getText(source).replace(/\s+/g, '')}`,
                property,
              );
              followed(property.expression, prefix);
              continue;
            }
            const name = property.name;
            if (
              !name ||
              !(ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
            )
              continue;
            sentKey(
              key(prefix, name.text),
              ts.isPropertyAssignment(property) ? property.initializer : undefined,
              property,
            );
          }
        else if (ts.isArrayLiteralExpression(value))
          for (const element of value.elements) sent(element, `${prefix}[]`);
      };
      node.arguments.forEach((argument, index) => {
        add(`argument ${index + 1}`, argument);
        const prefix = index ? `argument ${index + 1}` : '';
        if (!followed(argument, prefix)) sent(argument, prefix);
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return paths;
}

const inside = (inner: RequestPath, outer: RequestPath) =>
  inner.call === outer.call &&
  inner.path.length > outer.path.length &&
  inner.path.startsWith(outer.path) &&
  '=.['.includes(inner.path[outer.path.length]);

// Request parameters, arguments and literal values a traced SDK call sends in the rules' code and
// no longer sends in the AI's code, counted per file and method so moved or reordered calls still
// match, and keys the AI's code newly unsets, such as one overriding a spread with `undefined`. A
// dropped path inside another dropped path, such as the value of a dropped key, is left out of
// the result. A removed parameter moved to its documented replacement still counts: the owner
// keeps that move to the deterministic rules (docs/STRIPE-PAYMENT-METHOD-TYPES.md).
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
    for (const added of remaining) if (added.path.endsWith(UNSET)) dropped.push({ ...added, file });
  }
  return dropped.filter(
    (entry) =>
      !dropped.some(
        (outer) => outer !== entry && outer.file === entry.file && inside(entry, outer),
      ),
  );
}

// Files the AI changed on the repository's test paths (source-paths.ts): the checks that judge a
// migration stay as the repository wrote them.
export const editedTestFiles = (files: Set<string>) =>
  [...files].filter((path) => TEST_PATH.test(path));

// 0-based lines of the middle text that a diff from `from` to `to` writes (`added`, lines of
// `to`) or deletes and replaces (`removed`, lines of `from`).
function diffedLines(from: string, to: string, kind: 'added' | 'removed') {
  const lines = new Set<number>();
  let line = 0;
  for (const part of diffLines(from, to)) {
    if (kind === 'added' ? part.removed : part.added) continue;
    if (part[kind]) for (let index = 0; index < part.count; index++) lines.add(line + index);
    line += part.count;
  }
  return lines;
}

// Lines the deterministic rules wrote that the AI's code changes or deletes again, as 1-based
// lines of the rules' code. The AI builds on a rule's edit and never redoes it: the edit is
// reviewed with its rule. A line the AI's replacement repeats unchanged is not counted.
export function rewrittenRuleLines(
  original: Repository,
  rules: Repository,
  after: Repository,
  files: Set<string>,
) {
  return [...files].flatMap((path) => {
    const ruled = contentOf(rules, path);
    const base = contentOf(original, path) ?? '';
    if (ruled === undefined || ruled === base) return [];
    const written = diffedLines(base, ruled, 'added');
    return [...diffedLines(ruled, contentOf(after, path)!, 'removed')]
      .filter((line) => written.has(line))
      .map((line) => ({ file: path, line: line + 1 }));
  });
}

// Type-only escapes: `any` types, `as unknown as` double assertions, `as never` and comments that
// turn checks off. They make a broken read compile instead of migrating it.
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
    if (ts.isAsExpression(node) && node.type.kind === ts.SyntaxKind.NeverKeyword)
      escapes.push({ construct: 'as never', line: lineOf(source, node) });
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
// through the generated helper for `property` called on it. Every read of `property` from deeper
// in the receiver, such as `session.collected_information.shipping_details`, must be paired with
// an old-shape read; one dual read does not clear the others.
function readsOldShape(
  source: ts.SourceFile,
  start: number,
  end: number,
  receiver: string,
  property: string,
) {
  const receivers = new Set([receiver]);
  const from = (expression: ts.Expression) => receivers.has(receiverText(source, expression));
  const deeper = (expression: ts.Expression) => {
    const text = receiverText(source, expression);
    return [...receivers].some((name) => text.startsWith(`${name}.`));
  };
  const oldReads: ts.Node[] = [];
  const newReads: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (node.getEnd() <= start || node.getStart(source) >= end) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      from(node.initializer)
    )
      receivers.add(node.name.text);
    const read =
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      accessedName(node) === property
        ? node.expression
        : ts.isVariableDeclaration(node) &&
            ts.isObjectBindingPattern(node.name) &&
            node.initializer &&
            node.name.elements.some(
              (element) => (element.propertyName ?? element.name).getText(source) === property,
            )
          ? node.initializer
          : undefined;
    if (read && from(read)) oldReads.push(node);
    else if (read && deeper(read)) newReads.push(node);
    else if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : node.expression.getText(source);
      const [object, key] = node.arguments;
      if (
        object &&
        from(object) &&
        (VERSION_TOLERANT_HELPERS.get(callee)?.property === property ||
          (node.expression.getText(source) === 'Reflect.get' &&
            key &&
            ts.isStringLiteralLike(key) &&
            key.text === property))
      )
        oldReads.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const within = (node: ts.Node) =>
    oldReads.some(
      (old) => old.getStart(source) >= node.getStart(source) && old.getEnd() <= node.getEnd(),
    );
  // Paired: a `??` or `||` with an old-shape read on either side, or a conditional or `if` whose
  // condition reads the old shape.
  const paired = (read: ts.Node) => {
    for (let scope = read.parent; scope && !ts.isSourceFile(scope); scope = scope.parent)
      if (
        (ts.isBinaryExpression(scope) &&
          [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
            scope.operatorToken.kind,
          ) &&
          within(scope)) ||
        (ts.isConditionalExpression(scope) && within(scope.condition)) ||
        (ts.isIfStatement(scope) && within(scope.expression))
      )
        return true;
    return false;
  };
  return oldReads.length > 0 && newReads.every(paired);
}

// Where an edit's replacement starts in the patched file: earlier edits shift it by their change
// in length.
const patchedStart = (fileEdits: SourceEdit[], edit: SourceEdit) =>
  fileEdits
    .filter((candidate) => candidate.start < edit.start)
    .reduce(
      (position, candidate) =>
        position + candidate.replacement.length - (candidate.end - candidate.start),
      edit.start,
    );

// Dual-shape reads inside the code an edit replaces: generated helper calls and `Reflect.get` of a
// removed field, which the rules or an earlier AI round wrote and which are no longer findings.
function dualReads(source: ts.SourceFile, edit: SourceEdit, changes: Removal[]) {
  const reads: { line: number; receiver: string; schema: string; property: string }[] = [];
  const visit = (node: ts.Node) => {
    if (node.getEnd() <= edit.start || node.getStart(source) >= edit.end) return;
    if (
      ts.isCallExpression(node) &&
      node.getStart(source) >= edit.start &&
      node.getEnd() <= edit.end &&
      node.arguments.length
    ) {
      const [object, key] = node.arguments;
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : node.expression.getText(source);
      const removed =
        node.expression.getText(source) === 'Reflect.get' && key && ts.isStringLiteralLike(key)
          ? changes.find((change) => change.property === key.text)
          : undefined;
      const read = VERSION_TOLERANT_HELPERS.get(callee) ?? removed;
      if (read)
        reads.push({
          line: lineOf(source, node),
          receiver: receiverText(source, object),
          schema: read.schema,
          property: read.property,
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
}

// Reads of webhook payloads (or values known only from their Stripe type) that an AI edit rewrote
// without keeping the old shape, and dual-shape reads in the edited code that the edit dropped. A
// payload arrives at the webhook endpoint's API version, which moves independently of the client,
// so a read must work for both shapes.
export function newShapeOnlyReads(
  repository: Repository,
  edits: SourceEdit[],
  findings: Finding[],
  changes: Removal[],
) {
  const patched = new Map<string, ts.SourceFile>();
  const patchedFile = (file: string, content: string) => {
    if (!patched.has(file))
      patched.set(
        file,
        parse(
          file,
          applySourceEdits(
            content,
            edits.filter((edit) => edit.file === file),
          ),
        ),
      );
    return patched.get(file)!;
  };
  const rewritten = findings.flatMap((finding) => {
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
    const start = patchedStart(fileEdits, edit);
    const receiver = readReceiver(parse(finding.file, content), at, change.property);
    return receiver &&
      readsOldShape(
        patchedFile(finding.file, content),
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
  const dropped = edits.flatMap((edit) => {
    const content = contentOf(repository, edit.file);
    if (content === undefined) return [];
    const fileEdits = edits.filter((candidate) => candidate.file === edit.file);
    const start = patchedStart(fileEdits, edit);
    return dualReads(parse(edit.file, content), edit, changes)
      .filter(
        (read) =>
          !readsOldShape(
            patchedFile(edit.file, content),
            start,
            start + edit.replacement.length,
            read.receiver,
            read.property,
          ),
      )
      .map(({ line, schema, property }) => ({ file: edit.file, line, schema, property }));
  });
  return [...rewritten, ...dropped];
}
