import { readFile, stat } from 'node:fs/promises';
import { isObject, parseObject, resolvableComponentSchema } from './specifications.ts';
import { PipelineInputError } from './types.ts';

export interface ProviderAdapter {
  id: string;
  packageName: string;
  defaultImport: boolean;
  namedExport: string | null;
  operations: { resource: string; method: string; schema: string; operationId?: string }[];
  propertyRenames?: { schema: string; removed: string; replacement: string }[];
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
const MAX_SCHEMA_NAME_LENGTH = 256;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;

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
  const keys = Object.keys(value).sort().join(',');
  if (
    (keys !== 'defaultImport,id,namedExport,operations,packageName' &&
      keys !== 'defaultImport,id,namedExport,operations,packageName,propertyRenames') ||
    !Array.isArray(value.operations) ||
    !value.operations.length ||
    value.operations.length > MAX_OPERATIONS
  )
    throw new PipelineInputError(
      'Invalid provider configuration. Use a unique non-Stripe id, package, constructor import and 1–100 operations.',
    );
  const seen = new Set<string>();
  const operations = value.operations.map((operation) => {
    const operationKeys = isObject(operation) ? Object.keys(operation).sort().join(',') : '';
    if (
      !isObject(operation) ||
      !['method,resource,schema', 'method,operationId,resource,schema'].includes(operationKeys) ||
      typeof operation.resource !== 'string' ||
      !IDENTIFIER.test(operation.resource) ||
      typeof operation.method !== 'string' ||
      !IDENTIFIER.test(operation.method) ||
      typeof operation.schema !== 'string' ||
      !operation.schema.trim() ||
      operation.schema.length > MAX_CONFIG_BYTES ||
      (operation.operationId !== undefined &&
        (typeof operation.operationId !== 'string' ||
          !operation.operationId.trim() ||
          operation.operationId !== operation.operationId.trim() ||
          operation.operationId.length > MAX_SCHEMA_NAME_LENGTH ||
          /[\u0000-\u001f\u007f]/.test(operation.operationId)))
    )
      throw new PipelineInputError(
        'Each provider operation must specify resource, method and schema strings, with an optional printable OpenAPI operationId.',
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
  return {
    ...identity,
    operations,
    ...(parsedRenames.length ? { propertyRenames: parsedRenames } : {}),
  };
}
