import { readFile, stat } from 'node:fs/promises';
import { isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

export interface ProviderAdapter {
  id: string;
  packageName: string;
  defaultImport: boolean;
  namedExport: string | null;
  operations: { resource: string; method: string; schema: string }[];
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
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_OPERATIONS = 100;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;

export async function readProviderAdapter(path?: string): Promise<ProviderAdapter> {
  if (!path) return STRIPE;
  if ((await stat(path)).size > MAX_CONFIG_BYTES)
    throw new PipelineInputError('Provider configuration exceeds 64 KiB.');
  const value = parseObject(await readFile(path, 'utf8'), 'Provider configuration');
  if (
    Object.keys(value).sort().join(',') !== 'defaultImport,id,namedExport,operations,packageName' ||
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
    !(value.defaultImport || value.namedExport) ||
    !Array.isArray(value.operations) ||
    !value.operations.length ||
    value.operations.length > MAX_OPERATIONS
  )
    throw new PipelineInputError(
      'Invalid provider configuration. Use a unique non-Stripe id, package, constructor import and 1–100 operations.',
    );
  const seen = new Set<string>();
  const operations = value.operations.map((operation) => {
    if (
      !isObject(operation) ||
      Object.keys(operation).sort().join(',') !== 'method,resource,schema' ||
      typeof operation.resource !== 'string' ||
      !IDENTIFIER.test(operation.resource) ||
      typeof operation.method !== 'string' ||
      !IDENTIFIER.test(operation.method) ||
      typeof operation.schema !== 'string' ||
      !operation.schema.trim() ||
      operation.schema.length > MAX_CONFIG_BYTES
    )
      throw new PipelineInputError(
        'Each provider operation must specify resource, method and schema strings.',
      );
    const key = `${operation.resource}.${operation.method}`;
    if (seen.has(key)) throw new PipelineInputError(`Duplicate provider operation: ${key}`);
    seen.add(key);
    return { resource: operation.resource, method: operation.method, schema: operation.schema };
  });
  return {
    id: value.id,
    packageName: value.packageName,
    defaultImport: value.defaultImport,
    namedExport: value.namedExport,
    operations,
  };
}
