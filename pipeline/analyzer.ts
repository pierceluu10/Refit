import { posix, resolve } from 'node:path';
import ts from 'typescript-compiler';
import { STRIPE, validSdkResourcePath, type ProviderAdapter } from './providers.ts';
import { unsafeBindings } from './mutations.ts';
import { declaredApiVersions } from './declared-api-versions.ts';
import { guardedHistoryEdit } from './history-migration.ts';
import { createSourceImportResolver } from './source-imports.ts';
import { sourceBindings } from './source-modules.ts';
import { COPY_METHODS, ELEMENT_METHODS, sourceLiterals } from './source-literals.ts';
import { sdkConstructors } from './sdk-constructors.ts';
import { classClients } from './class-clients.ts';
import { factoryClients, proxyClient } from './factory-clients.ts';
import { helperClients } from './helper-clients.ts';
import { stripeWebhookPayloads } from './stripe-webhook-payloads.ts';
import { componentReference, isObject, resolvableComponentSchema } from './specifications.ts';
import type { OperationReplacement } from './provider-operation-replacements.ts';
import type { RequestPropertyRename } from './provider-request-renames.ts';
import type { PropertyMove } from './provider-renames.ts';
import {
  paymentMethodRule,
  removedParameterProperty,
  requestPropertyEdit,
  untracedRemovedParameters,
} from './request-migration.ts';
import { requestMoveEdit } from './request-move-families.ts';
import {
  INVOICE_PREVIEW_RULE,
  invoicePreviewEdits,
  type InvoicePreviewMove,
} from './stripe-invoice-preview.ts';
import type { RequestParameterRemoval } from './request-removals.ts';
import { StripeTypes } from './stripe-types.ts';
import {
  subscriptionPeriodEdit,
  HELPER_GLOBALS,
  HELPER_NAMES,
  subscriptionPeriodHelperModule,
  SUBSCRIPTION_PERIOD_HELPER_RULE,
  SUBSCRIPTION_PERIOD_RULE,
  HELPER_RULES,
  type PeriodRareCase,
} from './stripe-subscription-periods.ts';
import { movedIdEdit, movedValueEdit, periodHelperEdit } from './field-move-families.ts';
import { STRIPE_PACK } from './rule-pack.ts';
import { STRIPE_MOVE_REVIEW } from './stripe-field-moves.ts';
import { removedExpandPaths, removedExpandReason } from './stripe-expand-paths.ts';
import {
  PipelineInputError,
  type Finding,
  type Location,
  type Removal,
  type Repository,
  type SourceEdit,
} from './types.ts';

// A file that imports the SDK and does not parse: its evidence would be incomplete.
export class SourceParseError extends PipelineInputError {
  override name = 'SourceParseError';
  constructor(
    readonly file: string,
    readonly diagnostic: string,
  ) {
    super(`${file}: ${diagnostic}`);
  }
}

const PURE_STRING_METHODS = new Set(['toLowerCase', 'toUpperCase', 'trim', 'trimStart', 'trimEnd']);
const ARRAY_ITERATION_METHODS = new Set([
  'every',
  'filter',
  'find',
  'flatMap',
  'forEach',
  'map',
  'some',
]);

function componentDefinition(schemas: Record<string, unknown>, name: string) {
  const seen = new Set<string>();
  let current = name;
  while (!seen.has(current)) {
    seen.add(current);
    const definition = schemas[current];
    if (!isObject(definition)) return undefined;
    if (['allOf', 'anyOf', 'oneOf'].some((key) => key in definition)) return undefined;
    if ('$ref' in definition) {
      const referenced = componentReference(definition.$ref);
      if (!referenced) return undefined;
      current = referenced;
    } else return { name: current, definition };
  }
  return undefined;
}

function arrayItemSchema(schemas: Record<string, unknown>, value: unknown) {
  if (!isObject(value) || ['allOf', 'anyOf', 'oneOf'].some((key) => key in value)) return undefined;
  const referenced = '$ref' in value ? componentReference(value.$ref) : undefined;
  if ('$ref' in value && !referenced) return undefined;
  const definition = referenced ? componentDefinition(schemas, referenced)?.definition : value;
  if (!isObject(definition) || definition.type !== 'array' || 'prefixItems' in definition)
    return undefined;
  const items = definition.items;
  if (!isObject(items) || ['allOf', 'anyOf', 'oneOf'].some((key) => key in items)) return undefined;
  const itemReference = componentReference(items.$ref);
  return itemReference ? resolvableComponentSchema(schemas, itemReference) : undefined;
}

function referencedPropertySchema(
  schemas: Record<string, unknown>,
  parent: string,
  property: string,
) {
  const canonicalParent = resolvableComponentSchema(schemas, parent);
  if (!canonicalParent) return undefined;
  const definition = schemas[canonicalParent];
  if (!isObject(definition) || !isObject(definition.properties)) return undefined;
  const propertyDefinition = definition.properties[property];
  if (!isObject(propertyDefinition)) return undefined;
  if (['allOf', 'anyOf', 'oneOf'].some((key) => key in propertyDefinition)) return undefined;
  const referenced = componentReference(propertyDefinition.$ref);
  return referenced ? resolvableComponentSchema(schemas, referenced) : undefined;
}

// Stripe list properties (`invoice.lines`, `subscription.items`) are inline objects whose `data`
// array holds component objects; `parent.property.data` items resolve to that component.
function inlineListItemSchema(schemas: Record<string, unknown>, parent: string, property: string) {
  const canonicalParent = resolvableComponentSchema(schemas, parent);
  const definition = canonicalParent ? schemas[canonicalParent] : undefined;
  const list =
    isObject(definition) && isObject(definition.properties)
      ? definition.properties[property]
      : undefined;
  if (!isObject(list) || '$ref' in list || !isObject(list.properties)) return undefined;
  return arrayItemSchema(schemas, list.properties.data);
}
function referencedArrayItemSchema(
  schemas: Record<string, unknown>,
  parent: string,
  property: string,
) {
  const canonicalParent = resolvableComponentSchema(schemas, parent);
  if (!canonicalParent) return undefined;
  const definition = schemas[canonicalParent];
  if (!isObject(definition) || !isObject(definition.properties)) return undefined;
  return arrayItemSchema(schemas, definition.properties[property]);
}

function numericArrayIndex(expression: ts.Expression) {
  if (!ts.isNumericLiteral(expression)) return false;
  const index = Number(expression.text);
  return Number.isSafeInteger(index) && index >= 0;
}

const EQUALITY_TOKENS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

// The value a node compares with string literals: `value === 'a'` or `['a', 'b'].includes(value)`.
function comparedWithLiterals(node: ts.Node) {
  if (ts.isBinaryExpression(node) && EQUALITY_TOKENS.has(node.operatorToken.kind)) {
    if (ts.isStringLiteralLike(node.right)) return node.left;
    if (ts.isStringLiteralLike(node.left)) return node.right;
  }
  if (
    ts.isCallExpression(node) &&
    node.arguments.length === 1 &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'includes' &&
    ts.isArrayLiteralExpression(node.expression.expression) &&
    node.expression.expression.elements.length &&
    node.expression.expression.elements.every(ts.isStringLiteralLike)
  )
    return node.arguments[0];
  return undefined;
}

// Comments TypeScript, JSX and Flow read only above a file's first statement.
const FILE_PRAGMA = /^\/\/\/\s*<|@ts-(?:no)?check\b|@jsx|@flow\b/;

// Node runs a script whose shebang follows a byte order mark, and tsc strips the mark when it
// reads a file, but the parser accepts a shebang only at offset 0. A comment of the same length
// keeps every offset that edits use.
function parseableText(content: string) {
  return content.startsWith('\uFEFF#!') ? `\uFEFF//${content.slice(3)}` : content;
}

// Syntax errors in one source file; analyzeRepository skips such files instead of failing.
export function syntaxErrors(path: string, content: string) {
  const source = ts.createSourceFile(path, parseableText(content), ts.ScriptTarget.Latest, true);
  const program = ts.createProgram(
    [path],
    { allowJs: true, noLib: true },
    {
      ...ts.createCompilerHost({}),
      fileExists: (name) => name === path,
      readFile: (name) => (name === path ? content : undefined),
      getSourceFile: (name) => (name === path ? source : undefined),
      writeFile: () => undefined,
    },
  );
  return program
    .getSyntacticDiagnostics(source)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

// The compiler program over a repository's sources. Analyses of the same snapshot (the same `files`
// array, with the same paths and contents), such as one per SDK adapter, share it, so the type
// checker binds the files once and keeps what it has resolved.
const programs = new WeakMap<
  Repository['files'],
  { root: string; files: [string, string][]; built: ReturnType<typeof buildAnalysisProgram> }
>();

function analysisProgram(repository: Repository) {
  const cached = programs.get(repository.files);
  if (
    cached &&
    cached.root === repository.root &&
    cached.files.length === repository.files.length &&
    cached.files.every(
      ([path, content], index) =>
        repository.files[index].path === path && repository.files[index].content === content,
    )
  )
    return cached.built;
  const built = buildAnalysisProgram(repository);
  programs.set(repository.files, {
    root: repository.root,
    files: repository.files.map((file) => [file.path, file.content]),
    built,
  });
  return built;
}

function buildAnalysisProgram(repository: Repository) {
  const sources = new Map(
    repository.files.map((file) => [resolve(repository.root, file.path), file.content]),
  );
  const resolution = createSourceImportResolver(repository, sources);
  const options: ts.CompilerOptions = {
    allowJs: true,
    noLib: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = ts.createCompilerHost(options);
  host.fileExists = (name) => sources.has(name);
  host.readFile = (name) => sources.get(name);
  host.resolveModuleNames = (names, containingFile) =>
    names.map((name) => {
      const path = resolution.resolve(name, containingFile);
      if (!path) return undefined;
      return { resolvedFileName: path };
    });
  host.getSourceFile = (name, languageVersion) => {
    const content = sources.get(name);
    return content === undefined
      ? undefined
      : ts.createSourceFile(name, parseableText(content), languageVersion, true);
  };
  const program = ts.createProgram([...sources.keys()], options, host);
  return { sources, resolution, program, checker: program.getTypeChecker() };
}

export function analyzeRepository(
  repository: Repository,
  changes: Removal[],
  provider: ProviderAdapter = STRIPE,
  schemaDefinitions: Record<string, unknown> = {},
  operationReplacements: OperationReplacement[] = [],
  requestPropertyRenames: RequestPropertyRename[] = [],
  propertyMoves: PropertyMove[] = [],
  requestParameterRemovals: RequestParameterRemoval[] = [],
  // For review-only callers: also trace the SDK package where the importing file's tsconfig or
  // jsconfig is unverified, so a caller can report those calls for review instead of missing
  // them. Analyses that can lead to edits keep the default, which treats them as unknown imports.
  // `invoicePreview`: the contract-checked move of Stripe's removed upcoming invoice call.
  // `typeCheckedPeriodReads`: where validation's patched type check rejected a `current_period_*`
  // read on Subscription (file and offset of the property name); those reads take the period helper.
  // `modelFixClients`: trace only the client shapes the model-fix edits were decided on (AGENTS.md),
  // leaving lazy Proxy clients with a local or bound methods, a Proxy over a filled holder and a
  // holder used as the client to stop for review.
  options: {
    traceUnverifiedPackageImports?: boolean;
    invoicePreview?: InvoicePreviewMove;
    typeCheckedPeriodReads?: { file: string; position: number }[];
    modelFixClients?: boolean;
  } = {},
) {
  const { sources, resolution, program, checker } = analysisProgram(repository);
  const typeCheckedPeriodReads = new Set(
    (options.typeCheckedPeriodReads ?? []).map((read) => `${read.file}\0${read.position}`),
  );
  const findings: Finding[] = [];
  const imports: Location[] = [];
  const calls: (Location & { method: string })[] = [];
  const sdkCalls: (Location & {
    resource: string;
    method: string;
    expression: string;
    helperClient?: Finding['helperClient'];
  })[] = [];
  const sdkCallNodes = new Map<ts.Node, (typeof sdkCalls)[number]>();
  // Methods called directly on a client, such as the openai v3 SDK's
  // `openai.createChatCompletion(…)`. Listed for callers that read call arguments; no other
  // analysis uses them.
  const clientMethodCalls: (Location & { method: string; expression: string })[] = [];
  const clients = new Set<ts.Symbol>();
  const responses = new Map<ts.Symbol, string>();
  const arrayItems = new Map<ts.Symbol, string>();
  // List responses (`await stripe.subscriptions.list()`) and the object schema of their items.
  const listItems = new Map<ts.Symbol, string>();
  const origins = new Map<ts.Symbol, ts.CallExpression>();
  const wrappedResponses = new Map<ts.Symbol, ts.Symbol>();
  const edits: SourceEdit[] = [];
  const nodes: ts.Node[] = [];
  const locations = new Map(
    [...sources.keys()].map((path, index) => [path, repository.files[index].path]),
  );
  const location = (node: ts.Node): Location => {
    const source = node.getSourceFile();
    const position = source.getLineAndCharacterOfPosition(node.getStart());
    return {
      file: locations.get(source.fileName)!,
      line: position.line + 1,
      column: position.character + 1,
    };
  };
  function visit(node: ts.Node) {
    nodes.push(node);
    ts.forEachChild(node, visit);
  }
  // An unparseable file that never imports the SDK is skipped and reported for review; one that
  // does still fails the scan, because its evidence would be incomplete.
  const skippedFiles: string[] = [];
  const sdkImport = new RegExp(
    `(?:from\\s*|import\\s*\\(\\s*|require\\s*\\(\\s*)['"]${provider.packageName.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?:/[^'"]*)?['"]`,
  );
  for (const source of program.getSourceFiles()) {
    const diagnostics = program.getSyntacticDiagnostics(source);
    if (diagnostics.length) {
      const file = locations.get(source.fileName)!;
      const diagnostic = ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n');
      if (sdkImport.test(source.text)) throw new SourceParseError(file, diagnostic);
      skippedFiles.push(`${file}: ${diagnostic}`);
      continue;
    }
    visit(source);
  }
  const modules = sourceBindings(nodes, checker, resolution.resolve);
  const canonical = modules.canonical;
  const symbol = (node: ts.Node) =>
    modules.member(node) ?? canonical(checker.getSymbolAtLocation(node));
  const literals = sourceLiterals({ nodes, symbol, file: (node) => location(node).file });
  // Local helpers: function declarations and functions bound to a const, outside generators.
  const localFunctions = nodes.flatMap((node) => {
    const fn =
      ts.isFunctionDeclaration(node) && node.name && node.body
        ? { name: node.name, fn: node as ts.FunctionLikeDeclaration, statement: node as ts.Node }
        : ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer &&
            (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
            ts.isVariableDeclarationList(node.parent) &&
            node.parent.flags & ts.NodeFlags.Const
          ? { name: node.name, fn: node.initializer, statement: node.parent.parent }
          : undefined;
    const binding = fn && symbol(fn.name);
    return fn && binding && !fn.fn.asteriskToken ? [{ ...fn, binding }] : [];
  });
  const references = new Map<ts.Symbol, ts.Identifier[]>();
  for (const node of nodes)
    if (ts.isIdentifier(node)) {
      const binding = symbol(node);
      if (binding) references.set(binding, [...(references.get(binding) ?? []), node]);
    }
  const nullish = (expression: ts.Expression) =>
    expression.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(expression) && expression.text === 'undefined') ||
    ts.isVoidExpression(expression);
  // What a helper's `return`s give its caller (an async helper's returned call is awaited).
  function returnedValues(fn: ts.FunctionLikeDeclaration) {
    if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return [fn.body];
    const values: ts.Expression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression) values.push(node.expression);
      ts.forEachChild(node, visit);
    };
    if (fn.body) ts.forEachChild(fn.body, visit);
    return values;
  }
  const isAsync = (fn: ts.FunctionLikeDeclaration) =>
    Boolean(ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Async);
  // Helpers whose every non-nullish return is one traced object schema.
  const helperReturns = new Map<ts.Symbol, string>();
  // Parameters of private helpers that every call hands the same traced object schema.
  const helperParameters = new Set<ts.Symbol>();
  function returnedSchema(fn: ts.FunctionLikeDeclaration) {
    const schemas = new Set<string | undefined>();
    for (const value of returnedValues(fn)) {
      if (nullish(value)) continue;
      const operation = isAsync(fn) && ts.isCallExpression(value) ? responseCall(value) : undefined;
      schemas.add(
        operation
          ? operation.list
            ? undefined
            : (resolvableComponentSchema(schemaDefinitions, operation.schema) ?? operation.schema)
          : schemaForExpression(value),
      );
    }
    const [schema] = schemas;
    return schemas.size === 1 ? schema : undefined;
  }
  // The schema each call of a private helper passes at a parameter, or undefined when a call
  // passes something else or the helper escapes (exported, stored, passed on).
  function parameterSchema(
    entry: (typeof localFunctions)[number],
    parameter: ts.ParameterDeclaration,
  ) {
    const index = entry.fn.parameters.indexOf(parameter);
    if (
      !ts.isIdentifier(parameter.name) ||
      parameter.dotDotDotToken ||
      parameter.initializer ||
      ts.getCombinedModifierFlags(entry.statement as ts.Declaration) & ts.ModifierFlags.Export
    )
      return undefined;
    const binding = symbol(parameter.name);
    // A parameter the helper reassigns no longer holds what the caller passed.
    if (
      !binding ||
      (references.get(binding) ?? []).some(
        (reference) =>
          (ts.isBinaryExpression(reference.parent) &&
            reference.parent.left === reference &&
            reference.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            reference.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
          ts.isPrefixUnaryExpression(reference.parent) ||
          ts.isPostfixUnaryExpression(reference.parent),
      )
    )
      return undefined;
    const schemas = new Set<string | undefined>();
    for (const reference of references.get(entry.binding) ?? []) {
      if (reference === entry.name) continue;
      const parent = reference.parent;
      if (ts.isCallExpression(parent) && parent.expression === reference) {
        const argument = parent.arguments[index];
        if (
          !argument ||
          parent.arguments.slice(0, index + 1).some(ts.isSpreadElement) ||
          webhooks?.origin(argument)
        )
          return undefined;
        schemas.add(schemaForExpression(argument));
      } else if (
        ts.isCallExpression(parent) &&
        parent.arguments[0] === reference &&
        index === 0 &&
        ts.isPropertyAccessExpression(parent.expression) &&
        ARRAY_ITERATION_METHODS.has(parent.expression.name.text)
      )
        schemas.add(arrayItemForExpression(parent.expression.expression));
      else return undefined;
    }
    const [schema] = schemas;
    return schemas.size === 1 ? schema : undefined;
  }
  const stripeTypes =
    provider.packageName === STRIPE.packageName
      ? new StripeTypes(nodes, symbol, schemaDefinitions, provider.packageName)
      : undefined;
  // Receivers whose object type the code states (Stripe.* types, narrowed webhook events).
  // Files that import Stripe, use Stripe types or webhooks, or call a mapped Stripe resource
  // (including through a client imported from another module).
  const stripeResources = [...new Set(provider.operations.map((operation) => operation.resource))]
    .map((resource) => resource.replace(/[.$]/g, '\\$&'))
    .join('|');
  const stripeFilePattern = new RegExp(
    `from\\s*['"]stripe['"]|require\\(\\s*['"]stripe['"]\\s*\\)|\\bStripe\\.|\\.webhooks\\.constructEvent${stripeResources ? `|\\.(?:${stripeResources})\\.[A-Za-z]+\\s*\\(` : ''}`,
  );
  const stripeFiles = new Set(
    program.getSourceFiles().filter((source) => stripeFilePattern.test(source.text)),
  );
  const contains = (set: Set<ts.Symbol>, node: ts.Node) => {
    const found = symbol(node);
    return found !== undefined && set.has(found);
  };
  const add = (set: Set<ts.Symbol>, node: ts.Node) => {
    const found = symbol(node);
    if (found) set.add(found);
  };
  const sdk = sdkConstructors({
    nodes,
    checker,
    provider,
    symbol,
    external: (name, file) =>
      resolution.external(name, file) ||
      Boolean(
        options.traceUnverifiedPackageImports &&
        name === provider.packageName &&
        resolution.unverifiedFile(file),
      ),
  });
  let classBindings: ReturnType<typeof classClients> | undefined;
  let factoryBindings: ReturnType<typeof factoryClients> | undefined;
  const clientBinding = (node: ts.Expression) =>
    classBindings?.reference(node)?.binding ??
    factoryBindings?.call(node) ??
    (ts.isIdentifier(node) ? symbol(node) : undefined);
  imports.push(...sdk.imports.map(location));
  function sdkAccess(expression: ts.Expression) {
    const properties: (ts.PropertyAccessExpression & { name: ts.Identifier })[] = [];
    let current = expression;
    while (ts.isPropertyAccessExpression(current) && ts.isIdentifier(current.name)) {
      if (classBindings?.reference(current)) break;
      properties.push(current as ts.PropertyAccessExpression & { name: ts.Identifier });
      current = current.expression;
    }
    // `stripe!` and `(stripe)` are compile-time only; the runtime receiver is the client itself.
    while (ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current))
      current = current.expression;
    const binding = clientBinding(current);
    if (!binding || !clients.has(binding)) return;
    return { client: current, properties: properties.reverse() };
  }
  function sdkCall(node: ts.Node) {
    if (!ts.isCallExpression(node)) return;
    const access = sdkAccess(node.expression);
    if (!access || access.properties.length < 2) return;
    const resource = access.properties
      .slice(0, -1)
      .map((property) => property.name.text)
      .join('.');
    if (!validSdkResourcePath(resource)) return;
    const method = access.properties.at(-1)!.name.text;
    return {
      resource,
      method,
      expression: `${access.client.getText()}.${resource}.${method}`,
      client: access.client,
      start: access.properties[0].name.getStart(),
      optional:
        Boolean(node.questionDotToken) ||
        (ts.isPropertyAccessExpression(access.client) && Boolean(access.client.questionDotToken)) ||
        access.properties.some((property) => Boolean(property.questionDotToken)),
    };
  }
  function responseCall(node: ts.Node) {
    const call = sdkCall(node);
    if (call)
      return provider.operations.find(
        (operation) => operation.resource === call.resource && operation.method === call.method,
      );
  }
  // A call to a list method (docs.stripe.com/api/pagination): its result is a list object whose
  // `data` holds `schema` objects, not one of them.
  function listCall(node: ts.Node) {
    const operation = responseCall(node);
    return operation?.list ? operation : undefined;
  }
  // The object schema of the `data` items of a list response: a binding, or the awaited call.
  function listItemsForExpression(expression: ts.Expression): string | undefined {
    if (ts.isIdentifier(expression)) {
      const binding = symbol(expression);
      return binding ? listItems.get(binding) : undefined;
    }
    if (ts.isAwaitExpression(expression)) return listCall(expression.expression)?.schema;
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    )
      return listItemsForExpression(expression.expression);
    return undefined;
  }
  // `list(…).autoPagingEach(fn)` and `list(…).autoPagingToArray(…)`: stripe-node's helpers that
  // walk every page of the list call they are chained on.
  function autoPaging(node: ts.CallExpression, method: string) {
    const access = node.expression;
    return ts.isPropertyAccessExpression(access) && access.name.text === method
      ? listCall(access.expression)
      : undefined;
  }
  let webhooks: ReturnType<typeof stripeWebhookPayloads> | undefined;
  function arrayItemForExpression(expression: ts.Expression): string | undefined {
    if (ts.isIdentifier(expression)) {
      const binding = symbol(expression);
      if (!binding) return undefined;
      const responseSchema = responses.get(binding);
      const responseDefinition = responseSchema
        ? componentDefinition(schemaDefinitions, responseSchema)?.definition
        : undefined;
      return (
        arrayItems.get(binding) ??
        stripeTypes?.typedArrays.get(binding) ??
        arrayItemSchema(schemaDefinitions, responseDefinition)
      );
    }
    // `invoice.lines?.data ?? []`: an empty-array fallback keeps the element type.
    if (
      ts.isBinaryExpression(expression) &&
      (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      ts.isArrayLiteralExpression(expression.right) &&
      !expression.right.elements.length
    )
      return arrayItemForExpression(expression.left);
    if (ts.isPropertyAccessExpression(expression)) {
      if (expression.name.text === 'data') {
        const items = listItemsForExpression(expression.expression);
        if (items) return items;
      }
      const parent = schemaForExpression(expression.expression);
      if (parent) return referencedArrayItemSchema(schemaDefinitions, parent, expression.name.text);
      const list = expression.expression;
      if (expression.name.text === 'data' && ts.isPropertyAccessExpression(list)) {
        const owner = schemaForExpression(list.expression);
        return owner ? inlineListItemSchema(schemaDefinitions, owner, list.name.text) : undefined;
      }
      return undefined;
    }
    if (ts.isElementAccessExpression(expression)) {
      return expression.argumentExpression && numericArrayIndex(expression.argumentExpression)
        ? arrayItemForExpression(expression.expression)
        : undefined;
    }
    if (ts.isAwaitExpression(expression) && ts.isCallExpression(expression.expression)) {
      const paged = autoPaging(expression.expression, 'autoPagingToArray');
      if (paged) return paged.schema;
    }
    // `invoices.data.filter(…)`, `.slice(…)`: a copy holds the same objects.
    if (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      COPY_METHODS.has(expression.expression.name.text)
    )
      return arrayItemForExpression(expression.expression.expression);
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      awaitedField(expression)
    )
      return arrayItemForExpression(expression.expression);
    return undefined;
  }
  // `await session.line_items.data`: a field of a response is a plain value, so awaiting it
  // returns the value itself.
  function awaitedField(expression: ts.Expression): expression is ts.AwaitExpression {
    return (
      ts.isAwaitExpression(expression) &&
      (ts.isPropertyAccessExpression(expression.expression) ||
        ts.isElementAccessExpression(expression.expression))
    );
  }
  function arrayIteration(node: ts.CallExpression) {
    const method = node.expression;
    // `items?.map(…)` runs the callback on the same elements whenever it runs at all.
    const paged = autoPaging(node, 'autoPagingEach');
    if (
      !ts.isPropertyAccessExpression(method) ||
      (!paged && !ARRAY_ITERATION_METHODS.has(method.name.text)) ||
      node.arguments.length !== 1
    )
      return undefined;
    const callback = node.arguments[0];
    if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return undefined;
    if (callback.parameters.length !== 1) return undefined;
    const parameter = callback.parameters[0];
    if (
      !ts.isIdentifier(parameter.name) ||
      parameter.initializer ||
      parameter.dotDotDotToken ||
      parameter.questionToken
    )
      return undefined;
    const schema = paged?.schema ?? arrayItemForExpression(method.expression);
    return schema
      ? { callback, parameter: parameter.name, source: method.expression, schema }
      : undefined;
  }
  function schemaForExpression(expression: ts.Expression): string | undefined {
    const payload = webhooks?.schema(expression);
    if (payload) return payload;
    if (webhooks?.event(expression)) return 'event';
    if (ts.isIdentifier(expression)) {
      const target = symbol(expression)!;
      return responses.get(target) ?? stripeTypes?.typed.get(target);
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const parent = schemaForExpression(expression.expression);
      return parent
        ? referencedPropertySchema(schemaDefinitions, parent, expression.name.text)
        : undefined;
    }
    if (ts.isElementAccessExpression(expression)) {
      if (expression.argumentExpression && numericArrayIndex(expression.argumentExpression))
        return arrayItemForExpression(expression.expression);
      const parent = schemaForExpression(expression.expression);
      const property = expression.argumentExpression;
      return parent && property && ts.isStringLiteral(property)
        ? referencedPropertySchema(schemaDefinitions, parent, property.text)
        : undefined;
    }
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    )
      return (
        schemaForExpression(expression.expression) ?? stripeTypes?.expressionSchema(expression)
      );
    if (awaitedField(expression)) return schemaForExpression(expression.expression);
    // `await getCustomer(id)`: a local helper that returns one traced object schema.
    const helper = ts.isAwaitExpression(expression) ? expression.expression : expression;
    if (ts.isCallExpression(helper) && ts.isIdentifier(helper.expression)) {
      const binding = symbol(helper.expression);
      const entry = binding && localFunctions.find((candidate) => candidate.binding === binding);
      if (entry && helperReturns.has(binding) && (helper !== expression || !isAsync(entry.fn)))
        return helperReturns.get(binding);
    }
    // `plans.data.find(…)`, `.at(0)`: one of the array's objects, or undefined.
    if (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      ELEMENT_METHODS.has(expression.expression.name.text)
    ) {
      const item = arrayItemForExpression(expression.expression.expression);
      if (item) return item;
    }
    if (ts.isAwaitExpression(expression) && ts.isCallExpression(expression.expression)) {
      const operation = responseCall(expression.expression);
      return operation && !operation.list
        ? (resolvableComponentSchema(schemaDefinitions, operation.schema) ?? operation.schema)
        : stripeTypes?.expressionSchema(expression);
    }
    return stripeTypes?.expressionSchema(expression);
  }
  function responseBinding(expression: ts.Expression): ts.Symbol | undefined {
    if (ts.isIdentifier(expression)) return symbol(expression);
    if (
      ts.isPropertyAccessExpression(expression) ||
      ts.isElementAccessExpression(expression) ||
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    )
      return responseBinding(expression.expression);
    return undefined;
  }
  const declarations = nodes.filter(
    (node): node is ts.VariableDeclaration & { name: ts.Identifier; initializer: ts.Expression } =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      Boolean(node.initializer) &&
      ts.isVariableDeclarationList(node.parent) &&
      Boolean(node.parent.flags & ts.NodeFlags.Const),
  );
  // Fixed-point propagation makes imported clients independent of source-file ordering.
  let previousSize = -1;
  while (previousSize !== clients.size) {
    previousSize = clients.size;
    for (const node of declarations) {
      const value = node.initializer;
      if (sdk.creation(value)) add(clients, node.name);
      if (ts.isIdentifier(value) && contains(clients, value)) add(clients, node.name);
    }
    for (const [node, binding] of modules.inlineDefaults)
      if (sdk.creation(node.expression)) clients.add(binding);
  }
  classBindings = classClients({ nodes, creation: sdk.creation, clients, symbol, checker });
  const base = options.modelFixClients;
  factoryBindings = factoryClients({ nodes, clients, symbol, creation: sdk.creation, base });
  for (const declaration of declarations) {
    const forwarded = proxyClient(declaration.initializer, base);
    const binding = clientBinding(forwarded ?? declaration.initializer);
    // A Proxy reads its holder on every access, so a holder that only ever holds the client
    // (filled in the trap or by a factory) forwards to that client.
    if (
      binding &&
      (clients.has(binding) || (!base && forwarded && factoryBindings.holders.has(binding)))
    )
      add(clients, declaration.name);
  }
  const helperBindings = helperClients({
    nodes,
    clients,
    checker,
    symbol,
    clientBinding,
    creation: sdk.creation,
  });
  const clientReferences = {
    rootBinding: classBindings.rootBinding,
    aliases: [...classBindings.aliases, ...helperBindings.aliases],
    localArgument: helperBindings.localArgument,
    held: factoryBindings.held,
  };
  webhooks =
    provider.packageName === 'stripe'
      ? stripeWebhookPayloads({
          nodes,
          symbol,
          sdkCall,
          schemas: schemaDefinitions,
          location,
          iterationSource: (declaration) => {
            if (
              ts.isVariableDeclaration(declaration) &&
              ts.isVariableDeclarationList(declaration.parent) &&
              ts.isForOfStatement(declaration.parent.parent)
            )
              return declaration.parent.parent.expression;
            if (ts.isParameter(declaration) && ts.isCallExpression(declaration.parent.parent)) {
              const call = declaration.parent.parent;
              const iteration = arrayIteration(call);
              if (iteration?.parameter === declaration.name) return iteration.source;
              if (
                ts.isPropertyAccessExpression(call.expression) &&
                ARRAY_ITERATION_METHODS.has(call.expression.name.text) &&
                arrayItemForExpression(call.expression.expression)
              )
                return call.expression.expression;
            }
          },
        })
      : undefined;
  for (const [binding, call] of webhooks?.events ?? []) origins.set(binding, call);
  // Only transparent, top-level one-argument wrappers; no side effects or transformed responses.
  const wrappers = new Map<ts.Symbol, ts.CallExpression>();
  for (const node of nodes) {
    if (
      !ts.isFunctionDeclaration(node) ||
      !node.name ||
      !node.body ||
      !ts.isSourceFile(node.parent) ||
      node.parameters.length !== 1 ||
      node.body.statements.length !== 1
    )
      continue;
    const parameter = node.parameters[0];
    const statement = node.body.statements[0];
    if (
      !ts.isIdentifier(parameter.name) ||
      parameter.initializer ||
      parameter.dotDotDotToken ||
      parameter.questionToken ||
      !ts.isReturnStatement(statement) ||
      !statement.expression
    )
      continue;
    const value = ts.isAwaitExpression(statement.expression)
      ? statement.expression.expression
      : statement.expression;
    if (
      !ts.isCallExpression(value) ||
      value.arguments.length !== 1 ||
      !ts.isIdentifier(value.arguments[0]) ||
      symbol(value.arguments[0]) !== symbol(parameter.name) ||
      !responseCall(value)
    )
      continue;
    wrappers.set(symbol(node.name)!, value);
  }
  // A value that came through a local helper: Refit does not follow what the helper does to it, so
  // reads keep review confidence.
  function fromHelper(expression: ts.Expression, seen = new Set<ts.Symbol>()): boolean {
    while (
      ts.isPropertyAccessExpression(expression) ||
      ts.isElementAccessExpression(expression) ||
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isAwaitExpression(expression)
    )
      expression = expression.expression;
    if (ts.isCallExpression(expression)) {
      const callee = expression.expression;
      // A transparent wrapper or a declared Stripe return type already traces the call.
      if (ts.isIdentifier(callee) && helperReturns.has(symbol(callee)!))
        return !wrappers.has(symbol(callee)!) && !stripeTypes?.expressionSchema(expression);
      return ts.isPropertyAccessExpression(callee) && fromHelper(callee.expression, seen);
    }
    if (!ts.isIdentifier(expression)) return false;
    const binding = symbol(expression);
    if (!binding || seen.has(binding)) return false;
    if (helperParameters.has(binding)) return true;
    seen.add(binding);
    const declaration = binding.valueDeclaration;
    return Boolean(
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      fromHelper(declaration.initializer, seen),
    );
  }
  // Resolve only immutable, lexical bindings; a same-named parameter is a different symbol.
  let responseSchemasChanged = true;
  while (responseSchemasChanged) {
    responseSchemasChanged = false;
    const assignSchema = (name: ts.Identifier, schema: string | undefined) => {
      const target = symbol(name);
      if (!target || !schema || responses.get(target) === schema) return;
      responses.set(target, schema);
      responseSchemasChanged = true;
    };
    const assignListItems = (name: ts.Identifier, schema: string) => {
      const target = symbol(name);
      if (!target || listItems.get(target) === schema) return;
      listItems.set(target, schema);
      responseSchemasChanged = true;
    };
    const assignArrayItems = (name: ts.Identifier, schema: string | undefined) => {
      const target = symbol(name);
      if (!target || !schema || arrayItems.get(target) === schema) return;
      arrayItems.set(target, schema);
      responseSchemasChanged = true;
    };
    for (const entry of localFunctions) {
      const schema = returnedSchema(entry.fn);
      if (schema && helperReturns.get(entry.binding) !== schema) {
        helperReturns.set(entry.binding, schema);
        responseSchemasChanged = true;
      }
      for (const parameter of entry.fn.parameters) {
        // A declared Stripe type (`invoice: Stripe.Invoice`) already traces the parameter.
        if (parameter.type && stripeTypes?.typeSchema(parameter.type)) continue;
        const passed = parameterSchema(entry, parameter);
        if (!passed || !ts.isIdentifier(parameter.name)) continue;
        helperParameters.add(symbol(parameter.name)!);
        assignSchema(parameter.name, passed);
      }
    }
    for (const node of declarations) {
      const value = node.initializer;
      const awaited =
        ts.isAwaitExpression(value) && ts.isCallExpression(value.expression)
          ? value.expression
          : undefined;
      const wrapper =
        awaited && ts.isIdentifier(awaited.expression) && awaited.arguments.length === 1
          ? symbol(awaited.expression)
          : undefined;
      const origin = wrapper && wrappers.has(wrapper) ? wrappers.get(wrapper)! : awaited;
      const operation = origin ? responseCall(origin) : undefined;
      if (operation && ts.isAwaitExpression(value)) {
        if (operation.list) assignListItems(node.name, operation.schema);
        else
          assignSchema(
            node.name,
            resolvableComponentSchema(schemaDefinitions, operation.schema) ?? operation.schema,
          );
        origins.set(symbol(node.name)!, origin!);
        if (wrapper && wrappers.has(wrapper)) wrappedResponses.set(symbol(node.name)!, wrapper);
      }
      assignSchema(node.name, schemaForExpression(value));
      assignArrayItems(node.name, arrayItemForExpression(value));
    }
    for (const node of nodes) {
      if (
        !ts.isVariableDeclaration(node) ||
        !ts.isObjectBindingPattern(node.name) ||
        !ts.isVariableDeclarationList(node.parent) ||
        !(node.parent.flags & ts.NodeFlags.Const) ||
        !node.initializer
      )
        continue;
      // `const { data } = await stripe.subscriptions.list(…)`: the page's objects.
      const listed = listItemsForExpression(node.initializer);
      if (listed)
        for (const element of node.name.elements) {
          const property = element.propertyName ?? element.name;
          if (
            ts.isIdentifier(element.name) &&
            !element.initializer &&
            !element.dotDotDotToken &&
            (ts.isIdentifier(property) || ts.isStringLiteral(property)) &&
            property.text === 'data'
          )
            assignArrayItems(element.name, listed);
        }
      const parentSchema = schemaForExpression(node.initializer);
      if (!parentSchema) continue;
      for (const element of node.name.elements) {
        if (!ts.isIdentifier(element.name) || element.initializer || element.dotDotDotToken)
          continue;
        const property = element.propertyName ?? element.name;
        if (!ts.isIdentifier(property) && !ts.isStringLiteral(property)) continue;
        assignSchema(
          element.name,
          referencedPropertySchema(schemaDefinitions, parentSchema, property.text),
        );
        assignArrayItems(
          element.name,
          referencedArrayItemSchema(schemaDefinitions, parentSchema, property.text),
        );
      }
    }
    for (const node of nodes) {
      if (
        !ts.isVariableDeclaration(node) ||
        !ts.isArrayBindingPattern(node.name) ||
        !ts.isVariableDeclarationList(node.parent) ||
        !(node.parent.flags & ts.NodeFlags.Const) ||
        !node.initializer
      )
        continue;
      const itemSchema = arrayItemForExpression(node.initializer);
      if (!itemSchema) continue;
      for (const element of node.name.elements) {
        if (
          !ts.isBindingElement(element) ||
          !ts.isIdentifier(element.name) ||
          element.initializer ||
          element.dotDotDotToken
        )
          continue;
        assignSchema(element.name, itemSchema);
      }
    }
    for (const node of nodes) {
      if (
        !ts.isForOfStatement(node) ||
        !ts.isVariableDeclarationList(node.initializer) ||
        !(node.initializer.flags & ts.NodeFlags.Const) ||
        node.initializer.declarations.length !== 1
      )
        continue;
      const declaration = node.initializer.declarations[0];
      if (!ts.isIdentifier(declaration.name)) continue;
      // `for await (const item of stripe.subscriptions.list(…))` auto-paginates the list.
      const paged = node.awaitModifier ? listCall(node.expression) : undefined;
      assignSchema(declaration.name, paged?.schema ?? arrayItemForExpression(node.expression));
    }
    for (const node of nodes) {
      if (!ts.isCallExpression(node)) continue;
      const iteration = arrayIteration(node);
      if (iteration) assignSchema(iteration.parameter, iteration.schema);
    }
  }
  for (const node of nodes) {
    const sdk = sdkCall(node);
    if (sdk && stripeTypes) stripeFiles.add(node.getSourceFile());
    if (sdk) {
      const evidence = {
        ...location(node),
        resource: sdk.resource,
        method: sdk.method,
        expression: sdk.expression,
      };
      sdkCalls.push(evidence);
      sdkCallNodes.set(node, evidence);
    }
    if (!sdk && ts.isCallExpression(node)) {
      const access = sdkAccess(node.expression);
      if (access?.properties.length === 1)
        clientMethodCalls.push({
          ...location(node),
          method: access.properties[0].name.text,
          expression: `${access.client.getText()}.${access.properties[0].name.text}`,
        });
    }
    const operation = responseCall(node);
    if (operation)
      calls.push({
        ...location(node),
        method: `${operation.resource}.${operation.method}`,
        ...(operation.operationId ? { operationId: operation.operationId } : {}),
      });
  }
  const providerDetected =
    imports.length > 0 ||
    repository.dependencies.length > 0 ||
    Boolean(stripeTypes && (stripeTypes.typed.size || stripeTypes.typedArrays.size));
  const escapingClients = new Set<ts.Symbol>();
  // Module exports reachable through unsupported consumers can have their methods replaced.
  const exposedClients = new Set<ts.Symbol>();
  for (const binding of [...clients, ...wrappers.keys()]) {
    if (!binding.valueDeclaration) continue;
    if (modules.escapingSources.has(binding.valueDeclaration.getSourceFile().fileName))
      exposedClients.add(binding);
    if (
      exposedClients.has(binding) ||
      (resolution.unverified && Boolean(modules.clientExport(binding)))
    )
      escapingClients.add(binding);
  }
  const readOnlyCall = (node: ts.CallExpression) => {
    if (arrayIteration(node)) return true;
    if (
      node.arguments.length ||
      !ts.isPropertyAccessExpression(node.expression) ||
      !PURE_STRING_METHODS.has(node.expression.name.text)
    )
      return false;
    const field = node.expression.expression;
    if (!ts.isPropertyAccessExpression(field) || !ts.isIdentifier(field.expression)) return false;
    const schema = schemaForExpression(field.expression);
    return changes.some(
      (change) =>
        change.schema === schema && change.property === field.name.text && change.type === 'string',
    );
  };
  const initialUnsafe = new Set(escapingClients);
  // Read confirmation ignores repository-wide alias doubt (imports that may resolve to unscanned
  // declaration files); the read itself is traced to a Stripe call or a Stripe.* type.
  const initialMutated = new Set(exposedClients);
  for (const binding of [
    ...classBindings.unsafe,
    ...helperBindings.unsafe,
    ...(webhooks?.unsafeEvents ?? []),
  ]) {
    initialUnsafe.add(binding);
    initialMutated.add(binding);
  }
  const mutationNodes = nodes.filter(
    (node) =>
      !modules.safeNodes.has(node) &&
      !webhooks?.initializations.has(node) &&
      !classBindings!.initializations.has(node),
  );
  const unsafeConstructors = unsafeBindings(
    mutationNodes,
    checker,
    sdk.constructors,
    new Map(),
    canonical,
  );
  const mutatedConstructors = unsafeBindings(
    mutationNodes,
    checker,
    sdk.constructors,
    new Map(),
    canonical,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
  );
  for (const [node, binding] of [
    ...declarations.map((node) => [node.initializer, symbol(node.name)] as const),
    ...[...modules.inlineDefaults].map(([node, binding]) => [node.expression, binding] as const),
    ...[...classBindings.fields.values()].map(
      (field) => [field.initializer, field.binding] as const,
    ),
    ...helperBindings.creations,
    ...factoryBindings.creations,
  ]) {
    const creation = sdk.creation(node);
    if (!binding || !creation) continue;
    const spread = creation.arguments?.some(ts.isSpreadElement);
    if (spread || unsafeConstructors.has(sdk.binding(creation)!)) initialUnsafe.add(binding);
    if (spread || mutatedConstructors.has(sdk.binding(creation)!)) initialMutated.add(binding);
  }
  for (const [response, origin] of origins)
    if (sdkCall(origin)?.optional) {
      initialUnsafe.add(response);
      initialMutated.add(response);
    }
  const primitiveValue = (node: ts.Node): boolean => {
    if (!stripeTypes) return false;
    if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node))
      return primitiveValue(node.expression);
    if (!ts.isPropertyAccessExpression(node)) return false;
    const parent = schemaForExpression(node.expression);
    const definition = parent
      ? componentDefinition(schemaDefinitions, parent)?.definition
      : undefined;
    const property =
      definition && isObject(definition.properties)
        ? definition.properties[node.name.text]
        : undefined;
    return (
      isObject(property) &&
      typeof property.type === 'string' &&
      ['string', 'integer', 'number', 'boolean'].includes(property.type)
    );
  };
  const unsafe = unsafeBindings(
    mutationNodes,
    checker,
    clients,
    origins,
    canonical,
    initialUnsafe,
    readOnlyCall,
    arrayIteration,
    primitiveValue,
    clientReferences,
  );
  // Traced responses and Stripe-typed values passed into functions, returned, stored or aliased
  // keep their confirmation; only direct mutations downgrade a read.
  const mutated = unsafeBindings(
    mutationNodes,
    checker,
    clients,
    origins,
    canonical,
    initialMutated,
    readOnlyCall,
    arrayIteration,
    primitiveValue,
    clientReferences,
    false,
  );
  function helperEvidence(expression: ts.Expression, uncertain = unsafe) {
    const flow = helperBindings.client(expression);
    return flow && uncertain.has(flow.binding)
      ? {
          helperClient: {
            origin: location(flow.call),
            parameter: location(flow.parameter),
            stability: 'review' as const,
          },
        }
      : {};
  }
  for (const [node, evidence] of sdkCallNodes)
    Object.assign(evidence, helperEvidence(sdkCall(node)!.client));
  for (const [response, wrapper] of wrappedResponses) {
    if (unsafe.has(wrapper)) unsafe.add(response);
    if (mutated.has(wrapper)) mutated.add(response);
  }
  for (const node of nodes) {
    if (!ts.isCallExpression(node)) continue;
    const call = sdkCall(node);
    if (!call) continue;
    // Literal `expand` entries that walk through a removed field (stripe-expand-paths.ts) are
    // findings no rule edits, so a patch keeps them unresolved and never publishes as validated.
    // A list's expand paths start with `data.`; they are not checked against the item schema yet.
    const expanded = provider.packageName === STRIPE.packageName ? responseCall(node) : undefined;
    if (expanded && !expanded.list)
      for (const hit of removedExpandPaths(node, expanded.schema, changes, schemaDefinitions))
        findings.push({
          ...location(hit.node),
          changeId: hit.removal.id,
          expression: `${call.resource}.${call.method} expand '${hit.path}'`,
          confidence:
            !unsafe.has(clientBinding(call.client)!) && !call.optional ? 'confirmed' : 'review',
          ...helperEvidence(call.client),
          reason: removedExpandReason(hit),
        });
    for (const rule of requestPropertyRenames.filter(
      (entry) => entry.resource === call.resource && entry.method === call.method,
    )) {
      const edit = requestPropertyEdit(node, rule);
      if (edit.status === 'unaffected') continue;
      const confirmed =
        edit.status === 'editable' && !unsafe.has(clientBinding(call.client)!) && !call.optional;
      findings.push({
        ...location(node),
        changeId: rule.id,
        expression: `${rule.resource}.${rule.method} argument[${rule.argumentIndex}].${rule.removed}`,
        confidence: confirmed ? 'confirmed' : 'review',
        ...helperEvidence(call.client),
        reason: confirmed
          ? 'Removed request field in a direct SDK argument under an operator-authored rename with a matching recorded contract.'
          : edit.status === 'review'
            ? edit.reason
            : 'SDK client escape, mutation or optional invocation prevents a request-field edit; inspect manually.',
      });
      if (confirmed && edit.status === 'editable')
        edits.push({
          file: location(node).file,
          start: edit.start,
          end: edit.end,
          replacement: edit.replacement,
          changeId: rule.id,
        });
    }
    for (const removal of requestParameterRemovals.filter(
      (entry) =>
        entry.resource === call.resource &&
        entry.method === call.method &&
        // An operator-authored rename already migrates this parameter.
        !requestPropertyRenames.some(
          (rule) =>
            rule.resource === entry.resource &&
            rule.method === entry.method &&
            rule.removed === entry.parameter,
        ),
    )) {
      const property = removedParameterProperty(node, removal);
      if (!property) continue;
      const confirmed = !unsafe.has(clientBinding(call.client)!) && !call.optional;
      // Only the exact literal `['card']` has a reviewed replacement, and, where the repository
      // opted in, a literal list of `card` plus other distinct methods, or any other value
      // expression that names no in-person method (request-migration.ts). run.ts keeps the edit
      // only with the API version bump (and, for TypeScript, the SDK upgrade) in the same patch.
      const rule = removal.cardReplacement
        ? paymentMethodRule(property, { keepListed: removal.keepListed, checker })
        : undefined;
      // A reviewed move to the documented replacement (stripe-request-moves.ts), which also rides
      // with the version bump and, for TypeScript, the SDK upgrade in run.ts.
      const moved =
        confirmed &&
        removal.move &&
        !rule &&
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
          ? requestMoveEdit(property, removal.move)
          : undefined;
      if (moved && 'replacement' in moved)
        edits.push({
          file: location(property).file,
          start: moved.start,
          end: moved.end,
          replacement: moved.replacement,
          changeId: removal.id,
          rule: moved.rule,
        });
      if (confirmed && removal.cardReplacement && rule) {
        const quote = ts.isStringLiteral(property.name) ? property.name.getText()[0] : '';
        edits.push({
          file: location(property).file,
          start: property.name.getStart(),
          end: property.name.getEnd(),
          replacement: ts.isShorthandPropertyAssignment(property)
            ? `${removal.cardReplacement}: ${property.name.text}`
            : `${quote}${removal.cardReplacement}${quote}`,
          changeId: removal.id,
          rule,
        });
      }
      findings.push({
        ...location(property),
        changeId: removal.id,
        expression: `${removal.resource}.${removal.method} argument[${removal.argumentIndex}].${removal.parameter}`,
        confidence: confirmed ? 'confirmed' : 'review',
        requestParameter: { operationId: removal.operationId, parameter: removal.parameter },
        ...helperEvidence(call.client),
        reason:
          moved && 'reason' in moved
            ? `The target API version no longer accepts this request parameter. ${moved.reason}`
            : 'The target API version no longer accepts this request parameter, and no reviewed replacement exists; removing or replacing it changes request behavior.',
      });
    }
    // Stripe's removed upcoming invoice call (stripe-invoice-preview.ts). It stops for review
    // unless run.ts keeps the createPreview edit, which then covers the finding.
    if (
      options.invoicePreview &&
      provider.packageName === STRIPE.packageName &&
      call.resource === 'invoices' &&
      call.method === 'retrieveUpcoming' &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const confirmed = !unsafe.has(clientBinding(call.client)!) && !call.optional;
      const planned = confirmed ? invoicePreviewEdits(node, options.invoicePreview) : undefined;
      if (Array.isArray(planned))
        for (const edit of planned)
          edits.push({
            file: location(node).file,
            ...edit,
            changeId: INVOICE_PREVIEW_RULE,
            rule: INVOICE_PREVIEW_RULE,
          });
      const reason =
        planned && !Array.isArray(planned)
          ? planned.reason
          : 'Stripe 2025-03-31.basil removed the upcoming invoice API (invoices.retrieveUpcoming) in favour of invoices.createPreview; this call needs review.';
      findings.push({
        ...location(node.expression.name),
        changeId: INVOICE_PREVIEW_RULE,
        expression: 'invoices.retrieveUpcoming',
        confidence: confirmed ? 'confirmed' : 'review',
        ...helperEvidence(call.client),
        contractReview: reason,
        reason,
      });
    }
  }
  // A removed parameter set outside every traced SDK body stops for review, unless it is an exact
  // `['card']` in a local body only confirmed card-rule calls receive (request-migration.ts).
  for (const { property, removal, rule } of untracedRemovedParameters(
    nodes,
    requestParameterRemovals,
    (node) => {
      const call = sdkCall(node);
      return (
        call && {
          resource: call.resource,
          method: call.method,
          confirmed: !unsafe.has(clientBinding(call.client)!) && !call.optional,
        }
      );
    },
    (node) => location(node).file,
    checker,
  )) {
    const rename = Boolean(rule);
    if (rule && (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))) {
      const quote = ts.isStringLiteral(property.name) ? property.name.getText()[0] : '';
      edits.push({
        file: location(property).file,
        start: property.name.getStart(),
        end: property.name.getEnd(),
        replacement: ts.isShorthandPropertyAssignment(property)
          ? `${removal.cardReplacement}: ${property.name.text}`
          : `${quote}${removal.cardReplacement}${quote}`,
        changeId: removal.id,
        rule,
      });
    }
    findings.push({
      ...location(property),
      changeId: removal.id,
      expression: `${removal.parameter} ${rename ? 'in a local request body' : 'outside a traced SDK request body'}`,
      confidence: rename ? 'confirmed' : 'review',
      requestParameter: { operationId: removal.operationId, parameter: removal.parameter },
      reason: rename
        ? 'The target API version no longer accepts this request parameter. The local body reaches only traced SDK calls the owner-approved payment method rule covers.'
        : 'This object sets a request parameter the target API version removed, but Refit cannot trace it to an SDK call body: a request built in a variable, assembled by a wrapper or sent by an untraced client may still send it once the API version moves.',
    });
  }
  for (const node of nodes) {
    const operation = responseCall(node);
    if (!operation || !ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression))
      continue;
    const replacement = operationReplacements.find(
      (candidate) =>
        candidate.resource === operation.resource && candidate.method === operation.method,
    );
    if (!replacement) continue;
    const method = node.expression;
    const call = sdkCall(node)!;
    const confirmed = !unsafe.has(clientBinding(call.client)!) && !call.optional;
    findings.push({
      ...location(node),
      changeId: replacement.id,
      expression: `${operation.resource}.${operation.method}`,
      confidence: confirmed ? 'confirmed' : 'review',
      ...helperEvidence(call.client),
      reason: confirmed
        ? 'Removed endpoint call on an immutable SDK client under an operator-authored replacement with a matching recorded contract.'
        : 'SDK client escape, mutation or optional invocation prevents a configured endpoint edit; inspect manually.',
    });
    if (confirmed)
      edits.push({
        ...location(node),
        start: call.start,
        end: method.name.getEnd(),
        replacement: `${replacement.replacementResource}.${replacement.replacementMethod}`,
        changeId: replacement.id,
      });
  }
  let expanded: Set<string> | undefined;
  // Fields named by literal `expand` arrays. Any other mention of `expand`, such as a variable,
  // shorthand property or computed key, counts as expanding every field ('*').
  function expandedFields() {
    if (expanded) return expanded;
    expanded = new Set();
    const literalNames = new Set<ts.Node>();
    for (const node of nodes) {
      if (!ts.isPropertyAssignment(node) || node.name.getText().replace(/['"]/g, '') !== 'expand')
        continue;
      const value = node.initializer;
      if (
        !ts.isArrayLiteralExpression(value) ||
        !value.elements.every((element) => ts.isStringLiteralLike(element))
      )
        continue;
      literalNames.add(node.name);
      for (const element of value.elements as ts.NodeArray<ts.StringLiteralLike>)
        for (const segment of element.text.split('.')) expanded.add(segment);
    }
    for (const node of nodes)
      if (
        (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
        node.text === 'expand' &&
        !literalNames.has(node)
      )
        expanded.add('*');
    return expanded;
  }
  function expandsField(property: string) {
    return expandedFields().has('*') || expandedFields().has(property);
  }
  function addEdit(edit: SourceEdit) {
    if (
      edits.some(
        (other) => other.file === edit.file && other.start < edit.end && edit.start < other.end,
      )
    )
      return false;
    edits.push(edit);
    return true;
  }
  // Reads sharing a hoisted helper local plan the same declaration; it is added once.
  function addPlanned(planned: SourceEdit[]) {
    return planned.every(
      (edit) =>
        edits.some(
          (other) =>
            other.file === edit.file &&
            other.start === edit.start &&
            other.end === edit.end &&
            other.replacement === edit.replacement,
        ) || addEdit(edit),
    );
  }
  const periodPlans = new Map<
    ts.Node,
    { rareCase: PeriodRareCase; text?: string; selection?: string }
  >();
  function within(scope: ts.Node) {
    return nodes.filter(
      (candidate) =>
        candidate.getSourceFile() === scope.getSourceFile() &&
        candidate.pos >= scope.pos &&
        candidate.end <= scope.end,
    );
  }
  // A value the plan item's price can be compared with at every call site in the file.
  function priceValue(expression: ts.Expression) {
    if (ts.isStringLiteralLike(expression)) return expression.getText();
    if (
      ts.isPropertyAccessExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === 'env' &&
      ts.isIdentifier(expression.expression.expression) &&
      expression.expression.expression.text === 'process'
    )
      return expression.getText();
    if (!ts.isIdentifier(expression)) return;
    const declaration = symbol(expression)?.valueDeclaration;
    return declaration &&
      ts.isVariableDeclaration(declaration) &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const &&
      ts.isVariableStatement(declaration.parent.parent) &&
      ts.isSourceFile(declaration.parent.parent.parent)
      ? expression.getText()
      : undefined;
  }
  // The item an application already treats as its plan: a `price.id` comparison on a subscription
  // item, else a fixed `items.data[N]` index. Several different selections are ambiguous.
  function itemSelection(scope: ts.Node) {
    const prices = new Set<string>();
    const indexes = new Set<string>();
    for (const candidate of within(scope)) {
      if (
        ts.isBinaryExpression(candidate) &&
        [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(
          candidate.operatorToken.kind,
        )
      )
        for (const [side, other] of [
          [candidate.left, candidate.right],
          [candidate.right, candidate.left],
        ]) {
          const item =
            ts.isPropertyAccessExpression(side) &&
            side.name.text === 'id' &&
            ts.isPropertyAccessExpression(side.expression) &&
            side.expression.name.text === 'price'
              ? side.expression.expression
              : undefined;
          const value = item && priceValue(other);
          if (value && schemaForExpression(item) === 'subscription_item') prices.add(value);
        }
      if (
        ts.isElementAccessExpression(candidate) &&
        numericArrayIndex(candidate.argumentExpression) &&
        ts.isPropertyAccessExpression(candidate.expression) &&
        candidate.expression.name.text === 'data' &&
        ts.isPropertyAccessExpression(candidate.expression.expression) &&
        candidate.expression.expression.name.text === 'items' &&
        schemaForExpression(candidate.expression.expression.expression) === 'subscription'
      )
        indexes.add(candidate.argumentExpression.getText());
    }
    if (prices.size === 1) {
      const [price] = prices;
      return {
        text: `(items) => items.find((item) => item.price?.id === ${price})`,
        selection: `price.id === ${price}`,
      };
    }
    if (!prices.size && indexes.size === 1) {
      const [index] = indexes;
      return { text: `(items) => items[${index}]`, selection: `items.data[${index}]` };
    }
  }
  function periodPlan(node: ts.Node): {
    rareCase: PeriodRareCase;
    text?: string;
    selection?: string;
  } {
    for (let scope: ts.Node | undefined = node; scope; scope = scope.parent) {
      if (!ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) continue;
      const selection = itemSelection(scope);
      if (selection) return { rareCase: 'item-in-code', ...selection };
    }
    const policy = provider.stripeSubscriptionPeriods;
    return policy
      ? {
          rareCase: 'price-policy',
          text: `(items) => items.find((item) => item.price?.id === ${JSON.stringify(policy.priceId)})`,
          selection: `price.id === ${JSON.stringify(policy.priceId)}`,
        }
      : { rareCase: 'flagged' };
  }
  function propose(
    node: ts.Node,
    receiver: ts.Expression,
    change: Removal,
    typeChecked = false,
  ): SourceEdit['rule'] | undefined {
    const provenance = sourceEvidence(receiver)?.kind;
    // Removed Stripe reads with a documented new location go through a generated helper that reads
    // either API version (data/packs/stripe.json). Period reads also take a read the upgraded types
    // reject on Subscription. A field the code expands is held back where the entry says the expand
    // path moved too; webhook payloads are never expanded ("Objects sent in events are always in
    // their minimal form", https://docs.stripe.com/expand, read 2026-10-24), so an expand elsewhere
    // does not hold back a webhook read. An adapter's own move for the field wins.
    for (const move of provider.packageName === STRIPE.packageName ? STRIPE_PACK.fieldMoves : []) {
      if (!move.schemas.includes(change.schema)) continue;
      const file = location(node).file;
      if (move.family === 'period-helper') {
        if (
          !webhooks?.origin(receiver) &&
          provenance !== 'declared-type' &&
          provenance !== 'sdk' &&
          !typeChecked
        )
          continue;
        const plan = periodPlan(node);
        const edit = periodHelperEdit(node, move, file, change.id, plan.text);
        if (edit && addEdit(edit)) {
          periodPlans.set(node, plan);
          return edit.rule;
        }
        continue;
      }
      if (
        change.property !== move.property ||
        propertyMoves.some(
          (candidate) => candidate.schema === change.schema && candidate.removed === move.property,
        ) ||
        !(
          webhooks?.origin(receiver) ||
          ((move.family !== 'moved-value' ||
            !move.unlessExpanded ||
            !expandsField(move.property)) &&
            (provenance === 'declared-type' || provenance === 'sdk'))
        )
      )
        continue;
      if (move.family === 'moved-id') {
        const edit = movedIdEdit(node, move, file, change.id);
        if (edit && addEdit(edit)) return edit.rule;
        continue;
      }
      const planned = movedValueEdit(node, move, file, change.id);
      // Reads sharing a hoisted local plan the same declaration; it is added once.
      if (
        planned &&
        (move.typeofGuard || move.narrowTested ? addPlanned(planned) : addEdit(planned[0]))
      )
        return planned[0].rule;
    }
    if (webhooks?.origin(receiver)) return;
    // A value known only from its Stripe.* type may be a webhook payload passed into a helper;
    // its shape follows the endpoint's version, so other rules report it but never edit it.
    if (provenance === 'declared-type' || provenance === 'unmapped-sdk') return;
    if (provider.id !== STRIPE.id) {
      const rename = provider.propertyRenames?.find(
        (candidate) => candidate.schema === change.schema && candidate.removed === change.property,
      );
      const move = propertyMoves.find(
        (candidate) => candidate.schema === change.schema && candidate.removed === change.property,
      );
      if (
        rename &&
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === change.property &&
        (!move || !move.expandable || !expandsField(change.property))
      ) {
        const file = location(node).file;
        const start = node.name.getStart();
        if (edits.some((edit) => edit.file === file && edit.start === start)) return;
        edits.push({
          file,
          start,
          end: node.name.getEnd(),
          replacement: move ? move.accessor : rename.replacement,
          changeId: change.id,
        });
        // Missing optional intermediates read as null, like the removed nullable field.
        if (move?.fallbackNull)
          edits.push(
            {
              file,
              start: node.getStart(),
              end: node.getStart(),
              replacement: '(',
              changeId: change.id,
            },
            {
              file,
              start: node.getEnd(),
              end: node.getEnd(),
              replacement: ' ?? null)',
              changeId: change.id,
            },
          );
      }
      return;
    }
    if (
      change.schema !== 'payment_intent' ||
      change.property !== 'charges' ||
      !ts.isIdentifier(receiver)
    )
      return;
    const origin = origins.get(symbol(receiver)!);
    const guarded =
      origin &&
      guardedHistoryEdit({
        node,
        receiver,
        origin,
        checker,
        symbol,
        clients,
        locations,
        change,
        clientExport: modules.clientExport,
        resolveImport: resolution.resolve,
        classClient: (node) => classBindings!.reference(node)?.binding,
        helperClient: (node) => {
          const binding = clientBinding(node);
          return binding && helperBindings.flows.has(binding) ? binding : undefined;
        },
      });
    if (guarded) {
      if (!edits.some((edit) => edit.file === guarded.file)) edits.push(guarded);
      return;
    }
    if (edits.some((edit) => edit.file === location(node).file && edit.start === 0)) return;
    const data = node.parent;
    if (
      !origin ||
      origin.arguments.length !== 1 ||
      !ts.isPropertyAccessExpression(origin.expression) ||
      origin.expression.name.text !== 'retrieve' ||
      !ts.isPropertyAccessExpression(data) ||
      data.name.text !== 'data' ||
      data.expression !== node ||
      data.questionDotToken ||
      !ts.isReturnStatement(data.parent) ||
      data.parent.expression !== data ||
      !ts.isPropertyAccessExpression(node) ||
      node.questionDotToken
    )
      return;
    const resource = origin.expression.expression as ts.PropertyAccessExpression;
    const client = resource.expression as ts.Identifier;
    const visible = checker
      .getSymbolsInScope(node, ts.SymbolFlags.Value | ts.SymbolFlags.Alias)
      .find((candidate) => candidate.name === client.text);
    if (canonical(visible) !== symbol(client)) return;
    const block = data.parent.parent;
    if (!ts.isBlock(block)) return;
    const owner = block.parent;
    if (
      !(
        ts.isFunctionDeclaration(owner) ||
        ts.isFunctionExpression(owner) ||
        ts.isArrowFunction(owner)
      ) ||
      !owner.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    )
      return;
    // Only a response declared in this function body; nested closures and aliases need review.
    const declaration = symbol(receiver)?.valueDeclaration;
    if (!declaration || declaration.parent.parent.parent !== block) return;
    edits.push({
      file: location(node).file,
      start: data.getStart(),
      end: data.getEnd(),
      replacement: `(await ${client.text}.charges.list({ payment_intent: ${receiver.text}.id })).data`,
      changeId: change.id,
    });
  }
  function sourceEvidence(
    expression: ts.Expression,
    seen = new Set<ts.Symbol>(),
  ):
    | { kind: 'sdk' | 'unmapped-sdk'; call: ts.CallExpression }
    | { kind: 'webhook' | 'declared-type' }
    | undefined {
    if (webhooks?.origin(expression)) return { kind: 'webhook' };
    if (ts.isIdentifier(expression)) {
      const binding = symbol(expression);
      if (!binding || seen.has(binding)) return;
      const origin = origins.get(binding);
      if (origin && responseCall(origin)) return { kind: 'sdk', call: origin };
      const next = new Set([...seen, binding]);
      let declaration = binding.valueDeclaration;
      while (declaration && ts.isBindingElement(declaration))
        declaration = declaration.parent.parent;
      if (declaration && ts.isVariableDeclaration(declaration)) {
        const source =
          declaration.initializer ??
          (ts.isVariableDeclarationList(declaration.parent) &&
          ts.isForOfStatement(declaration.parent.parent)
            ? declaration.parent.parent.expression
            : undefined);
        const kind = source && sourceEvidence(source, next);
        if (kind) return kind;
      }
      if (
        declaration &&
        ts.isParameter(declaration) &&
        ts.isCallExpression(declaration.parent.parent)
      ) {
        const iteration = arrayIteration(declaration.parent.parent);
        if (iteration) return sourceEvidence(iteration.source, next);
      }
      return stripeTypes?.typed.has(binding) || stripeTypes?.typedArrays.has(binding)
        ? { kind: 'declared-type' }
        : undefined;
    }
    // The list call a `for await` loop, `autoPagingEach` or `autoPagingToArray` pages through.
    if (ts.isCallExpression(expression)) {
      const call = listCall(expression) ? expression : undefined;
      const paged =
        ts.isPropertyAccessExpression(expression.expression) &&
        (autoPaging(expression, 'autoPagingEach') || autoPaging(expression, 'autoPagingToArray'))
          ? expression.expression.expression
          : undefined;
      if (call) return { kind: 'sdk', call };
      if (paged && ts.isCallExpression(paged)) return { kind: 'sdk', call: paged };
    }
    if (ts.isAwaitExpression(expression)) {
      if (ts.isCallExpression(expression.expression)) {
        const call = expression.expression;
        if (sdkCall(call)) return { kind: responseCall(call) ? 'sdk' : 'unmapped-sdk', call };
        if (ts.isIdentifier(call.expression) && wrappers.has(symbol(call.expression)!))
          return {
            kind: 'sdk',
            call: responseCall(call) ? call : wrappers.get(symbol(call.expression)!)!,
          };
      }
      return sourceEvidence(expression.expression, seen);
    }
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isPropertyAccessExpression(expression) ||
      ts.isElementAccessExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    ) {
      const kind = sourceEvidence(expression.expression, seen);
      if (kind) return kind;
    }
    if (
      ts.isBinaryExpression(expression) &&
      (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      ts.isArrayLiteralExpression(expression.right) &&
      !expression.right.elements.length
    )
      return sourceEvidence(expression.left, seen);
    return stripeTypes?.expressionSchema(expression) ? { kind: 'declared-type' } : undefined;
  }
  // Reads ending two or more segments into a configured move's new path use the new location,
  // even where other removals share those segment names.
  function readsMovedPath(node: ts.Node) {
    return propertyMoves.some((move) => {
      const path = move.accessor.split(/\??\./);
      return path.slice(1).some((_, index) => {
        let current: ts.Node = node;
        for (const segment of path.slice(0, index + 2).reverse()) {
          if (!ts.isPropertyAccessExpression(current) || current.name.text !== segment)
            return false;
          current = current.expression;
        }
        return true;
      });
    });
  }
  // A parameter of a callback (inline or named) passed to an iteration method on a traced array:
  // its items are provider objects even when the callback shape is not confirmable.
  function iterationCallback(expression: ts.Expression) {
    let root = expression;
    while (
      ts.isPropertyAccessExpression(root) ||
      ts.isElementAccessExpression(root) ||
      ts.isNonNullExpression(root) ||
      ts.isParenthesizedExpression(root)
    )
      root = root.expression;
    const declaration = ts.isIdentifier(root) ? symbol(root)?.valueDeclaration : undefined;
    if (!declaration || !ts.isParameter(declaration)) return false;
    const callback = declaration.parent;
    const name =
      ts.isFunctionDeclaration(callback) && callback.name ? symbol(callback.name) : undefined;
    return nodes.some(
      (node) =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ARRAY_ITERATION_METHODS.has(node.expression.name.text) &&
        node.arguments.length > 0 &&
        (node.arguments[0] === callback ||
          (name !== undefined &&
            ts.isIdentifier(node.arguments[0]) &&
            symbol(node.arguments[0]) === name)) &&
        arrayItemForExpression(node.expression.expression) !== undefined,
    );
  }
  // A traced object's property the contract declares as a map of strings, such as `metadata`.
  function mapField(expression: ts.Expression) {
    while (ts.isNonNullExpression(expression) || ts.isParenthesizedExpression(expression))
      expression = expression.expression;
    if (!ts.isPropertyAccessExpression(expression)) return false;
    const parent = schemaForExpression(expression.expression);
    const definition = parent
      ? componentDefinition(schemaDefinitions, parent)?.definition
      : undefined;
    const field =
      definition && isObject(definition.properties)
        ? definition.properties[expression.name.text]
        : undefined;
    return (
      isObject(field) &&
      field.type === 'object' &&
      !field.properties &&
      !field.anyOf &&
      isObject(field.additionalProperties) &&
      field.additionalProperties.type === 'string'
    );
  }
  function record(node: ts.Node, receiver: ts.Expression, property: string | undefined) {
    if (
      property !== undefined &&
      ARRAY_ITERATION_METHODS.has(property) &&
      arrayItemForExpression(receiver)
    )
      return;
    // SDK resources are not response fields, even when their names match a removal.
    if (sdkAccess(receiver)) return;
    if (readsMovedPath(node)) return;
    const schema = schemaForExpression(receiver);
    const tracked = schema !== undefined;
    const webhook = webhooks?.origin(receiver);
    const provenance = sourceEvidence(receiver);
    // An object the application writes as a literal (`PLANS.find(…).price`) is not a Stripe object.
    if (!tracked && !provenance && !webhook && literals.literalObject(receiver)) return;
    // `appointment.amount = paid` sets a field on an object Refit does not trace; it reads nothing.
    if (
      !tracked &&
      ts.isBinaryExpression(node.parent) &&
      node.parent.left === node &&
      node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    )
      return;
    // `session.metadata.amount`: a value of a free-form map on a traced object, not an object field.
    if (!tracked && mapField(receiver)) return;
    const declaredType =
      provenance?.kind === 'declared-type' ||
      (provenance?.kind === 'unmapped-sdk' && Boolean(stripeTypes?.expressionSchema(receiver)));
    const sourceClient =
      provenance && 'call' in provenance ? sdkCall(provenance.call)?.client : undefined;
    const classClient = sourceClient && classBindings!.client(sourceClient);
    const checkedRead =
      ts.isPropertyAccessExpression(node) &&
      typeCheckedPeriodReads.has(`${location(node).file}\0${node.name.getStart()}`);
    for (const change of changes) {
      if (tracked && change.schema !== schema) continue;
      if (property !== undefined && change.property !== property) continue;
      if (!tracked && !providerDetected && !checkedRead) continue;
      // Unresolved Stripe receivers are flagged only where files work with Stripe; if none are
      // identifiable, every same-named read stays flagged.
      if (
        !tracked &&
        !checkedRead &&
        stripeTypes &&
        stripeFiles.size &&
        !stripeFiles.has(node.getSourceFile())
      )
        continue;
      const directCall = (expression: ts.Expression): ts.CallExpression | undefined => {
        if (ts.isAwaitExpression(expression) && ts.isCallExpression(expression.expression))
          return expression.expression;
        if (
          ts.isParenthesizedExpression(expression) ||
          ts.isAsExpression(expression) ||
          ts.isTypeAssertionExpression(expression) ||
          ts.isNonNullExpression(expression) ||
          ts.isSatisfiesExpression(expression) ||
          ts.isPropertyAccessExpression(expression) ||
          ts.isElementAccessExpression(expression)
        )
          return directCall(expression.expression);
      };
      const immediateCall = directCall(receiver);
      const immediateSdk = immediateCall ? sdkCall(immediateCall) : undefined;
      const responseSymbol = responseBinding(receiver);
      const uncertainMutation =
        fromHelper(receiver) ||
        (responseSymbol !== undefined && mutated.has(responseSymbol)) ||
        (immediateSdk &&
          (immediateSdk.optional || mutated.has(clientBinding(immediateSdk.client)!)));
      const confirmed = Boolean(
        tracked &&
        !uncertainMutation &&
        property !== undefined &&
        change.schema === schema &&
        (!webhook || webhook.schema !== undefined) &&
        (provenance?.kind !== 'unmapped-sdk' || declaredType),
      );
      // The type checker resolved the receiver to Subscription, and the helper returns the field the
      // object holds at runtime, so neither tracing nor mutation evidence is needed for this read.
      const typeChecked =
        !confirmed &&
        checkedRead &&
        STRIPE_PACK.fieldMoves.some(
          (move) =>
            move.family === 'period-helper' &&
            move.schemas.includes(change.schema) &&
            Object.hasOwn(move.helpers, change.property),
        );
      const migration =
        confirmed || typeChecked ? propose(node, receiver, change, typeChecked) : undefined;
      const checkedMigration = typeChecked && migration !== undefined;
      if (property === undefined && !tracked) continue;
      const file = location(node).file;
      const moveReview =
        confirmed &&
        provider.packageName === STRIPE.packageName &&
        !edits.some(
          (edit) => edit.file === file && edit.start < node.getEnd() && node.getStart() < edit.end,
        )
          ? STRIPE_MOVE_REVIEW[`${change.schema}.${change.property}`]
          : undefined;
      findings.push({
        ...location(node),
        changeId: change.id,
        expression: property === undefined ? '[computed property]' : `.${property}`,
        confidence: confirmed || checkedMigration ? 'confirmed' : 'review',
        ...(sourceClient ? helperEvidence(sourceClient, mutated) : {}),
        ...(declaredType ? { declaredType: { schema } } : {}),
        ...(checkedMigration ? { typeChecked: true as const } : {}),
        ...(tracked || provenance || checkedMigration || iterationCallback(receiver)
          ? {}
          : { untraced: true as const }),
        ...(migration === SUBSCRIPTION_PERIOD_HELPER_RULE && periodPlans.get(node)
          ? {
              subscriptionPeriod: {
                rareCase: periodPlans.get(node)!.rareCase,
                ...(periodPlans.get(node)!.selection
                  ? { selection: periodPlans.get(node)!.selection }
                  : {}),
              },
            }
          : {}),
        ...(classClient &&
        (mutated.has(classClient.binding) ||
          (provenance && 'call' in provenance && sdkCall(provenance.call)?.optional))
          ? { classClient: { origin: location(classClient.origin), stability: 'review' as const } }
          : {}),
        ...(webhook
          ? {
              webhook: {
                ...(migration && HELPER_RULES.has(migration)
                  ? { migration: { rule: migration } }
                  : {}),
                schema: webhook.schema,
                eventTypes: webhook.eventTypes,
                origin: webhook.origin,
                apiVersion: 'unverified' as const,
              },
            }
          : {}),
        reason:
          (checkedMigration
            ? `Removed subscription.${change.property} read that the upgraded stripe-node types reject on Subscription. Refit's tracer did not reach its receiver, so the version-tolerant period helper reads it.`
            : declaredType && confirmed
              ? `Removed ${schema}.${change.property} read on a value declared with a Stripe.* type.`
              : declaredType
                ? 'Declared Stripe type identifies this possible field usage, but the value may be mutated; inspect manually.'
                : confirmed && webhook
                  ? `Removed ${schema}.${change.property} read on a Stripe snapshot webhook payload narrowed by event.type. Incoming webhook API version and migration semantics require separate review.`
                  : confirmed
                    ? `Removed field read on a statically traced ${provider.id} ${schema} response.`
                    : uncertainMutation
                      ? 'Response or SDK client may be mutated or escape through an alias or call, or come from an optional SDK invocation; inspect manually.'
                      : 'Receiver or property cannot be proven by the supported local analysis; inspect manually.') +
          (moveReview ? ` ${moveReview}` : ''),
      });
    }
  }
  for (const node of nodes) {
    if (ts.isPropertyAccessExpression(node)) record(node, node.expression, node.name.text);
    if (ts.isElementAccessExpression(node))
      record(
        node,
        node.expression,
        ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined,
      );
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer
    ) {
      for (const element of node.name.elements) {
        const name = element.propertyName ?? element.name;
        if (ts.isIdentifier(name) || ts.isStringLiteral(name))
          record(element, node.initializer, name.text);
      }
    }
  }
  // `switch (subscription.status)`, `const unhandled: never = subscription.status`, or a compare
  // with string literals (`subscription.status === 'active'`, `['active'].includes(...)`), directly
  // or through one const alias; new enum values on these fields can reach unhandled code (owner
  // decision 6, 2026-10-24).
  const enumChecks: (Location & { schema: string; property: string; compare?: true })[] = [];
  const apiVersionLiterals: { file: string; start: number; end: number; value: string }[] = [];
  for (const node of nodes) {
    const compared = comparedWithLiterals(node);
    let checked = ts.isSwitchStatement(node)
      ? node.expression
      : ts.isVariableDeclaration(node) && node.type?.kind === ts.SyntaxKind.NeverKeyword
        ? node.initializer
        : compared;
    if (checked && ts.isIdentifier(checked)) {
      const declaration = symbol(checked)?.valueDeclaration;
      checked = declarations.find((entry) => entry === declaration)?.initializer;
    }
    while (
      checked &&
      (ts.isParenthesizedExpression(checked) ||
        ts.isAsExpression(checked) ||
        ts.isNonNullExpression(checked))
    )
      checked = checked.expression;
    if (!checked || !ts.isPropertyAccessExpression(checked)) continue;
    const schema = schemaForExpression(checked.expression);
    if (schema)
      enumChecks.push({
        ...location(node),
        schema,
        property: checked.name.text,
        ...(compared && { compare: true as const }),
      });
  }
  function dropPeriodHelper(file: string) {
    for (let index = edits.length - 1; index >= 0; index--)
      if (edits[index].file === file && HELPER_RULES.has(edits[index].rule!))
        edits.splice(index, 1);
    for (const finding of findings)
      if (finding.file === file) {
        delete finding.subscriptionPeriod;
        if (HELPER_RULES.has(finding.webhook?.migration?.rule ?? ''))
          delete finding.webhook!.migration;
      }
  }
  if (provider.stripeSubscriptionPeriods && webhooks) {
    for (const source of program.getSourceFiles()) {
      const file = locations.get(source.fileName);
      if (!file) continue;
      const proposal = subscriptionPeriodEdit({
        source,
        nodes: nodes.filter((node) => node.getSourceFile() === source),
        findings,
        changes,
        policy: provider.stripeSubscriptionPeriods,
        webhooks,
        symbol,
        unsafe,
        file,
      });
      if (!proposal) continue;
      // The configured policy's whole-handler migration takes precedence over the helper.
      dropPeriodHelper(file);
      if (edits.some((edit) => edit.file === file)) continue;
      edits.push(proposal.edit);
      for (const finding of proposal.findings)
        finding.webhook!.migration = {
          rule: SUBSCRIPTION_PERIOD_RULE,
          ...provider.stripeSubscriptionPeriods,
        };
    }
  }
  // One helper module per repository, beside the files that call it, imported where it is used.
  const helperSources = program
    .getSourceFiles()
    .filter((source) =>
      edits.some(
        (edit) => edit.file === locations.get(source.fileName) && HELPER_RULES.has(edit.rule!),
      ),
    );
  const moduleKind = (source: ts.SourceFile) =>
    /\.[cm]?tsx?$/.test(source.fileName)
      ? ('ts' as const)
      : source.fileName.endsWith('.cjs') ||
          (!source.fileName.endsWith('.mjs') &&
            !source.statements.some(
              (statement) => ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement),
            ))
        ? ('cjs' as const)
        : ('esm' as const);
  const kinds = helperSources.map(moduleKind);
  const kind = (['ts', 'esm', 'cjs'] as const)
    .map((candidate) => ({ candidate, count: kinds.filter((entry) => entry === candidate).length }))
    .sort((a, b) => b.count - a.count)[0]?.candidate;
  // Node16/NodeNext resolution requires explicit extensions on relative imports.
  const nodeModuleResolution = (repository.configurations ?? []).some((file) =>
    /"module(?:Resolution)?"\s*:\s*"node(?:16|next)"/i.test(file.content),
  );
  for (const source of helperSources)
    if (
      moduleKind(source) !== kind ||
      nodes.some(
        (node) =>
          node.getSourceFile() === source &&
          ts.isIdentifier(node) &&
          HELPER_NAMES.includes(node.text) &&
          !edits.some(
            (edit) =>
              edit.file === locations.get(source.fileName) &&
              edit.start <= node.getStart() &&
              node.getEnd() <= edit.end,
          ),
      )
    )
      dropPeriodHelper(locations.get(source.fileName)!);
  const helperFiles = helperSources
    .map((source) => locations.get(source.fileName)!)
    .filter((file) => edits.some((edit) => edit.file === file && HELPER_RULES.has(edit.rule!)));
  if (kind && helperFiles.length) {
    // The module and its imports carry the rule of the reads they serve.
    const moduleRule = STRIPE_PACK.fieldMoves
      .map((move) => move.rule)
      .find((rule) => edits.some((edit) => edit.rule === rule))!;
    const usedIn = (file: string) =>
      HELPER_NAMES.filter((name) =>
        edits.some(
          (edit) =>
            edit.file === file &&
            HELPER_RULES.has(edit.rule!) &&
            edit.replacement.includes(`${name}(`),
        ),
      );
    const sourceOf = (file: string) =>
      helperSources.find((entry) => locations.get(entry.fileName) === file)!;
    // Lines go after the file's directives and imports (and requires in CommonJS), in its own
    // line endings.
    const insert = (file: string, text: string, separator: string) => {
      const source = sourceOf(file);
      const prologue = source.statements.filter((_statement, index) =>
        source.statements
          .slice(0, index + 1)
          .every(
            (entry) =>
              (ts.isExpressionStatement(entry) && ts.isStringLiteral(entry.expression)) ||
              ts.isImportDeclaration(entry) ||
              (kind === 'cjs' &&
                ts.isVariableStatement(entry) &&
                entry.declarationList.declarations.every(
                  (variable) =>
                    variable.initializer && /^require\(/.test(variable.initializer.getText()),
                )),
          ),
      );
      // Without a prologue, after a byte order mark, a shebang (a comment after a mark, see
      // parseableText) and the leading file pragmas and comments set apart by a blank line. A
      // comment directly above the first statement, such as @ts-expect-error, stays on it.
      const head = /^\uFEFF?(?:#!.*|(?<=^\uFEFF)\/\/.*)?/.exec(source.text)![0].length;
      const header = (ts.getLeadingCommentRanges(source.text, head) ?? []).filter(
        ({ pos, end }) =>
          FILE_PRAGMA.test(source.text.slice(pos, end)) ||
          /^[^\S\r\n]*\r?\n[^\S\r\n]*\r?\n/.test(source.text.slice(end)),
      );
      const anchor = prologue.at(-1)?.getEnd() ?? header.at(-1)?.end ?? head;
      const newline = source.text.includes('\r\n') ? '\r\n' : '\n';
      const lines = text.replaceAll('\n', newline);
      const atLineEnd = /[^\uFEFF]$/.test(source.text.slice(0, anchor));
      edits.push({
        file,
        start: anchor,
        end: anchor,
        replacement: atLineEnd
          ? `${separator.replaceAll('\n', newline)}${lines}`
          : `${lines}${separator.replaceAll('\n', newline)}`,
        changeId: 'stripe-subscription-period-helper',
        rule: moduleRule,
      });
    };
    // One calling file gets the helpers it uses written into it, so the patch adds no module and
    // no import, and a test that loads that file alone with a fixed set of imports still runs. The
    // helpers' private names, and the globals they read, must be free in that file; otherwise the
    // module keeps them apart.
    const [single] = helperFiles;
    const inline =
      helperFiles.length === 1
        ? subscriptionPeriodHelperModule(kind, usedIn(single), true)
        : undefined;
    const declared = inline
      ? ts
          .createSourceFile('helpers.ts', inline, ts.ScriptTarget.Latest)
          .statements.flatMap((statement) =>
            (ts.isFunctionDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
            statement.name
              ? [statement.name.text]
              : [],
          )
      : [];
    const free = (source: ts.SourceFile) =>
      !nodes.some(
        (node) =>
          node.getSourceFile() === source && ts.isIdentifier(node) && declared.includes(node.text),
      ) &&
      !checker
        .getSymbolsInScope(
          source,
          ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Alias,
        )
        .some(
          (entry) =>
            HELPER_GLOBALS.includes(entry.name) &&
            entry.declarations?.some((declaration) => declaration.getSourceFile() === source),
        );
    if (inline && free(sourceOf(single))) insert(single, inline.replace(/\n$/, ''), '\n\n');
    else {
      const directories = helperFiles.map((file) => posix.dirname(file).split('/'));
      const shared = directories[0].filter((segment, index) =>
        directories.every((directory) => directory[index] === segment),
      );
      const extension =
        kind === 'ts'
          ? 'ts'
          : helperFiles.every((file) => file.endsWith(kind === 'esm' ? '.mjs' : '.cjs'))
            ? kind === 'esm'
              ? 'mjs'
              : 'cjs'
            : 'js';
      // No hyphen: Convex rejects one in a module in its functions folder, where this may land.
      const base = [
        ...shared.filter((segment) => segment !== '.'),
        'stripeSubscriptionPeriod',
      ].join('/');
      const taken = new Set(repository.files.map((file) => file.path.replace(/\.[^./]+$/, '')));
      const stem = taken.has(base) ? `${base}Refit` : base;
      edits.push({
        file: `${stem}.${extension}`,
        start: 0,
        end: 0,
        replacement: subscriptionPeriodHelperModule(kind, [
          ...new Set(helperFiles.flatMap(usedIn)),
        ]),
        changeId: 'stripe-subscription-period-helper',
        rule: moduleRule,
      });
      for (const file of helperFiles) {
        const relativeImports = sourceOf(file)
          .statements.filter(ts.isImportDeclaration)
          .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text)
          .filter((specifier) => specifier.startsWith('.'));
        const suffix =
          kind === 'ts'
            ? relativeImports.some((specifier) => specifier.endsWith('.js')) ||
              (!relativeImports.length && nodeModuleResolution)
              ? '.js'
              : ''
            : extension === 'js' && kind === 'cjs'
              ? ''
              : `.${extension}`;
        let specifier = posix.relative(posix.dirname(file), stem) + suffix;
        if (!specifier.startsWith('.')) specifier = `./${specifier}`;
        const used = usedIn(file).join(', ');
        insert(
          file,
          kind === 'cjs'
            ? `const { ${used} } = require('${specifier}');`
            : `import { ${used} } from '${specifier}';`,
          '\n',
        );
      }
    }
  }
  return {
    imports,
    calls,
    sdkCalls,
    clientMethodCalls,
    expandedFields: [...expandedFields()].sort(),
    apiVersionDeclarations: declaredApiVersions({
      nodes,
      mutationNodes,
      initialUnsafe,
      checker,
      provider,
      clients,
      creation: sdk.creation,
      constructorBinding: sdk.binding,
      clientBinding: (node) =>
        ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)
          ? symbol(node.parent.name)
          : (classBindings!.creations.get(node) ??
            helperBindings.creations.get(node) ??
            factoryBindings!.creations.get(node) ??
            (ts.isExportAssignment(node.parent)
              ? modules.inlineDefaults.get(node.parent)
              : undefined)),
      sdkCall: (node) => {
        const call = sdkCall(node);
        return provider.packageName === 'stripe' && call?.resource === 'webhooks'
          ? undefined
          : call;
      },
      symbol,
      canonical,
      location,
      references: clientReferences,
      literals: apiVersionLiterals,
    }),
    apiVersionLiterals,
    findings,
    enumChecks,
    sourceWarnings: resolution.warnings,
    providerDetected,
    stripeDetected: provider.id === 'stripe' && providerDetected,
    edits,
    skippedFiles,
  };
}
