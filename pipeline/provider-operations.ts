import { isObject } from './specifications.ts';
import { PipelineInputError, type Location } from './types.ts';
import type { ProviderAdapter } from './providers.ts';
import { isRemovedOperationChange, listOpenApiOperations } from './openapi-operations.ts';
const BREAKING_CHANGE_LEVEL = 2;

export interface MappedSdkCall extends Location {
  method: string;
  operationId?: string;
}

export interface ProviderOperationMapping {
  resource: string;
  method: string;
  schema: string;
  operationId: string;
  path: string;
  httpMethod: string;
}

export interface BreakingOperationChange {
  id: string;
  level: number;
  text: string;
}

export interface BreakingOperationImpact {
  operationId: string;
  path: string;
  httpMethod: string;
  text: string;
  changes: BreakingOperationChange[];
  usages: MappedSdkCall[];
}

export function validateProviderOperationMappings(
  provider: ProviderAdapter,
  before: unknown,
): ProviderOperationMapping[] {
  const mapped = provider.operations.filter(
    (operation): operation is typeof operation & { operationId: string } =>
      Boolean(operation.operationId),
  );
  if (!mapped.length) return [];
  if (!isObject(before) || !isObject(before.paths))
    throw new PipelineInputError('OpenAPI operation mappings require a document with paths.');
  return mapped.map((operation) => {
    const matches = listOpenApiOperations(before).filter(
      (candidate) => candidate.operation.operationId === operation.operationId,
    );
    if (matches.length !== 1)
      throw new PipelineInputError(
        `Provider operation ${operation.resource}.${operation.method} maps to OpenAPI operationId "${operation.operationId}", which resolves to ${matches.length} operations in the before specification.`,
      );
    return { ...operation, path: matches[0].path, httpMethod: matches[0].httpMethod };
  });
}

export function findBreakingOperationImpacts(
  diff: { engine: string; changes: unknown[] } | undefined,
  calls: MappedSdkCall[],
  mappings: ProviderOperationMapping[],
  breakingChanges?: unknown[],
): BreakingOperationImpact[] {
  if (!diff || diff.engine !== 'oasdiff' || !mappings.length) return [];
  const impacts = new Map<string, BreakingOperationImpact>();
  const candidates = [
    ...new Set([
      ...(breakingChanges ?? diff.changes),
      ...diff.changes.filter(isRemovedOperationChange),
    ]),
  ];
  for (const change of candidates) {
    if (
      !isObject(change) ||
      typeof change.id !== 'string' ||
      typeof change.text !== 'string' ||
      !Number.isFinite(Number(change.level)) ||
      (Number(change.level) < BREAKING_CHANGE_LEVEL && !isRemovedOperationChange(change)) ||
      typeof change.path !== 'string' ||
      typeof change.operation !== 'string'
    )
      continue;
    const httpMethod = change.operation.toUpperCase();
    const mapping = mappings.find(
      (candidate) => candidate.path === change.path && candidate.httpMethod === httpMethod,
    );
    if (!mapping) continue;
    const usages = calls.filter((call) => call.operationId === mapping.operationId);
    if (!usages.length) continue;
    const impactKey = JSON.stringify([mapping.operationId, mapping.path, mapping.httpMethod]);
    let impact = impacts.get(impactKey);
    if (!impact) {
      impact = {
        operationId: mapping.operationId,
        path: mapping.path,
        httpMethod: mapping.httpMethod,
        text: '',
        changes: [],
        usages,
      };
      impacts.set(impactKey, impact);
    }
    if (!impact.changes.some((entry) => entry.id === change.id && entry.text === change.text)) {
      impact.changes.push({ id: change.id, level: Number(change.level), text: change.text });
      impact.text = impact.changes.map((entry) => entry.text).join('; ');
    }
  }
  return [...impacts.values()];
}

export function countBreakingOperationUsages(impacts: BreakingOperationImpact[]) {
  const locations = new Set(
    impacts.flatMap((impact) =>
      impact.usages.map((usage) => JSON.stringify([usage.file, usage.line, usage.column])),
    ),
  );
  return locations.size;
}
