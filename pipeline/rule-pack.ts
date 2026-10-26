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

// A fact about a provider's SDK releases, read from its published packages or changelogs. Facts
// edit nothing; a provider's rules consult them before an edit names an SDK symbol.
interface SdkFactBase {
  package: string;
  source: string;
  // The day someone read the source.
  checkedAt: string;
}

export type SdkFact = SdkFactBase &
  (
    | {
        // The first release whose types define each member of `symbol`.
        family: 'member-since';
        symbol: string;
        since: Record<string, string>;
      }
    | {
        // The value `symbol` has from each listed release on (ascending), until `removedIn`.
        family: 'constant-value';
        symbol: string;
        values: [string, string][];
        removedIn?: string;
      }
    | {
        // The oldest major of the package that serves a supported API version.
        family: 'minimum-major';
        major: number;
      }
  );

export interface RulePack {
  formatVersion: 1;
  provider: string;
  fieldMoves: FieldMove[];
  requestMoves: RequestMove[];
  // `schema.property` → why a removed read stays for review.
  readReviews: Record<string, string>;
  // Optional in a pack file; empty when absent.
  sdkFacts: SdkFact[];
  // SDK identifier → why a use of it stops for review in an SDK upgrade.
  symbolReviews: Record<string, { reason: string; source: string }>;
}

const FIELD_FAMILIES = new Set(['moved-value', 'moved-id', 'period-helper']);
const REQUEST_FAMILIES = new Set(['request-rename', 'request-wrap']);
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SOURCE = /^https:\/\/\S+$/;
const RELEASE = /^\d+\.\d+\.\d+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

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
  const sdkFacts = value.sdkFacts ?? [];
  const symbolReviews = value.symbolReviews ?? {};
  if (!Array.isArray(sdkFacts) || !isObject(symbolReviews))
    fail(file, 'sdkFacts must be a list and symbolReviews an object.');
  for (const fact of sdkFacts) checkFact(file, fact);
  for (const [symbol, review] of Object.entries(symbolReviews))
    if (
      !IDENTIFIER.test(symbol) ||
      !isObject(review) ||
      typeof review.reason !== 'string' ||
      !review.reason ||
      typeof review.source !== 'string' ||
      !SOURCE.test(review.source)
    )
      fail(file, `symbol review ${symbol} needs an identifier key, a reason and an https source.`);
  return { ...value, sdkFacts, symbolReviews } as unknown as RulePack;
}

function checkFact(file: string, fact: unknown) {
  if (!isObject(fact) || typeof fact.package !== 'string' || !fact.package)
    fail(file, 'every SDK fact needs a package.');
  const name = `${String(fact.family)} fact for ${fact.package}`;
  if (typeof fact.source !== 'string' || !SOURCE.test(fact.source))
    fail(file, `${name} needs an https source.`);
  if (typeof fact.checkedAt !== 'string' || !DAY.test(fact.checkedAt))
    fail(file, `${name} needs checkedAt as YYYY-MM-DD.`);
  if (fact.family === 'minimum-major') {
    if (!Number.isInteger(fact.major) || (fact.major as number) < 1)
      fail(file, `${name} needs a positive major.`);
    return;
  }
  if (typeof fact.symbol !== 'string' || !IDENTIFIER.test(fact.symbol))
    fail(file, `${name} needs a symbol.`);
  if (fact.family === 'member-since') {
    const since = fact.since;
    if (
      !isObject(since) ||
      !Object.keys(since).length ||
      !Object.entries(since).every(
        ([member, release]) =>
          IDENTIFIER.test(member) && typeof release === 'string' && RELEASE.test(release),
      )
    )
      fail(file, `${name} needs members with releases.`);
    return;
  }
  if (fact.family === 'constant-value') {
    const values = fact.values;
    if (
      !Array.isArray(values) ||
      !values.length ||
      !values.every(
        (entry, index) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === 'string' &&
          RELEASE.test(entry[0]) &&
          typeof entry[1] === 'string' &&
          entry[1].length > 0 &&
          (index === 0 || compareReleases(values[index - 1][0], entry[0]) < 0),
      )
    )
      fail(file, `${name} needs values as [release, value] in ascending release order.`);
    if (
      fact.removedIn !== undefined &&
      (typeof fact.removedIn !== 'string' || !RELEASE.test(fact.removedIn))
    )
      fail(file, `${name} removedIn must be a release.`);
    return;
  }
  fail(file, `unknown SDK fact family ${String(fact.family)}.`);
}

// Orders `major.minor.patch` releases; a prerelease or build suffix is ignored.
export function compareReleases(left: string, right: string) {
  const parts = (value: string) => value.split(/[.-]/).slice(0, 3).map(Number);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

function sdkFact<Family extends SdkFact['family']>(
  pack: RulePack,
  family: Family,
  name: string,
  symbol?: string,
) {
  const fact = pack.sdkFacts.find(
    (entry) =>
      entry.family === family &&
      entry.package === name &&
      (symbol === undefined || ('symbol' in entry && entry.symbol === symbol)),
  );
  if (!fact)
    throw new PipelineInputError(
      `Rule pack ${pack.provider} has no ${family} fact for ${name}${symbol ? ` ${symbol}` : ''}.`,
    );
  return fact as Extract<SdkFact, { family: Family }>;
}

// Member → first release defining it.
export function membersSince(pack: RulePack, name: string, symbol: string) {
  return sdkFact(pack, 'member-since', name, symbol).since;
}

// Whether `release` defines `member`. Unknown members and unparseable releases answer false, so an
// edit naming the member stops for review instead of guessing.
export function releaseDefines(since: Record<string, string>, release: string, member: string) {
  const first = since[member];
  if (!first || !/^\d+\.\d+\.\d+/.test(release)) return false;
  return compareReleases(release, first) >= 0;
}

// The value a constant has in `release`, or undefined before its first or from its removal on.
export function constantValue(pack: RulePack, name: string, symbol: string, release: string) {
  const fact = sdkFact(pack, 'constant-value', name, symbol);
  if (
    !/^\d+\.\d+\.\d+/.test(release) ||
    (fact.removedIn && compareReleases(release, fact.removedIn) >= 0)
  )
    return undefined;
  return fact.values.filter(([since]) => compareReleases(release, since) >= 0).at(-1)?.[1];
}

// Package → oldest supported major, in pack order.
export function minimumMajors(pack: RulePack): Record<string, number> {
  return Object.fromEntries(
    pack.sdkFacts.flatMap((fact) =>
      fact.family === 'minimum-major' ? [[fact.package, fact.major]] : [],
    ),
  );
}

export function loadRulePack(url: URL): RulePack {
  return parseRulePack(JSON.parse(readFileSync(url, 'utf8')), url.pathname);
}

export const STRIPE_PACK = loadRulePack(new URL('../data/packs/stripe.json', import.meta.url));
export const SHOPIFY_PACK = loadRulePack(new URL('../data/packs/shopify.json', import.meta.url));
