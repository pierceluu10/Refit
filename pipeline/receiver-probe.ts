import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// What object an untraced read reads, decided by TypeScript's checker inside the offline check
// sandbox, where the repository's prepared dependencies and the target stripe-node are installed.
// The host has neither, so there a type from a library (zod, Prisma, Convex) or from stripe itself
// is an unresolved import; here it resolves (owner decision D2b, docs/ARCHITECTURE.md).
//
// Labels, for a read in a TypeScript file:
// - `own`: every part of the receiver's type, its base types and the property itself are declared
//   in the repository's own non-declaration files;
// - `library`: the same, but some part is declared in a dependency or a declaration file that is
//   not a Stripe package;
// - `stripe`: some part is declared in a Stripe package (`stripe`, `@stripe/*`, any package whose
//   name contains "stripe"), with the type names in `types`;
// - `asserted`: a type assertion in the receiver's local flow states the type, which can lie;
// - `unknown`: `any`, `unknown`, an unresolved import, a type parameter, a primitive, an index
//   signature or a read the probe cannot find.
export type ReceiverLabel = 'own' | 'library' | 'stripe' | 'asserted' | 'unknown';
export interface ProbedRead {
  file: string;
  line: number;
  column: number;
  expression: string;
  label: ReceiverLabel;
  types: string[];
}

// The checker builds one program over the repository's source files; larger repositories keep the
// host's own-declarations check.
export const MAX_PROBED_FILES = 2_000;
const TYPESCRIPT = /\.[cm]?tsx?$/;

// Run in the sandbox as `node probe.mjs input.json` from the workspace; prints one JSON array.
// Plain JavaScript: the sandbox has Node and Refit's read-only compiler, nothing else of Refit's.
export const RECEIVER_PROBE = `import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
const ts = createRequire(import.meta.url)(process.env.REFIT_TYPESCRIPT ?? '/refit/typescript/lib/typescript.js');
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const root = resolve('.');
// A package whose scope or name contains "stripe": stripe, @stripe/stripe-js, @types/stripe.
const STRIPE_PACKAGE = /[\\\\/]node_modules[\\\\/](?:@[^\\\\/]*stripe|(?:@[^\\\\/]+[\\\\/])?[^\\\\/]*stripe)/i;
// A type named in the Stripe namespace or declared in a module named for stripe, wherever it is.
const STRIPE_NAME = /^(?:Stripe\\.|"[^"]*stripe)/i;
const compilerOptions = () => {
  const config = join(root, 'tsconfig.json');
  const base = {};
  if (existsSync(config)) {
    const parsed = ts.readConfigFile(config, ts.sys.readFile);
    if (!parsed.error) Object.assign(base, ts.parseJsonConfigFileContent(parsed.config, ts.sys, root).options);
  }
  return { ...base, allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true, types: [],
    jsx: base.jsx ?? ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest,
    moduleResolution: base.moduleResolution ?? ts.ModuleResolutionKind.Bundler,
    module: base.module ?? ts.ModuleKind.ESNext };
};
const program = ts.createProgram(input.files.map((path) => resolve(root, path)), compilerOptions());
const checker = program.getTypeChecker();
const origin = (declaration) => {
  const path = declaration.getSourceFile().fileName;
  if (STRIPE_PACKAGE.test(path)) return 'stripe';
  return path.endsWith('.d.ts') || path.split(/[\\\\/]/).includes('node_modules') || !path.startsWith(root) ? 'library' : 'own';
};
const asserted = (expression, depth = 0) => {
  if (depth > 8) return false;
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) return true;
  if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) || ts.isAwaitExpression(expression) ||
    ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
    return asserted(expression.expression, depth + 1);
  if (!ts.isIdentifier(expression)) return false;
  let declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
  while (declaration && ts.isBindingElement(declaration)) declaration = declaration.parent.parent;
  return Boolean(declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && asserted(declaration.initializer, depth + 1));
};
const label = (access) => {
  if (asserted(access.expression)) return { label: 'asserted', types: [] };
  const origins = new Set();
  const types = new Set();
  const property = checker.getSymbolAtLocation(access.name)?.getDeclarations() ?? [];
  if (!property.length) return { label: 'unknown', types: [] };
  for (const declaration of property) origins.add(origin(declaration));
  const seen = new Set();
  const walk = (type) => {
    if (seen.has(type)) return true;
    seen.add(type);
    if (type.isUnion() || type.isIntersection()) return type.types.every(walk);
    if (!(type.flags & ts.TypeFlags.Object)) return false;
    const symbol = type.aliasSymbol ?? type.getSymbol();
    const declarations = symbol?.getDeclarations() ?? [];
    if (!declarations.length) return false;
    const name = checker.getFullyQualifiedName(symbol);
    if (STRIPE_NAME.test(name)) origins.add('stripe');
    types.add(name.replace(/^"[^"]*"\\./, ''));
    for (const declaration of declarations) origins.add(origin(declaration));
    const target = type.target ?? type;
    return (target.isClassOrInterface() ? (checker.getBaseTypes(target) ?? []) : []).every(walk);
  };
  const resolved = walk(checker.getNonNullableType(checker.getTypeAtLocation(access.expression)));
  const named = [...types].slice(0, 5);
  if (origins.has('stripe')) return { label: 'stripe', types: named };
  if (!resolved) return { label: 'unknown', types: named };
  return { label: origins.has('library') ? 'library' : 'own', types: named };
};
const results = input.reads.map((read) => {
  const source = program.getSourceFile(resolve(root, read.file));
  const property = read.expression.replace(/^\\./, '');
  let access;
  if (source && read.line >= 1 && read.line <= source.getLineStarts().length) {
    const start = source.getLineStarts()[read.line - 1] + read.column - 1;
    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node) && node.getStart(source) === start && node.name.text === property) access = node;
      else if (!access && node.pos <= start && start < node.end) ts.forEachChild(node, visit);
    };
    visit(source);
  }
  // A checker failure on one read leaves that read unknown, never the others.
  let result = { label: 'unknown', types: [] };
  try {
    if (access) result = label(access);
  } catch {}
  return { ...read, ...result };
});
process.stdout.write(JSON.stringify(results));
`;

// Writes the probe and its input to `directory`, which the sandbox mounts read-only, and returns
// the command to run from the workspace. Only reads in TypeScript files are probed.
export async function writeReceiverProbe(
  directory: string,
  mount: string,
  files: readonly string[],
  reads: readonly Pick<ProbedRead, 'file' | 'line' | 'column' | 'expression'>[],
) {
  const typed = reads.filter((read) => TYPESCRIPT.test(read.file) && !read.file.endsWith('.d.ts'));
  if (!typed.length || files.length > MAX_PROBED_FILES) return undefined;
  await writeFile(join(directory, 'probe.mjs'), RECEIVER_PROBE);
  await writeFile(
    join(directory, 'input.json'),
    JSON.stringify({
      files,
      reads: typed.map(({ file, line, column, expression }) => ({
        file,
        line,
        column,
        expression,
      })),
    }),
  );
  return ['node', `${mount}/probe.mjs`, `${mount}/input.json`];
}

// The probe's output, or undefined when it did not finish or printed something else.
export function readReceiverProbe(stdout: string): ProbedRead[] | undefined {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) &&
      parsed.every(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as ProbedRead).file === 'string' &&
          typeof (entry as ProbedRead).line === 'number' &&
          typeof (entry as ProbedRead).label === 'string',
      )
      ? (parsed as ProbedRead[])
      : undefined;
  } catch {
    return undefined;
  }
}

// D2b: a read the probe shows reads an object that is not a Stripe type, without an assertion.
export const notStripe = (read: ProbedRead) => read.label === 'own' || read.label === 'library';
