import { resolve } from 'node:path';
import ts from 'typescript-compiler';
import { compilerOptions } from './stripe-ground-truth.ts';

interface TypeError {
  file: string;
  line: number;
  column: number;
  code: string;
}

// Methods that change an array in place, so its elements may no longer be the ones written.
const MUTATING_METHODS = new Set([
  'copyWithin',
  'fill',
  'pop',
  'push',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift',
]);

// Of TS2322 errors in JavaScript files, the ones TypeScript reports only because JavaScript cannot
// say `as const`: a property set to a `const` array of string literals, which the checker widens to
// `string[]`, where every literal is a member of the element type the property expects. The value
// sent is exactly those literals, so the request is the one the types accept. The array must be
// written in the same file, never exported, reassigned element by element or mutated.
export function widenedLiteralErrors<Error extends TypeError>(
  root: string,
  errors: readonly Error[],
): Error[] {
  const candidates = errors.filter(
    (error) => error.code === 'TS2322' && /\.[cm]?jsx?$/.test(error.file),
  );
  if (!candidates.length) return [];
  const directory = resolve(root);
  const files = [...new Set(candidates.map((error) => resolve(directory, error.file)))];
  const program = ts.createProgram(files, compilerOptions(directory));
  const checker = program.getTypeChecker();
  return candidates.filter((error) => {
    const source = program.getSourceFile(resolve(directory, error.file));
    if (!source) return false;
    const position = source.getPositionOfLineAndCharacter(error.line - 1, error.column - 1);
    const property = nodeAt(source, position);
    if (!property || !ts.isPropertyAssignment(property) || !ts.isIdentifier(property.initializer))
      return false;
    const expected = checker.getContextualType(property.initializer);
    const element = expected && checker.getIndexTypeOfType(expected, ts.IndexKind.Number);
    const literals = constantLiterals(checker, source, property.initializer);
    return Boolean(
      element &&
      literals?.length &&
      literals.every((literal) =>
        checker.isTypeAssignableTo(checker.getTypeAtLocation(literal), element),
      ),
    );
  });
}

// The property assignment whose name starts at `position`.
function nodeAt(source: ts.SourceFile, position: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getStart(source) === position) found = node;
    else if (node.pos <= position && position < node.end) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// The string literals of a top-level `const` array the identifier names, if every other use of it
// in the file only reads it.
function constantLiterals(
  checker: ts.TypeChecker,
  source: ts.SourceFile,
  identifier: ts.Identifier,
): ts.StringLiteralLike[] | undefined {
  const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;
  if (
    !declaration ||
    declaration.getSourceFile() !== source ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    !(declaration.parent.flags & ts.NodeFlags.Const) ||
    !ts.isVariableStatement(declaration.parent.parent) ||
    declaration.parent.parent.parent !== source ||
    declaration.parent.parent.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ||
    !declaration.initializer ||
    !ts.isArrayLiteralExpression(declaration.initializer) ||
    !declaration.initializer.elements.every(ts.isStringLiteralLike)
  )
    return undefined;
  const symbol = checker.getSymbolAtLocation(declaration.name);
  let safe = true;
  const visit = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      node !== declaration.name &&
      checker.getSymbolAtLocation(node) === symbol &&
      !readOnly(node)
    )
      safe = false;
    if (ts.isExportSpecifier(node) || ts.isExportAssignment(node)) safe = false;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return safe
    ? (declaration.initializer.elements as ts.NodeArray<ts.StringLiteralLike>).slice()
    : undefined;
}

// A use that cannot change the array: a property value, a spread, an iterated value, or a
// non-mutating member read. A call argument may be mutated by its callee, so it does not count.
function readOnly(node: ts.Identifier) {
  const parent = node.parent;
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) return true;
  if (ts.isSpreadElement(parent) || ts.isForOfStatement(parent)) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node)
    return (
      !MUTATING_METHODS.has(parent.name.text) &&
      !(ts.isBinaryExpression(parent.parent) && parent.parent.left === parent)
    );
  return false;
}
