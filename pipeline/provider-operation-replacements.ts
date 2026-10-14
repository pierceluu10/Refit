import { digest, isObject, resolvableComponentSchema } from './specifications.ts';
import type { ProviderAdapter } from './providers.ts';
import { contractSignature } from './openapi-contracts.ts';
import { PipelineInputError, type Finding } from './types.ts';
import type { MappedSdkCall } from './provider-operations.ts';
import {
  isJsonMediaType,
  isRemovedOperationChange,
  listOpenApiOperations,
  successfulResponseSchema,
  type OpenApiOperation,
} from './openapi-operations.ts';

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
