import { digest, isObject, resolvableComponentSchema } from './specifications.ts';
import type { ProviderAdapter } from './providers.ts';
import { PipelineInputError, type Finding } from './types.ts';
import type { MappedSdkCall } from './provider-operations.ts';
import {
  isJsonMediaType,
  isRemovedOperationChange,
  listOpenApiOperations,
  successfulResponseSchema,
  type OpenApiOperation,
} from './openapi-operations.ts';

const MAX_CONTRACT_DEPTH = 64;
const MAX_CONTRACT_NODES = 20_000;
const OPERATION_ANNOTATIONS = new Set([
  'operationId',
  'summary',
  'description',
  'tags',
  'deprecated',
  'externalDocs',
]);
const PARAMETER_LOCATIONS = new Set(['path', 'query', 'header', 'cookie']);
const UNSUPPORTED_REFERENCE_KEYS = new Set([
  '$id',
  '$anchor',
  '$dynamicAnchor',
  '$dynamicRef',
  '$recursiveAnchor',
  '$recursiveRef',
]);

export interface OperationReplacement {
  id: string;
  resource: string;
  method: string;
  schema: string;
  operationId: string;
  path: string;
  httpMethod: string;
  replacementResource: string;
  replacementMethod: string;
  replacementOperationId: string;
  replacementPath: string;
  contractHash: string;
}

export interface OperationReplacementEvidence extends OperationReplacement {
  usages: MappedSdkCall[];
  supported: boolean;
}

function contractValue(value: unknown, document: Record<string, unknown>) {
  let nodes = 0;
  function visit(value: unknown, references: Set<string>, depth: number): unknown {
    if (++nodes > MAX_CONTRACT_NODES || depth > MAX_CONTRACT_DEPTH)
      throw new PipelineInputError(
        'Endpoint replacement contract exceeds the reference traversal limit.',
      );
    if (Array.isArray(value)) return value.map((entry) => visit(entry, references, depth + 1));
    if (!isObject(value)) return value;
    if (
      Object.keys(value).some((key) => UNSUPPORTED_REFERENCE_KEYS.has(key) && !isObject(value[key]))
    )
      throw new PipelineInputError(
        'Endpoint replacements do not resolve schema identifiers, anchors or dynamic references; review this contract manually.',
      );
    if (Object.hasOwn(value, '$ref')) {
      const reference = value.$ref;
      if (
        typeof reference !== 'string' ||
        !reference.startsWith('#/components/') ||
        Object.keys(value).length !== 1
      )
        throw new PipelineInputError(
          'Endpoint replacements require local component references without sibling fields.',
        );
      let target: unknown = document;
      for (const segment of reference
        .slice(2)
        .split('/')
        .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))) {
        if (!isObject(target) || !Object.hasOwn(target, segment))
          throw new PipelineInputError(
            `Endpoint replacement has an unresolved reference: ${reference}`,
          );
        target = target[segment];
      }
      if (references.has(reference)) return { $ref: reference };
      return {
        $ref: reference,
        definition: visit(target, new Set([...references, reference]), depth + 1),
      };
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, visit(value[key], references, depth + 1)]),
    );
  }
  return visit(value, new Set(), 0);
}

function contractSignature(endpoint: OpenApiOperation, document: Record<string, unknown>) {
  if (endpoint.pathItem.$ref)
    throw new PipelineInputError('Endpoint replacement path-item references require review.');
  const operation = Object.fromEntries(
    Object.entries(endpoint.operation).filter(([key]) => !OPERATION_ANNOTATIONS.has(key)),
  );
  const components = isObject(document.components) ? document.components : {};
  const pathParameters = validatePathParameters(endpoint, document);
  return JSON.stringify(
    contractValue(
      {
        openapi: document.openapi,
        jsonSchemaDialect: document.jsonSchemaDialect ?? null,
        httpMethod: endpoint.httpMethod,
        pathParameters,
        pathItemParameters: endpoint.pathItem.parameters ?? [],
        pathItemExtensions: Object.fromEntries(
          Object.entries(endpoint.pathItem).filter(([key]) => key.startsWith('x-')),
        ),
        operation: {
          ...operation,
          servers:
            endpoint.operation.servers ?? endpoint.pathItem.servers ?? document.servers ?? [],
          security: endpoint.operation.security ?? document.security ?? [],
        },
        securitySchemes: components.securitySchemes ?? {},
      },
      document,
    ),
  );
}

function validatePathParameters(endpoint: OpenApiOperation, document: Record<string, unknown>) {
  const names = [...endpoint.path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
  if (
    new Set(names).size !== names.length ||
    /[{}]/.test(endpoint.path.replace(/\{([^{}]+)\}/g, ''))
  )
    throw new PipelineInputError(
      'Endpoint replacements require unambiguous path parameter templates.',
    );
  const effective = new Map<string, Record<string, unknown>>();
  for (const parameters of [
    endpoint.pathItem.parameters ?? [],
    endpoint.operation.parameters ?? [],
  ]) {
    if (!Array.isArray(parameters))
      throw new PipelineInputError('Endpoint replacement parameters must be arrays.');
    const seen = new Set<string>();
    for (const parameter of parameters) {
      let definition = contractValue(parameter, document);
      while (isObject(definition) && Object.hasOwn(definition, '$ref'))
        definition = definition.definition;
      if (
        !isObject(definition) ||
        typeof definition.name !== 'string' ||
        !definition.name.trim() ||
        typeof definition.in !== 'string' ||
        !PARAMETER_LOCATIONS.has(definition.in) ||
        isObject(definition.schema) === isObject(definition.content)
      )
        throw new PipelineInputError(
          'Endpoint replacements require explicit, resolvable parameter definitions.',
        );
      const key = JSON.stringify([definition.in, definition.name]);
      if (seen.has(key))
        throw new PipelineInputError(
          'Endpoint replacement parameters cannot contain duplicate name/location entries.',
        );
      seen.add(key);
      effective.set(key, definition);
    }
  }
  const pathParameters = [...effective.values()].filter((parameter) => parameter.in === 'path');
  if (
    pathParameters.length !== names.length ||
    pathParameters.some(
      (parameter) => parameter.required !== true || !names.includes(String(parameter.name)),
    )
  )
    throw new PipelineInputError(
      'Endpoint replacements require every path template parameter to have a matching required path parameter definition.',
    );
  return names;
}

function assertResponse(
  endpoint: OpenApiOperation,
  schemas: Record<string, unknown>,
  schema: string,
) {
  const responses = endpoint.operation.responses;
  const success = isObject(responses)
    ? Object.entries(responses).filter(([status]) => /^2\d\d$/.test(status))
    : [];
  const response = success[0]?.[1];
  if (
    success.length !== 1 ||
    !isObject(response) ||
    !isObject(response.content) ||
    !Object.keys(response.content).every(isJsonMediaType) ||
    successfulResponseSchema(endpoint.operation, schemas) !== schema
  )
    throw new PipelineInputError(
      'Endpoint replacements require one JSON success response mapped to the same supported component schema.',
    );
}

export function validateOperationReplacements(
  provider: ProviderAdapter,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  beforeSchemas: Record<string, unknown>,
  afterSchemas: Record<string, unknown>,
): OperationReplacement[] {
  const baseline = listOpenApiOperations(before);
  const revised = listOpenApiOperations(after);
  const replacements: OperationReplacement[] = [];
  for (const rule of provider.operationReplacements ?? []) {
    const mapping = provider.operations.find(
      (operation) => operation.resource === rule.resource && operation.method === rule.method,
    );
    if (!mapping?.operationId)
      throw new PipelineInputError(
        'Endpoint replacement source needs an OpenAPI operationId mapping.',
      );
    const sources = baseline.filter(
      (endpoint) => endpoint.operation.operationId === mapping.operationId,
    );
    if (sources.length !== 1)
      throw new PipelineInputError(
        `Endpoint replacement source ${mapping.operationId} must resolve exactly once in the before contract.`,
      );
    const source = sources[0];
    if (
      revised.some(
        (endpoint) => endpoint.path === source.path && endpoint.httpMethod === source.httpMethod,
      )
    )
      continue;
    const targets = revised.filter(
      (endpoint) => endpoint.operation.operationId === rule.replacementOperationId,
    );
    if (targets.length !== 1)
      throw new PipelineInputError(
        `Endpoint replacement ${rule.replacementOperationId} must resolve exactly once in the after contract.`,
      );
    const target = targets[0];
    if (
      baseline.some(
        (endpoint) => endpoint.path === target.path && endpoint.httpMethod === target.httpMethod,
      )
    )
      throw new PipelineInputError(
        `Endpoint replacement ${rule.replacementOperationId} must use a newly introduced endpoint.`,
      );
    const schema = resolvableComponentSchema(beforeSchemas, mapping.schema);
    if (!schema)
      throw new PipelineInputError(
        `Endpoint replacement source schema ${mapping.schema} is unsupported.`,
      );
    assertResponse(source, beforeSchemas, schema);
    assertResponse(target, afterSchemas, schema);
    const sourceContract = contractSignature(source, before);
    const targetContract = contractSignature(target, after);
    if (sourceContract !== targetContract)
      throw new PipelineInputError(
        `Configured endpoint replacement ${mapping.operationId} → ${rule.replacementOperationId} changes its recorded request, response, HTTP method, path parameters, server or security contract. Review is required.`,
      );
    const contractHash = digest(sourceContract);
    replacements.push({
      ...rule,
      schema: mapping.schema,
      operationId: mapping.operationId,
      path: source.path,
      httpMethod: source.httpMethod,
      replacementPath: target.path,
      contractHash,
      id: digest(
        JSON.stringify({
          provider: provider.id,
          source: mapping.operationId,
          sourcePath: source.path,
          target: rule,
          targetPath: target.path,
          contractHash,
        }),
      ),
    });
  }
  return replacements;
}

export function operationReplacementEvidence(
  replacements: OperationReplacement[],
  calls: MappedSdkCall[],
  findings: Finding[],
): OperationReplacementEvidence[] {
  return replacements.map((replacement) => {
    const usages = calls.filter(
      (call) =>
        call.method === `${replacement.resource}.${replacement.method}` &&
        call.operationId === replacement.operationId,
    );
    return {
      ...replacement,
      usages,
      supported:
        usages.length > 0 &&
        usages.every((usage) =>
          findings.some(
            (finding) =>
              finding.changeId === replacement.id &&
              finding.confidence === 'confirmed' &&
              finding.file === usage.file &&
              finding.line === usage.line &&
              finding.column === usage.column,
          ),
        ),
    };
  });
}

export function isHandledOperationRemoval(
  change: unknown,
  replacements: OperationReplacementEvidence[],
) {
  return (
    isRemovedOperationChange(change) &&
    typeof change.operation === 'string' &&
    replacements.some(
      (replacement) =>
        replacement.supported &&
        change.path === replacement.path &&
        String(change.operation).toUpperCase() === replacement.httpMethod,
    )
  );
}

export function replacementAnalysisAdapter(
  provider: ProviderAdapter,
  replacements: OperationReplacement[],
): ProviderAdapter {
  return {
    ...provider,
    operations: [
      ...provider.operations,
      ...replacements.map((replacement) => ({
        resource: replacement.replacementResource,
        method: replacement.replacementMethod,
        schema: replacement.schema,
        operationId: replacement.replacementOperationId,
      })),
    ],
  };
}
