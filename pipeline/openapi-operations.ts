import { componentReference, isObject, resolvableComponentSchema } from './specifications.ts';

const HTTP_METHODS = new Set(['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace']);
const REMOVAL_IDS = new Set([
  'api-path-removed-with-deprecation',
  'api-path-removed-without-deprecation',
  'api-removed-with-deprecation',
  'api-removed-without-deprecation',
]);

export interface OpenApiOperation {
  path: string;
  httpMethod: string;
  pathItem: Record<string, unknown>;
  operation: Record<string, unknown>;
}

export function listOpenApiOperations(document: unknown): OpenApiOperation[] {
  if (!isObject(document) || !isObject(document.paths)) return [];
  const operations: OpenApiOperation[] = [];
  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!isObject(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (HTTP_METHODS.has(method.toLowerCase()) && isObject(operation))
        operations.push({ path, httpMethod: method.toUpperCase(), pathItem, operation });
    }
  }
  return operations;
}

export function isRemovedOperationChange(change: unknown): change is Record<string, unknown> {
  return isObject(change) && typeof change.id === 'string' && REMOVAL_IDS.has(change.id);
}

export function successfulResponseSchema(
  operation: Record<string, unknown>,
  schemas: Record<string, unknown>,
) {
  if (!isObject(operation.responses)) return undefined;
  const responseSchemas = new Set<string>();
  for (const [status, response] of Object.entries(operation.responses)) {
    if (!/^2\d\d$/.test(status) || !isObject(response) || !isObject(response.content)) continue;
    for (const [mediaType, media] of Object.entries(response.content)) {
      if (!isJsonMediaType(mediaType) || !isObject(media) || !isObject(media.schema)) continue;
      const reference = componentReference(media.schema.$ref);
      const resolved = reference ? resolvableComponentSchema(schemas, reference) : undefined;
      if (resolved) responseSchemas.add(resolved);
    }
  }
  return responseSchemas.size === 1 ? [...responseSchemas][0] : undefined;
}

export function isJsonMediaType(mediaType: string) {
  const normalized = mediaType.split(';', 1)[0].trim().toLowerCase();
  return normalized === 'application/json' || normalized.endsWith('+json');
}
