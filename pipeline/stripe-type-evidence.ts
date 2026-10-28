import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript-compiler';
import { requestProperty, responsePropertyOwner } from './operation-reach.ts';
import type { BreakingOperationImpact, ProviderOperationMapping } from './provider-operations.ts';
import { TEST_PATH } from './source-paths.ts';
import {
  asserted,
  compilerOptions,
  labelReads,
  SOURCE,
  stripeTypesEntry,
  typeNames,
} from './stripe-ground-truth.ts';
import type { Finding, Removal, Repository } from './types.ts';

// Removed-field reads whose receiver TypeScript's checker resolves to a Stripe object, using the
// application's own stripe type definitions and the ground-truth oracle's resolver. Type evidence
// only confirms that code reads a removed field; casts can lie, so these findings carry
// `typeEvidence` and stop automatic migration for review (pipeline/migration-review.ts).

// The checker builds a full program per tsconfig project; larger repositories are left to the
// analyzer's own evidence.
const MAX_TYPED_FILES = 2_000;
const TYPESCRIPT = /\.[cm]?tsx?$/;

const metadata = JSON.parse(
  readFileSync(new URL('./stripe-sdk-metadata.json', import.meta.url), 'utf8'),
) as { classes: Record<string, string> };
const classSchemas = new Map(Object.entries(metadata.classes));

// An explicit stripe package directory, else the one the repository has installed.
export function stripePackageDirectory(repositoryRoot: string, explicit?: string) {
  const directory = explicit ?? join(repositoryRoot, 'node_modules', 'stripe');
  if (!existsSync(join(directory, 'package.json'))) return undefined;
  try {
    const entry = stripeTypesEntry(directory);
    return existsSync(entry.ambient ?? entry.module) ? directory : undefined;
  } catch {
    return undefined;
  }
}

export function addTypeEvidence(
  repository: Repository,
  changes: Removal[],
  findings: Finding[],
  stripePackage: string,
) {
  const files = repository.files
    .map((file) => file.path)
    .filter((path) => SOURCE.test(path) && !path.endsWith('.d.ts'));
  if (!files.length || files.length > MAX_TYPED_FILES) return;
  const removed = new Map<string, Set<string>>();
  for (const change of changes)
    removed.set(change.property, (removed.get(change.property) ?? new Set()).add(change.schema));
  const reads = labelReads({
    repository: repository.root,
    stripePackage,
    removed,
    classSchemas,
    files: files.map((path) => resolve(repository.root, path)),
  });
  for (const read of reads) {
    if (read.label !== 'breaking') continue;
    for (const change of changes) {
      if (change.property !== read.property || !read.schemas.includes(change.schema)) continue;
      const existing = findings.find(
        (finding) =>
          finding.file === read.file &&
          finding.line === read.start.line &&
          finding.column === read.start.column &&
          finding.changeId === change.id &&
          finding.expression === `.${read.property}`,
      );
      if (existing?.confidence === 'confirmed') continue;
      const typeEvidence = {
        receiverTypes: read.receiverTypes,
        ...(read.asserted ? { asserted: true as const } : {}),
      };
      const reason = `TypeScript resolves this receiver to ${read.receiverTypes.join(' | ')}, whose ${change.schema}.${change.property} the target API version removes${read.asserted ? '; the type comes from a type assertion, which may not match the runtime object' : ''}. Type evidence does not establish SDK or incoming-event provenance; inspect manually.`;
      if (existing) {
        existing.confidence = 'confirmed';
        existing.typeEvidence = typeEvidence;
        existing.reason = reason;
        delete existing.untraced;
      } else
        findings.push({
          file: read.file,
          line: read.start.line,
          column: read.start.column,
          changeId: change.id,
          expression: `.${read.property}`,
          confidence: 'confirmed',
          typeEvidence,
          reason,
        });
    }
  }
}

// The type oracle (docs/ARCHITECTURE.md, "Type oracle"): tsc in the offline validation sandbox on
// the original code with the original stripe-node, on the original code with the target stripe-node
// the patch installs, and on the final patched code. Errors the target SDK alone introduces into
// the original code are reach evidence; errors the patch leaves against the original side are the
// D2 gate's evidence. Zero introduced errors is never proof that nothing is reached: casts, `any`
// and untyped clients hide errors, so no reach is ever relaxed from it.
export interface OracleTypeError {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}
export type OracleComparison =
  { status: 'compared'; introduced: OracleTypeError[] } | { status: 'unavailable'; reason: string };
export interface TypeOracleReach {
  changeId: string;
  operation: string;
  path: string;
  file: string;
  line: number;
  code: string;
}
export interface TypeOracle {
  // The stripe-node release on the original side (null when the patch does not say) and the one
  // installed in the patched workspace.
  sdk: { from: string | null; to: string };
  // The original code with the target SDK against the original code with the original SDK.
  unpatched: OracleComparison;
  // The final patched code with the target SDK against the original code with the original SDK.
  patched: OracleComparison;
  // Contract changes the unpatched errors moved to `reached`.
  reached: TypeOracleReach[];
}

// D2's type gate: the target SDK is installed and the patched code type-checks with no error the
// original code and SDK did not have. The other D2 conditions (tests, traced sites) are separate.
export function typeOraclePasses(oracle: TypeOracle | undefined) {
  return oracle?.patched.status === 'compared' && oracle.patched.introduced.length === 0;
}

// How a cleared read was shown not to read a Stripe object (localReceiverReads).
export type LocalProof = 'repository-type' | 'literal-config' | 'generated-type' | 'receiver-type';
export interface LocalReceiverOptions {
  // The removed fields reads name by `changeId` (`line_item` for line_item.price); the
  // receiver-type proof needs the schema a read's change removes the property from.
  changes?: readonly Pick<Removal, 'id' | 'schema'>[];
  // Removed-field reads Refit traced to Stripe objects: a cleared property must not also be read on
  // one in the same function.
  traced?: readonly { file: string; line: number; column: number; expression: string }[];
  // Files whose type check passed with no error at all against the installed stripe types, which
  // rejects a Stripe object assigned to an incompatible repository type. The repository-type
  // proof holds only there.
  typeChecked?: (file: string) => boolean;
}

// Headers a code generator writes at the top of the types it generates from the repository's own
// database or CMS schema. shortcut: Payload only, the one generator measured; add others with
// their own header when a run shows them.
const GENERATED_TYPES = [/This file was automatically generated by Payload\./];
// Array methods that return one element, pass each element to their callback, return a sub-array
// of the same elements, and change the array's elements in place.
const ELEMENT_METHODS = new Set(['find', 'findLast', 'at']);
const CALLBACK_METHODS = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'some',
]);
const SUBARRAY_METHODS = new Set(['filter', 'slice']);
const MUTATING_METHODS = new Set(['copyWithin', 'fill', 'push', 'splice', 'unshift']);
const WEBHOOK_CONSTRUCTORS = new Set(['constructEvent', 'constructEventAsync']);
// The stripe package's own files, under npm, Yarn and pnpm layouts.
const STRIPE_PACKAGE = /^(.*[\\/]node_modules[\\/]stripe)[\\/]/;
// Any other package whose name mentions Stripe (@stripe/stripe-js, stripe-event-types, a plugin)
// may declare Stripe API objects under its own names, so its types prove nothing.
const STRIPE_RELATED = /[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]*stripe[^\\/]*[\\/]/i;

// Founder decision (Otabek, 2026-10-28), widening owner decision D2b (2026-10-27): of `reads`
// (removed-field reads at the line and column where the property access starts), the ones Refit can
// prove do not read a Stripe object, each with its proof:
// - `repository-type`: in a TypeScript file whose type check passed (`typeChecked`), with no type
//   assertion on its receiver, the property resolves to declarations in the repository's own
//   non-declaration files and every part of the receiver's type, its base types included, is
//   declared there too. `any`, `unknown`, an unresolved import (the checker's error type), a type
//   parameter, a primitive and anything declared under node_modules or in a `.d.ts` file never count:
//   a Stripe type, reached directly, through an alias or as a base, is declared in the stripe package
//   or not resolved at all. A receiver whose type comes from a parameter annotation counts only when
//   every call of its function in the repository passes such a type and nothing else references the
//   function; from a variable annotation, only on a `const` whose initializer has such a type; from a
//   function's return annotation, never.
// - `literal-config`: the receiver is an object literal written in the repository, directly, through
//   a `const`, or as an element of a `const` array of object literals (by index, `find`, `at`, or as
//   the element parameter of a callback such as `find` or `map`) that nothing writes an element into.
// - `generated-type`: the receiver is a `const` asserted to a type a code generator wrote from the
//   repository's own schema (GENERATED_TYPES), which declares the property, outside a function that
//   constructs a Stripe webhook event, and not asserted from an event's `data.object`.
// A read never counts where its property is also read on a traced Stripe object in the same function.
export function localReceiverReads<
  Read extends {
    file: string;
    line: number;
    column: number;
    expression: string;
    changeId?: string;
  },
>(repository: Repository, reads: readonly Read[], options: LocalReceiverOptions = {}) {
  const candidates = reads.filter((read) => SOURCE.test(read.file) && !read.file.endsWith('.d.ts'));
  const files = repository.files
    .map((file) => file.path)
    .filter((path) => SOURCE.test(path) && !TEST_PATH.test(path));
  if (!candidates.length || files.length > MAX_TYPED_FILES) return [];
  const root = resolve(repository.root);
  const program = ts.createProgram(
    files.map((path) => resolve(root, path)),
    compilerOptions(root),
  );
  const checker = program.getTypeChecker();
  const own = (declaration: ts.Node) => {
    const path = declaration.getSourceFile().fileName;
    return (
      !path.endsWith('.d.ts') &&
      !path.split(/[\\/]/).includes('node_modules') &&
      path.startsWith(root)
    );
  };
  const generated = (declaration: ts.Node) =>
    own(declaration) &&
    GENERATED_TYPES.some((header) => header.test(declaration.getSourceFile().text.slice(0, 1000)));
  const sources = program
    .getSourceFiles()
    .filter((source) => own(source) && files.includes(relative(root, source.fileName)));
  const seen = new Set<ts.Type>();
  const local = (type: ts.Type): boolean => {
    if (seen.has(type)) return true;
    seen.add(type);
    if (type.isUnion() || type.isIntersection()) return type.types.every(local);
    if (!(type.flags & ts.TypeFlags.Object)) return false;
    const declarations = (type.aliasSymbol ?? type.getSymbol())?.getDeclarations() ?? [];
    if (!declarations.length || !declarations.every(own)) return false;
    const target = (type as ts.TypeReference).target ?? type;
    return (target.isClassOrInterface() ? (checker.getBaseTypes(target) ?? []) : []).every(local);
  };
  const localType = (node: ts.Node) => {
    seen.clear();
    return local(checker.getNonNullableType(checker.getTypeAtLocation(node)));
  };
  const symbolOf = (node: ts.Node) => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  };
  const constant = (declaration: ts.VariableDeclaration) =>
    Boolean(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const);
  // Every reference to `symbol` in the repository's own files.
  const references = new Map<ts.Symbol, ts.Identifier[]>();
  const referencesOf = (symbol: ts.Symbol) => {
    let found = references.get(symbol);
    if (found) return found;
    found = [];
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === symbol.name && symbolOf(node) === symbol)
        found!.push(node);
      ts.forEachChild(node, visit);
    };
    for (const source of sources) visit(source);
    references.set(symbol, found);
    return found;
  };
  // Runtime values do not depend on types, so a value's assertions and checks can be looked through.
  const value = (node: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
      ? value(node.expression)
      : node;
  const method = (node: ts.Expression, names: Set<string>) =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    names.has(node.expression.name.text)
      ? node.expression.expression
      : undefined;
  // No repository code replaces or adds an element: every reference reads a property that is not a
  // mutating method, reads an element, spreads the array, or imports or exports it.
  const unwritten = (symbol: ts.Symbol) =>
    referencesOf(symbol).every((reference) => {
      const parent = reference.parent;
      if (ts.isVariableDeclaration(parent) && parent.name === reference) return true;
      if (
        ts.isImportSpecifier(parent) ||
        ts.isImportClause(parent) ||
        ts.isExportSpecifier(parent) ||
        ts.isSpreadElement(parent)
      )
        return true;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === reference)
        return !MUTATING_METHODS.has(parent.name.text);
      if (ts.isElementAccessExpression(parent) && parent.expression === reference) {
        const user = parent.parent;
        return !(
          (ts.isBinaryExpression(user) &&
            user.left === parent &&
            user.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            user.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
          ts.isDeleteExpression(user)
        );
      }
      return false;
    });
  // A `const` binding cannot be reassigned, but an array's elements can be replaced or added to.
  const literalBinding = (
    node: ts.Expression,
    literal: (initializer: ts.Expression, depth: number) => boolean,
    depth: number,
    elements = false,
  ) => {
    const symbol = ts.isIdentifier(node) ? symbolOf(node) : undefined;
    const declaration = symbol?.valueDeclaration;
    return Boolean(
      symbol &&
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      own(declaration) &&
      constant(declaration) &&
      declaration.initializer &&
      literal(declaration.initializer, depth + 1) &&
      (!elements || unwritten(symbol)),
    );
  };
  const literalArray = (node: ts.Expression, depth = 0): boolean => {
    if (depth > 8) return false;
    node = value(node);
    if (ts.isArrayLiteralExpression(node))
      return node.elements.every(
        (element) =>
          ts.isObjectLiteralExpression(value(element)) && literalObject(element, depth + 1),
      );
    const array = method(node, SUBARRAY_METHODS);
    if (array) return literalArray(array, depth + 1);
    return literalBinding(node, literalArray, depth, true);
  };
  const literalObject = (node: ts.Expression, depth = 0): boolean => {
    if (depth > 8) return false;
    node = value(node);
    if (ts.isObjectLiteralExpression(node))
      return !node.properties.some((property) => ts.isSpreadAssignment(property));
    if (ts.isElementAccessExpression(node)) return literalArray(node.expression, depth + 1);
    const array = method(node, ELEMENT_METHODS);
    if (array) return literalArray(array, depth + 1);
    const declaration = ts.isIdentifier(node) ? symbolOf(node)?.valueDeclaration : undefined;
    if (declaration && ts.isParameter(declaration)) {
      const callback = declaration.parent;
      const call = callback.parent;
      return (
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        callback.parameters[0] === declaration &&
        ts.isIdentifier(declaration.name) &&
        ts.isCallExpression(call) &&
        call.arguments[0] === callback &&
        literalArray(method(call, CALLBACK_METHODS) ?? call, depth + 1)
      );
    }
    return literalBinding(node, literalObject, depth);
  };
  // Where a typed receiver's type comes from an annotation, the value written into it must have a
  // repository type as well; a Stripe value, unresolved here, does not.
  const annotatedSource = (node: ts.Expression): boolean => {
    let root = node;
    while (
      ts.isPropertyAccessExpression(root) ||
      ts.isElementAccessExpression(root) ||
      ts.isNonNullExpression(root) ||
      ts.isParenthesizedExpression(root) ||
      ts.isCallExpression(root)
    )
      root = root.expression;
    if (!ts.isIdentifier(root)) return true;
    let declaration: ts.Node | undefined = symbolOf(root)?.valueDeclaration;
    while (declaration && ts.isBindingElement(declaration)) declaration = declaration.parent.parent;
    if (!declaration) return true;
    if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration))
      return !declaration.type;
    if (ts.isVariableDeclaration(declaration) && declaration.type)
      return (
        constant(declaration) &&
        Boolean(declaration.initializer) &&
        localType(declaration.initializer!)
      );
    // An array method's callback: its element comes from the array, wherever that comes from.
    if (
      ts.isParameter(declaration) &&
      (ts.isArrowFunction(declaration.parent) || ts.isFunctionExpression(declaration.parent)) &&
      ts.isCallExpression(declaration.parent.parent) &&
      declaration.parent.parent.arguments.includes(declaration.parent)
    ) {
      const callee = declaration.parent.parent.expression;
      return (
        !declaration.type &&
        ts.isPropertyAccessExpression(callee) &&
        CALLBACK_METHODS.has(callee.name.text) &&
        annotatedSource(callee.expression)
      );
    }
    if (!ts.isParameter(declaration) || !declaration.type) return true;
    const owner = declaration.parent;
    const index = owner.parameters.indexOf(declaration);
    const binding =
      ts.isFunctionDeclaration(owner) && owner.name
        ? owner
        : (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) &&
            ts.isVariableDeclaration(owner.parent) &&
            constant(owner.parent)
          ? owner.parent
          : undefined;
    const name = binding?.name;
    if (!binding || !name || !ts.isIdentifier(name)) return false;
    if (ts.getCombinedModifierFlags(binding as ts.Declaration) & ts.ModifierFlags.Export)
      return false;
    const symbol = symbolOf(name);
    const calls = symbol ? referencesOf(symbol).filter((reference) => reference !== name) : [];
    return (
      calls.length > 0 &&
      calls.every((reference) => {
        const call = reference.parent;
        if (!ts.isCallExpression(call) || call.expression !== reference) return false;
        const argument = call.arguments[index];
        if (!argument) return Boolean(declaration.initializer || declaration.questionToken);
        return !ts.isSpreadElement(argument) && !asserted(argument, checker) && localType(argument);
      })
    );
  };
  const repositoryType = (access: ts.PropertyAccessExpression, file: string) => {
    if (!TYPESCRIPT.test(file) || !(options.typeChecked?.(file) ?? false)) return false;
    if (asserted(access.expression, checker)) return false;
    const declarations = checker.getSymbolAtLocation(access.name)?.getDeclarations() ?? [];
    return (
      declarations.length > 0 &&
      declarations.every(own) &&
      localType(access.expression) &&
      annotatedSource(access.expression)
    );
  };
  const enclosing = (node: ts.Node): ts.Node => {
    let current = node.parent;
    while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current))
      current = current.parent;
    return current ?? node.getSourceFile();
  };
  const constructsEvent = (scope: ts.Node): boolean =>
    (ts.isCallExpression(scope) &&
      ts.isPropertyAccessExpression(scope.expression) &&
      WEBHOOK_CONSTRUCTORS.has(scope.expression.name.text)) ||
    Boolean(ts.forEachChild(scope, (child) => constructsEvent(child) || undefined));
  const generatedType = (access: ts.PropertyAccessExpression) => {
    let receiver = value(access.expression);
    if (ts.isIdentifier(receiver)) {
      const declaration = symbolOf(receiver)?.valueDeclaration;
      if (
        !declaration ||
        !ts.isVariableDeclaration(declaration) ||
        !constant(declaration) ||
        !declaration.initializer
      )
        return false;
      receiver = declaration.initializer;
      while (ts.isParenthesizedExpression(receiver)) receiver = receiver.expression;
    } else receiver = access.expression;
    while (ts.isParenthesizedExpression(receiver)) receiver = receiver.expression;
    if (!ts.isAsExpression(receiver) && !ts.isTypeAssertionExpression(receiver)) return false;
    const names: string[] = [];
    for (
      let operand: ts.Expression = receiver.expression;
      ts.isPropertyAccessExpression(operand);
      operand = operand.expression
    )
      names.unshift(operand.name.text);
    if (names.join('.').includes('data.object')) return false;
    const type = checker.getTypeFromTypeNode(receiver.type);
    const parts = type.isUnion() ? type.types : [type];
    const property = checker.getSymbolAtLocation(access.name)?.getDeclarations() ?? [];
    return (
      parts.every((part) => {
        const declarations = (part.aliasSymbol ?? part.getSymbol())?.getDeclarations() ?? [];
        return (
          Boolean(part.flags & ts.TypeFlags.Object) &&
          declarations.length > 0 &&
          declarations.every(generated)
        );
      }) &&
      property.length > 0 &&
      property.every(generated) &&
      !constructsEvent(enclosing(access))
    );
  };
  // receiver-type: a part of the receiver's type that is not the changed schema's Stripe object.
  const notSchema = (type: ts.Type, schemas: readonly string[], depth = 0): boolean => {
    if (depth > 8) return false;
    if (type.isUnion() || type.isIntersection())
      return type.types.every((member) => notSchema(member, schemas, depth + 1));
    if (!(type.flags & ts.TypeFlags.Object)) return false;
    const declarations = (type.aliasSymbol ?? type.getSymbol())?.getDeclarations() ?? [];
    if (!declarations.length) return false;
    for (const declaration of declarations) {
      const path = declaration.getSourceFile().fileName;
      const stripe = STRIPE_PACKAGE.exec(path)?.[1];
      if (stripe) {
        // Resource names come from Stripe's SDK spec (x-stripeResource), as the type evidence's do.
        const name = typeNames(type, checker, stripe)[0] ?? '';
        const schema = name.startsWith('Stripe.') ? classSchemas.get(name.slice(7)) : undefined;
        // Stripe's resources are interfaces; an unmapped one may be a variant of the changed
        // object (an upcoming invoice), and only classes such as its errors are not resources.
        if (schema ? schemas.includes(schema) : !ts.isClassDeclaration(declaration)) return false;
      } else if (STRIPE_RELATED.test(path)) return false;
    }
    const target = (type as ts.TypeReference).target ?? type;
    return (target.isClassOrInterface() ? (checker.getBaseTypes(target) ?? []) : []).every((base) =>
      notSchema(base, schemas, depth + 1),
    );
  };
  // The property itself: `Pick<Stripe.LineItem, 'price'>` or a spread of a Stripe object declares
  // it on the Stripe type, whatever the receiver's own name.
  const propertyNotSchema = (access: ts.PropertyAccessExpression, schemas: readonly string[]) => {
    const declarations = checker.getSymbolAtLocation(access.name)?.getDeclarations() ?? [];
    return (
      declarations.length > 0 &&
      declarations.every((declaration) => {
        const path = declaration.getSourceFile().fileName;
        if (!STRIPE_RELATED.test(path)) return true;
        const owner = declaration.parent;
        const symbol =
          (ts.isInterfaceDeclaration(owner) || ts.isClassDeclaration(owner)) && owner.name
            ? checker.getSymbolAtLocation(owner.name)
            : undefined;
        return Boolean(
          STRIPE_PACKAGE.test(path) &&
          symbol &&
          notSchema(checker.getDeclaredTypeOfSymbol(symbol), schemas),
        );
      })
    );
  };
  const assigned = (reference: ts.Node) => {
    const parent = reference.parent;
    return (
      (ts.isBinaryExpression(parent) &&
        parent.left === reference &&
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator))
    );
  };
  // Every value that can reach `node` carries the type the checker reports: no type assertion,
  // annotation or return type stands in for a value Refit cannot see. A runtime check (`instanceof`)
  // on an `any` or `unknown` value narrows it to a class, which cannot lie.
  const flows = (node: ts.Expression, schemas: readonly string[], depth = 0): boolean => {
    if (depth > 6 || asserted(node, checker)) return false;
    node = value(node);
    if (ts.isAwaitExpression(node)) return flows(node.expression, schemas, depth + 1);
    if (ts.isConditionalExpression(node))
      return flows(node.whenTrue, schemas, depth + 1) && flows(node.whenFalse, schemas, depth + 1);
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
      ].includes(node.operatorToken.kind)
    )
      return flows(node.left, schemas, depth + 1) && flows(node.right, schemas, depth + 1);
    if (ts.isCallExpression(node))
      return returns(node, schemas, depth) && flows(node.expression, schemas, depth + 1);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      return flows(node.expression, schemas, depth + 1);
    if (ts.isArrayLiteralExpression(node))
      return node.elements.every((element) =>
        flows(ts.isSpreadElement(element) ? element.expression : element, schemas, depth + 1),
      );
    if (!ts.isIdentifier(node)) return true;
    const symbol = symbolOf(node);
    let declaration: ts.Node | undefined = symbol?.valueDeclaration;
    while (declaration && ts.isBindingElement(declaration)) declaration = declaration.parent.parent;
    if (!symbol || !declaration) return false;
    // A library's value (an imported client or ORM) has the type its package declares.
    if (!own(declaration)) return true;
    if (
      ts.isFunctionDeclaration(declaration) ||
      ts.isClassDeclaration(declaration) ||
      ts.isEnumDeclaration(declaration)
    )
      return true;
    if (checker.getTypeOfSymbol(symbol).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
      const narrowed = checker.getNonNullableType(checker.getTypeAtLocation(node));
      const members = narrowed.isUnion() ? narrowed.types : [narrowed];
      return members.every((member) =>
        (member.getSymbol()?.getDeclarations() ?? []).some(ts.isClassDeclaration),
      );
    }
    if (ts.isVariableDeclaration(declaration)) {
      const statement = declaration.parent.parent;
      if (ts.isForOfStatement(statement) && declaration.parent === statement.initializer)
        return flows(statement.expression, schemas, depth + 1);
      if (!declaration.initializer) return false;
      if (!constant(declaration) && referencesOf(symbol).some(assigned)) return false;
      return (
        flows(declaration.initializer, schemas, depth + 1) &&
        (!declaration.type ||
          notSchema(
            checker.getNonNullableType(checker.getTypeAtLocation(declaration.initializer)),
            schemas,
          ))
      );
    }
    if (ts.isParameter(declaration)) return parameterFlows(declaration, schemas, depth);
    return false;
  };
  // An argument or returned value behind an annotation: its own flow, and its type, which the
  // annotation could hide.
  const fills = (node: ts.Expression, schemas: readonly string[], depth: number) =>
    !ts.isSpreadElement(node) &&
    flows(node, schemas, depth + 1) &&
    notSchema(checker.getNonNullableType(checker.getTypeAtLocation(node)), schemas);
  const parameterFlows = (
    parameter: ts.ParameterDeclaration,
    schemas: readonly string[],
    depth: number,
  ): boolean => {
    const owner = parameter.parent;
    const index = owner.parameters.indexOf(parameter);
    if (parameter.dotDotDotToken) return false;
    // A callback of an array method: the array passes each value.
    if (
      (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) &&
      ts.isCallExpression(owner.parent) &&
      owner.parent.arguments.includes(owner)
    ) {
      const callee = owner.parent.expression;
      if (!ts.isPropertyAccessExpression(callee) || !CALLBACK_METHODS.has(callee.name.text))
        return false;
      if (!flows(callee.expression, schemas, depth + 1)) return false;
      if (!parameter.type) return true;
      const passed = checker.getContextualType(owner)?.getCallSignatures()[0]?.parameters[index];
      return Boolean(
        passed &&
        notSchema(
          checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(passed, owner)),
          schemas,
        ),
      );
    }
    // A named function: every repository reference calls it with values that flow.
    const binding =
      ts.isFunctionDeclaration(owner) && owner.name
        ? owner
        : (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) &&
            ts.isVariableDeclaration(owner.parent) &&
            constant(owner.parent)
          ? owner.parent
          : undefined;
    const name = binding?.name;
    const symbol = name && ts.isIdentifier(name) ? symbolOf(name) : undefined;
    if (!symbol) return false;
    const calls = referencesOf(symbol).filter(
      (reference) =>
        reference !== name &&
        !ts.isImportSpecifier(reference.parent) &&
        !ts.isImportClause(reference.parent) &&
        !ts.isExportSpecifier(reference.parent),
    );
    return (
      calls.length > 0 &&
      calls.every((reference) => {
        const call = reference.parent;
        if (!ts.isCallExpression(call) || call.expression !== reference) return false;
        const argument = call.arguments[index];
        if (!argument) return Boolean(parameter.initializer || parameter.questionToken);
        return fills(argument, schemas, depth);
      })
    );
  };
  // A repository function: every value it returns flows, and fits its return annotation.
  const returns = (call: ts.CallExpression, schemas: readonly string[], depth: number) => {
    const declaration = checker.getResolvedSignature(call)?.declaration;
    if (!declaration || !ts.isFunctionLike(declaration)) return false;
    if (!own(declaration)) return true;
    const body = 'body' in declaration ? declaration.body : undefined;
    if (!body) return false;
    const fits = (returned: ts.Expression) =>
      declaration.type ? fills(returned, schemas, depth) : flows(returned, schemas, depth + 1);
    if (!ts.isBlock(body)) return fits(body as ts.Expression);
    const values: ts.Expression[] = [];
    let bare = false;
    const visit = (node: ts.Node) => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) {
        if (node.expression) values.push(node.expression);
        else bare = true;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(body, visit);
    return !bare && values.every(fits);
  };
  const receiverType = (access: ts.PropertyAccessExpression, read: Read) => {
    if (!TYPESCRIPT.test(read.file) || !(options.typeChecked?.(read.file) ?? false)) return false;
    const schemas = (options.changes ?? [])
      .filter((change) => change.id === read.changeId)
      .map((change) => change.schema);
    return (
      schemas.length > 0 &&
      notSchema(
        checker.getNonNullableType(checker.getTypeAtLocation(access.expression)),
        schemas,
      ) &&
      propertyNotSchema(access, schemas) &&
      flows(access.expression, schemas)
    );
  };
  const results: (Read & { proof: LocalProof })[] = [];
  for (const read of candidates) {
    const source = program.getSourceFile(resolve(root, read.file));
    if (!source) continue;
    const offset = (line: number, column: number) =>
      (source.getLineStarts()[line - 1] ?? NaN) + column - 1;
    const start = offset(read.line, read.column);
    const property = read.expression.replace(/^\./, '');
    let access: ts.PropertyAccessExpression | undefined;
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        node.getStart(source) === start &&
        node.name.text === property
      )
        access = node;
      else if (!access && node.pos <= start && start < node.end) ts.forEachChild(node, visit);
    };
    visit(source);
    if (!access) continue;
    const scope = enclosing(access);
    const tracedHere = (options.traced ?? []).some((site) => {
      if (site.file !== read.file || site.expression !== read.expression) return false;
      const position = offset(site.line, site.column);
      return scope.getStart(source) <= position && position < scope.getEnd();
    });
    if (tracedHere) continue;
    const proof: LocalProof | undefined = repositoryType(access, read.file)
      ? 'repository-type'
      : literalObject(access.expression)
        ? 'literal-config'
        : generatedType(access)
          ? 'generated-type'
          : receiverType(access, read)
            ? 'receiver-type'
            : undefined;
    if (proof) results.push({ ...read, proof });
  }
  return results;
}

// `Property 'x' does not exist on type 'Stripe.Subscription'` (TS2339), or with a suggestion (TS2551),
// also on an awaited SDK response, `Response<Subscription>`.
const MISSING_PROPERTY =
  /^Property '([^']+)' does not exist on type '(?:Stripe\.)?(?:Response<(?:Stripe\.)?([\w.]+)>|([\w.]+))'/;

// stripe-node's request type for a resource method: `checkout.sessions` `create` is
// `SessionCreateParams`, printed bare or qualified (`Stripe.Checkout.SessionCreateParams`).
function paramsType(mapping: ProviderOperationMapping) {
  const resource = mapping.resource.split('.').at(-1) ?? '';
  const singular = resource.endsWith('ies')
    ? `${resource.slice(0, -3)}y`
    : resource.replace(/s$/, '');
  const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  return `${capital(singular)}${capital(mapping.method)}Params`;
}

const offsetOf = (source: ts.SourceFile, error: OracleTypeError) =>
  (source.getLineStarts()[error.line - 1] ?? NaN) + error.column - 1;

// A request change is reached where the target SDK's types reject the property it names: inside a
// traced call of its operation, at a property of that name or anywhere in the call when the message
// quotes the name; or, in a call Refit did not trace, where the message quotes the name on the
// operation's own stripe-node request type, which only the SDK's typing of that call gives it.
function requestError(
  change: Record<string, unknown>,
  errors: OracleTypeError[],
  impacts: BreakingOperationImpact[],
  mappings: ProviderOperationMapping[],
  files: { path: string; content: string }[],
) {
  const name = requestProperty(String(change.text))?.split('/').at(-1);
  const sameOperation = (entry: { path: string; httpMethod: string }) =>
    entry.path === change.path && entry.httpMethod === String(change.operation).toUpperCase();
  const impact = impacts.find(sameOperation);
  const mapping = mappings.find(sameOperation);
  if (!name) return undefined;
  const typed = mapping
    ? new RegExp(`'${name}' does not exist in type '(?:[\\w.]+\\.)?${paramsType(mapping)}'`)
    : undefined;
  return errors.find((error) => {
    if (TEST_PATH.test(error.file)) return false;
    if (typed?.test(error.message)) return true;
    const content = files.find((file) => file.path === error.file)?.content;
    const calls = impact?.usages.filter((usage) => usage.file === error.file) ?? [];
    if (content === undefined || !calls.length) return false;
    const source = ts.createSourceFile(error.file, content, ts.ScriptTarget.Latest, true);
    const offset = offsetOf(source, error);
    const wanted = new Set(calls.map((call) => `${call.line}:${call.column}`));
    const within = (node: ts.Node) => node.getStart() <= offset && offset < node.getEnd();
    const namedProperty = (node: ts.Node): boolean =>
      ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        node.name.text === name &&
        within(node)) ||
      Boolean(ts.forEachChild(node, (child) => namedProperty(child) || undefined));
    const inCall = (node: ts.Node): boolean => {
      if (ts.isCallExpression(node) && within(node)) {
        const start = source.getLineAndCharacterOfPosition(node.getStart());
        if (
          wanted.has(`${start.line + 1}:${start.character + 1}`) &&
          (error.message.includes(`'${name}'`) || node.arguments.some(namedProperty))
        )
          return true;
      }
      return Boolean(ts.forEachChild(node, (child) => inCall(child) || undefined));
    };
    return inCall(source);
  });
}

// A response change is reached where the target SDK's types say the object the code reads lost the
// property the change names on that object's schema.
function responseError(
  change: Record<string, unknown>,
  errors: OracleTypeError[],
  before: Record<string, unknown>,
) {
  const owner = responsePropertyOwner(change, before);
  if (!owner) return undefined;
  return errors.find((error) => {
    const match = MISSING_PROPERTY.exec(error.message);
    if (!['TS2339', 'TS2551'].includes(error.code) || !match || TEST_PATH.test(error.file))
      return false;
    const type = match[2] ?? match[3];
    const schemas = [...classSchemas]
      .filter(([name]) => name === type || name.endsWith(`.${type}`))
      .map(([, schema]) => schema);
    return match[1] === owner.property && schemas.includes(owner.schema);
  });
}

// Moves contract changes tracing could not decide (`unknown`) to `reached` where the unpatched
// errors locate them. It never moves a change toward a passing reach, and leaves every other reach
// as tracing decided it.
export function typeOracleReach(
  changes: Record<string, unknown>[],
  errors: OracleTypeError[],
  context: {
    files: { path: string; content: string }[];
    impacts: BreakingOperationImpact[];
    mappings: ProviderOperationMapping[];
    before: Record<string, unknown>;
    sdk: string;
  },
) {
  const reached: TypeOracleReach[] = [];
  if (!errors.length) return reached;
  for (const change of changes) {
    const id = String(change.id);
    if (change.reach !== 'unknown') continue;
    const error = id.startsWith('request-')
      ? requestError(change, errors, context.impacts, context.mappings, context.files)
      : id.startsWith('response-')
        ? responseError(change, errors, context.before)
        : undefined;
    if (!error) continue;
    const reachReason = `With stripe-node ${context.sdk} installed, tsc reports ${error.code} at ${error.file}:${error.line} on the unpatched code: ${error.message}`;
    Object.assign(change, { reach: 'reached', reachReason });
    for (const impact of context.impacts)
      for (const entry of impact.changes)
        if (entry.id === id && entry.text === change.text) entry.reachReason = reachReason;
    reached.push({
      changeId: id,
      operation: String(change.operation),
      path: String(change.path),
      file: error.file,
      line: error.line,
      code: error.code,
    });
  }
  return reached;
}
