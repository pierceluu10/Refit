import { readdirSync, readFileSync } from 'node:fs';
import {
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  type GraphQLSchema,
} from 'graphql';
import type { CapturedDocumentation } from './documentation-sources.ts';
import { checkRuleProvenance, fail, IDENTIFIER, type RuleProvenance } from './rule-pack.ts';
import { pinnedShopifyDiff, type SchemaChange } from './shopify-schema-diff.ts';
import {
  pinnedShopifySchema,
  pinnedShopifyVersions,
  SHOPIFY_APIS,
  type ShopifyApi,
} from './shopify-schemas.ts';
import { isObject } from './specifications.ts';

// Shopify rule tables (data/rules/shopify/<api>-<version>.json) keep the Stripe tables' shape and
// provenance (pipeline/rule-pack.ts): each rule quotes a Shopify changelog entry or migration guide
// verbatim, and its `diff` is the schema change it answers, with the schema coordinate where the
// Stripe tables put the operation ID. Families:
// - graphql-rename: a field, argument, input field or enum value whose documented replacement is
//   another coordinate (a rename, or a move to another type such as Shop.draftOrders to
//   QueryRoot.draftOrders). The replacement must exist at the table's version with the same type
//   and every argument of the old field.
// - graphql-argument-drop: an argument or input field Shopify removed because only one value is
//   still allowed; a document may drop it only where it sends exactly that literal.
// - rest-to-graphql: a REST Admin endpoint and the GraphQL root field Shopify documents for it,
//   which must exist at the table's version.
// - webhook-topic-rename: a WebhookSubscriptionTopic value and its documented replacement.
// - package-major: a documented call rewrite in a major release of a Shopify npm package (table
//   api `packages`, no schema version); only the quote and the published release are checked.
// No Shopify rule edits code yet: every rule is review-only until a benchmark shows zero wrong
// patches (owner decision D3), and the Shopify tracer (pipeline/shopify-analysis.ts) reads them.
export const SHOPIFY_RULE_FAMILIES = [
  'graphql-rename',
  'graphql-argument-drop',
  'rest-to-graphql',
  'webhook-topic-rename',
  'package-major',
] as const;

interface ShopifyRuleBase extends RuleProvenance {
  rule: string;
  source: string;
  warning: string;
}

export type ShopifyRule = ShopifyRuleBase &
  (
    | { family: 'graphql-rename'; coordinate: string; replacement: string }
    | {
        family: 'graphql-argument-drop';
        coordinate: string;
        value: string | number | boolean | null;
      }
    | { family: 'rest-to-graphql'; method: string; path: string; replacement: string }
    | { family: 'webhook-topic-rename'; topic: string; replacement: string }
    | {
        family: 'package-major';
        package: string;
        major: number;
        symbol: string;
        replacement: string;
      }
  );

export interface ShopifyRuleTable {
  formatVersion: 1;
  provider: 'shopify';
  api: ShopifyApi | 'packages';
  // The API version that made the change and the pinned version before it; omitted for packages.
  version?: string;
  previous?: string;
  rules: ShopifyRule[];
}

// A change with no mechanical replacement, recorded so a repository that uses it is told before the
// version that removes it (data/shopify-alerts.json). `coordinates` may end in `*` to cover every
// coordinate with that prefix, such as `PriceRule*`, and is empty for a change outside the schema
// (a REST endpoint, a platform policy).
export interface ShopifyAlert {
  id: string;
  api: ShopifyApi;
  coordinates: string[];
  summary: string;
  // The version that removes or changes it (the page's effectiveApiVersion) and the day the page
  // names, each when known; an empty deadline means Shopify announced no date.
  deadline: { version?: string; date?: string };
  source: string;
  quote: string;
  checkedAt: string;
  origin: 'hand-written' | 'generated';
  generatedBy?: { model: string; responseId: string };
}

const COORDINATE =
  /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\([A-Za-z_][A-Za-z0-9_]*:\))?)?$/;
const VERSION = /^\d{4}-(?:01|04|07|10)$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE = /^https:\/\/(?:shopify\.dev|github\.com\/Shopify)\//;

const text = (value: unknown) => typeof value === 'string' && value.length > 0;

export function parseShopifyRuleTable(value: unknown, file: string, names = new Set<string>()) {
  if (
    !isObject(value) ||
    value.formatVersion !== 1 ||
    value.provider !== 'shopify' ||
    !(SHOPIFY_APIS.includes(value.api as ShopifyApi) || value.api === 'packages') ||
    !Array.isArray(value.rules)
  )
    fail(file, 'expected formatVersion 1, provider shopify, an api and rules.');
  if (
    value.api === 'packages'
      ? 'version' in value
      : !VERSION.test(String(value.version)) || !VERSION.test(String(value.previous))
  )
    fail(
      file,
      'a schema table needs version and previous as YYYY-MM; a packages table has neither.',
    );
  for (const entry of value.rules) {
    if (
      !isObject(entry) ||
      !text(entry.rule) ||
      !IDENTIFIER.test(String(entry.rule).replace(/-/g, '_'))
    )
      fail(file, 'every rule needs a name.');
    const name = entry.rule as string;
    if (names.has(name)) fail(file, `${name} is defined twice.`);
    names.add(name);
    if (!SHOPIFY_RULE_FAMILIES.includes(entry.family as ShopifyRule['family']))
      fail(file, `${name} has an unknown family.`);
    if (!text(entry.source) || !SOURCE.test(String(entry.source)) || !text(entry.warning))
      fail(file, `${name} needs a shopify.dev or Shopify GitHub source and a warning.`);
    if (entry.status !== 'review-only') fail(file, `${name} must be review-only.`);
    const shape =
      entry.family === 'graphql-rename'
        ? COORDINATE.test(String(entry.coordinate)) && COORDINATE.test(String(entry.replacement))
        : entry.family === 'graphql-argument-drop'
          ? COORDINATE.test(String(entry.coordinate)) &&
            (['string', 'number', 'boolean'].includes(typeof entry.value) || entry.value === null)
          : entry.family === 'rest-to-graphql'
            ? /^(GET|POST|PUT|DELETE)$/.test(String(entry.method)) &&
              text(entry.path) &&
              COORDINATE.test(String(entry.replacement))
            : entry.family === 'webhook-topic-rename'
              ? /^[A-Z0-9_]+$/.test(String(entry.topic)) &&
                /^[A-Z0-9_]+$/.test(String(entry.replacement))
              : text(entry.package) &&
                Number.isInteger(entry.major) &&
                text(entry.symbol) &&
                text(entry.replacement);
    if (!shape) fail(file, `${name} is missing the values its family needs.`);
    if ((value.api === 'packages') !== (entry.family === 'package-major'))
      fail(file, `${name}: package rules go in the packages table and only there.`);
    checkRuleProvenance(file, entry);
  }
  return value as unknown as ShopifyRuleTable;
}

const TABLES = new URL('../data/rules/shopify/', import.meta.url);
const ALERTS = new URL('../data/shopify-alerts.json', import.meta.url);

export function loadShopifyRuleTables(directory = TABLES) {
  const names = new Set<string>();
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const url = new URL(name, directory);
      return parseShopifyRuleTable(JSON.parse(readFileSync(url, 'utf8')), url.pathname, names);
    });
}

export function parseShopifyAlerts(value: unknown, file: string): ShopifyAlert[] {
  if (!isObject(value) || value.formatVersion !== 1 || !Array.isArray(value.alerts))
    fail(file, 'expected formatVersion 1 and alerts.');
  const ids = new Set<string>();
  for (const alert of value.alerts) {
    if (
      !isObject(alert) ||
      !text(alert.id) ||
      ids.has(alert.id as string) ||
      !SHOPIFY_APIS.includes(alert.api as ShopifyApi) ||
      !Array.isArray(alert.coordinates) ||
      !alert.coordinates.every((item) => COORDINATE.test(String(item).replace(/\*$/, ''))) ||
      !text(alert.summary) ||
      !isObject(alert.deadline) ||
      (alert.deadline.version !== undefined && !VERSION.test(String(alert.deadline.version))) ||
      (alert.deadline.date !== undefined && !DAY.test(String(alert.deadline.date))) ||
      !text(alert.source) ||
      !SOURCE.test(String(alert.source)) ||
      !text(alert.quote) ||
      String(alert.quote).length > 1000 ||
      !DAY.test(String(alert.checkedAt)) ||
      !['hand-written', 'generated'].includes(alert.origin as string) ||
      (alert.origin === 'generated' &&
        (!isObject(alert.generatedBy) ||
          !text(alert.generatedBy.model) ||
          !text(alert.generatedBy.responseId)))
    )
      fail(
        file,
        `invalid or repeated alert ${JSON.stringify(isObject(alert) ? alert.id : alert)}.`,
      );
    ids.add(alert.id as string);
  }
  return value.alerts as ShopifyAlert[];
}

export const loadShopifyAlerts = () =>
  parseShopifyAlerts(JSON.parse(readFileSync(ALERTS, 'utf8')), ALERTS.pathname);

// The schema member at a coordinate, as a comparable signature, or undefined when it is absent.
export function coordinateSignature(schema: GraphQLSchema, coordinate: string) {
  const [, typeName, member, argument] =
    /^([^.]+)(?:\.([^(]+)(?:\(([^:]+):\))?)?$/.exec(coordinate) ?? [];
  const type = typeName ? schema.getType(typeName) : undefined;
  if (!type) return undefined;
  if (!member) return type.toString();
  if (isEnumType(type))
    return argument ? undefined : type.getValue(member) ? 'enum value' : undefined;
  if (isInputObjectType(type)) {
    const field = argument ? undefined : type.getFields()[member];
    return field && String(field.type);
  }
  if (!isObjectType(type) && !isInterfaceType(type)) return undefined;
  const field = type.getFields()[member];
  if (!field) return undefined;
  if (argument) {
    const match = field.args.find((item) => item.name === argument);
    return match && String(match.type);
  }
  return `${String(field.type)}(${field.args.map((item) => `${item.name}:${String(item.type)}`).join(',')})`;
}

// The arguments a field signature accepts, by name.
const signatureArguments = (signature: string) =>
  new Map(
    (/\((.*)\)$/.exec(signature)?.[1] ?? '')
      .split(',')
      .filter(Boolean)
      .map((item) => item.split(':') as [string, string]),
  );

// What a rule is checked against: the saved Shopify pages, by URL without `.md`.
export interface ShopifyRuleEvidence {
  pages: Map<string, CapturedDocumentation>;
  releases?: (name: string) => Promise<string[]>;
}

function quoteProblems(
  rule: { source: string; quote: string },
  pages: ShopifyRuleEvidence['pages'],
) {
  const page = pages.get(rule.source);
  if (!page) return [`no captured page for ${rule.source}`];
  return page.content.includes(rule.quote)
    ? []
    : [`the quote is not in the captured page ${rule.source} verbatim`];
}

// The schema change a coordinate names between a table's two pinned versions. A table for the
// oldest pin or older is checked against the oldest pin alone: the coordinate must be absent from
// it. A change from an unpinned quarter between two pins goes in the next pinned version's table,
// whose diff contains it.
export function answeredChange(
  api: ShopifyApi,
  version: string,
  coordinate: string,
): SchemaChange | undefined {
  const versions = pinnedShopifyVersions(api);
  if (version <= versions[0]) {
    const oldest = pinnedShopifySchema(api, versions[0]).schema;
    if (coordinateSignature(oldest, coordinate) !== undefined) return undefined;
    return {
      id: 'removed-before-pins' as SchemaChange['id'],
      coordinate,
      text: `${coordinate} is absent from the oldest pinned ${api} schema, ${versions[0]}.`,
      breaking: true,
    };
  }
  return pinnedShopifyDiff(api, version).changes.find(
    (change) => change.coordinate === coordinate && change.id !== 'enum-value-added',
  );
}

// The schema a rule's replacement must exist in: the table's version, or the oldest pin for a table
// older than every pin.
function targetSchema(api: ShopifyApi, version: string) {
  const versions = pinnedShopifyVersions(api);
  return pinnedShopifySchema(api, versions.includes(version) ? version : versions[0]).schema;
}

export async function verifyShopifyRule(
  rule: ShopifyRule,
  table: ShopifyRuleTable,
  evidence: ShopifyRuleEvidence,
) {
  const problems = [
    ...quoteProblems(rule, evidence.pages),
    ...(rule.also ?? []).flatMap((item) => quoteProblems(item, evidence.pages)),
  ];
  if (rule.family === 'package-major' || table.api === 'packages') {
    if (rule.family !== 'package-major' || table.api !== 'packages')
      return [...problems, 'package rules go in the packages table and only there'];
    const releases = (await evidence.releases?.(rule.package)) ?? [];
    if (!releases.some((release) => release.startsWith(`${rule.major}.`)))
      problems.push(`${rule.package} has no published ${rule.major}.x release`);
    const expected = {
      id: 'package-major',
      operationId: `${rule.package}@${rule.major}`,
      text: `${rule.symbol} is replaced by ${rule.replacement} in ${rule.package} ${rule.major}.0.0.`,
    };
    if (JSON.stringify(rule.diff) !== JSON.stringify(expected))
      problems.push(`the diff entry must be ${JSON.stringify(expected)}`);
    return problems;
  }
  const api = table.api;
  const version = table.version!;
  const versions = pinnedShopifyVersions(api);
  const index = versions.indexOf(version);
  if (index > 0 && versions[index - 1] !== table.previous)
    return [
      ...problems,
      `the ${version} table must compare against the pinned ${versions[index - 1]}`,
    ];
  if (index < 0 && version > versions[0])
    return [
      ...problems,
      `${api} ${version} is not pinned; use the table of the next pinned version`,
    ];
  const target = targetSchema(api, version);
  if (rule.family === 'rest-to-graphql') {
    if (
      !/^(QueryRoot|Mutation)\./.test(rule.replacement) ||
      coordinateSignature(target, rule.replacement) === undefined
    )
      problems.push(`${rule.replacement} is not a root field of admin ${version}`);
    const expected = {
      id: 'graphql-replacement-present',
      operationId: rule.replacement,
      text: `${rule.method} ${rule.path} is answered by ${rule.replacement}.`,
    };
    if (JSON.stringify(rule.diff) !== JSON.stringify(expected))
      problems.push(`the diff entry must be ${JSON.stringify(expected)}`);
    return problems;
  }
  const coordinate =
    rule.family === 'webhook-topic-rename'
      ? `WebhookSubscriptionTopic.${rule.topic}`
      : rule.coordinate;
  const change = answeredChange(api, version, coordinate);
  if (!change)
    return [
      ...problems,
      `no change to ${coordinate} between the pinned ${api} ${table.previous} and ${version} schemas`,
    ];
  if (
    rule.diff.id !== change.id ||
    rule.diff.operationId !== coordinate ||
    rule.diff.text !== change.text
  )
    problems.push(
      `the diff entry must be ${JSON.stringify({ id: change.id, operationId: coordinate, text: change.text })}`,
    );
  if (rule.family === 'graphql-argument-drop') return problems;
  const replacement =
    rule.family === 'webhook-topic-rename'
      ? `WebhookSubscriptionTopic.${rule.replacement}`
      : rule.replacement;
  const after = coordinateSignature(target, replacement);
  if (after === undefined)
    return [...problems, `${replacement} is not in the ${api} ${version} schema`];
  if (rule.family === 'graphql-rename') {
    const previous = pinnedShopifySchema(
      api,
      versions.includes(table.previous!) ? table.previous! : versions[0],
    ).schema;
    const before = coordinateSignature(previous, coordinate);
    // A rule older than the pins cannot read the old member; its replacement is checked alone.
    if (before !== undefined) {
      const fieldPart = (signature: string) => signature.replace(/\(.*\)$/, '');
      if (fieldPart(before) !== fieldPart(after))
        problems.push(`${replacement} has type ${fieldPart(after)}, not ${fieldPart(before)}`);
      const accepted = signatureArguments(after);
      for (const [name, type] of signatureArguments(before))
        if (accepted.get(name) !== type)
          problems.push(`${replacement} does not take ${name}: ${type}`);
    }
  }
  return problems;
}

export type CoverageState = 'rule' | 'alert-only' | 'unmapped';

// Every breaking or deprecated change in every pinned diff, with the rule or alert that answers it.
export function shopifyCoverage(tables: ShopifyRuleTable[], alerts: ShopifyAlert[]) {
  const rows: {
    api: ShopifyApi;
    version: string;
    change: SchemaChange;
    state: CoverageState;
    by?: string;
  }[] = [];
  for (const api of SHOPIFY_APIS)
    for (const version of pinnedShopifyVersions(api).slice(1))
      for (const change of pinnedShopifyDiff(api, version).changes) {
        if (!change.breaking && change.id !== 'deprecated') continue;
        const rule = tables
          .filter((table) => table.api === api)
          .flatMap((table) => table.rules)
          .find((item) => item.diff.operationId === change.coordinate);
        const alert = alerts.find(
          (item) =>
            item.api === api &&
            item.coordinates.some((pattern) =>
              pattern.endsWith('*')
                ? change.coordinate.startsWith(pattern.slice(0, -1))
                : pattern === change.coordinate,
            ),
        );
        rows.push({
          api,
          version,
          change,
          state: rule ? 'rule' : alert ? 'alert-only' : 'unmapped',
          by: rule?.rule ?? alert?.id,
        });
      }
  return rows;
}

// An alert's evidence: its quote verbatim, every exact coordinate present in some pinned schema of
// its API (a glob must match at least one change), and its date, when given, written in the page.
export function verifyShopifyAlert(alert: ShopifyAlert, pages: ShopifyRuleEvidence['pages']) {
  const problems = quoteProblems(alert, pages);
  const versions = pinnedShopifyVersions(alert.api);
  for (const coordinate of alert.coordinates) {
    const prefix = coordinate.endsWith('*') ? coordinate.slice(0, -1) : undefined;
    const known = versions.some((version) => {
      const schema = pinnedShopifySchema(alert.api, version).schema;
      return prefix
        ? Object.keys(schema.getTypeMap()).some((name) => name.startsWith(prefix.split('.')[0]))
        : coordinateSignature(schema, coordinate) !== undefined;
    });
    if (!known) problems.push(`${coordinate} is in no pinned ${alert.api} schema`);
  }
  const page = pages.get(alert.source);
  if (alert.deadline.date && page && !pageDates(page.content).has(alert.deadline.date))
    problems.push(`the page does not name ${alert.deadline.date}`);
  return problems;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

// Every day a page names, as ISO dates: ISO dates, metadata timestamps and "Month D, YYYY".
export function pageDates(content: string) {
  const days = new Set<string>(content.match(/\d{4}-\d{2}-\d{2}/g) ?? []);
  for (const [, month, day, year] of content.matchAll(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}),? (\d{4})\b/g,
  ))
    days.add(
      `${year}-${String(MONTHS.indexOf(month) + 1).padStart(2, '0')}-${day.padStart(2, '0')}`,
    );
  return days;
}
