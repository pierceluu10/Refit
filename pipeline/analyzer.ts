import { resolve } from 'node:path';
import ts from 'typescript-compiler';
import { STRIPE, validSdkResourcePath, type ProviderAdapter } from './providers.ts';
import { unsafeBindings } from './mutations.ts';
import { declaredApiVersions } from './declared-api-versions.ts';
import { guardedHistoryEdit } from './history-migration.ts';
import { createSourceImportResolver } from './source-imports.ts';
import { sourceBindings } from './source-modules.ts';
import { sdkConstructors } from './sdk-constructors.ts';
import { componentReference, isObject, resolvableComponentSchema } from './specifications.ts';
import type { OperationReplacement } from './provider-operation-replacements.ts';
import type { RequestPropertyRename } from './provider-request-renames.ts';
import { requestPropertyEdit } from './request-migration.ts';
import { StripeTypes } from './stripe-types.ts';
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
  const sdkCalls: (Location & { resource: string; method: string; expression: string })[] = [];
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
    provider.id === STRIPE.id
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
  // Bindings whose properties the code assigns, deletes or Object.assigns into.
  const written = new Set<ts.Symbol>();
  const rootSymbol = (expression: ts.Expression): ts.Symbol | undefined =>
    ts.isIdentifier(expression)
      ? symbol(expression)
      : ts.isPropertyAccessExpression(expression) ||
          ts.isElementAccessExpression(expression) ||
          ts.isParenthesizedExpression(expression) ||
          ts.isNonNullExpression(expression)
        ? rootSymbol(expression.expression)
        : undefined;
  for (const node of nodes) {
    const target =
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
        ? node.left
        : ts.isDeleteExpression(node)
          ? node.expression
          : ts.isCallExpression(node) &&
              node.expression.getText() === 'Object.assign' &&
              node.arguments.length > 0
            ? node.arguments[0]
            : undefined;
    const updated =
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
        ? node.operand
        : undefined;
    const writtenSymbol = (target ?? updated) ? rootSymbol((target ?? updated)!) : undefined;
    if (writtenSymbol) written.add(writtenSymbol);
  }
  // A write through an alias (`const alias = sub; alias.x = 1`) writes the original too.
  const aliasEdges: [ts.Symbol, ts.Symbol][] = [];
  for (const node of nodes) {
    const pair =
      ts.isVariableDeclaration(node) && node.initializer
        ? ([node.name, node.initializer] as const)
        : ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ? ([node.left, node.right] as const)
          : undefined;
    if (!pair || !ts.isIdentifier(pair[0])) continue;
    const [left, right] = [symbol(pair[0]), rootSymbol(pair[1] as ts.Expression)];
    if (left && right) aliasEdges.push([left, right]);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [left, right] of aliasEdges)
      if (written.has(left) !== written.has(right)) {
        written.add(left);
        written.add(right);
        changed = true;
      }
  }
  const statedType = (expression: ts.Expression): boolean => {
    if (!stripeTypes) return false;
    if (stripeTypes.expressionSchema(expression)) return true;
    if (ts.isIdentifier(expression)) {
      const target = symbol(expression);
      return Boolean(target && stripeTypes.typed.has(target));
    }
    return ts.isPropertyAccessExpression(expression) ||
      ts.isElementAccessExpression(expression) ||
      ts.isParenthesizedExpression(expression) ||
      ts.isNonNullExpression(expression)
      ? statedType(expression.expression)
      : false;
  };
  const contains = (set: Set<ts.Symbol>, node: ts.Node) => {
    const found = symbol(node);
    return found !== undefined && set.has(found);
  };
  const add = (set: Set<ts.Symbol>, node: ts.Node) => {
    const found = symbol(node);
    if (found) set.add(found);
  };
  const sdk = sdkConstructors({ nodes, checker, provider, symbol, external: resolution.external });
  imports.push(...sdk.imports.map(location));
  function sdkAccess(expression: ts.Expression) {
    const properties: (ts.PropertyAccessExpression & { name: ts.Identifier })[] = [];
    let current = expression;
    while (ts.isPropertyAccessExpression(current) && ts.isIdentifier(current.name)) {
      properties.push(current as ts.PropertyAccessExpression & { name: ts.Identifier });
      current = current.expression;
    }
    if (!ts.isIdentifier(current) || !contains(clients, current)) return;
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
      expression: `${access.client.text}.${resource}.${method}`,
      client: access.client,
      start: access.properties[0].name.getStart(),
      optional:
        Boolean(node.questionDotToken) ||
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
    if (ts.isIdentifier(expression)) {
      const target = symbol(expression)!;
      return responses.get(target) ?? stripeTypes?.typed.get(target);
    }
    const stated = stripeTypes?.expressionSchema(expression);
    if (stated) return stated;
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
      return schemaForExpression(expression.expression);
    if (ts.isAwaitExpression(expression) && ts.isCallExpression(expression.expression)) {
      const operation = responseCall(expression.expression);
      return operation
        ? (resolvableComponentSchema(schemaDefinitions, operation.schema) ?? operation.schema)
        : undefined;
    }
    return undefined;
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
    if (sdk)
      sdkCalls.push({
        ...location(node),
        resource: sdk.resource,
        method: sdk.method,
        expression: sdk.expression,
      });
    const operation = responseCall(node);
    if (operation)
      calls.push({
        ...location(node),
        method: `${operation.resource}.${operation.method}`,
        ...(operation.operationId ? { operationId: operation.operationId } : {}),
      });
  }
  const providerDetected = imports.length > 0 || repository.dependencies.length > 0;
  const escapingClients = new Set<ts.Symbol>();
  for (const binding of [...clients, ...wrappers.keys()])
    if (
      binding.valueDeclaration &&
      (modules.escapingSources.has(binding.valueDeclaration.getSourceFile().fileName) ||
        (resolution.unverified && Boolean(modules.clientExport(binding))))
    )
      escapingClients.add(binding);
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
  const mutationNodes = nodes.filter((node) => !modules.safeNodes.has(node));
  const unsafeConstructors = unsafeBindings(
    mutationNodes,
    checker,
    sdk.constructors,
    new Map(),
    canonical,
  );
  for (const [node, binding] of [
    ...declarations.map((node) => [node.initializer, symbol(node.name)] as const),
    ...[...modules.inlineDefaults].map(([node, binding]) => [node.expression, binding] as const),
  ]) {
    const creation = sdk.creation(node);
    if (
      binding &&
      creation &&
      (creation.arguments?.some(ts.isSpreadElement) ||
        unsafeConstructors.has(sdk.binding(creation)!))
    )
      initialUnsafe.add(binding);
  }
  for (const [response, origin] of origins)
    if (sdkCall(origin)?.optional) initialUnsafe.add(response);
  const primitiveValue = (node: ts.Node): boolean => {
    if (!stripeTypes) return false;
    if (
      (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
      [
        ts.SyntaxKind.StringKeyword,
        ts.SyntaxKind.NumberKeyword,
        ts.SyntaxKind.BooleanKeyword,
      ].includes(node.type.kind)
    )
      return true;
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
  );
  for (const [response, wrapper] of wrappedResponses) if (unsafe.has(wrapper)) unsafe.add(response);
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
        edit.status === 'editable' && !unsafe.has(symbol(call.client)!) && !call.optional;
      findings.push({
        ...location(node),
        changeId: rule.id,
        expression: `${rule.resource}.${rule.method} argument[${rule.argumentIndex}].${rule.removed}`,
        confidence: confirmed ? 'confirmed' : 'review',
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
    const confirmed = !unsafe.has(symbol(call.client)!) && !call.optional;
    findings.push({
      ...location(node),
      changeId: replacement.id,
      expression: `${operation.resource}.${operation.method}`,
      confidence: confirmed ? 'confirmed' : 'review',
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
  function propose(node: ts.Node, receiver: ts.Expression, change: Removal) {
    if (provider.id !== STRIPE.id) {
      const rename = provider.propertyRenames?.find(
        (candidate) => candidate.schema === change.schema && candidate.removed === change.property,
      );
      if (
        rename &&
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === change.property
      ) {
        const start = node.name.getStart();
        if (!edits.some((edit) => edit.file === location(node).file && edit.start === start))
          edits.push({
            file: location(node).file,
            start,
            end: node.name.getEnd(),
            replacement: rename.replacement,
            changeId: change.id,
          });
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
  function record(node: ts.Node, receiver: ts.Expression, property: string | undefined) {
    if (
      property !== undefined &&
      ARRAY_ITERATION_METHODS.has(property) &&
      arrayItemForExpression(receiver)
    )
      return;
    // SDK resources are not response fields, even when their names match a removal.
    if (sdkAccess(receiver)) return;
    const schema = schemaForExpression(receiver);
    const tracked = schema !== undefined;
    for (const change of changes) {
      if (tracked && change.schema !== schema) continue;
      if (property !== undefined && change.property !== property) continue;
      if (!tracked && !providerDetected) continue;
      // Unresolved Stripe receivers are flagged only where files work with Stripe; if none are
      // identifiable, every same-named read stays flagged.
      if (!tracked && stripeTypes && stripeFiles.size && !stripeFiles.has(node.getSourceFile()))
        continue;
      const immediateCall =
        ts.isParenthesizedExpression(receiver) &&
        ts.isAwaitExpression(receiver.expression) &&
        ts.isCallExpression(receiver.expression.expression)
          ? receiver.expression.expression
          : undefined;
      const immediateSdk = immediateCall ? sdkCall(immediateCall) : undefined;
      const responseSymbol = responseBinding(receiver);
      // A stated Stripe type is the evidence for what the object is; only a write to it (or an
      // optional SDK call) leaves it uncertain. Traced responses keep the escape analysis.
      const uncertainMutation = statedType(receiver)
        ? (responseSymbol !== undefined && written.has(responseSymbol)) ||
          Boolean(immediateSdk?.optional)
        : (responseSymbol !== undefined && unsafe.has(responseSymbol)) ||
          (immediateSdk && (immediateSdk.optional || unsafe.has(symbol(immediateSdk.client)!)));
      const confirmed = Boolean(
        tracked && !uncertainMutation && property !== undefined && change.schema === schema,
      );
      if (confirmed) propose(node, receiver, change);
      if (property === undefined && !tracked) continue;
      findings.push({
        ...location(node),
        changeId: change.id,
        expression: property === undefined ? '[computed property]' : `.${property}`,
        confidence: confirmed ? 'confirmed' : 'review',
        reason: confirmed
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
  return {
    imports,
    calls,
    sdkCalls,
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
          : ts.isExportAssignment(node.parent)
            ? modules.inlineDefaults.get(node.parent)
            : undefined,
      sdkCall,
      symbol,
      canonical,
      location,
    }),
    findings,
    sourceWarnings: resolution.warnings,
    providerDetected,
    stripeDetected: provider.id === 'stripe' && providerDetected,
    edits,
    skippedFiles,
  };
}
