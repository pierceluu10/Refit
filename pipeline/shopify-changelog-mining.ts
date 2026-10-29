import type { AiOptions } from './ai-budget.ts';
import type { CapturedDocumentation } from './documentation-sources.ts';
import { requestStructuredOutput, UnusableAiResponse } from './openai.ts';
import {
  answeredChange,
  SHOPIFY_RULE_FAMILIES,
  verifyShopifyAlert,
  verifyShopifyRule,
  type ShopifyAlert,
  type ShopifyRule,
  type ShopifyRuleEvidence,
  type ShopifyRuleTable,
} from './shopify-rules.ts';
import { pinnedShopifyDiff } from './shopify-schema-diff.ts';
import { pinnedShopifyVersions, SHOPIFY_APIS, type ShopifyApi } from './shopify-schemas.ts';
import { PipelineInputError } from './types.ts';

// AI changelog mining (founder decision, 2026-10-29: maximise useful AI use). The model reads one
// Shopify changelog entry and the schema changes it may describe, and proposes rules and alerts.
// Code derives everything the schemas decide (the diff entry, the table versions) and verifies each
// candidate as `refit rules check` does; a rule candidate that fails becomes an alert when its quote
// verifies, so nothing the entry announces is lost, and an alert's version comes from the page's
// own effectiveApiVersion, never from the model.

export interface ChangelogEntry {
  title: string;
  url: string;
  slug: string;
  published: string;
  categories: string[];
}

// The API areas whose changes Refit can find in code, and the tags that announce a change.
const AREAS = new Set([
  'GraphQL Admin API',
  'Storefront API',
  'Customer Account API',
  'Events &amp; webhooks',
  'Admin REST API',
  'App Bridge',
  'Polaris',
  'Hydrogen',
  'Shopify CLI',
  'Metafields and metaobjects',
]);
const CHANGE_TAGS = new Set([
  'Action Required',
  'Breaking API Change',
  'Deprecation announcement',
  'Update',
]);

export function changelogEntries(feed: string): ChangelogEntry[] {
  return [...feed.matchAll(/<item>([\s\S]*?)<\/item>/g)].flatMap(([, item]) => {
    const link = /<link>https:\/\/shopify\.dev\/changelog\/([a-z0-9-]+)<\/link>/.exec(item);
    const title = /<title>([\s\S]*?)<\/title>/.exec(item);
    const published = /<atom:published>([^<]+)<\/atom:published>/.exec(item);
    if (!link || !title || !published) return [];
    return [
      {
        title: title[1].trim(),
        url: `https://shopify.dev/changelog/posts/${link[1]}.md`,
        slug: link[1],
        published: published[1].slice(0, 10),
        categories: [...item.matchAll(/<category>([^<]+)<\/category>/g)].map((match) => match[1]),
      },
    ];
  });
}

export const isChangeEntry = (entry: ChangelogEntry) =>
  entry.categories.some((category) => AREAS.has(category)) &&
  entry.categories.some((category) => CHANGE_TAGS.has(category));

// The page's front-matter fields Refit reads: the version a change takes effect in and its APIs.
export function entryMetadata(content: string) {
  const version = /^\s*effectiveApiVersion: '?(\d{4}-\d{2})'?$/m.exec(content)?.[1];
  const handles = [...content.matchAll(/^\s*handle: ([a-z0-9-]+)$/gm)].map((match) => match[1]);
  return { version, handles };
}

const MAX_DIGEST = 200;

// The breaking and deprecated schema changes an entry may describe: those whose type or member name
// the page mentions, from every pinned diff of every API.
export function entryDigest(content: string) {
  const words = new Set(content.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
  const lines: string[] = [];
  for (const api of SHOPIFY_APIS)
    for (const version of pinnedShopifyVersions(api).slice(1))
      for (const change of pinnedShopifyDiff(api, version).changes)
        if (
          (change.breaking || change.id === 'deprecated') &&
          change.coordinate.split(/[.():]/).some((part) => part && words.has(part)) &&
          lines.length < MAX_DIGEST
        )
          lines.push(`${api} ${version} ${change.id} ${change.text}`);
  return lines;
}

const MAX_CANDIDATES = 20;

const INSTRUCTIONS = `You turn one Shopify developer changelog entry into migration rules and alerts for Refit, which edits customer code that calls Shopify's Admin GraphQL, Storefront and Customer Account APIs, REST Admin API, webhooks and npm packages. You receive the entry's Markdown and the schema changes between Refit's pinned GraphQL schemas whose names the entry mentions ("<api> <version> <change id> <text>").

Propose a rule (kind "rule") only where the entry names an exact one-to-one replacement that keeps behaviour, in one of these families:
- "graphql-rename": a field, argument, input field or enum value replaced by another coordinate with the same type and arguments (also a field moved to another type, such as Shop.draftOrders to QueryRoot.draftOrders). coordinate is the old schema coordinate, replacement the new one. Coordinates: "Type.field", "Type.field(argument:)", "InputType.field", "EnumType.VALUE"; root fields are "QueryRoot.x" (Admin; Storefront also uses QueryRoot) and "Mutation.x".
- "graphql-argument-drop": an argument or input field removed because only one value remains allowed; value is that value (JSON scalar as a string, such as "true").
- "rest-to-graphql": a REST Admin endpoint the entry maps to one GraphQL root field. method, path (as "products.json" or "products/{id}.json"), replacement "QueryRoot.x" or "Mutation.x".
- "webhook-topic-rename": a webhook topic replaced by another; topic and replacement as WebhookSubscriptionTopic values (PRODUCTS_UPDATE).
- "package-major": a call rewrite in a major release of a Shopify npm package; package, major, symbol (old call) and replacement (new call).

Everything else the entry announces that can break customer code — removals without an exact replacement, behaviour changes, new required inputs, type changes, version or platform deadlines, REST endpoints without a one-to-one GraphQL field — is an alert (kind "alert"): coordinates lists every affected schema coordinate (a prefix ending in "*" for a whole family of types such as "PriceRule*"; empty when the change is outside the schemas), summary says in one sentence what breaks and what to do, date is the removal or deadline day the entry writes (YYYY-MM-DD, "" when none). Propose nothing for purely additive entries.

Fields, all required; use "" where a field does not apply:
- kind, family ("" for alerts), api ("admin", "storefront" or "customer-account"), version (the API version the change takes effect in, YYYY-MM, "" when the entry names none).
- coordinate, replacement, value, method, path, topic, package, major (a number as a string), symbol: per family.
- coordinates, summary, date: alerts.
- quote: one sentence, list item or table row copied character for character from the entry that states the change. Copy it exactly, including backticks and punctuation; do not join or shorten text.
- warning: rules only, one or two sentences for a reviewer saying what the edit does.
- rationale: why the entry shows the replacement keeps behaviour, or why this is an alert.

A missing rule is safe; a wrong rule edits customer code wrongly. Return at most ${MAX_CANDIDATES} items; return an empty list when the entry has none.`;

const FIELDS = [
  'kind',
  'family',
  'api',
  'version',
  'coordinate',
  'replacement',
  'value',
  'method',
  'path',
  'topic',
  'package',
  'major',
  'symbol',
  'summary',
  'date',
  'quote',
  'warning',
  'rationale',
] as const;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [...FIELDS, 'coordinates'],
        properties: {
          ...Object.fromEntries(FIELDS.map((field) => [field, { type: 'string' }])),
          kind: { type: 'string', enum: ['rule', 'alert'] },
          family: { type: 'string', enum: ['', ...SHOPIFY_RULE_FAMILIES] },
          api: { type: 'string', enum: [...SHOPIFY_APIS] },
          coordinates: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

export type MinedCandidate = Record<(typeof FIELDS)[number], string> & { coordinates: string[] };

export interface EntryMining {
  slug: string;
  url: string;
  candidates: MinedCandidate[];
  error: string | null;
  model: string | null;
  responseId: string | null;
  costUsd: number;
}

// One request per entry; an unusable answer is recorded as the entry's error, never retried.
export async function mineEntry(
  entry: ChangelogEntry,
  page: CapturedDocumentation,
  options: AiOptions,
): Promise<EntryMining> {
  const evidence = {
    entry: {
      title: entry.title,
      url: page.url,
      sha256: page.hash,
      published: entry.published,
      categories: entry.categories,
    },
    markdown: page.content,
    schemaChanges: entryDigest(page.content),
  };
  const failed = { slug: entry.slug, url: page.url, candidates: [], model: null, responseId: null };
  try {
    const response = await requestStructuredOutput(
      { evidence, instructions: INSTRUCTIONS, name: 'shopify_migration_rules', schema: SCHEMA },
      options,
    );
    const recorded = {
      slug: entry.slug,
      url: page.url,
      model: response.model,
      responseId: response.responseId,
      costUsd: response.budget?.costUsd ?? 0,
    };
    const parsed: unknown = JSON.parse(response.content);
    const items = (parsed as { items?: unknown }).items;
    if (!Array.isArray(items) || items.length > MAX_CANDIDATES)
      return { ...recorded, candidates: [], error: 'The model returned no item list.' };
    return { ...recorded, candidates: items as MinedCandidate[], error: null };
  } catch (error) {
    if (!(error instanceof PipelineInputError)) throw error;
    const costUsd = error instanceof UnusableAiResponse ? (error.budget?.costUsd ?? 0) : 0;
    return { ...failed, error: error.message, costUsd };
  }
}

const slugPart = (value: string) =>
  value
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

// The table a schema rule belongs in: the first pinned version at or after the change's version,
// whose diff contains it, and the pinned version before that; for a change in the oldest pinned
// version or earlier, that version and the quarter before it.
export function tableFor(api: ShopifyApi, version: string): ShopifyRuleTable | undefined {
  if (!/^\d{4}-(?:01|04|07|10)$/.test(version)) return undefined;
  const versions = pinnedShopifyVersions(api);
  const pinned = versions.find((item) => item >= version);
  if (!pinned) return undefined;
  const index = versions.indexOf(pinned);
  const [year, month] = version.split('-').map(Number);
  const target = index === 0 ? version : pinned;
  const previous =
    index > 0
      ? versions[index - 1]
      : month === 1
        ? `${year - 1}-10`
        : `${year}-${String(month - 3).padStart(2, '0')}`;
  return { formatVersion: 1, provider: 'shopify', api, version: target, previous, rules: [] };
}

export type Outcome =
  | { kind: 'rule'; rule: ShopifyRule; table: ShopifyRuleTable }
  | { kind: 'alert'; alert: ShopifyAlert; refusedRule?: string[] }
  | { kind: 'refused'; reasons: string[] };

// A verified rule, else a verified alert, else why neither holds. The diff entry, the table
// versions and an alert's version are derived here, never taken from the model.
export async function completeMined(
  candidate: MinedCandidate,
  context: {
    source: string;
    checkedAt: string;
    generatedBy: { model: string; responseId: string };
    page: CapturedDocumentation;
  },
  evidence: ShopifyRuleEvidence,
): Promise<Outcome> {
  const api = candidate.api as ShopifyApi;
  const common = {
    source: context.source,
    quote: candidate.quote,
    checkedAt: context.checkedAt,
    status: 'review-only' as const,
    origin: 'generated' as const,
    generatedBy: context.generatedBy,
  };
  let refusedRule: string[] | undefined;
  if (candidate.kind === 'rule') {
    const outcome = await ruleOutcome(candidate, api, common, evidence);
    if ('rule' in outcome) return { kind: 'rule', ...outcome };
    refusedRule = outcome.reasons;
  }
  const alert: ShopifyAlert = {
    id: `shopify-alert-${slugPart(context.source.split('/').pop()!)}-${slugPart(candidate.coordinates[0] ?? candidate.coordinate ?? 'change').slice(0, 60) || 'change'}`,
    api,
    coordinates: [
      ...new Set(
        candidate.coordinates.length
          ? candidate.coordinates
          : candidate.coordinate
            ? [candidate.coordinate]
            : [],
      ),
    ],
    summary: candidate.summary || candidate.warning || candidate.rationale,
    deadline: {
      ...(entryMetadata(context.page.content).version
        ? { version: entryMetadata(context.page.content).version }
        : {}),
      ...(candidate.date ? { date: candidate.date } : {}),
    },
    source: common.source,
    quote: common.quote,
    checkedAt: common.checkedAt,
    origin: 'generated',
    generatedBy: common.generatedBy,
  };
  const problems =
    alert.summary && alert.quote
      ? verifyShopifyAlert(alert, evidence.pages)
      : ['the candidate has no summary or quote'];
  // A date the page does not write is dropped rather than refusing the whole alert.
  if (problems.length === 1 && problems[0].startsWith('the page does not name')) {
    delete alert.deadline.date;
    return { kind: 'alert', alert, refusedRule };
  }
  return problems.length
    ? { kind: 'refused', reasons: [...(refusedRule ?? []), ...problems] }
    : { kind: 'alert', alert, refusedRule };
}

async function ruleOutcome(
  candidate: MinedCandidate,
  api: ShopifyApi,
  common: Omit<ShopifyRule, 'rule' | 'family' | 'warning' | 'diff'> & { source: string },
  evidence: ShopifyRuleEvidence,
): Promise<{ rule: ShopifyRule; table: ShopifyRuleTable } | { reasons: string[] }> {
  const family = candidate.family as ShopifyRule['family'];
  if (!SHOPIFY_RULE_FAMILIES.includes(family)) return { reasons: ['no rule family'] };
  if (family === 'package-major') {
    const major = Number(candidate.major);
    const rule = {
      ...common,
      rule: `shopify-${slugPart(candidate.package)}-${major}-${slugPart(candidate.symbol)}`.slice(
        0,
        120,
      ),
      family,
      package: candidate.package,
      major,
      symbol: candidate.symbol,
      replacement: candidate.replacement,
      warning: candidate.warning,
      diff: {
        id: 'package-major',
        operationId: `${candidate.package}@${major}`,
        text: `${candidate.symbol} is replaced by ${candidate.replacement} in ${candidate.package} ${major}.0.0.`,
      },
    } as ShopifyRule;
    const table: ShopifyRuleTable = {
      formatVersion: 1,
      provider: 'shopify',
      api: 'packages',
      rules: [],
    };
    const reasons = Number.isInteger(major)
      ? await verifyShopifyRule(rule, table, evidence)
      : ['no major'];
    return reasons.length ? { reasons } : { rule, table };
  }
  const version =
    candidate.version ||
    entryMetadata(evidence.pages.get(common.source)?.content ?? '').version ||
    '';
  const table = tableFor(api, version);
  if (!table) return { reasons: [`no pinned ${api} schemas around version "${version}"`] };
  const tableVersion = table.version!;
  const coordinate =
    family === 'webhook-topic-rename'
      ? `WebhookSubscriptionTopic.${candidate.topic}`
      : candidate.coordinate;
  const change =
    family === 'rest-to-graphql' ? undefined : answeredChange(api, tableVersion, coordinate);
  if (family !== 'rest-to-graphql' && !change)
    return {
      reasons: [
        `no change to ${coordinate} between the pinned ${api} ${table.previous} and ${version} schemas`,
      ],
    };
  const values =
    family === 'graphql-rename'
      ? { coordinate, replacement: candidate.replacement }
      : family === 'graphql-argument-drop'
        ? { coordinate, value: parseScalar(candidate.value) }
        : family === 'webhook-topic-rename'
          ? { topic: candidate.topic, replacement: candidate.replacement }
          : { method: candidate.method, path: candidate.path, replacement: candidate.replacement };
  const name = family === 'rest-to-graphql' ? `${candidate.method}-${candidate.path}` : coordinate;
  const rule = {
    ...common,
    rule: `shopify-${tableVersion}-${slugPart(name)}`.slice(0, 120),
    family,
    ...values,
    warning: candidate.warning,
    diff:
      family === 'rest-to-graphql'
        ? {
            id: 'graphql-replacement-present',
            operationId: candidate.replacement,
            text: `${candidate.method} ${candidate.path} is answered by ${candidate.replacement}.`,
          }
        : { id: change!.id, operationId: coordinate, text: change!.text },
  } as ShopifyRule;
  if (!rule.warning) return { reasons: ['no warning'] };
  const reasons = await verifyShopifyRule(rule, table, evidence);
  return reasons.length ? { reasons } : { rule, table };
}

function parseScalar(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    return ['string', 'number', 'boolean'].includes(typeof parsed) || parsed === null
      ? (parsed as string)
      : value;
  } catch {
    return value;
  }
}
