import ts from 'typescript-compiler';
import type { FieldMove } from './rule-pack.ts';
import { movedReadEdit } from './stripe-field-moves.ts';
import type { SourceEdit } from './types.ts';

// The code behind each field-move family in a rule pack (pipeline/rule-pack.ts). A family knows how
// to rewrite a read safely; the pack entry says which field, which helper and which guards apply.

type Family<F extends FieldMove['family']> = Extract<FieldMove, { family: F }>;

// `receiver.property` → `helper(receiver)`. Reads under a typeof guard or a narrowing test share one
// local in TypeScript, so the narrowing still holds; the entry decides which of these apply.
export function movedValueEdit(
  node: ts.Node,
  move: Family<'moved-value'>,
  file: string,
  changeId: string,
): SourceEdit[] | undefined {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== move.property) return;
  const parent = node.parent;
  // Writes and deletes stay for review: a helper call cannot be assigned to.
  if (
    (ts.isBinaryExpression(parent) &&
      parent.left === node &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
    ts.isDeleteExpression(parent)
  )
    return;
  const dropped = (read: ts.PropertyAccessExpression) =>
    ts.isPropertyAccessExpression(read.parent) &&
    read.parent.expression === read &&
    Boolean(move.droppedFields?.includes(read.parent.name.text));
  if (dropped(node)) return;
  const local = { helper: move.helper, rule: move.rule };
  // Plain JavaScript does not narrow, so each read can call the helper.
  if (move.typeofGuard && /\.[cm]?tsx?$/.test(file) && typeofGuarded(node)) {
    const scoped = receiverReads(node);
    return scoped && localReadEdits(node, scoped, file, changeId, local);
  }
  const hoisted = move.narrowTested
    ? narrowedReadEdits(node, file, changeId, local, (read) => !dropped(read))
    : undefined;
  if (hoisted) return hoisted;
  const edit = movedReadEdit(
    node,
    file,
    changeId,
    move.rule,
    (receiver) => `${move.helper}(${receiver})`,
  );
  return edit && [edit];
}

// `receiver.property.id` → `helper(receiver)`, for an object that became an ID unless expanded.
export function movedIdEdit(
  node: ts.Node,
  move: Family<'moved-id'>,
  file: string,
  changeId: string,
) {
  const read = node.parent;
  if (
    !ts.isPropertyAccessExpression(node) ||
    node.name.text !== move.property ||
    !ts.isPropertyAccessExpression(read) ||
    read.expression !== node ||
    read.name.text !== 'id' ||
    // `line.price?.id.length` short-circuits on a missing object; the helper result would not.
    ((read.questionDotToken || node.questionDotToken) &&
      (ts.isPropertyAccessExpression(read.parent) ||
        ts.isElementAccessExpression(read.parent) ||
        ts.isCallExpression(read.parent)) &&
      read.parent.expression === read)
  )
    return;
  const edit = movedReadEdit(
    node,
    file,
    changeId,
    move.rule,
    (receiver) => `${move.helper}(${receiver})`,
  );
  return edit && { ...edit, end: read.getEnd() };
}

// Each property's read becomes its helper; `plan` selects the item when items differ.
export function periodHelperEdit(
  node: ts.Node,
  move: Family<'period-helper'>,
  file: string,
  changeId: string,
  plan: string | undefined,
) {
  if (!ts.isPropertyAccessExpression(node) || !Object.hasOwn(move.helpers, node.name.text)) return;
  const helper = move.helpers[node.name.text];
  return movedReadEdit(
    node,
    file,
    changeId,
    move.rule,
    (receiver) => `${helper}(${receiver}${plan ? `, ${plan}` : ''})`,
  );
}

// `typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription.id`
// narrows the field for the reads it guards; separate helper calls would not be narrowed, so the
// patched code would not compile.
function typeofGuarded(read: ts.PropertyAccessExpression) {
  const text = read.getText();
  let scope: ts.Node = read;
  while (!ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)
      ? unwrap(node.expression)
      : node;
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isTypeOfExpression(node) && unwrap(node.expression).getText() === text) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

// A truthiness, null or typeof test of the read or of a member chain on it (`if (x.f)`,
// `x.f?.address ? x.f.name : ''`, `!x.f`, `x.f && …`, `x.f === null`), which narrows later reads.
function tested(read: ts.Expression) {
  let node: ts.Node = read;
  for (;;) {
    const parent = node.parent;
    if (
      (ts.isPropertyAccessExpression(parent) && parent.expression === node) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent)
    ) {
      node = parent;
      continue;
    }
    if (ts.isTypeOfExpression(parent)) return true;
    if (ts.isPrefixUnaryExpression(parent))
      return parent.operator === ts.SyntaxKind.ExclamationToken;
    if (ts.isBinaryExpression(parent)) {
      const operator = parent.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.AmpersandAmpersandToken ||
        operator === ts.SyntaxKind.BarBarToken
      ) {
        if (parent.left === node) return true;
        node = parent;
        continue;
      }
      return [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(operator);
    }
    return (
      ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) &&
        parent.expression === node) ||
      (ts.isForStatement(parent) && parent.condition === node) ||
      (ts.isConditionalExpression(parent) && parent.condition === node)
    );
  }
}

// TypeScript narrows a tested field for the reads after the test, but not separate helper calls, so
// `if (session.shipping_details) use(session.shipping_details.address)` would stop compiling. A
// test narrows reads in the block holding it (a case clause shares its switch's scope, so the block
// around the switch), so the reads in the largest such block around this read share one local,
// declared as `receiverReads` and `localReadEdits` allow; otherwise each read calls the helper.
function narrowedReadEdits(
  read: ts.PropertyAccessExpression,
  file: string,
  changeId: string,
  local: { helper: string; rule: string },
  keep: (read: ts.PropertyAccessExpression) => boolean = () => true,
) {
  if (!/\.[cm]?tsx?$/.test(file)) return;
  const scoped = receiverReads(read);
  if (!scoped) return;
  const within = (node: ts.Node, outer: ts.Node) =>
    outer.getStart() <= node.getStart() && node.getEnd() <= outer.getEnd();
  let region: ts.Node | undefined;
  for (const test of scoped.reads.filter(tested)) {
    let block: ts.Node = test.parent;
    while (
      !ts.isBlock(block) &&
      !ts.isSourceFile(block) &&
      !(ts.isCaseClause(block) && block === scoped.scope)
    )
      block = block.parent;
    if (within(read, block) && (!region || within(region, block))) region = block;
  }
  const reads = region ? scoped.reads.filter((node) => within(node, region)) : [];
  if (reads.length < 2 || !reads.every(keep)) return;
  return localReadEdits(read, { reads, scope: scoped.scope }, file, changeId, local);
}

// Every read of `receiver.field` in the block, loop or function that declares the receiver once,
// as a parameter or a `const`, or none when the receiver or the field is written there.
function receiverReads(read: ts.PropertyAccessExpression) {
  const receiver = read.expression;
  if (!ts.isIdentifier(receiver)) return;
  const declares = (node: ts.Node) =>
    (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
    ts.isIdentifier(node.name) &&
    node.name.text === receiver.text;
  let scope: ts.Node | undefined = read.parent;
  while (scope && !scopeDeclares(scope, declares)) scope = scope.parent;
  if (!scope) return;
  const text = read.getText();
  const reads: ts.PropertyAccessExpression[] = [];
  let declarations = 0;
  let constant = true;
  let written = false;
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)
      ? unwrap(node.expression)
      : node;
  // The receiver, the field, or a computed member of the receiver that may be the field.
  const writes = (target: ts.Expression) => {
    const value = unwrap(target);
    if (value.getText() === receiver.text) return true;
    if (!ts.isPropertyAccessExpression(value) && !ts.isElementAccessExpression(value)) return false;
    if (unwrap(value.expression).getText() !== receiver.text) return false;
    return ts.isPropertyAccessExpression(value)
      ? value.name.text === read.name.text
      : !ts.isStringLiteralLike(value.argumentExpression) ||
          value.argumentExpression.text === read.name.text;
  };
  const visit = (node: ts.Node) => {
    if (declares(node)) {
      declarations++;
      if (
        ts.isVariableDeclaration(node) &&
        !(ts.isVariableDeclarationList(node.parent) && node.parent.flags & ts.NodeFlags.Const)
      )
        constant = false;
    }
    if (ts.isPropertyAccessExpression(node) && node.getText() === text) reads.push(node);
    const target =
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        ? node.left
        : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
            (node.operator === ts.SyntaxKind.PlusPlusToken ||
              node.operator === ts.SyntaxKind.MinusMinusToken)
          ? node.operand
          : ts.isDeleteExpression(node)
            ? node.expression
            : undefined;
    if (target && writes(target)) written = true;
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return declarations === 1 && constant && !written ? { reads, scope } : undefined;
}

function scopeDeclares(scope: ts.Node, declares: (node: ts.Node) => boolean) {
  if (ts.isFunctionLike(scope)) return scope.parameters.some(declares);
  if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isCaseClause(scope))
    return scope.statements.some(
      (statement) =>
        ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declares),
    );
  if (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope))
    return (
      !!scope.initializer &&
      ts.isVariableDeclarationList(scope.initializer) &&
      scope.initializer.declarations.some(declares)
    );
  return false;
}

// One local that every read uses narrows like the field did. It is declared before the statement
// holding the first read, in the innermost block of the receiver's scope holding them all, and is
// named after the receiver (`invoiceSubscription`, `sessionShippingDetails`), so locals for two
// receivers in one block never clash. Not when the receiver itself is used between the
// declaration and the last read (`await save(session)`), since that call could change the field.
// shortcut: a call can still change the field through an alias made before the declaration;
// upgrade if a repository mutates payloads that way.
function localReadEdits(
  read: ts.PropertyAccessExpression,
  { reads, scope }: { reads: ts.PropertyAccessExpression[]; scope: ts.Node },
  file: string,
  changeId: string,
  { helper, rule }: { helper: string; rule: string },
): SourceEdit[] | undefined {
  if (reads.some((node) => node.questionDotToken)) return;
  const source = read.getSourceFile();
  const first = reads.reduce((left, right) => (right.getStart() < left.getStart() ? right : left));
  const last = reads.reduce((left, right) => (right.getEnd() > left.getEnd() ? right : left));
  let anchor: ts.Node = first;
  while (
    anchor.parent &&
    !(
      (ts.isBlock(anchor.parent) ||
        ts.isSourceFile(anchor.parent) ||
        ts.isCaseClause(anchor.parent)) &&
      reads.every(
        (node) =>
          anchor.parent.getStart() <= node.getStart() && node.getEnd() <= anchor.parent.getEnd(),
      )
    )
  )
    anchor = anchor.parent;
  const declaration = read.expression.getText();
  const lineStart = source.text.lastIndexOf('\n', anchor.getStart()) + 1;
  const indentation = source.text.slice(lineStart, anchor.getStart());
  if (
    !anchor.parent ||
    anchor.parent.getStart() < scope.getStart() ||
    anchor.parent.getEnd() > scope.getEnd() ||
    anchor.getStart() === first.getStart() ||
    /\S/.test(indentation) ||
    (ts.isVariableStatement(anchor) &&
      anchor.declarationList.declarations.some(
        (entry) => ts.isIdentifier(entry.name) && entry.name.text === declaration,
      ))
  )
    return;
  let escapes = false;
  const visit = (node: ts.Node) => {
    if (escapes || node.getEnd() <= anchor.getStart() || node.getStart() >= last.getEnd()) return;
    if (
      ts.isIdentifier(node) &&
      node.text === declaration &&
      !(
        (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node
      ) &&
      !(
        (ts.isPropertyAccessExpression(node.parent) || ts.isPropertyAssignment(node.parent)) &&
        node.parent.name === node
      )
    )
      escapes = true;
    ts.forEachChild(node, visit);
  };
  visit(anchor.parent);
  if (escapes) return;
  const field = read.name.text.replace(/_(\w)/g, (_match, letter: string) => letter.toUpperCase());
  const base = `${declaration}${field[0].toUpperCase()}${field.slice(1)}`;
  let name = base;
  for (let suffix = 2; new RegExp(`\\b${name}\\b`).test(source.text); suffix++)
    name = `${base}${suffix}`;
  const imports = source.statements.filter(ts.isImportDeclaration);
  const semicolon = !imports.length || imports[0].getText().endsWith(';') ? ';' : '';
  const newline = source.text.includes('\r\n') ? '\r\n' : '\n';
  return [
    {
      file,
      start: anchor.getStart(),
      end: anchor.getStart(),
      replacement: `const ${name} = ${helper}(${declaration})${semicolon}${newline}${indentation}`,
      changeId,
      rule,
    },
    {
      file,
      start: read.getStart(),
      end: read.getEnd(),
      replacement: name,
      changeId,
      rule,
    },
  ];
}
