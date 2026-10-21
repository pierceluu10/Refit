import { readFile } from 'node:fs/promises';
import { validDate } from './deadline-registry.ts';
import { isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

export const DEFAULT_MODEL_PARAMETERS = new URL('../data/model-parameters.json', import.meta.url);

// The request parameters the replacement rule stops on, per provider.
export const MODEL_PARAMETER_NAMES: Record<string, ReadonlySet<string>> = {
  openai: new Set([
    'temperature',
    'top_p',
    'max_tokens',
    'presence_penalty',
    'frequency_penalty',
    'logit_bias',
    'logprobs',
    'top_logprobs',
  ]),
  anthropic: new Set(['temperature', 'top_p', 'top_k']),
};
const OFFICIAL_HOSTS = [
  'developers.openai.com',
  'platform.openai.com',
  'platform.claude.com',
  'docs.anthropic.com',
];

export interface ParameterSpec {
  accepts: 'any' | 'default-only' | 'none';
  default?: number;
  min?: number;
  max?: number;
  renamedTo?: string;
}

// One replacement model: what an official page, read on `checkedAt`, says it accepts.
export interface ModelParameterEntry {
  provider: 'openai' | 'anthropic';
  model: string;
  parameters: Record<string, ParameterSpec>;
  source: string;
  defaultSource?: string;
  checkedAt: string;
}

export interface ModelParameterTable {
  formatVersion: 1;
  models: ModelParameterEntry[];
}

export const EMPTY_MODEL_PARAMETERS: ModelParameterTable = { formatVersion: 1, models: [] };

function officialUrl(value: unknown) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      OFFICIAL_HOSTS.includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port
    );
  } catch {
    return false;
  }
}

function ownKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
  errors: string[],
) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) errors.push(`${label}: unknown fields ${unknown.join(', ')}.`);
}

function checkSpec(name: string, spec: unknown, label: string, errors: string[]) {
  const at = `${label}: ${name}`;
  if (!isObject(spec)) return errors.push(`${at} must be an object.`);
  ownKeys(spec, ['accepts', 'default', 'min', 'max', 'renamedTo'], at, errors);
  const has = (key: string) => Object.hasOwn(spec, key);
  const finite = (key: string) => Number.isFinite(spec[key]);
  if (spec.accepts !== 'any' && spec.accepts !== 'default-only' && spec.accepts !== 'none')
    errors.push(`${at}: accepts must be any, default-only or none.`);
  if (spec.accepts === 'default-only' ? !finite('default') : has('default'))
    errors.push(`${at}: default must be a finite number, and only with default-only.`);
  for (const key of ['min', 'max'])
    if (has(key) && (spec.accepts !== 'any' || !finite(key)))
      errors.push(`${at}: ${key} must be a finite number, and only with accepts any.`);
  if (finite('min') && finite('max') && (spec.min as number) > (spec.max as number))
    errors.push(`${at}: min is above max.`);
  if (
    has('renamedTo') &&
    (spec.accepts !== 'none' ||
      typeof spec.renamedTo !== 'string' ||
      !/^[a-z_][a-z0-9_]*$/.test(spec.renamedTo) ||
      spec.renamedTo === name)
  )
    errors.push(`${at}: renamedTo must be a different identifier, and only with accepts none.`);
}

// Shape problems make the table unusable; the whole file is rejected, never a partial table.
export function checkModelParameters(value: unknown, now: Date) {
  const errors: string[] = [];
  if (!isObject(value) || value.formatVersion !== 1 || !Array.isArray(value.models))
    return { errors: ['Table requires formatVersion: 1 and a models array.'] };
  ownKeys(value, ['formatVersion', 'models'], 'Table', errors);
  const today = now.toISOString().slice(0, 10);
  const seen = new Set<string>();
  for (const [index, entry] of value.models.entries()) {
    if (!isObject(entry)) {
      errors.push(`entry ${index}: must be an object.`);
      continue;
    }
    const label = `entry ${index} (${String(entry.provider)}:${String(entry.model)})`;
    ownKeys(
      entry,
      ['provider', 'model', 'parameters', 'source', 'defaultSource', 'checkedAt'],
      label,
      errors,
    );
    const provider = typeof entry.provider === 'string' ? entry.provider : '';
    const names = Object.hasOwn(MODEL_PARAMETER_NAMES, provider)
      ? MODEL_PARAMETER_NAMES[provider]
      : undefined;
    if (!names) errors.push(`${label}: unknown provider.`);
    if (typeof entry.model !== 'string' || !entry.model || entry.model !== entry.model.trim())
      errors.push(`${label}: model must be a non-empty string without surrounding whitespace.`);
    else if (seen.has(`${provider}:${entry.model}`)) errors.push(`${label}: duplicate model.`);
    else seen.add(`${provider}:${entry.model}`);
    if (!officialUrl(entry.source))
      errors.push(`${label}: source must be an https URL on an official provider host.`);
    if (!validDate(entry.checkedAt) || entry.checkedAt > today)
      errors.push(`${label}: checkedAt must be a real YYYY-MM-DD date, not in the future.`);
    if (!isObject(entry.parameters) || !Object.keys(entry.parameters).length) {
      errors.push(`${label}: parameters must be a non-empty object.`);
      continue;
    }
    let hasDefault = false;
    for (const [name, spec] of Object.entries(entry.parameters)) {
      if (names && !names.has(name))
        errors.push(`${label}: ${name} is not a ${provider} parameter.`);
      checkSpec(name, spec, label, errors);
      if (isObject(spec) && Object.hasOwn(spec, 'default')) hasDefault = true;
    }
    if (
      hasDefault !== Object.hasOwn(entry, 'defaultSource') ||
      (hasDefault && !officialUrl(entry.defaultSource))
    )
      errors.push(
        `${label}: defaultSource must be an official URL, exactly when a default is given.`,
      );
  }
  return { errors };
}

export async function loadModelParameters(
  path: string | URL = DEFAULT_MODEL_PARAMETERS,
  now = new Date(),
): Promise<ModelParameterTable> {
  const value = parseObject(await readFile(path, 'utf8'), 'Model parameter table');
  const { errors } = checkModelParameters(value, now);
  if (errors.length)
    throw new PipelineInputError(
      `Model parameter table is invalid: ${errors.slice(0, 5).join(' ')}`,
    );
  return value as unknown as ModelParameterTable;
}

export type ParameterVerdict =
  | { ok: true }
  | {
      ok: false;
      why: 'unproven' | 'not-numeric' | 'not-accepted' | 'renamed' | 'non-default' | 'out-of-range';
      spec?: ParameterSpec;
    };

// Whether the table proves `model` accepts `name` set to the literal `value` (undefined: not a numeric literal).
export function parameterVerdict(
  table: ModelParameterTable,
  provider: string,
  model: string,
  name: string,
  value: number | undefined,
): ParameterVerdict {
  const entry = table.models.find((item) => item.provider === provider && item.model === model);
  if (!entry || !Object.hasOwn(entry.parameters, name)) return { ok: false, why: 'unproven' };
  const spec = entry.parameters[name];
  if (value === undefined) return { ok: false, why: 'not-numeric', spec };
  if (spec.accepts === 'none')
    return { ok: false, why: spec.renamedTo ? 'renamed' : 'not-accepted', spec };
  if (spec.accepts === 'default-only' && value !== spec.default)
    return { ok: false, why: 'non-default', spec };
  if (
    spec.accepts === 'any' &&
    ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max))
  )
    return { ok: false, why: 'out-of-range', spec };
  // Anything not proven above, including an unrecognized spec, stops.
  if (spec.accepts !== 'any' && spec.accepts !== 'default-only')
    return { ok: false, why: 'unproven', spec };
  return { ok: true };
}

export function parameterReason(
  name: string,
  value: number | undefined,
  to: string,
  verdict: Extract<ParameterVerdict, { ok: false }>,
) {
  const v = value === undefined ? '' : ` ${value}`;
  const spec = verdict.spec;
  const end = `; change it by hand to ${to}.`;
  switch (verdict.why) {
    case 'unproven':
      return `The request sets ${name}${v}, which no official page read for ${to} proves it accepts${end}`;
    case 'not-numeric':
      return `The request sets ${name} to a value that is not a numeric literal, so it cannot be checked against what ${to} accepts${end}`;
    case 'not-accepted':
      return `The request sets ${name}${v}, which ${to} does not accept${end}`;
    case 'renamed':
      return `The request sets ${name}${v}, which ${to} does not accept; it takes ${spec?.renamedTo} instead, and Refit does not rename parameters${end}`;
    case 'non-default':
      return `The request sets ${name}${v}, which ${to} accepts only at ${spec?.default} (non-default value)${end}`;
    case 'out-of-range':
      return `The request sets ${name}${v}, outside the ${spec?.min ?? 'any'} to ${spec?.max ?? 'any'} range ${to} accepts${end}`;
  }
}
