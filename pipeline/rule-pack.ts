import { readdirSync, readFileSync } from 'node:fs';
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

// A removed request parameter whose documented replacement sends the same request, or a removed
// enum value of a request parameter whose documented successor replaces it.
export interface RequestMove {
  rule: string;
  // `request-rename` sends the value under `replacement`; `request-wrap` sends
  // `replacement: { type: discriminator, [parameter]: value }`; `request-enum-value` sends the
  // literal `value` of `parameter` as `replacement`, or with a discriminator as
  // `{ [discriminator]: replacement }`.
  family: 'request-rename' | 'request-wrap' | 'request-enum-value';
  operations: string[];
  parameter: string;
  replacement: string;
  discriminator?: string;
  value?: string;
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

export const FIELD_FAMILIES = new Set(['moved-value', 'moved-id', 'period-helper']);
export const REQUEST_FAMILIES = new Set(['request-rename', 'request-wrap', 'request-enum-value']);
export const ENUM_VALUE = /^[A-Za-z0-9_.-]+$/;
export const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SOURCE = /^https:\/\/\S+$/;
const RELEASE = /^\d+\.\d+\.\d+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function fail(file: string, message: string): never {
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

export function checkFieldMove(file: string, entry: unknown, rules: Set<string>) {
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
  for (const flag of ['unlessExpanded', 'typeofGuard', 'narrowTested'])
    if (entry[flag] !== undefined && entry[flag] !== true)
      fail(file, `${entry.rule} ${flag} must be true when set.`);
}

export function checkRequestMove(file: string, entry: unknown, rules: Set<string>) {
  if (!isObject(entry) || !REQUEST_FAMILIES.has(entry.family as string))
    fail(file, `unknown request move family ${isObject(entry) ? String(entry.family) : ''}.`);
  checkCommon(file, entry, rules);
  if (
    !strings(entry.operations) ||
    typeof entry.parameter !== 'string' ||
    typeof entry.replacement !== 'string' ||
    !(entry.family === 'request-enum-value' ? ENUM_VALUE : IDENTIFIER).test(entry.replacement)
  )
    fail(file, `${entry.rule} needs operations, a parameter and a replacement.`);
  if (
    entry.family === 'request-enum-value' &&
    (typeof entry.value !== 'string' || !ENUM_VALUE.test(entry.value))
  )
    fail(file, `${entry.rule} needs the removed enum value.`);
  if (entry.family === 'request-wrap' && typeof entry.discriminator !== 'string')
    fail(file, `${entry.rule} needs a discriminator.`);
  if (
    entry.family === 'request-enum-value' &&
    entry.discriminator !== undefined &&
    (typeof entry.discriminator !== 'string' || !IDENTIFIER.test(entry.discriminator))
  )
    fail(file, `${entry.rule} discriminator must be a property name.`);
}

export function parseRulePack(value: unknown, file: string): RulePack {
  if (!isObject(value) || value.formatVersion !== 1 || typeof value.provider !== 'string')
    fail(file, 'expected formatVersion 1 and a provider.');
  const { fieldMoves, requestMoves, readReviews } = value;
  if (!Array.isArray(fieldMoves) || !Array.isArray(requestMoves) || !isObject(readReviews))
    fail(file, 'expected fieldMoves, requestMoves and readReviews.');
  const rules = new Set<string>();
  for (const entry of fieldMoves) checkFieldMove(file, entry, rules);
  for (const entry of requestMoves) checkRequestMove(file, entry, rules);
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

// A rule table (data/rules/<provider>/<version>.json) holds the rules one API version needs, each
// with where it came from: the vendor page and its verbatim quote, the oasdiff entry between the
// two pinned contracts it answers, and whether it edits code (`auto`) or is only stored for review.
// Owner decision D3 (2026-10-27): a rule is `auto` only with a verified quote, a matching diff entry
// and a benchmark run with zero wrong patches, which `benchmark` names.
export const RULE_STATUSES = ['auto', 'review-only'] as const;
// `learned` rules come from proven AI fixes (founder decision, 2026-10-28; pipeline/learning.ts).
export const RULE_ORIGINS = ['generated', 'hand-written', 'learned'] as const;
const MAX_QUOTE_LENGTH = 1000;

export interface RuleProvenance {
  quote: string;
  checkedAt: string;
  // The oasdiff changelog entry, between the table's `previous` and `version` contracts.
  diff: { id: string; operationId: string; text: string };
  status: (typeof RULE_STATUSES)[number];
  origin: (typeof RULE_ORIGINS)[number];
  generatedBy?: { model: string; responseId: string };
  benchmark?: string;
  // A learned rule's proven fixes, and why it was rolled back (pipeline/learning.ts).
  learnedFrom?: { repo: string; run: string; grade: string | null }[];
  demoted?: { at: string; reason: string };
  // Further pages behind one field move, such as one page per object a helper reads, each verified
  // like the rule's own source.
  also?: Evidence[];
}

export interface Evidence {
  source: string;
  quote: string;
  diff: { id: string; operationId: string; text: string };
}

export type TableRule = (FieldMove | RequestMove) & RuleProvenance;

export interface RuleTable {
  formatVersion: 1;
  provider: string;
  // The API version that made the change, and the pinned version before it.
  version: string;
  previous: string;
  rules: TableRule[];
}

export const isFieldMove = <T extends FieldMove | RequestMove>(
  rule: T,
): rule is Extract<T, FieldMove> => FIELD_FAMILIES.has(rule.family);

export function parseRuleTable(value: unknown, file: string, rules = new Set<string>()): RuleTable {
  if (
    !isObject(value) ||
    value.formatVersion !== 1 ||
    typeof value.provider !== 'string' ||
    typeof value.version !== 'string' ||
    typeof value.previous !== 'string' ||
    !Array.isArray(value.rules)
  )
    fail(file, 'expected formatVersion 1, a provider, a version, its previous version and rules.');
  for (const entry of value.rules) {
    if (!isObject(entry)) fail(file, 'every rule must be an object.');
    if (FIELD_FAMILIES.has(entry.family as string)) checkFieldMove(file, entry, rules);
    else checkRequestMove(file, entry, rules);
    checkRuleProvenance(file, entry);
  }
  return value as unknown as RuleTable;
}

// The provenance every table rule carries, whichever provider and family: source pages with
// verbatim quotes, the contract diff entry it answers, its status and origin.
export function checkRuleProvenance(file: string, entry: Record<string, unknown>) {
  const name = entry.rule as string;
  if (typeof entry.checkedAt !== 'string' || !DAY.test(entry.checkedAt))
    fail(file, `${name} needs checkedAt as YYYY-MM-DD.`);
  const evidence = [entry, ...(Array.isArray(entry.also) ? entry.also : [])];
  if (entry.also !== undefined && (!Array.isArray(entry.also) || !entry.also.length))
    fail(file, `${name} also must list further evidence when set.`);
  for (const item of evidence) {
    const diff = isObject(item) ? item.diff : undefined;
    if (
      !isObject(item) ||
      typeof item.source !== 'string' ||
      !SOURCE.test(item.source) ||
      typeof item.quote !== 'string' ||
      !item.quote.trim() ||
      item.quote.length > MAX_QUOTE_LENGTH ||
      !isObject(diff) ||
      Object.keys(diff).sort().join(',') !== 'id,operationId,text' ||
      !Object.values(diff).every((part) => typeof part === 'string' && part.length > 0)
    )
      fail(
        file,
        `${name} needs each source with a quote of at most ${MAX_QUOTE_LENGTH} characters and its oasdiff entry as exactly id, operationId and text.`,
      );
  }
  if (!RULE_STATUSES.includes(entry.status as RuleProvenance['status']))
    fail(file, `${name} status must be auto or review-only.`);
  if (!RULE_ORIGINS.includes(entry.origin as RuleProvenance['origin']))
    fail(file, `${name} origin must be generated, hand-written or learned.`);
  if (
    entry.origin === 'learned' &&
    (!Array.isArray(entry.learnedFrom) ||
      new Set(entry.learnedFrom.map((item) => (isObject(item) ? String(item.repo) : ''))).size < 3)
  )
    fail(file, `${name} is learned and needs learnedFrom with at least 3 repositories.`);
  const generatedBy = entry.generatedBy;
  if (
    entry.origin === 'generated' &&
    (!isObject(generatedBy) ||
      typeof generatedBy.model !== 'string' ||
      !generatedBy.model ||
      typeof generatedBy.responseId !== 'string' ||
      !generatedBy.responseId)
  )
    fail(file, `${name} is generated and needs generatedBy with a model and a response id.`);
  if (entry.status === 'auto' && (typeof entry.benchmark !== 'string' || !entry.benchmark))
    fail(file, `${name} is auto and needs the benchmark run that showed zero wrong patches.`);
}

export function loadRuleTables(directory: URL, rules = new Set<string>()): RuleTable[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const url = new URL(name, directory);
      return parseRuleTable(JSON.parse(readFileSync(url, 'utf8')), url.pathname, rules);
    });
}

// A pack with the `auto` rules of its tables added; review-only rules edit nothing.
export function withRuleTables(pack: RulePack, tables: RuleTable[]): RulePack {
  const auto = tables.flatMap((table) => table.rules.filter((rule) => rule.status === 'auto'));
  const names = new Set([...pack.fieldMoves, ...pack.requestMoves].map((move) => move.rule));
  for (const rule of auto)
    if (names.has(rule.rule))
      fail(pack.provider, `rule ${rule.rule} is in both the pack and a rule table.`);
  return {
    ...pack,
    fieldMoves: [...pack.fieldMoves, ...auto.filter((rule) => isFieldMove(rule))],
    requestMoves: [
      ...pack.requestMoves,
      ...auto.filter((rule): rule is RequestMove & RuleProvenance => !isFieldMove(rule)),
    ],
  };
}

export const STRIPE_RULE_TABLES = loadRuleTables(new URL('../data/rules/stripe/', import.meta.url));
// Rules the autonomous loop promoted, in their own pack (pipeline/learning.ts).
export const STRIPE_LEARNED_TABLES = loadRuleTables(
  new URL('../data/learning/rules/stripe/', import.meta.url),
  new Set(STRIPE_RULE_TABLES.flatMap((table) => table.rules.map((rule) => rule.rule))),
);
export const STRIPE_PACK = withRuleTables(
  loadRulePack(new URL('../data/packs/stripe.json', import.meta.url)),
  [...STRIPE_RULE_TABLES, ...STRIPE_LEARNED_TABLES],
);
export const SHOPIFY_PACK = loadRulePack(new URL('../data/packs/shopify.json', import.meta.url));
