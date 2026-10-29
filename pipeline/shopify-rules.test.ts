import { buildSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import type { CapturedDocumentation } from './documentation-sources.ts';
import {
  changelogEntries,
  completeMined,
  entryMetadata,
  isChangeEntry,
  tableFor,
  type MinedCandidate,
} from './shopify-changelog-mining.ts';
import {
  pageDates,
  parseShopifyRuleTable,
  verifyShopifyAlert,
  verifyShopifyRule,
  type ShopifyRule,
  type ShopifyRuleTable,
} from './shopify-rules.ts';
import { diffSchemas, pinnedShopifyDiff } from './shopify-schema-diff.ts';
import { pinnedShopifySchema, pinnedShopifyVersions } from './shopify-schemas.ts';

const SOURCE = 'https://shopify.dev/changelog/posts/example';
const QUOTE = 'Use `QueryRoot.draftOrders` instead of `Shop.draftOrders`.';
const page = (content: string): CapturedDocumentation => ({
  formatVersion: 1,
  kind: 'refit-documentation-snapshot',
  label: 'example',
  url: `${SOURCE}.md`,
  revision: 'r',
  hash: 'h',
  content,
  contentType: 'text/markdown',
});
const pages = new Map([
  [
    SOURCE,
    page(
      `---\nmetadata:\n  effectiveApiVersion: '2026-01'\n---\n${QUOTE} Removed on January 1, 2026.`,
    ),
  ],
]);
const table: ShopifyRuleTable = {
  formatVersion: 1,
  provider: 'shopify',
  api: 'admin',
  version: '2026-01',
  previous: '2025-01',
  rules: [],
};
const rule = (overrides: Partial<ShopifyRule> = {}) =>
  ({
    rule: 'shopify-2026-01-shop-draftorders',
    family: 'graphql-rename',
    coordinate: 'Shop.draftOrders',
    replacement: 'QueryRoot.draftOrders',
    source: SOURCE,
    warning: 'Reads draft orders from the root query.',
    quote: QUOTE,
    checkedAt: '2026-10-29',
    diff: {
      id: 'field-removed',
      operationId: 'Shop.draftOrders',
      text: 'Shop.draftOrders was removed.',
    },
    status: 'review-only',
    origin: 'hand-written',
    ...overrides,
  }) as ShopifyRule;

describe('Shopify schema diff', () => {
  it('lists removals, type changes, new required inputs, enum changes and deprecations', () => {
    const before = buildSchema(`
      type Query { shop: Shop, items(first: Int, sort: Sort): [String] }
      type Shop { name: String!, legacy: String @deprecated(reason: "Use name."), count: Int! }
      input Filter { a: String, b: Int }
      enum Sort { ID RELEVANCE }
    `);
    const after = buildSchema(`
      type Query { shop: Shop, items(first: Int!): [String] }
      type Shop { name: String! @deprecated(reason: "Use title."), count: Int, title: String! }
      input Filter { a: String, c: ID! }
      enum Sort { ID TITLE }
    `);
    expect(
      diffSchemas(before, after).map((change) => [change.id, change.coordinate, change.breaking]),
    ).toEqual([
      ['input-field-removed', 'Filter.b', true],
      ['input-field-added-required', 'Filter.c', true],
      ['argument-type-changed', 'Query.items(first:)', true],
      ['argument-removed', 'Query.items(sort:)', true],
      ['field-type-changed', 'Shop.count', true],
      ['field-removed', 'Shop.legacy', true],
      ['deprecated', 'Shop.name', false],
      ['enum-value-removed', 'Sort.RELEVANCE', true],
      ['enum-value-added', 'Sort.TITLE', false],
    ]);
    expect(
      diffSchemas(before, after).find((change) => change.coordinate === 'Shop.legacy')
        ?.deprecationReason,
    ).toBe('Use name.');
  });

  it('treats a field that becomes non-null as compatible', () => {
    const before = buildSchema('type Query { a: String }');
    expect(diffSchemas(before, buildSchema('type Query { a: String! }'))).toEqual([]);
  });

  it('diffs the pinned schemas', () => {
    expect(pinnedShopifyVersions('admin')[0]).toBe('2025-01');
    const diff = pinnedShopifyDiff('admin', '2026-01');
    expect(diff.previous).toBe('2025-01');
    expect(diff.changes).toContainEqual(
      expect.objectContaining({
        id: 'field-removed',
        coordinate: 'Shop.draftOrders',
        deprecationReason: 'Use `QueryRoot.draftOrders` instead.',
      }),
    );
  });
});

describe('Shopify rule verification', () => {
  it('keeps a rename the pinned schemas and the quote back', async () => {
    expect(await verifyShopifyRule(rule(), table, { pages })).toEqual([]);
    expect(parseShopifyRuleTable({ ...table, rules: [rule()] }, 'table.json').rules).toHaveLength(
      1,
    );
  });

  it('refuses a misquote, an invented diff entry and a replacement of another type', async () => {
    expect(await verifyShopifyRule(rule({ quote: 'Use draftOrders.' }), table, { pages })).toEqual([
      `the quote is not in the captured page ${SOURCE} verbatim`,
    ]);
    expect(
      await verifyShopifyRule(
        rule({ diff: { id: 'deprecated', operationId: 'Shop.draftOrders', text: 'x' } }),
        table,
        { pages },
      ),
    ).toHaveLength(1);
    const problems = await verifyShopifyRule(
      rule({ replacement: 'QueryRoot.shop' } as Partial<ShopifyRule>),
      table,
      { pages },
    );
    expect(problems.some((problem) => problem.startsWith('QueryRoot.shop has type'))).toBe(true);
  });

  it('refuses a rule for a coordinate that did not change', async () => {
    expect(
      await verifyShopifyRule(
        rule({
          coordinate: 'Shop.name',
          diff: { id: 'field-removed', operationId: 'Shop.name', text: 'Shop.name was removed.' },
        } as Partial<ShopifyRule>),
        table,
        { pages },
      ),
    ).toEqual(['no change to Shop.name between the pinned admin 2025-01 and 2026-01 schemas']);
  });

  it('refuses an auto rule', () => {
    expect(() =>
      parseShopifyRuleTable({ ...table, rules: [rule({ status: 'auto' })] }, 'table.json'),
    ).toThrow('review-only');
  });

  it('checks an alert against its page and the pins', () => {
    const alert = {
      id: 'a',
      api: 'admin' as const,
      coordinates: ['PriceRule*', 'Shop.draftOrders'],
      summary: 's',
      deadline: { version: '2026-01', date: '2026-01-01' },
      source: SOURCE,
      quote: QUOTE,
      checkedAt: '2026-10-29',
      origin: 'hand-written' as const,
    };
    expect(verifyShopifyAlert(alert, pages)).toEqual([]);
    expect(
      verifyShopifyAlert(
        { ...alert, coordinates: ['Nope.field'], deadline: { date: '2026-02-01' } },
        pages,
      ),
    ).toEqual(['Nope.field is in no pinned admin schema', 'the page does not name 2026-02-01']);
    expect(pinnedShopifySchema('admin', '2025-01').schema.getType('PriceRule')).toBeDefined();
  });
});

describe('Shopify changelog mining', () => {
  const feed = `<item><title>Removing Shop.draftOrders</title><category>GraphQL Admin API</category><category>Breaking API Change</category><link>https://shopify.dev/changelog/removing-shop-draftorders</link><atom:published>2025-10-01T00:00:00.000Z</atom:published></item>
<item><title>New thing</title><category>GraphQL Admin API</category><category>New</category><link>https://shopify.dev/changelog/new-thing</link><atom:published>2025-10-02T00:00:00.000Z</atom:published></item>`;

  it('reads change entries from the feed', () => {
    const entries = changelogEntries(feed);
    expect(entries.map((entry) => [entry.slug, isChangeEntry(entry)])).toEqual([
      ['removing-shop-draftorders', true],
      ['new-thing', false],
    ]);
    expect(entries[0].url).toBe('https://shopify.dev/changelog/posts/removing-shop-draftorders.md');
    expect(entryMetadata(pages.get(SOURCE)!.content).version).toBe('2026-01');
    expect([...pageDates('Removed on January 1, 2026 and 2026-04-01.')]).toEqual([
      '2026-04-01',
      '2026-01-01',
    ]);
  });

  it('places a change in the next pinned table', () => {
    expect(tableFor('admin', '2025-07')).toMatchObject({ version: '2026-01', previous: '2025-01' });
    expect(tableFor('admin', '2024-10')).toMatchObject({ version: '2024-10', previous: '2024-07' });
    expect(tableFor('admin', '2027-01')).toBeUndefined();
  });

  const candidate = (overrides: Partial<MinedCandidate>): MinedCandidate => ({
    kind: 'rule',
    family: 'graphql-rename',
    api: 'admin',
    version: '2026-01',
    coordinate: 'Shop.draftOrders',
    replacement: 'QueryRoot.draftOrders',
    value: '',
    method: '',
    path: '',
    topic: '',
    package: '',
    major: '',
    symbol: '',
    summary: '',
    date: '',
    quote: QUOTE,
    warning: 'Reads draft orders from the root query.',
    rationale: '',
    coordinates: [],
    ...overrides,
  });
  const context = {
    source: SOURCE,
    checkedAt: '2026-10-29',
    generatedBy: { model: 'm', responseId: 'r' },
    page: pages.get(SOURCE)!,
  };

  it('derives the diff entry and keeps a verified rule', async () => {
    const outcome = await completeMined(candidate({}), context, { pages });
    expect(outcome).toMatchObject({
      kind: 'rule',
      rule: { diff: rule().diff, origin: 'generated' },
      table: { version: '2026-01' },
    });
  });

  it('keeps a rule that fails verification as an alert with the page version', async () => {
    const outcome = await completeMined(
      candidate({ replacement: 'QueryRoot.shop', summary: 'Shop.draftOrders is removed.' }),
      context,
      { pages },
    );
    expect(outcome).toMatchObject({
      kind: 'alert',
      alert: { coordinates: ['Shop.draftOrders'], deadline: { version: '2026-01' } },
    });
    expect(outcome.kind === 'alert' && outcome.refusedRule?.length).toBeTruthy();
  });

  it('refuses a misquoted candidate', async () => {
    expect((await completeMined(candidate({ quote: 'invented' }), context, { pages })).kind).toBe(
      'refused',
    );
  });
});
