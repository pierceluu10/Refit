import { isObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import type { OpenApiOperation } from './openapi-operations.ts';

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

export function contractValue(value: unknown, document: Record<string, unknown>) {
  let nodes = 0;
  function visit(value: unknown, references: Set<string>, depth: number): unknown {
    if (++nodes > MAX_CONTRACT_NODES || depth > MAX_CONTRACT_DEPTH)
      throw new PipelineInputError('Migration contract exceeds the reference traversal limit.');
    if (Array.isArray(value)) return value.map((entry) => visit(entry, references, depth + 1));
    if (!isObject(value)) return value;
    if (
      Object.keys(value).some((key) => UNSUPPORTED_REFERENCE_KEYS.has(key) && !isObject(value[key]))
    )
      throw new PipelineInputError(
        'Configured migrations do not resolve schema identifiers, anchors or dynamic references; review this contract manually.',
      );
    if (Object.hasOwn(value, '$ref')) {
      const reference = value.$ref;
      if (
        typeof reference !== 'string' ||
        !reference.startsWith('#/components/') ||
        Object.keys(value).length !== 1
      )
        throw new PipelineInputError(
          'Configured migrations require local component references without sibling fields.',
        );
      let target: unknown = document;
      for (const segment of reference
        .slice(2)
        .split('/')
        .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))) {
        if (!isObject(target) || !Object.hasOwn(target, segment))
          throw new PipelineInputError(`Migration has an unresolved reference: ${reference}`);
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

export function contractSignature(endpoint: OpenApiOperation, document: Record<string, unknown>) {
  if (endpoint.pathItem.$ref)
    throw new PipelineInputError('Migration path-item references require review.');
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
      'Configured migrations require unambiguous path parameter templates.',
    );
  const effective = new Map<string, Record<string, unknown>>();
  for (const parameters of [
    endpoint.pathItem.parameters ?? [],
    endpoint.operation.parameters ?? [],
  ]) {
    if (!Array.isArray(parameters))
      throw new PipelineInputError('Migration parameters must be arrays.');
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
          'Configured migrations require explicit, resolvable parameter definitions.',
        );
      const key = JSON.stringify([definition.in, definition.name]);
      if (seen.has(key))
        throw new PipelineInputError(
          'Migration parameters cannot contain duplicate name/location entries.',
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
      'Configured migrations require every path template parameter to have a matching required path parameter definition.',
    );
  return names;
}
