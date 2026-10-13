import { resolve } from 'node:path';
import ts from 'typescript-compiler';
import {
  type DeprecationModel,
  type DeprecationSnapshot,
  readDeprecationSnapshot,
} from './deprecation-snapshots.ts';
import { unsafeBindings } from './mutations.ts';
import { applySourceEdits, renderPatch } from './patches.ts';
import { type ProviderAdapter, readProviderAdapter } from './providers.ts';
import { readRepository } from './repository.ts';
import { resolveSourceImport } from './source-imports.ts';
import { digest } from './specifications.ts';
import { PipelineInputError, type Location, type Repository, type SourceEdit } from './types.ts';

export type DeprecatedModelFinding = {
  kind: 'deprecated-model';
  provider: 'openai' | 'anthropic';
  modelId: string;
  status: 'deprecated' | 'retired';
  replacement: string | null;
  shutdownDate: string | null;
  location: { file: string; line: number; column: number };
  call: string;
  confidence: 'confirmed' | 'needs-review';
  reason: string;
};

type Candidate = {
  model: DeprecationModel;
  node: ts.Node;
  locationNode: ts.Node;
  reason: string | null;
};

const VARIABLE_REASON =
  'The model ID flows through a variable or configuration value; verify its runtime value manually.';
const ENV_REASON =
  'The model ID is combined with an environment lookup; the runtime value cannot be proven.';
const FUNCTION_ARGUMENT_REASON =
  'The model ID flows through a function argument; not every runtime caller can be proven.';
const TEMPLATE_REASON =
  'The model ID is written as a template string; only direct string literals are confirmed.';
const SPREAD_REASON =
  'The model property comes from an object spread; property order and runtime values need review.';
const COMPUTED_REASON =
  'The model property uses a computed key; the runtime key and value need review.';
const DUPLICATE_REASON =
  'The options object contains multiple model properties; runtime property order needs review.';
const OPTIONS_REASON =
  'The call options are not an inline object literal; mutation and runtime construction need review.';
const MUTATION_REASON =
  'The provider SDK client may be mutated or escape through an alias, export, or call; inspect manually.';

function encodeStringLiteral(value: string, original: string) {
  const quote = original.startsWith("'") ? "'" : '"';
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll(quote, `\\${quote}`)
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  return `${quote}${escaped}${quote}`;
}

export function scanDeprecatedModels(
  repository: Repository,
  provider: ProviderAdapter,
  snapshot: DeprecationSnapshot,
) {
  if (provider.id !== snapshot.provider)
    throw new PipelineInputError(
      `Deprecation snapshot provider ${snapshot.provider} does not match adapter ${provider.id}.`,
    );
  const models = new Map(snapshot.models.map((model) => [model.id, model]));
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
  const nodes: ts.Node[] = [];
  function visit(node: ts.Node) {
    nodes.push(node);
    ts.forEachChild(node, visit);
  }
  for (const source of program.getSourceFiles()) {
    const diagnostics = program.getSyntacticDiagnostics(source);
    if (diagnostics.length)
      throw new PipelineInputError(
        `${locations.get(source.fileName)}: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n')}`,
      );
    visit(source);
  }

  const constructors = new Set<ts.Symbol>();
  for (const node of nodes) {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== provider.packageName
    )
      continue;
    const clause = node.importClause;
    if (provider.defaultImport && clause?.name && !clause.isTypeOnly)
      add(constructors, clause.name);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.isTypeOnly)
      for (const binding of clause.namedBindings.elements)
        if (
          (binding.propertyName ?? binding.name).text === provider.namedExport &&
          !binding.isTypeOnly
        )
          add(constructors, binding.name);
  }
  const declarations = nodes.filter(
    (node): node is ts.VariableDeclaration & { name: ts.Identifier; initializer: ts.Expression } =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      Boolean(node.initializer) &&
      ts.isVariableDeclarationList(node.parent) &&
      Boolean(node.parent.flags & ts.NodeFlags.Const),
  );
  const clients = new Set<ts.Symbol>();
  let previousSize = -1;
  while (previousSize !== clients.size) {
    previousSize = clients.size;
    for (const declaration of declarations) {
      const value = declaration.initializer;
      if (
        ts.isNewExpression(value) &&
        ts.isIdentifier(value.expression) &&
        contains(constructors, value.expression)
      )
        add(clients, declaration.name);
      if (ts.isIdentifier(value) && contains(clients, value)) add(clients, declaration.name);
    }
  }
  const initiallyUnsafe = new Set<ts.Symbol>();
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
      if (client.valueDeclaration?.getSourceFile().fileName === source) initiallyUnsafe.add(client);
  }
  const unsafe = unsafeBindings(nodes, checker, clients, new Map(), canonical, initiallyUnsafe);

  const propertyName = (property: ts.ObjectLiteralElementLike) => {
    if (
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      property.name &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    )
      return property.name.text;
  };
  const variableDeclaration = (expression: ts.Expression) => {
    if (!ts.isIdentifier(expression)) return;
    const declaration = symbol(expression)?.valueDeclaration;
    return declaration && ts.isVariableDeclaration(declaration) ? declaration : undefined;
  };
  const callSites = (parameter: ts.ParameterDeclaration) => {
    const owner = parameter.parent;
    if (!ts.isFunctionDeclaration(owner) || !owner.name) return [];
    const ownerSymbol = symbol(owner.name);
    const index = owner.parameters.indexOf(parameter);
    return nodes
      .filter(
        (node): node is ts.CallExpression =>
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          symbol(node.expression) === ownerSymbol &&
          Boolean(node.arguments[index]),
      )
      .map((call) => call.arguments[index]);
  };
  const candidates = (
    expression: ts.Expression,
    reason: string | null,
    seen = new Set<ts.Symbol>(),
    locationNode: ts.Node = expression,
  ): Candidate[] => {
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      const model = models.get(expression.text);
      return model
        ? [
            {
              model,
              node: expression,
              locationNode,
              reason:
                reason ?? (ts.isNoSubstitutionTemplateLiteral(expression) ? TEMPLATE_REASON : null),
            },
          ]
        : [];
    }
    if (ts.isTemplateExpression(expression)) {
      const exact = expression.getText().slice(1, -1);
      const model = models.get(exact);
      return model
        ? [{ model, node: expression.head, locationNode, reason: reason ?? TEMPLATE_REASON }]
        : expression.templateSpans.flatMap((span) =>
            candidates(span.expression, reason ?? TEMPLATE_REASON, seen, locationNode),
          );
    }
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isAwaitExpression(expression)
    )
      return candidates(expression.expression, reason, seen, locationNode);
    if (ts.isConditionalExpression(expression))
      return [
        ...candidates(expression.whenTrue, reason ?? VARIABLE_REASON, seen, locationNode),
        ...candidates(expression.whenFalse, reason ?? VARIABLE_REASON, seen, locationNode),
      ];
    if (ts.isBinaryExpression(expression))
      return [
        ...candidates(
          expression.left,
          reason ?? (expression.getText().includes('process.env') ? ENV_REASON : VARIABLE_REASON),
          seen,
          locationNode,
        ),
        ...candidates(
          expression.right,
          reason ?? (expression.getText().includes('process.env') ? ENV_REASON : VARIABLE_REASON),
          seen,
          locationNode,
        ),
      ];
    if (ts.isIdentifier(expression)) {
      return symbolCandidates(symbol(expression), reason, seen, locationNode);
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const declaration = variableDeclaration(expression.expression);
      if (!declaration?.initializer || !ts.isObjectLiteralExpression(declaration.initializer))
        return [];
      const property = declaration.initializer.properties.find(
        (candidate) => propertyName(candidate) === expression.name.text,
      );
      if (property && ts.isPropertyAssignment(property))
        return candidates(property.initializer, reason ?? VARIABLE_REASON, seen, locationNode);
      return [];
    }
    return [];
  };
  const symbolCandidates = (
    current: ts.Symbol | undefined,
    reason: string | null,
    seen: Set<ts.Symbol>,
    locationNode: ts.Node,
  ): Candidate[] => {
    current = canonical(current);
    const declaration = current?.valueDeclaration;
    if (!declaration || !current || seen.has(current)) return [];
    const nextSeen = new Set(seen).add(current);
    if (ts.isVariableDeclaration(declaration) && declaration.initializer)
      return candidates(declaration.initializer, reason ?? VARIABLE_REASON, nextSeen, locationNode);
    if (ts.isParameter(declaration))
      return callSites(declaration).flatMap((argument) =>
        candidates(argument, reason ?? FUNCTION_ARGUMENT_REASON, nextSeen, locationNode),
      );
    return [];
  };
  const objectCandidates = (
    object: ts.ObjectLiteralExpression,
    argument: string,
    outerReason: string | null,
    locationOverride?: ts.Node,
  ) => {
    const output: Candidate[] = [];
    const matchingProperties = object.properties.filter((property) => {
      if (propertyName(property) === argument) return true;
      return (
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        ts.isComputedPropertyName(property.name) &&
        (ts.isStringLiteral(property.name.expression) ||
          ts.isNoSubstitutionTemplateLiteral(property.name.expression)) &&
        property.name.expression.text === argument
      );
    });
    const objectReason =
      outerReason ??
      (object.properties.some(ts.isSpreadAssignment)
        ? SPREAD_REASON
        : matchingProperties.length > 1
          ? DUPLICATE_REASON
          : null);
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        const declaration = variableDeclaration(property.expression);
        if (declaration?.initializer && ts.isObjectLiteralExpression(declaration.initializer))
          output.push(
            ...objectCandidates(
              declaration.initializer,
              argument,
              objectReason ?? SPREAD_REASON,
              locationOverride ?? property,
            ),
          );
        continue;
      }
      const computed =
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        ts.isComputedPropertyName(property.name);
      const matchesComputed =
        computed &&
        ts.isComputedPropertyName(property.name) &&
        (ts.isStringLiteral(property.name.expression) ||
          ts.isNoSubstitutionTemplateLiteral(property.name.expression)) &&
        property.name.expression.text === argument;
      if (propertyName(property) !== argument && !matchesComputed) continue;
      const propertyReason = objectReason ?? (computed ? COMPUTED_REASON : null);
      if (ts.isPropertyAssignment(property))
        output.push(
          ...candidates(
            property.initializer,
            propertyReason,
            new Set(),
            locationOverride ?? property.initializer,
          ),
        );
      else if (ts.isShorthandPropertyAssignment(property))
        output.push(
          ...symbolCandidates(
            checker.getShorthandAssignmentValueSymbol(property),
            propertyReason,
            new Set(),
            locationOverride ?? property.name,
          ),
        );
    }
    return output;
  };
  const operationCall = (node: ts.CallExpression) => {
    if (!ts.isPropertyAccessExpression(node.expression)) return;
    const method = node.expression;
    const resourceParts: string[] = [];
    let receiver: ts.Expression = method.expression;
    while (ts.isPropertyAccessExpression(receiver)) {
      resourceParts.unshift(receiver.name.text);
      receiver = receiver.expression;
    }
    if (!ts.isIdentifier(receiver) || !contains(clients, receiver)) return;
    const operation = provider.operations.find(
      (candidate) =>
        candidate.resource === resourceParts.join('.') && candidate.method === method.name.text,
    );
    return operation ? { operation, receiver } : undefined;
  };

  const findings: DeprecatedModelFinding[] = [];
  const edits: SourceEdit[] = [];
  const findingKeys = new Set<string>();
  for (const node of nodes) {
    if (!ts.isCallExpression(node)) continue;
    const traced = operationCall(node);
    if (!traced) continue;
    for (const check of traced.operation.requestChecks ?? []) {
      if (check.kind !== 'model-id' || !node.arguments[0]) continue;
      const firstArgument = node.arguments[0];
      let found: Candidate[] = [];
      if (ts.isObjectLiteralExpression(firstArgument))
        found = objectCandidates(firstArgument, check.argument, null);
      else {
        const declaration = variableDeclaration(firstArgument);
        if (declaration?.initializer && ts.isObjectLiteralExpression(declaration.initializer))
          found = objectCandidates(
            declaration.initializer,
            check.argument,
            OPTIONS_REASON,
            firstArgument,
          );
        else found = candidates(firstArgument, OPTIONS_REASON);
      }
      for (const candidate of found) {
        const clientUnsafe = unsafe.has(symbol(traced.receiver)!);
        const reason = clientUnsafe ? MUTATION_REASON : candidate.reason;
        const confidence = reason ? 'needs-review' : 'confirmed';
        const modelLocation = location(candidate.locationNode);
        const key = `${modelLocation.file}:${modelLocation.line}:${modelLocation.column}:${candidate.model.id}:${confidence}`;
        if (findingKeys.has(key)) continue;
        findingKeys.add(key);
        findings.push({
          kind: 'deprecated-model',
          provider: snapshot.provider,
          modelId: candidate.model.id,
          status: candidate.model.status,
          replacement: candidate.model.replacement,
          shutdownDate: candidate.model.shutdownDate,
          location: modelLocation,
          call: node.expression.getText(),
          confidence,
          reason: reason ?? '',
        });
        if (confidence === 'confirmed' && candidate.model.replacement !== null)
          edits.push({
            file: modelLocation.file,
            start: candidate.node.getStart(),
            end: candidate.node.getEnd(),
            replacement: encodeStringLiteral(candidate.model.replacement, candidate.node.getText()),
            changeId: `deprecated-model:${candidate.model.id}`,
          });
      }
    }
  }
  return { findings, edits };
}

export function proposeDeprecatedModelPatch(
  repository: Repository,
  provider: ProviderAdapter,
  snapshot: DeprecationSnapshot,
) {
  const scanned = scanDeprecatedModels(repository, provider, snapshot);
  const modified = {
    ...repository,
    files: repository.files.map((file) => ({
      ...file,
      content: applySourceEdits(
        file.content,
        scanned.edits.filter((edit) => edit.file === file.path),
      ),
    })),
  };
  const remaining = scanDeprecatedModels(modified, provider, snapshot).findings;
  return {
    generator: 'deterministic' as const,
    summary: 'Replace directly written deprecated model IDs with snapshot replacements.',
    status: scanned.edits.length ? ('proposed' as const) : ('unsupported' as const),
    edits: scanned.edits.length,
    unresolvedFindings: remaining.length,
    remainingFindings: remaining,
    diff: renderPatch(repository, scanned.edits),
    validation: 'not-run' as const,
    warnings: [
      'Review required: replacement models can differ in behavior, capabilities, pricing, limits, and output; test the migration before release.',
      'Only direct string literals with a snapshot replacement are changed. Dynamic values, uncertain clients, and models without replacements require manual review.',
      'Unresolved findings come from rescanning the proposed code; disappearing findings do not prove behavioral compatibility.',
      'Patch contains source code. Review it for sensitive content before sharing.',
    ],
    source: snapshot.source.url,
  };
}

export async function runDeprecationPipeline(options: {
  repository: string;
  providerConfig: string;
  snapshot: string;
  proposePatch?: boolean;
}) {
  const provider = await readProviderAdapter(options.providerConfig);
  const [repository, snapshot] = await Promise.all([
    readRepository(options.repository, provider.packageName),
    readDeprecationSnapshot(options.snapshot),
  ]);
  const scanned = scanDeprecatedModels(repository, provider, snapshot);
  const repositoryHash = digest(
    JSON.stringify({
      files: repository.files,
      dependencies: repository.dependencies,
      lockfiles: repository.lockfiles,
    }),
  );
  return {
    formatVersion: 1,
    provider: snapshot.provider,
    adapter: provider,
    runId: digest(
      `${snapshot.source.sha256}:${repositoryHash}:${digest(JSON.stringify(provider))}`,
    ),
    status: scanned.findings.some((finding) => finding.confidence === 'confirmed')
      ? ('affected' as const)
      : scanned.findings.length
        ? ('needs-review' as const)
        : ('no-deprecated-model-signal' as const),
    snapshot: {
      hash: snapshot.source.sha256,
      source: snapshot.source.url,
      retrievedAt: snapshot.source.retrievedAt,
    },
    repository: {
      hash: repositoryHash,
      scannedFiles: repository.files.length,
      dependencies: repository.dependencies,
      lockfiles: repository.lockfiles,
    },
    findings: scanned.findings,
    warnings: repository.warnings,
    patch: options.proposePatch
      ? proposeDeprecatedModelPatch(repository, provider, snapshot)
      : {
          status: 'not-generated' as const,
          reason:
            'This pipeline produces deprecation evidence. Request a deterministic patch to replace confirmed literals.',
        },
  };
}
