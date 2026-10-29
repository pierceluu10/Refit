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
import { functionReturns, typedPrograms } from './type-clients.ts';
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

// Founder decision (Otabek, 2026-10-28): a type-checker result naming a Stripe type is evidence of
// Stripe usage. Of `findings` that Refit did not confirm, the removed-field reads TypeScript's
// checker proves read the changed schema's own stripe-node type, each with the change it reads. The
// receiver's type, nullish parts left out, must be exactly that schema's class (stripe-sdk-metadata),
// and the value must have got it honestly: no type assertion (JavaScript's `/** @type */ (…)`
// included; one that only intersects the value's own type with inline members is followed) and no
// `any` anywhere on the path it took. The path is followed through variables and
// every write to them, destructuring, array elements, inserts and the callbacks that receive them,
// the returns of the repository's functions and the argument every call in the repository passes
// to a parameter, and ends at a stripe-node declaration (an SDK response, a webhook event) or at an
// annotated parameter of a function the repository never calls. A function the repository passes
// as a value, rather than calling it, proves nothing about its parameters. Where an annotation takes
// a value, the value's type must be assignable to it, as the checker would require.
export function typeProvenReads(
  repository: Repository,
  changes: readonly Removal[],
  findings: readonly Finding[],
  explicitPackage?: string,
) {
  const proven: { file: string; line: number; column: number; changeId: string }[] = [];
  const candidates = findings.filter(
    (finding) =>
      finding.confidence !== 'confirmed' &&
      finding.expression.startsWith('.') &&
      !finding.requestParameter &&
      SOURCE.test(finding.file),
  );
  if (!candidates.length) return proven;
  const typed = typedPrograms(repository, explicitPackage);
  if (!('programs' in typed)) return proven;
  for (const { program, sources } of typed.programs) {
    const files = new Map(sources.map((source) => [typed.path(source.fileName), source]));
    const reads = candidates.filter((finding) => files.has(finding.file));
    if (reads.length)
      proven.push(...provenInProgram(program, files, reads, changes, typed.stripe, typed.inStripe));
  }
  return proven;
}

function provenInProgram(
  program: ts.Program,
  files: Map<string, ts.SourceFile>,
  reads: readonly Finding[],
  changes: readonly Removal[],
  stripe: string,
  inStripe: (node: ts.Node) => boolean,
) {
  const checker = program.getTypeChecker();
  const sources = [...files.values()];
  const resolved = (symbol: ts.Symbol | undefined) =>
    symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  // Every write to a variable or an array element, every insert into an array, and every reference.
  const writes = new Map<ts.Symbol, ts.Expression[]>();
  const references = new Map<ts.Symbol, ts.Identifier[]>();
  const add = <T>(map: Map<ts.Symbol, T[]>, symbol: ts.Symbol | undefined, value: T) => {
    if (symbol) map.set(symbol, [...(map.get(symbol) ?? []), value]);
  };
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) add(references, resolved(checker.getSymbolAtLocation(node)), node);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const target = ts.isElementAccessExpression(node.left)
        ? node.left.expression
        : ts.isPropertyAccessExpression(node.left)
          ? node.left.name
          : node.left;
      add(writes, checker.getSymbolAtLocation(target), node.right);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      MUTATING_METHODS.has(node.expression.name.text)
    ) {
      const method = node.expression.name.text;
      const array = checker.getSymbolAtLocation(node.expression.expression);
      // `fill` and `copyWithin` write values the path does not follow; their method is no value.
      if (method === 'fill' || method === 'copyWithin') add(writes, array, node.expression);
      else
        for (const value of method === 'splice' ? node.arguments.slice(2) : node.arguments)
          add(writes, array, value);
    }
    ts.forEachChild(node, visit);
  };
  for (const source of sources) visit(source);

  const nullish = (expression: ts.Expression): boolean =>
    ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)
      ? nullish(expression.expression)
      : expression.kind === ts.SyntaxKind.NullKeyword ||
        ts.isVoidExpression(expression) ||
        (ts.isIdentifier(expression) && expression.text === 'undefined');
  const own = (node: ts.Node) => !node.getSourceFile().isDeclarationFile && !inStripe(node);
  const library = (node: ts.Node) => program.isSourceFileDefaultLibrary(node.getSourceFile());
  const assignable = (value: ts.Node, annotated: ts.Node) =>
    checker.isTypeAssignableTo(
      checker.getTypeAtLocation(value),
      checker.getTypeAtLocation(annotated),
    );

  const memo = new Map<ts.Node, boolean>();
  const pending = new Set<ts.Node>();
  function honest(expression: ts.Expression): boolean {
    const known = memo.get(expression);
    if (known !== undefined) return known;
    // A cycle adds no assertion of its own.
    if (pending.has(expression)) return true;
    pending.add(expression);
    const result =
      !(checker.getTypeAtLocation(expression).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) &&
      honestValue(expression);
    pending.delete(expression);
    memo.set(expression, result);
    return result;
  }
  const honestOrNullish = (expression: ts.Expression) => nullish(expression) || honest(expression);
  function honestValue(expression: ts.Expression): boolean {
    if (ts.isParenthesizedExpression(expression))
      return !ts.getJSDocTypeTag(expression) && honest(expression.expression);
    if (
      ts.isNonNullExpression(expression) ||
      ts.isAwaitExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isElementAccessExpression(expression)
    )
      return honest(expression.expression);
    if (ts.isConditionalExpression(expression))
      return honestOrNullish(expression.whenTrue) && honestOrNullish(expression.whenFalse);
    if (ts.isBinaryExpression(expression)) {
      const operator = expression.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.EqualsToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandToken
      )
        return honest(expression.right);
      if (
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.BarBarToken
      )
        return honestOrNullish(expression.left) && honestOrNullish(expression.right);
      return false;
    }
    if (ts.isArrayLiteralExpression(expression))
      return expression.elements.every((element) =>
        ts.isSpreadElement(element) ? honest(element.expression) : honestOrNullish(element),
      );
    if (ts.isPropertyAccessExpression(expression)) {
      // A stripe-node property (`list.data`, `event.data.object`) has the type of its object,
      // unless the code writes the property.
      const symbol = checker.getSymbolAtLocation(expression.name);
      const declarations = symbol?.getDeclarations() ?? [];
      return (
        declarations.length > 0 &&
        declarations.every(inStripe) &&
        (writes.get(symbol!) ?? []).every(honestOrNullish) &&
        honest(expression.expression)
      );
    }
    if (ts.isCallExpression(expression)) {
      const declaration = checker.getResolvedSignature(expression)?.declaration;
      if (!declaration || ts.isJSDocSignature(declaration)) return false;
      if (inStripe(declaration)) return true;
      // An array method that returns elements of its array.
      if (library(declaration))
        return (
          ts.isPropertyAccessExpression(expression.expression) &&
          (ELEMENT_METHODS.has(expression.expression.name.text) ||
            SUBARRAY_METHODS.has(expression.expression.name.text) ||
            COMPARATOR_METHODS.has(expression.expression.name.text)) &&
          honest(expression.expression.expression)
        );
      if (!own(declaration)) return false;
      const values = functionReturns(declaration);
      return Boolean(values?.every(honestOrNullish) && values.some((value) => !nullish(value)));
    }
    if (ts.isIdentifier(expression)) {
      const symbol = resolved(checker.getSymbolAtLocation(expression));
      return Boolean(symbol && honestSymbol(symbol));
    }
    // `value as Own & { extra?: … }`: an assertion that keeps the value's own type and only adds
    // members the repository writes inline keeps where the value came from (quorum's
    // `invoice as Stripe.Invoice & { payment_intent?: … }`).
    if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
      const operand = checker.getNonNullableType(checker.getTypeAtLocation(expression.expression));
      const asserted = checker.getTypeFromTypeNode(expression.type);
      return (
        asserted.isIntersection() &&
        asserted.types.includes(operand) &&
        asserted.types.every(
          (member) =>
            member === operand ||
            Boolean(
              member.flags & ts.TypeFlags.Object &&
              (member as ts.ObjectType).objectFlags & ts.ObjectFlags.Anonymous &&
              member.symbol?.declarations?.every(
                (declaration) => ts.isTypeLiteralNode(declaration) && own(declaration),
              ),
            ),
        ) &&
        honest(expression.expression)
      );
    }
    // Anything else, another type assertion included, proves nothing.
    return false;
  }
  const symbols = new Map<ts.Symbol, boolean>();
  function honestSymbol(symbol: ts.Symbol): boolean {
    const known = symbols.get(symbol);
    if (known !== undefined) return known;
    symbols.set(symbol, true);
    const declarations = symbol.getDeclarations() ?? [];
    const result =
      declarations.length > 0 &&
      declarations.every(honestDeclaration) &&
      (writes.get(symbol) ?? []).every((value) =>
        ts.isSpreadElement(value) ? honest(value.expression) : honestOrNullish(value),
      );
    symbols.set(symbol, result);
    return result;
  }
  // The value a declaration starts with: an initializer, or the iterated array of a `for…of`.
  function honestStart(declaration: ts.VariableDeclaration): boolean {
    if (declaration.initializer && !nullish(declaration.initializer))
      return (
        honest(declaration.initializer) &&
        (!declaration.type || assignable(declaration.initializer, declaration.name))
      );
    const statement = declaration.parent.parent;
    return ts.isForOfStatement(statement) ? honest(statement.expression) : true;
  }
  function honestDeclaration(declaration: ts.Declaration): boolean {
    if (inStripe(declaration)) return true;
    if (ts.isVariableDeclaration(declaration)) return honestStart(declaration);
    if (ts.isBindingElement(declaration)) {
      if (declaration.initializer && !honestOrNullish(declaration.initializer)) return false;
      let root: ts.Node = declaration.parent.parent;
      while (ts.isBindingElement(root)) root = root.parent.parent;
      return ts.isVariableDeclaration(root)
        ? honestStart(root)
        : ts.isParameter(root) && honestParameter(root);
    }
    if (ts.isParameter(declaration)) return honestParameter(declaration);
    return false;
  }
  function honestParameter(parameter: ts.ParameterDeclaration): boolean {
    if (parameter.dotDotDotToken) return false;
    if (parameter.initializer && !honestOrNullish(parameter.initializer)) return false;
    const fn = parameter.parent;
    const index = fn.parameters.indexOf(parameter);
    const annotated = Boolean(parameter.type ?? ts.getJSDocType(parameter));
    // A callback: an array method passes it elements of its array, stripe-node its own objects.
    if (
      (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
      ts.isCallExpression(fn.parent) &&
      fn.parent.arguments.includes(fn)
    ) {
      const call = fn.parent;
      const declaration = checker.getResolvedSignature(call)?.declaration;
      if (!declaration || !ts.isPropertyAccessExpression(call.expression)) return false;
      const method = call.expression.name.text;
      const array = call.expression.expression;
      if (inStripe(declaration)) return honest(array);
      if (
        !library(declaration) ||
        !(index === 0 || (index === 1 && COMPARATOR_METHODS.has(method))) ||
        !(CALLBACK_METHODS.has(method) || COMPARATOR_METHODS.has(method))
      )
        return false;
      const element = checker.getIndexTypeOfType(
        checker.getNonNullableType(checker.getTypeAtLocation(array)),
        ts.IndexKind.Number,
      );
      return (
        honest(array) &&
        (!parameter.type ||
          Boolean(
            element &&
            checker.isTypeAssignableTo(element, checker.getTypeAtLocation(parameter.name)),
          ))
      );
    }
    // A named function or method: every reference calls it, and every call passes an honest value.
    const name =
      ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)
        ? fn.name
        : (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
            ts.isVariableDeclaration(fn.parent) &&
            fn.parent.initializer === fn
          ? fn.parent.name
          : undefined;
    const symbol = name && resolved(checker.getSymbolAtLocation(name));
    if (!symbol) return false;
    let calls = 0;
    for (const reference of references.get(symbol) ?? []) {
      const parent = reference.parent;
      if (
        reference === name ||
        ts.isImportSpecifier(parent) ||
        ts.isImportClause(parent) ||
        ts.isExportSpecifier(parent) ||
        ts.isExportAssignment(parent)
      )
        continue;
      const callee =
        ts.isPropertyAccessExpression(parent) && parent.name === reference ? parent : reference;
      const call = callee.parent;
      if (!ts.isCallExpression(call) || call.expression !== callee) return false;
      if (call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) return false;
      calls += 1;
      const argument = call.arguments[index];
      if (!argument) continue;
      if (!honestOrNullish(argument)) return false;
      if (parameter.type && !nullish(argument) && !assignable(argument, parameter.name))
        return false;
    }
    return calls > 0 || annotated;
  }

  // The changed schema of a receiver whose every non-nullish part is that schema's Stripe class.
  const schemaOf = (type: ts.Type) => {
    const value = checker.getNonNullableType(type);
    const schemas = new Set(
      (value.isUnion() ? value.types : [value]).map((part) => {
        if (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return undefined;
        const names = (part.isIntersection() ? part.types : [part]).flatMap((member) =>
          typeNames(member, checker, stripe),
        );
        if (names.includes('<any>')) return undefined;
        const mapped = new Set(
          names
            .filter((name) => name.startsWith('Stripe.'))
            .map((name) => classSchemas.get(name.slice('Stripe.'.length))),
        );
        return mapped.size === 1 ? [...mapped][0] : undefined;
      }),
    );
    return schemas.size === 1 ? [...schemas][0] : undefined;
  };

  // `schema.property` pairs the code writes, deletes or assigns into on that Stripe type: a read of
  // such a field may see the code's own value or its absence, so it is never proven.
  const written = new Set<string>();
  const writeTarget = (target: ts.Expression, properties?: string[]) => {
    const schema = schemaOf(checker.getTypeAtLocation(target));
    if (schema) for (const property of properties ?? ['*']) written.add(`${schema}.${property}`);
  };
  const visitWrites = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ((ts.isBinaryExpression(node.parent) &&
        node.parent.left === node &&
        node.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
        ts.isDeleteExpression(node.parent) ||
        ((ts.isPrefixUnaryExpression(node.parent) || ts.isPostfixUnaryExpression(node.parent)) &&
          (node.parent.operator === ts.SyntaxKind.PlusPlusToken ||
            node.parent.operator === ts.SyntaxKind.MinusMinusToken)))
    )
      writeTarget(node.expression, [node.name.text]);
    // `Object.assign(x, …)`, `Reflect.set(x, …)` and `Reflect.deleteProperty(x, …)` may write any field.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      ((node.expression.expression.text === 'Object' && node.expression.name.text === 'assign') ||
        (node.expression.expression.text === 'Reflect' &&
          ['set', 'deleteProperty', 'defineProperty'].includes(node.expression.name.text))) &&
      node.arguments[0]
    )
      writeTarget(node.arguments[0]);
    ts.forEachChild(node, visitWrites);
  };
  for (const source of sources) visitWrites(source);

  const proven: { file: string; line: number; column: number; changeId: string }[] = [];
  for (const read of reads) {
    const source = files.get(read.file)!;
    const property = read.expression.slice(1);
    let start: number;
    try {
      start = source.getPositionOfLineAndCharacter(read.line - 1, read.column - 1);
    } catch {
      continue;
    }
    let access: ts.PropertyAccessExpression | undefined;
    const find = (node: ts.Node) => {
      if (access || node.getEnd() <= start || node.getStart() > start) return;
      if (
        ts.isPropertyAccessExpression(node) &&
        node.getStart() === start &&
        node.name.text === property
      )
        access = node;
      else ts.forEachChild(node, find);
    };
    find(source);
    if (!access) continue;
    const change = changes.find((candidate) => candidate.id === read.changeId);
    if (
      !change ||
      change.property !== property ||
      written.has(`${change.schema}.${property}`) ||
      written.has(`${change.schema}.*`) ||
      schemaOf(checker.getTypeAtLocation(access.expression)) !== change.schema ||
      !honest(access.expression)
    )
      continue;
    proven.push({ file: read.file, line: read.line, column: read.column, changeId: change.id });
  }
  return proven;
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
export type LocalProof =
  'repository-type' | 'literal-config' | 'generated-type' | 'receiver-type' | 'prisma-client';
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
  // The models the repository's committed Prisma schema declares (runtime-stand-ins.ts), for the
  // prisma-client proof.
  prismaModels?: readonly string[];
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
  'sort',
  'toSorted',
]);
// Comparators, whose first two parameters are both elements.
const COMPARATOR_METHODS = new Set(['sort', 'toSorted']);
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
//   the element parameter of a callback such as `find`, `map` or a `sort` comparator) that nothing
//   writes an element into, or as a property of a `const` object literal of object literals read by a
//   computed key; `null` and `undefined` count as no value.
// - `generated-type`: the receiver is a `const` asserted to a type a code generator wrote from the
//   repository's own schema (GENERATED_TYPES), which declares the property, outside a function that
//   constructs a Stripe webhook event, and not asserted from an event's `data.object`.
// - `receiver-type` (also behind a type assertion, followed from the asserted value) and
//   `prisma-client`: see their definitions below.
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
  // The installed stripe types are loaded even where no file imports them, so the receiver-type
  // checks can compare with them (acceptsSchema).
  const stripe = stripePackageDirectory(root);
  const entry = stripe ? stripeTypesEntry(stripe) : undefined;
  const program = ts.createProgram(
    [
      ...files.map((path) => resolve(root, path)),
      ...(entry ? [entry.ambient ?? entry.module!] : []),
    ],
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
  // No repository code can change an object's properties: no reference is written through, passed
  // to a call (`Object.assign(row, …)`), returned, or copied into another binding or literal.
  const unchanged = (symbol: ts.Symbol) =>
    referencesOf(symbol).every((reference) => {
      const parent = reference.parent;
      // Through a namespace import (`cfg.plans.pro = …`) the object escapes what is checked here.
      if (ts.isPropertyAccessExpression(parent) && parent.name === reference) return false;
      if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
        return (
          parent.expression !== reference ||
          (!assigned(parent) && !ts.isDeleteExpression(parent.parent))
        );
      return !(
        ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
          parent.arguments?.includes(reference)) ||
        ts.isReturnStatement(parent) ||
        ts.isArrowFunction(parent) ||
        ts.isArrayLiteralExpression(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isShorthandPropertyAssignment(parent) ||
        (ts.isVariableDeclaration(parent) && parent.initializer === reference) ||
        (ts.isBinaryExpression(parent) && parent.right === reference && assigned(parent.left))
      );
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
      (elements ? unwritten(symbol) : unchanged(symbol)),
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
    // No value at all (`plan ? PLANS[plan] : null`) is not a Stripe object either.
    if (
      node.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(node) && node.text === 'undefined' && !symbolOf(node)?.valueDeclaration)
    )
      return true;
    if (ts.isConditionalExpression(node))
      return literalObject(node.whenTrue, depth + 1) && literalObject(node.whenFalse, depth + 1);
    if (ts.isElementAccessExpression(node))
      return literalArray(node.expression, depth + 1) || literalRecord(node.expression, depth + 1);
    const array = method(node, ELEMENT_METHODS);
    if (array) return literalArray(array, depth + 1);
    const declaration = ts.isIdentifier(node) ? symbolOf(node)?.valueDeclaration : undefined;
    if (declaration && ts.isParameter(declaration)) {
      const callback = declaration.parent;
      const call = callback.parent;
      const index = callback.parameters.indexOf(declaration);
      return (
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        (index === 0 ||
          (index === 1 &&
            ts.isCallExpression(call) &&
            ts.isPropertyAccessExpression(call.expression) &&
            COMPARATOR_METHODS.has(call.expression.name.text))) &&
        ts.isIdentifier(declaration.name) &&
        ts.isCallExpression(call) &&
        call.arguments[0] === callback &&
        literalArray(method(call, CALLBACK_METHODS) ?? call, depth + 1)
      );
    }
    return literalBinding(node, literalObject, depth);
  };
  // An object literal whose every property is an object literal, read by a computed key: a table
  // of plans keyed by name.
  const literalRecord = (node: ts.Expression, depth = 0): boolean => {
    if (depth > 8) return false;
    node = value(node);
    if (ts.isObjectLiteralExpression(node))
      return node.properties.every(
        (property) =>
          ts.isPropertyAssignment(property) &&
          ts.isObjectLiteralExpression(value(property.initializer)) &&
          literalObject(property.initializer, depth + 1),
      );
    return (
      literalBinding(node, literalRecord, depth) &&
      entriesUnchanged(symbolOf(node as ts.Identifier)!)
    );
  };
  // Each entry of a record (`plans.pro`, `plans[key]`) is only read: a property of it, or the value
  // of a `const` (directly, behind a cast or as a branch of a conditional) that is itself unchanged.
  // `Object.assign(plans.pro, …)` or a write into an entry could put anything there.
  const entriesUnchanged = (symbol: ts.Symbol) =>
    referencesOf(symbol).every((reference) => {
      const entry = reference.parent;
      if (
        !(ts.isPropertyAccessExpression(entry) || ts.isElementAccessExpression(entry)) ||
        entry.expression !== reference
      )
        return true;
      let use: ts.Node = entry;
      while (
        ts.isParenthesizedExpression(use.parent) ||
        ts.isAsExpression(use.parent) ||
        ts.isNonNullExpression(use.parent) ||
        ts.isSatisfiesExpression(use.parent) ||
        (ts.isConditionalExpression(use.parent) && use.parent.condition !== use)
      )
        use = use.parent;
      const parent = use.parent;
      if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
        return (
          parent.expression === use && !assigned(parent) && !ts.isDeleteExpression(parent.parent)
        );
      if (
        ts.isVariableDeclaration(parent) &&
        parent.initializer === use &&
        constant(parent) &&
        ts.isIdentifier(parent.name)
      ) {
        const alias = symbolOf(parent.name);
        return Boolean(alias && unchanged(alias));
      }
      return false;
    });
  // `sort` passes array elements to its comparator only on an array; a class's own `sort` may not.
  const arrayComparator = (callee: ts.PropertyAccessExpression) => {
    if (!COMPARATOR_METHODS.has(callee.name.text)) return true;
    const type = checker.getNonNullableType(checker.getTypeAtLocation(callee.expression));
    return checker.isArrayType(type) || checker.isTupleType(type);
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
        arrayComparator(callee) &&
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
  // The installed stripe package's types for each schema, by the SDK spec's resource names.
  let stripeTypes: Map<string, ts.Type[]> | undefined;
  const schemaTypes = (schema: string) => {
    if (!stripeTypes) {
      const found = new Map<string, ts.Type[]>();
      const visit = (node: ts.Node, stripe: string) => {
        if (
          (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) &&
          node.name &&
          !node.typeParameters
        ) {
          const symbol = checker.getSymbolAtLocation(node.name);
          const type = symbol && checker.getDeclaredTypeOfSymbol(symbol);
          const name = type ? (typeNames(type, checker, stripe)[0] ?? '') : '';
          const mapped = name.startsWith('Stripe.') ? classSchemas.get(name.slice(7)) : undefined;
          if (type && mapped) found.set(mapped, [...(found.get(mapped) ?? []), type]);
        }
        ts.forEachChild(node, (child) => visit(child, stripe));
      };
      for (const source of program.getSourceFiles()) {
        const stripe = STRIPE_PACKAGE.exec(source.fileName)?.[1];
        if (stripe) visit(source, stripe);
      }
      stripeTypes = found;
    }
    return stripeTypes.get(schema) ?? [];
  };
  // A passing type check lets a Stripe object reach a receiver without a cast only where its type
  // is assignable to the receiver's, however the value travels (a property write, push, Map.set,
  // a spread, a constructor). With the target stripe-node the removed field is gone from it, so a
  // receiver that requires the field cannot take it. Unknown schemas and types prove nothing.
  // shortcut: a value typed `any` (JSON.parse, an untyped library) written into the receiver is not
  // seen; upgrade by following writes if a review finds one.
  const acceptsSchema = (receiver: ts.Type, schemas: readonly string[]) => {
    if (receiver.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
    const types = schemas.map(schemaTypes);
    return (
      !schemas.length ||
      types.some((list) => !list.length) ||
      types.some((list) => list.some((type) => checker.isTypeAssignableTo(type, receiver)))
    );
  };
  const schemasOf = (read: Read) =>
    (options.changes ?? [])
      .filter((change) => change.id === read.changeId)
      .map((change) => change.schema);
  const receiverOf = (access: ts.PropertyAccessExpression) =>
    checker.getNonNullableType(checker.getTypeAtLocation(access.expression));
  const repositoryType = (access: ts.PropertyAccessExpression, read: Read) => {
    const file = read.file;
    if (!TYPESCRIPT.test(file) || !(options.typeChecked?.(file) ?? false)) return false;
    if (asserted(access.expression, checker)) return false;
    if (acceptsSchema(receiverOf(access), schemasOf(read))) return false;
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
    // A read of a smaller expression ends by itself; only the steps through declarations count.
    if (ts.isAwaitExpression(node)) return flows(node.expression, schemas, depth);
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
      return flows(node.expression, schemas, depth);
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
      if (
        !ts.isPropertyAccessExpression(callee) ||
        !CALLBACK_METHODS.has(callee.name.text) ||
        !arrayComparator(callee)
      )
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
    const schemas = schemasOf(read);
    return (
      !acceptsSchema(receiverOf(access), schemas) &&
      notSchema(receiverOf(access), schemas) &&
      propertyNotSchema(access, schemas) &&
      flows(access.expression, schemas)
    );
  };
  // receiver-type behind an assertion: `(product as any).default_price` reads a Stripe.Product's
  // default_price whatever the cast says, so the receiver's type is followed from the asserted
  // value, which must flow (no annotation or assertion of its own), through each property read. Every
  // object it can be must declare the property and not be the changed schema's Stripe object.
  const unasserted = (node: ts.Expression, schemas: readonly string[]): ts.Type[] | undefined => {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return unasserted(node.expression, schemas);
    let types: ts.Type[];
    if (ts.isPropertyAccessExpression(node)) {
      const owners = unasserted(node.expression, schemas);
      if (!owners) return undefined;
      types = [];
      for (const owner of owners) {
        const property = checker.getPropertyOfType(owner, node.name.text);
        // Only stripe-node's own declarations describe what Stripe sends; a repository holder's
        // property can be written with anything behind a cast.
        if (
          !property?.declarations?.length ||
          !property.declarations.every((declaration) =>
            STRIPE_PACKAGE.test(declaration.getSourceFile().fileName),
          )
        )
          return undefined;
        types.push(checker.getTypeOfSymbolAtLocation(property, node));
      }
    } else if (flows(node, schemas)) types = [checker.getTypeAtLocation(node)];
    else return undefined;
    const members = types
      .map((type) => checker.getNonNullableType(type))
      .flatMap((type) => (type.isUnion() ? type.types : [type]));
    if (members.some((type) => type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)))
      return undefined;
    // A primitive member (a Stripe id where the object is not expanded) has no Stripe fields.
    const objects = members.filter((type) => type.flags & ts.TypeFlags.Object);
    return objects.length ? objects : undefined;
  };
  const assertedReceiverType = (access: ts.PropertyAccessExpression, read: Read) => {
    if (!TYPESCRIPT.test(read.file) || !(options.typeChecked?.(read.file) ?? false)) return false;
    if (!asserted(access.expression, checker)) return false;
    const schemas = schemasOf(read);
    const receivers = unasserted(access.expression, schemas);
    return Boolean(
      receivers?.every(
        (receiver) =>
          checker.getPropertyOfType(receiver, access.name.text) &&
          notSchema(receiver, schemas) &&
          !acceptsSchema(receiver, schemas),
      ),
    );
  };
  // prisma-client: a model delegate (`prisma.subscription`) on a client the repository constructs
  // from @prisma/client. The generated client is missing from a clean checkout, so its type is
  // unresolved here; the delegate's name is a model the committed schema declares.
  // shortcut: a client generated to a custom output path, or one extended with `$extends`, is not
  // followed; add it when a run shows one.
  const prismaImport = (node: ts.Node) => {
    const declaration = ts.isIdentifier(node)
      ? checker.getSymbolAtLocation(node)?.declarations?.[0]
      : undefined;
    return Boolean(
      declaration &&
      ts.isImportSpecifier(declaration) &&
      (declaration.propertyName ?? declaration.name).text === 'PrismaClient' &&
      ts.isStringLiteral(declaration.parent.parent.parent.moduleSpecifier) &&
      declaration.parent.parent.parent.moduleSpecifier.text === '@prisma/client',
    );
  };
  // `PrismaClient`, optionally with `| undefined` or `| null`, as a global or holder declares it.
  const prismaTypeNode = (node: ts.TypeNode | undefined): boolean =>
    Boolean(
      node &&
      (ts.isUnionTypeNode(node)
        ? node.types.some(ts.isTypeReferenceNode) &&
          node.types.every(
            (member) =>
              (ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword) ||
              member.kind === ts.SyntaxKind.UndefinedKeyword ||
              prismaTypeNode(member),
          )
        : ts.isTypeReferenceNode(node) && prismaImport(node.typeName)),
    );
  // A write of `.name` on an untyped receiver (`(globalThis as any).prisma = …`) that the symbol's
  // references cannot see.
  const untypedWrite = (name: string) => {
    const visit = (node: ts.Node): boolean =>
      (ts.isPropertyAccessExpression(node) &&
        node.name.text === name &&
        assigned(node) &&
        Boolean(checker.getTypeAtLocation(node.expression).flags & ts.TypeFlags.Any)) ||
      Boolean(ts.forEachChild(node, (child) => visit(child) || undefined));
    return sources.some(visit);
  };
  const prismaClient = (node: ts.Expression, seen: Set<ts.Node>, depth = 0): boolean => {
    if (depth > 8) return false;
    node = value(node);
    if (seen.has(node)) return true;
    seen.add(node);
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
        node.operatorToken.kind,
      )
    )
      return prismaClient(node.left, seen, depth + 1) && prismaClient(node.right, seen, depth + 1);
    if (ts.isNewExpression(node)) return prismaImport(node.expression);
    if (ts.isIdentifier(node)) {
      const declaration = symbolOf(node)?.valueDeclaration;
      return Boolean(
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        own(declaration) &&
        constant(declaration) &&
        declaration.initializer &&
        prismaClient(declaration.initializer, seen, depth + 1),
      );
    }
    // A holder for reuse across hot reloads (`globalThis.prisma`, `globalForPrisma.prisma`): typed
    // PrismaClient, and every value the repository writes into it a client too.
    if (ts.isPropertyAccessExpression(node)) {
      const symbol = checker.getSymbolAtLocation(node.name);
      const declarations = symbol?.getDeclarations() ?? [];
      return Boolean(
        symbol &&
        declarations.length &&
        declarations.every(
          (declaration) =>
            (ts.isVariableDeclaration(declaration) || ts.isPropertySignature(declaration)) &&
            own(declaration) &&
            prismaTypeNode(declaration.type),
        ) &&
        !untypedWrite(symbol.name) &&
        referencesOf(symbol).every((reference) => {
          const access = reference.parent;
          if (!ts.isPropertyAccessExpression(access) || access.name !== reference)
            return !assigned(reference);
          if (!assigned(access)) return true;
          const write = access.parent;
          return (
            ts.isBinaryExpression(write) &&
            write.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            prismaClient(write.right, seen, depth + 1)
          );
        }),
      );
    }
    return false;
  };
  const models = new Set(
    (options.prismaModels ?? []).map((model) => model.charAt(0).toLowerCase() + model.slice(1)),
  );
  const prismaDelegate = (access: ts.PropertyAccessExpression) =>
    models.has(access.name.text) && prismaClient(access.expression, new Set());
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
    const proof: LocalProof | undefined = repositoryType(access, read)
      ? 'repository-type'
      : literalObject(access.expression)
        ? 'literal-config'
        : generatedType(access)
          ? 'generated-type'
          : receiverType(access, read) || assertedReceiverType(access, read)
            ? 'receiver-type'
            : prismaDelegate(access)
              ? 'prisma-client'
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
