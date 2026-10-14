import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript-compiler';
import { isObject } from './specifications.ts';

// Independent labelling oracle for the Stripe benchmark: TypeScript's own checker, with the
// application's exact stripe package type definitions, decides what each property read's
// receiver is. It never uses Refit's analyzer, so its labels can grade it.

const SKIPPED = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.turbo']);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

export type OracleLabel = 'breaking' | 'stripe-unaffected' | 'not-stripe' | 'unknown';

export interface OracleRead {
  file: string;
  line: number;
  column: number;
  property: string;
  label: OracleLabel;
  receiverTypes: string[];
  schemas: string[];
}

// `Stripe.Checkout.Session` → `checkout.session`, from x-stripeResource in Stripe's SDK spec.
export function stripeClassSchemas(sdkSpec: Record<string, unknown>) {
  const map = new Map<string, string>();
  const schemas = isObject(sdkSpec.components) ? sdkSpec.components.schemas : undefined;
  if (!isObject(schemas)) return map;
  for (const [schema, definition] of Object.entries(schemas)) {
    const resource = isObject(definition) ? definition['x-stripeResource'] : undefined;
    if (!isObject(resource) || typeof resource.class_name !== 'string') continue;
    const name = [resource.in_package, resource.class_name].filter(Boolean).join('.');
    if (!map.has(name)) map.set(name, schema);
  }
  return map;
}

function sourceFiles(root: string, directory = root, files: string[] = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name)) sourceFiles(root, path, files);
    } else if (SOURCE.test(entry.name)) files.push(path);
  }
  return files;
}

function compilerOptions(root: string): ts.CompilerOptions {
  const config = join(root, 'tsconfig.json');
  const base: ts.CompilerOptions = {};
  if (existsSync(config)) {
    const parsed = ts.readConfigFile(config, ts.sys.readFile);
    if (!parsed.error)
      Object.assign(base, ts.parseJsonConfigFileContent(parsed.config, ts.sys, root).options);
  }
  return {
    ...base,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    jsx: base.jsx ?? ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.Latest,
    moduleResolution: base.moduleResolution ?? ts.ModuleResolutionKind.Bundler,
    module: base.module ?? ts.ModuleKind.ESNext,
  };
}

function typeNames(type: ts.Type, checker: ts.TypeChecker, depth = 0): string[] {
  if (depth > 4) return [];
  if (type.isUnion() || type.isIntersection())
    return type.types.flatMap((member) => typeNames(member, checker, depth + 1));
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return ['<any>'];
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (!symbol) return [checker.typeToString(type)];
  return [checker.getFullyQualifiedName(symbol).replace(/^"[^"]+"\./, '')];
}

export function labelReads(options: {
  repository: string;
  stripeTypes: string;
  removed: Map<string, Set<string>>;
  classSchemas: Map<string, string>;
}): OracleRead[] {
  const files = sourceFiles(options.repository);
  // Monorepos keep a tsconfig per package; each file is checked with its nearest project so
  // that package path aliases resolve.
  const projects = new Map<string, string[]>();
  for (const file of files) {
    let directory = dirname(file);
    while (
      directory.startsWith(options.repository) &&
      !existsSync(join(directory, 'tsconfig.json'))
    )
      directory = dirname(directory);
    const project = directory.startsWith(options.repository) ? directory : options.repository;
    projects.set(project, [...(projects.get(project) ?? []), file]);
  }
  const reads: OracleRead[] = [];
  for (const [project, projectFiles] of projects) {
    const program = ts.createProgram(
      [...projectFiles, join(options.stripeTypes, 'index.d.ts')],
      compilerOptions(project),
    );
    reads.push(...readsInProgram(program, projectFiles, options));
  }
  return reads;
}

function readsInProgram(
  program: ts.Program,
  files: string[],
  options: Parameters<typeof labelReads>[0],
): OracleRead[] {
  const checker = program.getTypeChecker();
  const reads: OracleRead[] = [];
  for (const path of files) {
    const source = program.getSourceFile(path);
    if (!source) continue;
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && options.removed.has(node.name.text)) {
        const receiverTypes = [
          ...new Set(typeNames(checker.getTypeAtLocation(node.expression), checker)),
        ];
        const schemas = receiverTypes
          .filter((name) => name.startsWith('Stripe.'))
          .map((name) => options.classSchemas.get(name.slice('Stripe.'.length)))
          .filter((schema): schema is string => Boolean(schema));
        const removedFrom = options.removed.get(node.name.text)!;
        const unmapped = receiverTypes.some(
          (name) =>
            name === '<any>' ||
            (name.startsWith('Stripe.') && !options.classSchemas.has(name.slice(7))),
        );
        const label: OracleLabel = schemas.some((schema) => removedFrom.has(schema))
          ? 'breaking'
          : unmapped
            ? 'unknown'
            : schemas.length
              ? 'stripe-unaffected'
              : 'not-stripe';
        const position = source.getLineAndCharacterOfPosition(node.name.getStart());
        reads.push({
          file: relative(options.repository, path),
          line: position.line + 1,
          column: position.character + 1,
          property: node.name.text,
          label,
          receiverTypes,
          schemas,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return reads;
}

export function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}
