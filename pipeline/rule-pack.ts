import { readFileSync } from 'node:fs';
import { isObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

// A provider's migration rules as data: each entry names a family (the code that edits) and the
// values it edits with. Families are provider-independent; entries carry the provider's facts.

// A removed response field whose value is readable at a documented new location through a
// generated helper that reads either API version.
interface FieldMoveBase {
  rule: string;
  schemas: string[];
  // Paths (schema, then properties) that must all exist in the target contract.
  targets: string[][];
  source: string;
  warning: string;
}

export type FieldMove = FieldMoveBase &
  (
    | {
        // `receiver.property` reads become `helper(receiver)`.
        family: 'moved-value';
        property: string;
        helper: string;
        // Reads of these child fields stay for review: the new object no longer carries them.
        droppedFields?: string[];
        // Writes and deletes stay for review.
        readsOnly?: boolean;
        // Skipped when the code expands the field, whose expand path moved too.
        unlessExpanded?: boolean;
        // In TypeScript, reads under a `typeof` guard of the field share one local, so the guard
        // still narrows.
        typeofGuard?: boolean;
        // In TypeScript, reads after a truthiness, null or typeof test share one local.
        narrowTested?: boolean;
      }
    | {
        // `receiver.property.id` reads become `helper(receiver)`.
        family: 'moved-id';
        property: string;
        helper: string;
      }
    | {
        // Each property's read becomes its helper, given the item-selection plan.
        family: 'period-helper';
        helpers: Record<string, string>;
      }
  );

// A removed request parameter whose documented replacement sends the same request.
export interface RequestMove {
  rule: string;
  // `request-rename` sends the value under `replacement`; `request-wrap` sends
  // `replacement: { type: discriminator, [parameter]: value }`.
  family: 'request-rename' | 'request-wrap';
  operations: string[];
  parameter: string;
  replacement: string;
  discriminator?: string;
  source: string;
  warning: string;
}

export interface RulePack {
  formatVersion: 1;
  provider: string;
  fieldMoves: FieldMove[];
  requestMoves: RequestMove[];
  // `schema.property` → why a removed read stays for review.
  readReviews: Record<string, string>;
}

const FIELD_FAMILIES = new Set(['moved-value', 'moved-id', 'period-helper']);
const REQUEST_FAMILIES = new Set(['request-rename', 'request-wrap']);
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SOURCE = /^https:\/\/\S+$/;

function fail(file: string, message: string): never {
  throw new PipelineInputError(`Rule pack ${file}: ${message}`);
}

function strings(value: unknown, minimum = 1): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.every((entry) => typeof entry === 'string' && entry.length > 0)
  );
}

function checkCommon(file: string, entry: Record<string, unknown>, rules: Set<string>) {
  if (typeof entry.rule !== 'string' || !entry.rule) fail(file, 'every entry needs a rule.');
  if (rules.has(entry.rule)) fail(file, `rule ${entry.rule} is listed twice.`);
  rules.add(entry.rule);
  if (typeof entry.source !== 'string' || !SOURCE.test(entry.source))
    fail(file, `${entry.rule} needs an https source.`);
  if (typeof entry.warning !== 'string' || !entry.warning)
    fail(file, `${entry.rule} needs a warning.`);
}

export function parseRulePack(value: unknown, file: string): RulePack {
  if (!isObject(value) || value.formatVersion !== 1 || typeof value.provider !== 'string')
    fail(file, 'expected formatVersion 1 and a provider.');
  const { fieldMoves, requestMoves, readReviews } = value;
  if (!Array.isArray(fieldMoves) || !Array.isArray(requestMoves) || !isObject(readReviews))
    fail(file, 'expected fieldMoves, requestMoves and readReviews.');
  const rules = new Set<string>();
  for (const entry of fieldMoves) {
    if (!isObject(entry) || !FIELD_FAMILIES.has(entry.family as string))
      fail(file, `unknown field move family ${isObject(entry) ? String(entry.family) : ''}.`);
    checkCommon(file, entry, rules);
    if (!strings(entry.schemas)) fail(file, `${entry.rule} needs schemas.`);
    if (
      !Array.isArray(entry.targets) ||
      !entry.targets.length ||
      !entry.targets.every((path) => strings(path, 2))
    )
      fail(file, `${entry.rule} needs target paths.`);
    if (entry.family === 'period-helper') {
      const helpers = entry.helpers;
      if (
        !isObject(helpers) ||
        !Object.keys(helpers).length ||
        !Object.values(helpers).every((name) => typeof name === 'string' && IDENTIFIER.test(name))
      )
        fail(file, `${entry.rule} needs helpers.`);
    } else if (
      typeof entry.property !== 'string' ||
      typeof entry.helper !== 'string' ||
      !IDENTIFIER.test(entry.helper)
    )
      fail(file, `${entry.rule} needs a property and a helper.`);
    if (entry.droppedFields !== undefined && !strings(entry.droppedFields))
      fail(file, `${entry.rule} droppedFields must list fields.`);
    for (const flag of ['readsOnly', 'unlessExpanded', 'typeofGuard', 'narrowTested'])
      if (entry[flag] !== undefined && entry[flag] !== true)
        fail(file, `${entry.rule} ${flag} must be true when set.`);
  }
  for (const entry of requestMoves) {
    if (!isObject(entry) || !REQUEST_FAMILIES.has(entry.family as string))
      fail(file, `unknown request move family ${isObject(entry) ? String(entry.family) : ''}.`);
    checkCommon(file, entry, rules);
    if (
      !strings(entry.operations) ||
      typeof entry.parameter !== 'string' ||
      typeof entry.replacement !== 'string' ||
      !IDENTIFIER.test(entry.replacement)
    )
      fail(file, `${entry.rule} needs operations, a parameter and a replacement.`);
    if (entry.family === 'request-wrap' && typeof entry.discriminator !== 'string')
      fail(file, `${entry.rule} needs a discriminator.`);
  }
  for (const [field, reason] of Object.entries(readReviews))
    if (
      !/^[^.]+(\.[^.]+)+$/.test(field) ||
      typeof reason !== 'string' ||
      !/Source: https:\/\//.test(reason)
    )
      fail(file, `read review ${field} needs a schema.property key and a reason with its source.`);
  return value as unknown as RulePack;
}

export function loadRulePack(url: URL): RulePack {
  return parseRulePack(JSON.parse(readFileSync(url, 'utf8')), url.pathname);
}

export const STRIPE_PACK = loadRulePack(new URL('../data/packs/stripe.json', import.meta.url));
