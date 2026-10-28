import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript-compiler';
import { isObject } from './specifications.ts';

// Independent labelling oracle for the Stripe benchmark: TypeScript's own checker, with the
// application's exact stripe package type definitions, decides what each property read's
// receiver is. It never uses Refit's analyzer, so its labels can grade it.

const SKIPPED = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.turbo']);
export const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

export type OracleLabel = 'breaking' | 'stripe-unaffected' | 'not-stripe' | 'unknown';

export interface OracleRead {
  file: string;
  line: number;
  column: number;
  property: string;
  label: OracleLabel;
  receiverTypes: string[];
  schemas: string[];
  // Set for a request parameter the call still sends: `POST /v1/checkout/sessions payment_method_types`.
  request?: string;
  // Where the whole property access starts, which is where Refit's analyzer reports a read.
  start: { line: number; column: number };
  // A type assertion (`as`, `<T>`) in the receiver's local flow states its type. Casts can lie,
  // for example an Invoice payload cast to Stripe.Checkout.Session.
  asserted: boolean;
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

// `Checkout.SessionCreateParams` → `POST /v1/checkout/sessions`, from x-stripeOperations: stripe-node
// names each method's parameter type `<Class><Method>Params`.
export function stripeParamOperations(sdkSpec: Record<string, unknown>) {
  const map = new Map<string, { path: string; operation: string }>();
  const schemas = isObject(sdkSpec.components) ? sdkSpec.components.schemas : undefined;
  if (!isObject(schemas)) return map;
  for (const definition of Object.values(schemas)) {
    if (!isObject(definition)) continue;
    const resource = definition['x-stripeResource'];
    const operations = definition['x-stripeOperations'];
    if (
      !isObject(resource) ||
      typeof resource.class_name !== 'string' ||
      !Array.isArray(operations)
    )
      continue;
    const prefix = [resource.in_package, resource.class_name].filter(Boolean).join('.');
    for (const entry of operations) {
      if (!isObject(entry) || entry.method_on !== 'service') continue;
      const { method_name: method, path, operation } = entry;
      if (typeof method !== 'string' || typeof path !== 'string' || typeof operation !== 'string')
        continue;
      const name = `${prefix}${method.replace(/(?:^|_)([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase())}Params`;
      if (!map.has(name)) map.set(name, { path, operation });
    }
  }
  return map;
}

// The object schemas a request value can take: `$ref`, `anyOf`/`oneOf` and array items unwrapped.
function objectSchemas(
  document: Record<string, unknown>,
  schema: unknown,
  depth = 0,
): Record<string, unknown>[] {
  if (!isObject(schema) || depth > 8) return [];
  const reference = schema.$ref;
  if (typeof reference === 'string') {
    const components = isObject(document.components) ? document.components.schemas : undefined;
    const name = reference.slice('#/components/schemas/'.length);
    return isObject(components) ? objectSchemas(document, components[name], depth + 1) : [];
  }
  const options = [schema.anyOf, schema.oneOf].find(Array.isArray);
  if (options) return options.flatMap((option) => objectSchemas(document, option, depth + 1));
  if (schema.items) return objectSchemas(document, schema.items, depth + 1);
  return isObject(schema.properties) ? [schema] : [];
}

export function requestSchemas(document: Record<string, unknown>, path: string, operation: string) {
  const paths = isObject(document.paths) ? document.paths[path] : undefined;
  const entry = isObject(paths) ? paths[operation] : undefined;
  const body = isObject(entry) ? entry.requestBody : undefined;
  const content = isObject(body) && isObject(body.content) ? body.content : undefined;
  const form = content?.['application/x-www-form-urlencoded'];
  return objectSchemas(document, isObject(form) ? form.schema : undefined);
}

function propertySchemas(
  document: Record<string, unknown>,
  schemas: Record<string, unknown>[],
  property: string,
) {
  const owners = schemas.filter(
    (schema) => isObject(schema.properties) && Object.hasOwn(schema.properties, property),
  );
  return {
    declared: owners.length > 0,
    children: owners.flatMap((schema) =>
      objectSchemas(document, (schema.properties as Record<string, unknown>)[property]),
    ),
  };
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

// Older stripe-node declares an ambient `stripe` module; v22 ships module types, resolved by path.
export function stripeTypesEntry(stripePackage: string) {
  const manifest = readJson(join(stripePackage, 'package.json'));
  const ambient = manifest.types ?? manifest.typings;
  if (typeof ambient === 'string') return { ambient: join(stripePackage, ambient) };
  const exported = manifest.exports;
  const types =
    isObject(exported) && isObject(exported.default) && isObject(exported.default.require)
      ? exported.default.require.types
      : undefined;
  if (typeof types !== 'string') throw new Error(`${stripePackage}: no stripe type definitions.`);
  return { module: join(stripePackage, types) };
}

export function compilerOptions(root: string, stripeModule?: string): ts.CompilerOptions {
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
    ...(stripeModule ? { paths: { ...base.paths, stripe: [stripeModule] } } : {}),
  };
}

function typeNames(
  type: ts.Type,
  checker: ts.TypeChecker,
  stripePackage: string,
  depth = 0,
): string[] {
  if (depth > 4) return [];
  if (type.isUnion() || type.isIntersection())
    return type.types.flatMap((member) => typeNames(member, checker, stripePackage, depth + 1));
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return ['<any>'];
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (!symbol) return [checker.typeToString(type)];
  const name = checker.getFullyQualifiedName(symbol);
  // v22 declares `Checkout.Session` as `Session` in `resources/Checkout/Sessions.d.ts`.
  const declared = name.startsWith(`"${stripePackage}/`)
    ? /\/resources\/(?:(.+)\/)?[^/"]+"\.(.+)$/.exec(name)
    : undefined;
  if (declared)
    return [['Stripe', declared[1]?.replaceAll('/', '.'), declared[2]].filter(Boolean).join('.')];
  return [name.replace(/^"[^"]+"\./, '')];
}

// shortcut: follows only the receiver's own variable initializers; a cast at a caller of a typed
// parameter is not seen. Upgrade if callers' casts must be distinguished.
export function asserted(expression: ts.Expression, checker: ts.TypeChecker, depth = 0): boolean {
  if (depth > 8) return false;
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) return true;
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isAwaitExpression(expression) ||
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  )
    return asserted(expression.expression, checker, depth + 1);
  if (!ts.isIdentifier(expression)) return false;
  let declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
  while (declaration && ts.isBindingElement(declaration)) declaration = declaration.parent.parent;
  return Boolean(
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    asserted(declaration.initializer, checker, depth + 1),
  );
}

// `files` (absolute paths) restricts the check to files already read and bounded by the caller.
export function labelReads(options: {
  repository: string;
  stripePackage: string;
  removed: Map<string, Set<string>>;
  classSchemas: Map<string, string>;
  // Request parameters are labelled when both contracts and the parameter-type map are given.
  requests?: {
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    operations: Map<string, { path: string; operation: string }>;
  };
  files?: string[];
}): OracleRead[] {
  const files = options.files ?? sourceFiles(options.repository);
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
  const entry = stripeTypesEntry(options.stripePackage);
  const reads: OracleRead[] = [];
  for (const [project, projectFiles] of projects) {
    const program = ts.createProgram(
      entry.ambient ? [...projectFiles, entry.ambient] : projectFiles,
      compilerOptions(project, entry.module),
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
    const walked = new Set<ts.Node>();
    // A parameter the before contract accepts and the after contract no longer does.
    const walkRequest = (
      requests: NonNullable<typeof options.requests>,
      literal: ts.ObjectLiteralExpression,
      before: Record<string, unknown>[],
      after: Record<string, unknown>[],
      request: string,
      prefix: string,
    ) => {
      if (walked.has(literal)) return;
      walked.add(literal);
      for (const property of literal.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
          continue;
        if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) continue;
        const name = property.name.text;
        const was = propertySchemas(requests.before, before, name);
        if (!was.declared) continue;
        const now = propertySchemas(requests.after, after, name);
        if (!now.declared) {
          const position = source.getLineAndCharacterOfPosition(property.name.getStart());
          reads.push({
            file: relative(options.repository, path),
            line: position.line + 1,
            column: position.character + 1,
            start: { line: position.line + 1, column: position.character + 1 },
            asserted: false,
            property: name,
            label: 'breaking',
            receiverTypes: [],
            schemas: [],
            request: `${request} ${prefix}${name}`,
          });
          continue;
        }
        if (!ts.isPropertyAssignment(property)) continue;
        const values = ts.isArrayLiteralExpression(property.initializer)
          ? property.initializer.elements
          : [property.initializer];
        for (const value of values)
          if (ts.isObjectLiteralExpression(value))
            walkRequest(requests, value, was.children, now.children, request, `${prefix}${name}.`);
      }
    };
    const visitRequest = (node: ts.Expression, requests: NonNullable<typeof options.requests>) => {
      const contextual = checker.getContextualType(node);
      if (!contextual) return;
      // Literal arguments, and `const params = {…}` passed by name.
      const declaration = ts.isIdentifier(node)
        ? checker.getSymbolAtLocation(node)?.valueDeclaration
        : undefined;
      const literal = ts.isObjectLiteralExpression(node)
        ? node
        : declaration &&
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer &&
            ts.isObjectLiteralExpression(declaration.initializer)
          ? declaration.initializer
          : undefined;
      if (!literal) return;
      for (const name of typeNames(contextual, checker, options.stripePackage)) {
        const operation = name.startsWith('Stripe.')
          ? requests.operations.get(name.slice('Stripe.'.length))
          : undefined;
        if (!operation) continue;
        walkRequest(
          requests,
          literal,
          requestSchemas(requests.before, operation.path, operation.operation),
          requestSchemas(requests.after, operation.path, operation.operation),
          `${operation.operation.toUpperCase()} ${operation.path}`,
          '',
        );
      }
    };
    const visit = (node: ts.Node) => {
      if (
        options.requests &&
        (ts.isObjectLiteralExpression(node) ||
          (ts.isIdentifier(node) &&
            ts.isCallExpression(node.parent) &&
            node.parent.arguments.includes(node)))
      )
        visitRequest(node, options.requests);
      if (ts.isPropertyAccessExpression(node) && options.removed.has(node.name.text)) {
        const receiverTypes = [
          ...new Set(
            typeNames(checker.getTypeAtLocation(node.expression), checker, options.stripePackage),
          ),
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
        const start = source.getLineAndCharacterOfPosition(node.getStart());
        reads.push({
          file: relative(options.repository, path),
          line: position.line + 1,
          column: position.character + 1,
          property: node.name.text,
          label,
          receiverTypes,
          schemas,
          start: { line: start.line + 1, column: start.character + 1 },
          asserted: asserted(node.expression, checker),
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
