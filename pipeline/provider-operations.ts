import { isObject } from './specifications.ts';
import { PipelineInputError, type Location } from './types.ts';
import type { ProviderAdapter } from './providers.ts';

const OPENAPI_METHODS = new Set([
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
  'trace',
]);
const REMOVED_OPERATION_CHANGES = new Set([
  'api-path-removed-with-deprecation',
  'api-path-removed-without-deprecation',
  'api-removed-with-deprecation',
  'api-removed-without-deprecation',
]);

export interface MappedSdkCall extends Location {
  method: string;
  operationId?: string;
}

export interface RemovedOperationImpact {
  operationId: string;
  path: string;
  httpMethod: string;
  text: string;
  usages: MappedSdkCall[];
}

export function validateProviderOperationMappings(provider: ProviderAdapter, before: unknown) {
  const mapped = provider.operations.filter((operation) => operation.operationId);
  if (!mapped.length) return;
  if (!isObject(before) || !isObject(before.paths))
    throw new PipelineInputError('OpenAPI operation mappings require a document with paths.');
  for (const operation of mapped) {
    const matches = findOperationIds(before.paths, operation.operationId!);
    if (matches.length !== 1)
      throw new PipelineInputError(
        `Provider operation ${operation.resource}.${operation.method} maps to OpenAPI operationId "${operation.operationId}", which resolves to ${matches.length} operations in the before specification.`,
      );
  }
}

export function findRemovedOperationImpacts(
  diff: { engine: string; changes: unknown[] } | undefined,
  calls: MappedSdkCall[],
): RemovedOperationImpact[] {
  if (!diff || diff.engine !== 'oasdiff') return [];
  const impacts: RemovedOperationImpact[] = [];
  const seen = new Set<string>();
  for (const change of diff.changes) {
    if (
      !isObject(change) ||
      typeof change.id !== 'string' ||
      !REMOVED_OPERATION_CHANGES.has(change.id) ||
      typeof change.operationId !== 'string' ||
      typeof change.path !== 'string' ||
      typeof change.operation !== 'string' ||
      typeof change.text !== 'string'
    )
      continue;
    const httpMethod = change.operation.toUpperCase();
    const changeKey = JSON.stringify([change.operationId, change.path, httpMethod]);
    if (seen.has(changeKey)) continue;
    seen.add(changeKey);
    const usages = calls.filter((call) => call.operationId === change.operationId);
    if (!usages.length) continue;
    impacts.push({
      operationId: change.operationId,
      path: change.path,
      httpMethod,
      text: change.text,
      usages,
    });
  }
  return impacts;
}

export function countRemovedOperationUsages(impacts: RemovedOperationImpact[]) {
  return impacts.reduce((count, impact) => count + impact.usages.length, 0);
}

function findOperationIds(paths: Record<string, unknown>, operationId: string) {
  const matches: { path: string; method: string }[] = [];
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isObject(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (
        OPENAPI_METHODS.has(method.toLowerCase()) &&
        isObject(operation) &&
        operation.operationId === operationId
      )
        matches.push({ path, method: method.toUpperCase() });
    }
  }
  return matches;
}
