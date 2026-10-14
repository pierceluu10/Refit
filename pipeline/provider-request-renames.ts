import {
  componentReference,
  digest,
  isObject,
  resolvableComponentSchema,
} from './specifications.ts';
import { contractSignature, contractValue } from './openapi-contracts.ts';
import { listOpenApiOperations, type OpenApiOperation } from './openapi-operations.ts';
import type { ProviderAdapter } from './providers.ts';
import type { MappedSdkCall } from './provider-operations.ts';
import { PipelineInputError, type Finding } from './types.ts';

type Rule = NonNullable<ProviderAdapter['requestPropertyRenames']>[number];
export interface RequestPropertyRename extends Rule {
  id: string;
  schema: string;
  operationId: string;
  path: string;
  httpMethod: string;
  contractHash: string;
}
export interface RequestPropertyRenameEvidence extends RequestPropertyRename {
  usages: MappedSdkCall[];
  supported: boolean;
}

function requestSchema(endpoint: OpenApiOperation, document: Record<string, unknown>) {
  let body = contractValue(endpoint.operation.requestBody, document);
  while (isObject(body) && Object.hasOwn(body, '$ref')) body = body.definition;
  const content = isObject(body) ? body.content : undefined;
  const media =
    isObject(content) && Object.keys(content).join(',') === 'application/json'
      ? content['application/json']
      : undefined;
  const reference =
    isObject(media) && isObject(media.schema) ? componentReference(media.schema.$ref) : undefined;
  const components = isObject(document.components) ? document.components : {};
  const schemas = isObject(components.schemas) ? components.schemas : {};
  const name = reference ? resolvableComponentSchema(schemas, reference) : undefined;
  const definition = name ? schemas[name] : undefined;
  if (
    !name ||
    !isObject(definition) ||
    definition.type !== 'object' ||
    !isObject(definition.properties)
  )
    throw new PipelineInputError(
      'Request property renames require one application/json body referencing a supported local component object schema.',
    );
  return { name, definition, properties: definition.properties };
}

export function validateRequestPropertyRenames(
  provider: ProviderAdapter,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): RequestPropertyRename[] {
  const baseline = listOpenApiOperations(before);
  const revised = listOpenApiOperations(after);
  const replacements: RequestPropertyRename[] = [];
  const groups = new Map<string, Rule[]>();
  for (const rule of provider.requestPropertyRenames ?? []) {
    const key = `${rule.resource}.${rule.method}`;
    groups.set(key, [...(groups.get(key) ?? []), rule]);
  }
  for (const [name, rules] of groups) {
    const mapping = provider.operations.find(
      (entry) => `${entry.resource}.${entry.method}` === name,
    );
    const sources = baseline.filter(
      (entry) => entry.operation.operationId === mapping?.operationId,
    );
    if (!mapping?.operationId || sources.length !== 1)
      throw new PipelineInputError(
        `Request rename ${name} needs one mapped operationId in the before contract.`,
      );
    const source = sources[0];
    const oldBody = requestSchema(source, before);
    for (const rule of rules)
      if (!Object.hasOwn(oldBody.properties, rule.removed))
        throw new PipelineInputError(
          `Request rename ${name}.${rule.removed} is not a declared before body property.`,
        );
    const targets = revised.filter((entry) => entry.operation.operationId === mapping.operationId);
    if (
      targets.length !== 1 ||
      targets[0].path !== source.path ||
      targets[0].httpMethod !== source.httpMethod
    )
      throw new PipelineInputError(
        `Request rename ${name} requires the same unique operationId, path and HTTP method after the change.`,
      );
    const target = targets[0];
    const newBody = requestSchema(target, after);
    const active = rules.filter((rule) => !Object.hasOwn(newBody.properties, rule.removed));
    if (!active.length) continue;
    const normalized = structuredClone(before);
    const components = normalized.components as Record<string, unknown>;
    const schemas = components.schemas as Record<string, Record<string, unknown>>;
    const schema = schemas[oldBody.name];
    const properties = schema.properties as Record<string, unknown>;
    for (const rule of active) {
      if (
        Object.hasOwn(oldBody.properties, rule.replacement) ||
        !Object.hasOwn(newBody.properties, rule.replacement)
      )
        throw new PipelineInputError(
          `Request rename ${name}.${rule.removed} requires a newly introduced replacement property ${rule.replacement}.`,
        );
      properties[rule.replacement] = properties[rule.removed];
      delete properties[rule.removed];
      if (Array.isArray(schema.required))
        schema.required = schema.required.map((field) =>
          field === rule.removed ? rule.replacement : field,
        );
    }
    const normalizedSource = listOpenApiOperations(normalized).find(
      (entry) => entry.path === source.path && entry.httpMethod === source.httpMethod,
    )!;
    const expected = contractSignature(normalizedSource, normalized);
    if (expected !== contractSignature(target, after))
      throw new PipelineInputError(
        `Request rename ${name} changes constraints, requiredness, response, parameters, server or security beyond the configured field names. Review is required.`,
      );
    const contractHash = digest(expected);
    for (const rule of active)
      replacements.push({
        ...rule,
        schema: oldBody.name,
        operationId: mapping.operationId,
        path: source.path,
        httpMethod: source.httpMethod,
        contractHash,
        id: digest(
          JSON.stringify({
            provider: provider.id,
            operationId: mapping.operationId,
            rule,
            contractHash,
          }),
        ),
      });
  }
  return replacements;
}

export function requestRenameEvidence(
  replacements: RequestPropertyRename[],
  calls: MappedSdkCall[],
  findings: Finding[],
): RequestPropertyRenameEvidence[] {
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
        !findings.some(
          (finding) => finding.changeId === replacement.id && finding.confidence === 'review',
        ),
    };
  });
}

export function isHandledRequestRename(
  change: unknown,
  replacements: RequestPropertyRenameEvidence[],
) {
  if (!isObject(change) || typeof change.text !== 'string') return false;
  const removed =
    change.id === 'request-property-removed'
      ? change.text.match(/^removed the request property `([^`]+)`$/)
      : undefined;
  const added =
    change.id === 'new-required-request-property'
      ? change.text.match(/^added the new required request property `([^`]+)`$/)
      : undefined;
  if (!removed && !added) return false;
  return replacements.some(
    (entry) =>
      entry.supported &&
      entry.path === change.path &&
      entry.httpMethod === String(change.operation).toUpperCase() &&
      (removed ? entry.removed === removed[1] : entry.replacement === added![1]),
  );
}
