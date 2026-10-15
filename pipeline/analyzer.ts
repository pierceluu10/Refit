import { posix, resolve } from 'node:path';
import ts from 'typescript-compiler';
import { STRIPE, validSdkResourcePath, type ProviderAdapter } from './providers.ts';
import { unsafeBindings } from './mutations.ts';
import { declaredApiVersions } from './declared-api-versions.ts';
import { guardedHistoryEdit } from './history-migration.ts';
import { createSourceImportResolver } from './source-imports.ts';
import { sourceBindings } from './source-modules.ts';
import { sdkConstructors } from './sdk-constructors.ts';
import { classClients } from './class-clients.ts';
import { helperClients } from './helper-clients.ts';
import { stripeWebhookPayloads } from './stripe-webhook-payloads.ts';
import { componentReference, isObject, resolvableComponentSchema } from './specifications.ts';
import type { OperationReplacement } from './provider-operation-replacements.ts';
import type { RequestPropertyRename } from './provider-request-renames.ts';
import type { PropertyMove } from './provider-renames.ts';
import { requestPropertyEdit } from './request-migration.ts';
import { StripeTypes } from './stripe-types.ts';
import {
  subscriptionPeriodEdit,
  PERIOD_HELPERS,
  subscriptionPeriodHelperEdit,
  subscriptionPeriodHelperModule,
  SUBSCRIPTION_PERIOD_HELPER_RULE,
  SUBSCRIPTION_PERIOD_RULE,
  HELPER_RULES,
  INVOICE_SUBSCRIPTION_HELPER,
  INVOICE_SUBSCRIPTION_HELPER_RULE,
  invoiceSubscriptionHelperEdit,
  type PeriodRareCase,
} from './stripe-subscription-periods.ts';
import {
  PipelineInputError,
  type Finding,
  type Location,
  type Removal,
  type Repository,
  type SourceEdit,
} from './types.ts';

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

// Syntax errors in one source file; analyzeRepository skips such files instead of failing.
export function syntaxErrors(path: string, content: string) {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
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

export function analyzeRepository(
  repository: Repository,
  changes: Removal[],
  provider: ProviderAdapter = STRIPE,
  schemaDefinitions: Record<string, unknown> = {},
  operationReplacements: OperationReplacement[] = [],
  requestPropertyRenames: RequestPropertyRename[] = [],
  propertyMoves: PropertyMove[] = [],
) {
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
      : ts.createSourceFile(name, content, languageVersion, true);
  };
  const program = ts.createProgram([...sources.keys()], options, host);
  const checker = program.getTypeChecker();
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
  const clients = new Set<ts.Symbol>();
  const responses = new Map<ts.Symbol, string>();
  const arrayItems = new Map<ts.Symbol, string>();
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
      const message = `${locations.get(source.fileName)}: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n')}`;
      if (sdkImport.test(source.text)) throw new PipelineInputError(message);
      skippedFiles.push(message);
      continue;
    }
    visit(source);
  }
  const modules = sourceBindings(nodes, checker, resolution.resolve);
  const canonical = modules.canonical;
  const symbol = (node: ts.Node) => canonical(checker.getSymbolAtLocation(node));
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
  const sdk = sdkConstructors({ nodes, checker, provider, symbol, external: resolution.external });
  let classBindings: ReturnType<typeof classClients> | undefined;
  const clientBinding = (node: ts.Expression) =>
    classBindings?.reference(node)?.binding ?? (ts.isIdentifier(node) ? symbol(node) : undefined);
  imports.push(...sdk.imports.map(location));
  function sdkAccess(expression: ts.Expression) {
    const properties: (ts.PropertyAccessExpression & { name: ts.Identifier })[] = [];
    let current = expression;
    while (ts.isPropertyAccessExpression(current) && ts.isIdentifier(current.name)) {
      if (classBindings?.reference(current)) break;
      properties.push(current as ts.PropertyAccessExpression & { name: ts.Identifier });
      current = current.expression;
    }
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
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    )
      return arrayItemForExpression(expression.expression);
    return undefined;
  }
  function arrayIteration(node: ts.CallExpression) {
    const method = node.expression;
    if (
      node.questionDotToken ||
      !ts.isPropertyAccessExpression(method) ||
      method.questionDotToken ||
      !ARRAY_ITERATION_METHODS.has(method.name.text) ||
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
    const schema = arrayItemForExpression(method.expression);
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
    if (ts.isAwaitExpression(expression) && ts.isCallExpression(expression.expression)) {
      const operation = responseCall(expression.expression);
      return operation
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
  for (const declaration of declarations) {
    const binding = clientBinding(declaration.initializer);
    if (binding && clients.has(binding)) add(clients, declaration.name);
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
    const assignArrayItems = (name: ts.Identifier, schema: string | undefined) => {
      const target = symbol(name);
      if (!target || !schema || arrayItems.get(target) === schema) return;
      arrayItems.set(target, schema);
      responseSchemasChanged = true;
    };
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
      assignSchema(declaration.name, arrayItemForExpression(node.expression));
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
  ): SourceEdit['rule'] | undefined {
    const provenance = sourceEvidence(receiver)?.kind;
    // Every subscription-period read (SDK response, webhook payload or Stripe.*-typed value) goes
    // through the generated helper, which reads either API version.
    if (
      provider.packageName === STRIPE.packageName &&
      change.schema === 'subscription' &&
      (webhooks?.origin(receiver) || provenance === 'declared-type' || provenance === 'sdk')
    ) {
      const plan = periodPlan(node);
      const edit = subscriptionPeriodHelperEdit(node, location(node).file, change.id, plan.text);
      if (edit && addEdit(edit)) {
        periodPlans.set(node, plan);
        return edit.rule;
      }
    }
    // Same for invoice.subscription, unless the code expands it (the expand path moved too) or the
    // adapter configures its own move.
    if (
      provider.packageName === STRIPE.packageName &&
      change.schema === 'invoice' &&
      change.property === 'subscription' &&
      !expandsField('subscription') &&
      !propertyMoves.some((move) => move.schema === 'invoice' && move.removed === 'subscription') &&
      (webhooks?.origin(receiver) || provenance === 'declared-type' || provenance === 'sdk')
    ) {
      const edit = invoiceSubscriptionHelperEdit(node, location(node).file, change.id);
      if (edit && addEdit(edit)) return edit.rule;
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
    const declaredType =
      provenance?.kind === 'declared-type' ||
      (provenance?.kind === 'unmapped-sdk' && Boolean(stripeTypes?.expressionSchema(receiver)));
    const sourceClient =
      provenance && 'call' in provenance ? sdkCall(provenance.call)?.client : undefined;
    const classClient = sourceClient && classBindings!.client(sourceClient);
    for (const change of changes) {
      if (tracked && change.schema !== schema) continue;
      if (property !== undefined && change.property !== property) continue;
      if (!tracked && !providerDetected) continue;
      // Unresolved Stripe receivers are flagged only where files work with Stripe; if none are
      // identifiable, every same-named read stays flagged.
      if (!tracked && stripeTypes && stripeFiles.size && !stripeFiles.has(node.getSourceFile()))
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
      const migration = confirmed ? propose(node, receiver, change) : undefined;
      if (property === undefined && !tracked) continue;
      findings.push({
        ...location(node),
        changeId: change.id,
        expression: property === undefined ? '[computed property]' : `.${property}`,
        confidence: confirmed ? 'confirmed' : 'review',
        ...(sourceClient ? helperEvidence(sourceClient, mutated) : {}),
        ...(declaredType ? { declaredType: { schema } } : {}),
        ...(tracked || provenance || iterationCallback(receiver)
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
                ...(migration === SUBSCRIPTION_PERIOD_HELPER_RULE ||
                migration === INVOICE_SUBSCRIPTION_HELPER_RULE
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
          declaredType && confirmed
            ? `Removed ${schema}.${change.property} read on a value declared with a Stripe.* type.`
            : declaredType
              ? 'Declared Stripe type identifies this possible field usage, but the value may be mutated; inspect manually.'
              : confirmed && webhook
                ? `Removed ${schema}.${change.property} read on a Stripe snapshot webhook payload narrowed by event.type. Incoming webhook API version and migration semantics require separate review.`
                : confirmed
                  ? `Removed field read on a statically traced ${provider.id} ${schema} response.`
                  : uncertainMutation
                    ? 'Response or SDK client may be mutated or escape through an alias or call, or come from an optional SDK invocation; inspect manually.'
                    : 'Receiver or property cannot be proven by the supported local analysis; inspect manually.',
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
  // `switch (subscription.status)` or `const unhandled: never = subscription.status`, directly or
  // through one const alias; new enum values on these fields can reach unhandled code.
  const enumChecks: (Location & { schema: string; property: string })[] = [];
  const apiVersionLiterals: { file: string; start: number; end: number; value: string }[] = [];
  for (const node of nodes) {
    let checked = ts.isSwitchStatement(node)
      ? node.expression
      : ts.isVariableDeclaration(node) && node.type?.kind === ts.SyntaxKind.NeverKeyword
        ? node.initializer
        : undefined;
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
    if (schema) enumChecks.push({ ...location(node), schema, property: checked.name.text });
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
  const helperNames = [...Object.values(PERIOD_HELPERS), INVOICE_SUBSCRIPTION_HELPER] as string[];
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
          helperNames.includes(node.text) &&
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
    const moduleRule = edits.some((edit) => edit.rule === SUBSCRIPTION_PERIOD_HELPER_RULE)
      ? SUBSCRIPTION_PERIOD_HELPER_RULE
      : INVOICE_SUBSCRIPTION_HELPER_RULE;
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
    const base = [
      ...shared.filter((segment) => segment !== '.'),
      'stripe-subscription-period',
    ].join('/');
    const taken = new Set(repository.files.map((file) => file.path.replace(/\.[^./]+$/, '')));
    const stem = taken.has(base) ? `${base}-refit` : base;
    edits.push({
      file: `${stem}.${extension}`,
      start: 0,
      end: 0,
      replacement: subscriptionPeriodHelperModule(kind),
      changeId: 'stripe-subscription-period-helper',
      rule: moduleRule,
    });
    for (const file of helperFiles) {
      const source = helperSources.find((entry) => locations.get(entry.fileName) === file)!;
      const used = helperNames.filter((name) =>
        edits.some(
          (edit) =>
            edit.file === file &&
            HELPER_RULES.has(edit.rule!) &&
            edit.replacement.includes(`${name}(`),
        ),
      );
      const relativeImports = source.statements
        .filter(ts.isImportDeclaration)
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
      const declaration =
        kind === 'cjs'
          ? `const { ${used.join(', ')} } = require('${specifier}');`
          : `import { ${used.join(', ')} } from '${specifier}';`;
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
      const anchor = prologue.at(-1)?.getEnd() ?? 0;
      edits.push({
        file,
        start: anchor,
        end: anchor,
        replacement: anchor ? `\n${declaration}` : `${declaration}\n`,
        changeId: 'stripe-subscription-period-helper',
        rule: moduleRule,
      });
    }
  }
  return {
    imports,
    calls,
    sdkCalls,
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
