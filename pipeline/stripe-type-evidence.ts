import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

// Owner decision D2b (2026-10-27): of `reads` (removed-field reads at the line and column where the
// property access starts), the ones TypeScript's checker, run on the repository's own files, shows
// read an object the repository itself declares, never a Stripe type. A read counts only in a
// TypeScript file, with no type assertion on its receiver, when the property resolves to
// declarations in the repository's own non-declaration files and every part of the receiver's type,
// its base types included, is declared there too. `any`, `unknown`, an unresolved import (the
// checker's error type), a type parameter, a primitive and anything declared under node_modules or
// in a `.d.ts` file never count: a Stripe type, reached directly, through an alias or as a base, is
// declared in the stripe package or not resolved at all.
export function localReceiverReads<
  Read extends { file: string; line: number; column: number; expression: string },
>(repository: Repository, reads: readonly Read[]) {
  const typed = reads.filter((read) => TYPESCRIPT.test(read.file) && !read.file.endsWith('.d.ts'));
  const files = repository.files
    .map((file) => file.path)
    .filter((path) => SOURCE.test(path) && !TEST_PATH.test(path));
  if (!typed.length || files.length > MAX_TYPED_FILES) return [];
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
  return typed.filter((read) => {
    const source = program.getSourceFile(resolve(root, read.file));
    if (!source) return false;
    const start = source.getLineStarts()[read.line - 1] + read.column - 1;
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
    if (!access || asserted(access.expression, checker)) return false;
    const declarations = checker.getSymbolAtLocation(access.name)?.getDeclarations() ?? [];
    seen.clear();
    return (
      declarations.length > 0 &&
      declarations.every(own) &&
      local(checker.getNonNullableType(checker.getTypeAtLocation(access.expression)))
    );
  });
}

// Owner decision D2b for contract changes: a response change stays `unknown` when code reads its
// property name on an object Refit cannot trace (operation-reach.ts annotateReach). Where every
// read of that name (`reads`, the analyzer's findings for the change's owner) is untraced and
// `local` shows its receiver is not a Stripe type, the change is not reached: it becomes `unused`
// with the reads it checked, and leaves `impacts`. A traced or confirmed read, a computed property
// and a read `local` does not return keep the change as it was.
export async function localReach(options: {
  changes: Record<string, unknown>[];
  impacts: readonly BreakingOperationImpact[];
  before: Record<string, unknown>;
  reads: (removals: Removal[]) => Finding[];
  local: (reads: Finding[]) => Promise<readonly Finding[]> | readonly Finding[];
}) {
  const owners = new Map<Record<string, unknown>, { schema: string; property: string }>();
  for (const change of options.changes) {
    if (change.reach !== 'unknown' || !String(change.id).startsWith('response-')) continue;
    const owner = responsePropertyOwner(change, options.before);
    if (owner) owners.set(change, owner);
  }
  const removals = new Map<string, Removal>();
  for (const { schema, property } of owners.values())
    removals.set(`reach:${schema}.${property}`, {
      id: `reach:${schema}.${property}`,
      schema,
      property,
      pointer: `/components/schemas/${schema}/properties/${property}`,
    });
  const findings = removals.size
    ? options.reads([...removals.values()]).filter((finding) => !TEST_PATH.test(finding.file))
    : [];
  const site = (read: Pick<Finding, 'file' | 'line' | 'column' | 'expression'>) =>
    `${read.file}:${read.line}:${read.column}${read.expression}`;
  const local = new Set(
    (await options.local(findings.filter((finding) => finding.untraced))).map((read) => site(read)),
  );
  const cleared: { change: Record<string, unknown>; reads: Finding[] }[] = [];
  for (const [change, owner] of owners) {
    const reads = findings.filter(
      (finding) => finding.changeId === `reach:${owner.schema}.${owner.property}`,
    );
    if (!reads.length || !reads.every((read) => read.untraced && local.has(site(read)))) continue;
    const listed = reads
      .slice(0, 3)
      .map((read) => `${read.file}:${read.line}`)
      .join(', ');
    Object.assign(change, {
      reach: 'unused',
      reachReason: `Owner decision D2b: TypeScript's checker shows every read of \`${owner.property}\` (${listed}${reads.length > 3 ? ` and ${reads.length - 3} more` : ''}) reads an object that is not a Stripe type, not ${owner.schema}; the type oracle passed and the AI proposed no change.`,
    });
    cleared.push({ change, reads });
  }
  const gone = new Set(cleared.map(({ change }) => `${String(change.id)} ${String(change.text)}`));
  const impacts = options.impacts.flatMap((impact) => {
    const changes = impact.changes.filter((entry) => !gone.has(`${entry.id} ${entry.text}`));
    return changes.length
      ? [changes.length === impact.changes.length ? impact : { ...impact, changes }]
      : [];
  });
  return { cleared, impacts };
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
