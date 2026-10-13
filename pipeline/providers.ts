import { readFile, stat } from 'node:fs/promises';
import { isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

export interface ProviderAdapter {
  id: string;
  packageName: string;
  defaultImport: boolean;
  namedExport: string | null;
  operations: ProviderOperation[];
}

export interface ProviderOperation {
  resource: string;
  method: string;
  schema?: string;
  requestChecks?: { argument: string; kind: 'model-id' }[];
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
const MAX_REQUEST_CHECKS = 100;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESOURCE_PATH = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
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
    const operationKeys = isObject(operation) ? Object.keys(operation).sort().join(',') : '';
    if (
      !isObject(operation) ||
      ![
        'method,requestChecks,resource',
        'method,requestChecks,resource,schema',
        'method,resource,schema',
      ].includes(operationKeys) ||
      typeof operation.resource !== 'string' ||
      !RESOURCE_PATH.test(operation.resource) ||
      typeof operation.method !== 'string' ||
      !IDENTIFIER.test(operation.method) ||
      !(
        operation.schema === undefined ||
        (typeof operation.schema === 'string' &&
          Boolean(operation.schema.trim()) &&
          operation.schema.length <= MAX_CONFIG_BYTES)
      ) ||
      !(
        operation.requestChecks === undefined ||
        (Array.isArray(operation.requestChecks) &&
          operation.requestChecks.length > 0 &&
          operation.requestChecks.length <= MAX_REQUEST_CHECKS)
      )
    )
      throw new PipelineInputError(
        'Each provider operation must specify a dotted resource path, method, and schema or requestChecks.',
      );
    const requestChecks = operation.requestChecks?.map((requestCheck) => {
      if (
        !isObject(requestCheck) ||
        Object.keys(requestCheck).sort().join(',') !== 'argument,kind' ||
        typeof requestCheck.argument !== 'string' ||
        !IDENTIFIER.test(requestCheck.argument) ||
        requestCheck.kind !== 'model-id'
      )
        throw new PipelineInputError(
          'Each provider request check must specify an argument identifier and supported kind.',
        );
      return { argument: requestCheck.argument, kind: 'model-id' as const };
    });
    if (
      requestChecks &&
      new Set(requestChecks.map((check) => check.argument)).size !== requestChecks.length
    )
      throw new PipelineInputError(
        'Provider request check arguments must be unique per operation.',
      );
    const key = `${operation.resource}.${operation.method}`;
    if (seen.has(key)) throw new PipelineInputError(`Duplicate provider operation: ${key}`);
    seen.add(key);
    return {
      resource: operation.resource,
      method: operation.method,
      ...(operation.schema === undefined ? {} : { schema: operation.schema }),
      ...(requestChecks === undefined ? {} : { requestChecks }),
    };
  });
  return {
    id: value.id,
    packageName: value.packageName,
    defaultImport: value.defaultImport,
    namedExport: value.namedExport,
    operations,
  };
}
