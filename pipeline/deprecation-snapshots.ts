import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { PipelineInputError } from './types.ts';

export const MAX_DEPRECATION_SNAPSHOT_BYTES = 1024 * 1024;

export type DeprecationProvider = 'openai' | 'anthropic';
export type DeprecationStatus = 'deprecated' | 'retired';

export interface DeprecationModel {
  id: string;
  status: DeprecationStatus;
  shutdownDate: string | null;
  replacement: string | null;
  sourceNote: string;
}

export interface DeprecationSnapshot {
  kind: 'refit-deprecation-snapshot';
  version: 1;
  provider: DeprecationProvider;
  source: {
    url: string;
    retrievedAt: string;
    sha256: string;
  };
  models: DeprecationModel[];
}

type JsonObject = Record<string, unknown>;

function fail(label: string, detail: string): never {
  throw new PipelineInputError(`${label}: ${detail}.`);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireExactKeys(value: JsonObject, keys: string[], label: string) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail(label, `expected exactly the keys ${expected.join(', ')}`);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value)
    fail(label, 'must be a non-empty string without surrounding whitespace');
  return value;
}

function requireNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requireNonEmptyString(value, label);
}

function requireIsoDate(value: unknown, label: string): string | null {
  if (value === null) return null;
  const date = requireNonEmptyString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)))
    fail(label, 'must be null or a valid YYYY-MM-DD date');
  const parsed = new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10);
  if (parsed !== date) fail(label, 'must be null or a valid YYYY-MM-DD date');
  return date;
}

function requireRetrievedAt(value: unknown, label: string): string {
  const retrievedAt = requireNonEmptyString(value, label);
  const parsed = new Date(retrievedAt);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== retrievedAt)
    fail(label, 'must be an ISO 8601 UTC timestamp in canonical form');
  return retrievedAt;
}

function requireSourceUrl(value: unknown, label: string): string {
  const sourceUrl = requireNonEmptyString(value, label);
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    fail(label, 'must be a valid absolute HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    fail(label, 'must be a credential-free absolute HTTPS URL');
  return sourceUrl;
}

function parseModel(value: unknown, label: string): DeprecationModel {
  if (!isObject(value)) fail(label, 'must be an object');
  requireExactKeys(value, ['id', 'status', 'shutdownDate', 'replacement', 'sourceNote'], label);
  const status = value.status;
  if (status !== 'deprecated' && status !== 'retired')
    fail(`${label}.status`, 'must be deprecated or retired');
  return {
    id: requireNonEmptyString(value.id, `${label}.id`),
    status,
    shutdownDate: requireIsoDate(value.shutdownDate, `${label}.shutdownDate`),
    replacement: requireNullableString(value.replacement, `${label}.replacement`),
    sourceNote: requireNonEmptyString(value.sourceNote, `${label}.sourceNote`),
  };
}

function parseSnapshot(value: unknown, label: string, verifyHash: boolean): DeprecationSnapshot {
  if (!isObject(value)) fail(label, 'must be a JSON object');
  requireExactKeys(value, ['kind', 'version', 'provider', 'source', 'models'], label);
  if (value.kind !== 'refit-deprecation-snapshot')
    fail(`${label}.kind`, 'must be refit-deprecation-snapshot');
  if (value.version !== 1) fail(`${label}.version`, 'must be 1');
  if (value.provider !== 'openai' && value.provider !== 'anthropic')
    fail(`${label}.provider`, 'must be openai or anthropic');
  if (!isObject(value.source)) fail(`${label}.source`, 'must be an object');
  requireExactKeys(value.source, ['url', 'retrievedAt', 'sha256'], `${label}.source`);
  if (!Array.isArray(value.models)) fail(`${label}.models`, 'must be an array');
  const models = value.models.map((model, index) => parseModel(model, `${label}.models[${index}]`));
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) fail(`${label}.models`, `contains duplicate model id ${model.id}`);
    ids.add(model.id);
  }
  const sha256 = requireNonEmptyString(value.source.sha256, `${label}.source.sha256`);
  if (!/^[a-f0-9]{64}$/.test(sha256))
    fail(`${label}.source.sha256`, 'must be a lowercase SHA-256 digest');
  if (verifyHash && sha256 !== hashDeprecationModels(models))
    fail(`${label}.source.sha256`, 'does not match the canonical models hash');
  return {
    kind: 'refit-deprecation-snapshot',
    version: 1,
    provider: value.provider,
    source: {
      url: requireSourceUrl(value.source.url, `${label}.source.url`),
      retrievedAt: requireRetrievedAt(value.source.retrievedAt, `${label}.source.retrievedAt`),
      sha256,
    },
    models,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashDeprecationModels(models: DeprecationModel[]): string {
  return createHash('sha256').update(canonicalJson(models)).digest('hex');
}

export function validateDeprecationSnapshot(
  value: unknown,
  label = 'Deprecation snapshot',
): DeprecationSnapshot {
  return parseSnapshot(value, label, true);
}

export function buildDeprecationSnapshot(
  value: unknown,
  label = 'Deprecation snapshot input',
): DeprecationSnapshot {
  if (!isObject(value) || !isObject(value.source)) fail(label, 'must contain a source object');
  const withHash = {
    ...value,
    source: {
      ...value.source,
      sha256: '0'.repeat(64),
    },
  };
  const parsed = parseSnapshot(withHash, label, false);
  return {
    ...parsed,
    source: {
      ...parsed.source,
      sha256: hashDeprecationModels(parsed.models),
    },
  };
}

export async function readDeprecationSnapshot(path: string): Promise<DeprecationSnapshot> {
  if ((await stat(path)).size > MAX_DEPRECATION_SNAPSHOT_BYTES)
    throw new PipelineInputError(`${path} exceeds the 1 MiB deprecation snapshot input limit.`);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (cause) {
    throw new PipelineInputError(`${path} is not valid JSON.`, { cause });
  }
  return validateDeprecationSnapshot(value, path);
}

export function encodeDeprecationSnapshot(snapshot: DeprecationSnapshot): string {
  const encoded = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (Buffer.byteLength(encoded) > MAX_DEPRECATION_SNAPSHOT_BYTES)
    throw new PipelineInputError('Encoded deprecation snapshot exceeds the 1 MiB input limit.');
  return encoded;
}
