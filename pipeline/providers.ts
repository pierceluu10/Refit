import { readFile, stat } from 'node:fs/promises';
import { isObject, parseObject, resolvableComponentSchema } from './specifications.ts';
import { PipelineInputError } from './types.ts';

export interface ProviderAdapter {
  id: string;
  packageName: string;
  defaultImport: boolean;
  namedExport: string | null;
  apiVersion?: {
    constructorArgument: number;
    property: string;
    requestArguments: number[];
  };
  operations: { resource: string; method: string; schema: string; operationId?: string }[];
  propertyRenames?: { schema: string; removed: string; replacement: string }[];
  operationReplacements?: {
    resource: string;
    method: string;
    replacementResource: string;
    replacementMethod: string;
    replacementOperationId: string;
  }[];
}

export interface ProviderIdentity {
  id: string;
  packageName: string;
  defaultImport: boolean;
  namedExport: string | null;
}

export const STRIPE: ProviderAdapter = {
  id: 'stripe',
  packageName: 'stripe',
  defaultImport: true,
  namedExport: 'Stripe',
  apiVersion: { constructorArgument: 1, property: 'apiVersion', requestArguments: [1, 2] },
  operations: ['retrieve', 'create', 'update', 'confirm', 'cancel', 'capture'].map((method) => ({
    resource: 'paymentIntents',
    method,
    schema: 'payment_intent',
  })),
};

export function validateProviderMappings(
  provider: ProviderAdapter,
  schemas: Record<string, unknown>,
) {
  for (const operation of provider.operations) {
    if (resolvableComponentSchema(schemas, operation.schema)) continue;
    throw new PipelineInputError(
      `Provider operation ${operation.resource}.${operation.method} maps to schema "${operation.schema}", which is missing or unsupported in the before specification. Map it to a local component object schema with directly declared properties.`,
    );
  }
}

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_OPERATIONS = 100;
const MAX_PROPERTY_RENAMES = 100;
const MAX_OPERATION_REPLACEMENTS = 100;
const MAX_SCHEMA_NAME_LENGTH = 256;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export const MAX_SDK_RESOURCE_LENGTH = 256;
const SDK_RESOURCE_PATH = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const REQUIRED_KEYS = ['defaultImport', 'id', 'namedExport', 'operations', 'packageName'];
const CONFIG_KEYS = new Set([
  ...REQUIRED_KEYS,
  'propertyRenames',
  'operationReplacements',
  'apiVersion',
]);
const MAX_SDK_ARGUMENT_INDEX = 16;

function validOperationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Boolean(value.trim()) &&
    value === value.trim() &&
    value.length <= MAX_SCHEMA_NAME_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function validSdkResourcePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_SDK_RESOURCE_LENGTH &&
    SDK_RESOURCE_PATH.test(value)
  );
}

export function validateProviderIdentity(value: Record<string, unknown>): ProviderIdentity {
  if (
    typeof value.id !== 'string' ||
    !PROVIDER_ID.test(value.id) ||
    value.id === STRIPE.id ||
    typeof value.packageName !== 'string' ||
    !PACKAGE_NAME.test(value.packageName) ||
    typeof value.defaultImport !== 'boolean' ||
    !(
      value.namedExport === null ||
      (typeof value.namedExport === 'string' && IDENTIFIER.test(value.namedExport))
    ) ||
    !(value.defaultImport || value.namedExport)
  )
    throw new PipelineInputError(
      'Invalid provider configuration. Use a unique non-Stripe id, package, constructor import and 1–100 operations.',
    );
  return {
    id: value.id,
    packageName: value.packageName,
    defaultImport: value.defaultImport,
    namedExport: value.namedExport,
  };
}

export async function readProviderAdapter(path?: string): Promise<ProviderAdapter> {
  if (!path) return STRIPE;
  if ((await stat(path)).size > MAX_CONFIG_BYTES)
    throw new PipelineInputError('Provider configuration exceeds 64 KiB.');
  const value = parseObject(await readFile(path, 'utf8'), 'Provider configuration');
  return parseProviderAdapter(value);
}

export function parseProviderAdapter(value: Record<string, unknown>): ProviderAdapter {
  const identity = validateProviderIdentity(value);
  if (
    REQUIRED_KEYS.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !CONFIG_KEYS.has(key)) ||
    !Array.isArray(value.operations) ||
    !value.operations.length ||
    value.operations.length > MAX_OPERATIONS
  )
    throw new PipelineInputError(
      'Invalid provider configuration. Use a unique non-Stripe id, package, constructor import and 1–100 operations.',
    );
  const seen = new Set<string>();
  const apiVersion = value.apiVersion;
  const argumentIndex = (index: unknown): index is number =>
    typeof index === 'number' &&
    Number.isInteger(index) &&
    index >= 0 &&
    index <= MAX_SDK_ARGUMENT_INDEX;
  if (
    apiVersion !== undefined &&
    (!isObject(apiVersion) ||
      Object.keys(apiVersion).sort().join(',') !==
        'constructorArgument,property,requestArguments' ||
      !argumentIndex(apiVersion.constructorArgument) ||
      !validSdkResourcePath(apiVersion.property) ||
      !Array.isArray(apiVersion.requestArguments) ||
      apiVersion.requestArguments.length > MAX_SDK_ARGUMENT_INDEX + 1 ||
      !apiVersion.requestArguments.every(argumentIndex) ||
      new Set(apiVersion.requestArguments).size !== apiVersion.requestArguments.length)
  )
    throw new PipelineInputError(
      `Provider apiVersion requires an identifier property path, a constructorArgument index and unique requestArguments indexes from 0 to ${MAX_SDK_ARGUMENT_INDEX}.`,
    );
  const operations = value.operations.map((operation) => {
    const operationKeys = isObject(operation) ? Object.keys(operation).sort().join(',') : '';
    if (
      !isObject(operation) ||
      !['method,resource,schema', 'method,operationId,resource,schema'].includes(operationKeys) ||
      !validSdkResourcePath(operation.resource) ||
      typeof operation.method !== 'string' ||
      !IDENTIFIER.test(operation.method) ||
      typeof operation.schema !== 'string' ||
      !operation.schema.trim() ||
      operation.schema.length > MAX_CONFIG_BYTES ||
      (operation.operationId !== undefined && !validOperationId(operation.operationId))
    )
      throw new PipelineInputError(
        'Each provider operation must specify an identifier-style resource path, method and schema strings, with an optional printable OpenAPI operationId.',
      );
    const key = `${operation.resource}.${operation.method}`;
    if (seen.has(key)) throw new PipelineInputError(`Duplicate provider operation: ${key}`);
    seen.add(key);
    return {
      resource: operation.resource,
      method: operation.method,
      schema: operation.schema,
      ...(operation.operationId ? { operationId: operation.operationId } : {}),
    };
  });
  const propertyRenames = value.propertyRenames;
  if (
    propertyRenames !== undefined &&
    (!Array.isArray(propertyRenames) || propertyRenames.length > MAX_PROPERTY_RENAMES)
  )
    throw new PipelineInputError(
      `Provider propertyRenames must contain at most ${MAX_PROPERTY_RENAMES} entries.`,
    );
  const seenRenames = new Set<string>();
  const seenTargets = new Set<string>();
  const parsedRenames = (propertyRenames ?? []).map((rename) => {
    if (
      !isObject(rename) ||
      Object.keys(rename).sort().join(',') !== 'removed,replacement,schema' ||
      typeof rename.schema !== 'string' ||
      !rename.schema.trim() ||
      rename.schema !== rename.schema.trim() ||
      rename.schema.length > MAX_SCHEMA_NAME_LENGTH ||
      typeof rename.removed !== 'string' ||
      !IDENTIFIER.test(rename.removed) ||
      typeof rename.replacement !== 'string' ||
      !IDENTIFIER.test(rename.replacement) ||
      rename.removed === rename.replacement
    )
      throw new PipelineInputError(
        'Each property rename must specify a schema and distinct identifier-style removed and replacement fields.',
      );
    const source = JSON.stringify([rename.schema, rename.removed]);
    const target = JSON.stringify([rename.schema, rename.replacement]);
    if (seenRenames.has(source))
      throw new PipelineInputError(
        `Duplicate property rename source: ${rename.schema}.${rename.removed}`,
      );
    if (seenTargets.has(target))
      throw new PipelineInputError(
        `Duplicate property rename target: ${rename.schema}.${rename.replacement}`,
      );
    seenRenames.add(source);
    seenTargets.add(target);
    return {
      schema: rename.schema,
      removed: rename.removed,
      replacement: rename.replacement,
    };
  });
  const replacements = value.operationReplacements;
  if (
    replacements !== undefined &&
    (!Array.isArray(replacements) || replacements.length > MAX_OPERATION_REPLACEMENTS)
  )
    throw new PipelineInputError(
      `Provider operationReplacements must contain at most ${MAX_OPERATION_REPLACEMENTS} entries.`,
    );
  const replacementSources = new Set<string>();
  const replacementTargets = new Set<string>();
  const replacementIds = new Set<string>();
  const parsedReplacements = (replacements ?? []).map((replacement) => {
    if (
      !isObject(replacement) ||
      Object.keys(replacement).sort().join(',') !==
        'method,replacementMethod,replacementOperationId,replacementResource,resource' ||
      !validSdkResourcePath(replacement.resource) ||
      !validSdkResourcePath(replacement.replacementResource) ||
      ![replacement.method, replacement.replacementMethod].every(
        (name) => typeof name === 'string' && IDENTIFIER.test(name),
      ) ||
      !validOperationId(replacement.replacementOperationId)
    )
      throw new PipelineInputError(
        'Each operation replacement must name source and replacement SDK resource/method identifiers and a printable replacementOperationId.',
      );
    const resource = replacement.resource as string;
    const method = replacement.method as string;
    const replacementResource = replacement.replacementResource as string;
    const replacementMethod = replacement.replacementMethod as string;
    const source = `${resource}.${method}`;
    const target = `${replacementResource}.${replacementMethod}`;
    const mapped = operations.find(
      (operation) => operation.resource === resource && operation.method === method,
    );
    if (!mapped?.operationId)
      throw new PipelineInputError(
        `Operation replacement source ${source} needs an existing operationId mapping.`,
      );
    if (
      source === target ||
      operations.some((operation) => `${operation.resource}.${operation.method}` === target)
    )
      throw new PipelineInputError(
        `Operation replacement target ${target} must be a new, distinct SDK method mapping.`,
      );
    if (
      replacementSources.has(source) ||
      replacementTargets.has(target) ||
      replacementIds.has(replacement.replacementOperationId)
    )
      throw new PipelineInputError(
        'Operation replacement sources, SDK targets and replacement operation IDs must be unique.',
      );
    replacementSources.add(source);
    replacementTargets.add(target);
    replacementIds.add(replacement.replacementOperationId);
    return {
      resource,
      method,
      replacementResource,
      replacementMethod,
      replacementOperationId: replacement.replacementOperationId,
    };
  });
  return {
    ...identity,
    operations,
    ...(apiVersion
      ? {
          apiVersion: {
            constructorArgument: apiVersion.constructorArgument as number,
            property: apiVersion.property as string,
            requestArguments: apiVersion.requestArguments as number[],
          },
        }
      : {}),
    ...(parsedRenames.length ? { propertyRenames: parsedRenames } : {}),
    ...(parsedReplacements.length ? { operationReplacements: parsedReplacements } : {}),
  };
}
