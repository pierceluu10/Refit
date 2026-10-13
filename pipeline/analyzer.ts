import { resolve } from 'node:path';
import ts from 'typescript-compiler';
import { STRIPE, type ProviderAdapter } from './providers.ts';
import { unsafeBindings } from './mutations.ts';
import { guardedHistoryEdit } from './history-migration.ts';
import { resolveSourceImport } from './source-imports.ts';
import { isObject } from './specifications.ts';
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

function componentReference(reference: unknown) {
  const prefix = '#/components/schemas/';
  if (typeof reference !== 'string' || !reference.startsWith(prefix)) return undefined;
  const pointer = reference.slice(prefix.length);
  if (!pointer || pointer.includes('/') || /~(?![01])/.test(pointer)) return undefined;
  return pointer.replaceAll('~1', '/').replaceAll('~0', '~');
}

function resolvableSchema(schemas: Record<string, unknown>, name: string) {
  const seen = new Set<string>();
  let current = name;
  while (!seen.has(current)) {
    seen.add(current);
    const definition = schemas[current];
    if (!isObject(definition)) return undefined;
    if (['allOf', 'anyOf', 'oneOf'].some((key) => key in definition)) return undefined;
    if (isObject(definition.properties)) return current;
    const referenced = componentReference(definition.$ref);
    if (!referenced) return undefined;
    current = referenced;
  }
  return undefined;
}

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
  return itemReference ? resolvableSchema(schemas, itemReference) : undefined;
}

function referencedPropertySchema(
  schemas: Record<string, unknown>,
  parent: string,
  property: string,
) {
  const canonicalParent = resolvableSchema(schemas, parent);
  if (!canonicalParent) return undefined;
  const definition = schemas[canonicalParent];
  if (!isObject(definition) || !isObject(definition.properties)) return undefined;
  const propertyDefinition = definition.properties[property];
  if (!isObject(propertyDefinition)) return undefined;
  if (['allOf', 'anyOf', 'oneOf'].some((key) => key in propertyDefinition)) return undefined;
  const referenced = componentReference(propertyDefinition.$ref);
  return referenced ? resolvableSchema(schemas, referenced) : undefined;
}

function referencedArrayItemSchema(
  schemas: Record<string, unknown>,
  parent: string,
  property: string,
) {
  const canonicalParent = resolvableSchema(schemas, parent);
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

export function analyzeRepository(
  repository: Repository,
  changes: Removal[],
  provider: ProviderAdapter = STRIPE,
  schemaDefinitions: Record<string, unknown> = {},
) {
  const sources = new Map(
    repository.files.map((file) => [resolve(repository.root, file.path), file.content]),
  );
  const options: ts.CompilerOptions = {
    allowJs: true,
    noLib: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = ts.createCompilerHost(options);
  const resolvedImports = new Map<string, string>();
  host.fileExists = (name) => sources.has(name);
  host.readFile = (name) => sources.get(name);
  host.resolveModuleNames = (names, containingFile) =>
    names.map((name) => {
      const path = resolveSourceImport(name, containingFile, sources);
      if (!path) return undefined;
      resolvedImports.set(`${containingFile}\0${name}`, path);
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
  const constructors = new Set<ts.Symbol>();
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
  const canonical = (value: ts.Symbol | undefined): ts.Symbol | undefined => {
    if (!value || !(value.flags & ts.SymbolFlags.Alias)) return value;
    const binding = value.declarations?.[0];
    if (
      !binding ||
      !ts.isImportSpecifier(binding) ||
      binding.isTypeOnly ||
      binding.parent.parent.isTypeOnly
    )
      return value;
    const target = checker.getAliasedSymbol(value);
    const declaration = target.valueDeclaration;
    const statement =
      declaration && ts.isFunctionDeclaration(declaration)
        ? declaration
        : declaration?.parent.parent;
    const imported = binding.parent.parent.parent;
    if (
      !declaration ||
      !(ts.isVariableDeclaration(declaration) || ts.isFunctionDeclaration(declaration)) ||
      !statement ||
      !(ts.isVariableStatement(statement) || ts.isFunctionDeclaration(statement)) ||
      !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
      !ts.isStringLiteral(imported.moduleSpecifier)
    )
      return value;
    return resolvedImports.get(
      `${imported.getSourceFile().fileName}\0${imported.moduleSpecifier.text}`,
    ) === declaration.getSourceFile().fileName
      ? target
      : value;
  };
  const symbol = (node: ts.Node) => canonical(checker.getSymbolAtLocation(node));
  const contains = (set: Set<ts.Symbol>, node: ts.Node) => {
    const found = symbol(node);
    return found !== undefined && set.has(found);
  };
  const add = (set: Set<ts.Symbol>, node: ts.Node) => {
    const found = symbol(node);
    if (found) set.add(found);
  };
  function visit(node: ts.Node) {
    nodes.push(node);
    ts.forEachChild(node, visit);
  }
  for (const source of program.getSourceFiles()) {
    const diagnostics = program.getSyntacticDiagnostics(source);
    if (diagnostics.length) {
      throw new PipelineInputError(
        `${locations.get(source.fileName)}: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n')}`,
      );
    }
    visit(source);
  }
  for (const node of nodes) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === provider.packageName
    ) {
      imports.push(location(node));
      const clause = node.importClause;
      if (provider.defaultImport && clause?.name && !clause.isTypeOnly)
        add(constructors, clause.name);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.isTypeOnly) {
        for (const binding of clause.namedBindings.elements) {
          if (
            (binding.propertyName ?? binding.name).text === provider.namedExport &&
            !binding.isTypeOnly
          )
            add(constructors, binding.name);
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.some(
        (argument) => ts.isStringLiteral(argument) && argument.text === provider.packageName,
      )
    ) {
      imports.push(location(node));
    }
  }
  function responseCall(node: ts.Node) {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const method = node.expression;
    const resource = method.expression;
    if (
      ts.isPropertyAccessExpression(resource) &&
      ts.isIdentifier(resource.expression) &&
      contains(clients, resource.expression)
    )
      return provider.operations.find(
        (operation) =>
          operation.resource === resource.name.text && operation.method === method.name.text,
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
      return arrayItems.get(binding) ?? arrayItemSchema(schemaDefinitions, responseDefinition);
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const parent = schemaForExpression(expression.expression);
      return parent
        ? referencedArrayItemSchema(schemaDefinitions, parent, expression.name.text)
        : undefined;
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
    if (ts.isIdentifier(expression)) return responses.get(symbol(expression)!);
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
        ? (resolvableSchema(schemaDefinitions, operation.schema) ?? operation.schema)
        : undefined;
    }
    if (ts.isCallExpression(expression)) {
      const operation = responseCall(expression);
      return operation
        ? (resolvableSchema(schemaDefinitions, operation.schema) ?? operation.schema)
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
      if (
        ts.isNewExpression(value) &&
        ts.isIdentifier(value.expression) &&
        contains(constructors, value.expression)
      )
        add(clients, node.name);
      if (ts.isIdentifier(value) && contains(clients, value)) add(clients, node.name);
    }
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
          resolvableSchema(schemaDefinitions, operation.schema) ?? operation.schema,
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
    const operation = responseCall(node);
    if (operation)
      calls.push({ ...location(node), method: `${operation.resource}.${operation.method}` });
  }
  const providerDetected = imports.length > 0 || repository.dependencies.length > 0;
  const escapingClients = new Set<ts.Symbol>();
  for (const node of nodes) {
    const namespaceImport =
      ts.isImportDeclaration(node) &&
      node.importClause?.namedBindings &&
      ts.isNamespaceImport(node.importClause.namedBindings);
    if (!namespaceImport && !ts.isExportDeclaration(node)) continue;
    const module = (node as ts.ImportDeclaration | ts.ExportDeclaration).moduleSpecifier;
    const source =
      module && ts.isStringLiteral(module)
        ? resolvedImports.get(`${node.getSourceFile().fileName}\0${module.text}`)
        : node.getSourceFile().fileName;
    for (const client of clients)
      if (client.valueDeclaration?.getSourceFile().fileName === source) escapingClients.add(client);
    for (const wrapper of wrappers.keys())
      if (wrapper.valueDeclaration?.getSourceFile().fileName === source)
        escapingClients.add(wrapper);
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
  const unsafe = unsafeBindings(
    nodes,
    checker,
    clients,
    origins,
    canonical,
    escapingClients,
    readOnlyCall,
    arrayIteration,
  );
  for (const [response, wrapper] of wrappedResponses) if (unsafe.has(wrapper)) unsafe.add(response);
  function propose(node: ts.Node, receiver: ts.Expression, change: Removal) {
    if (provider !== STRIPE) {
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
    if (ts.isIdentifier(receiver) && contains(clients, receiver)) return;
    const schema = schemaForExpression(receiver);
    const tracked = schema !== undefined;
    for (const change of changes) {
      if (tracked && change.schema !== schema) continue;
      if (property !== undefined && change.property !== property) continue;
      if (!tracked && !providerDetected) continue;
      const immediateCall =
        ts.isParenthesizedExpression(receiver) &&
        ts.isAwaitExpression(receiver.expression) &&
        ts.isCallExpression(receiver.expression.expression)
          ? receiver.expression.expression
          : undefined;
      const immediateResource =
        immediateCall && ts.isPropertyAccessExpression(immediateCall.expression)
          ? immediateCall.expression.expression
          : undefined;
      const responseSymbol = responseBinding(receiver);
      const uncertainMutation =
        (responseSymbol !== undefined && unsafe.has(responseSymbol)) ||
        (immediateResource &&
          ts.isPropertyAccessExpression(immediateResource) &&
          unsafe.has(symbol(immediateResource.expression)!));
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
            ? 'Response or SDK client may be mutated or escape through an alias or call; inspect manually.'
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
    findings,
    providerDetected,
    stripeDetected: provider.id === 'stripe' && providerDetected,
    edits,
  };
}
