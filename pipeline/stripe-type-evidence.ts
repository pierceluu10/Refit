import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript-compiler';
import { requestProperty, responsePropertyOwner } from './operation-reach.ts';
import type { BreakingOperationImpact } from './provider-operations.ts';
import { TEST_PATH } from './source-paths.ts';
import { labelReads, SOURCE, stripeTypesEntry } from './stripe-ground-truth.ts';
import type { Finding, Removal, Repository } from './types.ts';

// Removed-field reads whose receiver TypeScript's checker resolves to a Stripe object, using the
// application's own stripe type definitions and the ground-truth oracle's resolver. Type evidence
// only confirms that code reads a removed field; casts can lie, so these findings carry
// `typeEvidence` and stop automatic migration for review (pipeline/migration-review.ts).

// The checker builds a full program per tsconfig project; larger repositories are left to the
// analyzer's own evidence.
const MAX_TYPED_FILES = 2_000;

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

// `Property 'x' does not exist on type 'Stripe.Subscription'` (TS2339), or with a suggestion (TS2551).
const MISSING_PROPERTY = /^Property '([^']+)' does not exist on type '(?:Stripe\.)?([\w.]+)'/;

const offsetOf = (source: ts.SourceFile, error: OracleTypeError) =>
  (source.getLineStarts()[error.line - 1] ?? NaN) + error.column - 1;

// A request change is reached where the target SDK's types reject the property it names inside a
// traced call of its operation: at a property of that name, or anywhere in the call when the
// message quotes the name.
function requestError(
  change: Record<string, unknown>,
  errors: OracleTypeError[],
  impacts: BreakingOperationImpact[],
  files: { path: string; content: string }[],
) {
  const name = requestProperty(String(change.text))?.split('/').at(-1);
  const impact = impacts.find(
    (entry) =>
      entry.path === change.path && entry.httpMethod === String(change.operation).toUpperCase(),
  );
  if (!name || !impact) return undefined;
  return errors.find((error) => {
    const content = files.find((file) => file.path === error.file)?.content;
    const calls = impact.usages.filter((usage) => usage.file === error.file);
    if (content === undefined || !calls.length || TEST_PATH.test(error.file)) return false;
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
    const schemas = [...classSchemas]
      .filter(([name]) => name === match[2] || name.endsWith(`.${match[2]}`))
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
      ? requestError(change, errors, context.impacts, context.files)
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
