import { expect, it } from 'vitest';
import {
  breakingPages,
  checkReview,
  checkSdkMap,
  classifiedPages,
  compareTags,
  diffSdkMaps,
  MEASURED_ACCURACY,
  readJson,
  renderPrBody,
  renderReleaseTest,
  reviewEntries,
  sdkMapChanged,
  sdkMapSource,
  type SdkMap,
} from './stripe-release.ts';

const metadata = readJson<SdkMap>('pipeline/stripe-sdk-metadata.json');

const map = (overrides: Partial<SdkMap>): SdkMap => ({
  source: 'stripe/openapi v100 openapi/spec3.sdk.json (2026-09-30.endive)',
  generated: '2026-09-30',
  operationVersions: ['2026-09-30.endive'],
  classes: { Customer: 'customer' },
  events: { 'customer.created': 'customer' },
  operations: [{ schema: 'customer', method: 'create', operation: 'post', path: '/v1/customers' }],
  ...overrides,
});

it('compares stripe/openapi tags by number, not as text, and refuses other names', () => {
  expect(compareTags('v999', 'v2591')).toBeLessThan(0);
  expect(compareTags('v2591', 'v2526')).toBeGreaterThan(0);
  expect(compareTags('v2526', 'v2526')).toBe(0);
  expect(() => compareTags('2591', 'v1')).toThrow('2591 is not a stripe/openapi release tag');
  expect(() => compareTags('v25a', 'v1')).toThrow('not a stripe/openapi release tag');
});

it('reads the tag and API version the SDK map was generated from', () => {
  expect(sdkMapSource(map({}))).toEqual({ tag: 'v100', version: '2026-09-30.endive' });
  expect(() => sdkMapSource({ source: 'hand-written' })).toThrow('Unrecognized SDK map source');
});

it('lists added and removed classes, events, operations and versions, sorted', () => {
  const before = map({});
  const after = map({
    source: 'stripe/openapi v101 openapi/spec3.sdk.json (2026-10-28.endive)',
    operationVersions: ['2026-09-30.endive', '2026-10-28.endive'],
    classes: { Customer: 'customer', 'Billing.Meter': 'billing.meter', Account: 'account' },
    events: {},
    operations: [
      { schema: 'customer', method: 'create', operation: 'post', path: '/v1/customers' },
      { schema: 'customer', method: 'del', operation: 'delete', path: '/v1/customers/{customer}' },
    ],
  });
  expect(diffSdkMaps(before, after)).toEqual({
    versions: { added: ['2026-10-28.endive'], removed: [] },
    classes: { added: ['Account', 'Billing.Meter'], removed: [] },
    events: { added: [], removed: ['customer.created'] },
    operations: { added: ['customer del delete /v1/customers/{customer}'], removed: [] },
  });
  expect(sdkMapChanged(before, after)).toBe(true);
});

it('ignores a new source tag and date but not a class that now maps to another schema', () => {
  const before = map({});
  expect(sdkMapChanged(before, map({ source: 'other', generated: '2027-01-01' }))).toBe(false);
  const remapped = map({ classes: { Customer: 'deleted_customer' } });
  expect(diffSdkMaps(before, remapped).classes).toEqual({ added: [], removed: [] });
  expect(sdkMapChanged(before, remapped)).toBe(true);
});

const OVERVIEW = `# Endive

Intro that links [a page](https://docs.stripe.com/changelog/endive/2026-09-30/intro-link.md).

## 2026-10-28.endive

| Title | Affected Products | Breaking change? | Category |
| --- | --- | --- | --- |
| [Adds a thing](https://docs.stripe.com/changelog/endive/2026-10-28/adds-a-thing.md) | Billing | Non-breaking | api |

## 2026-09-30.endive

### Billing and invoicing

| Title | Affected Products | Breaking change? | Category |
| --- | --- | --- | --- |
| [Unifies the anchor \\| format](https://docs.stripe.com/changelog/endive/2026-09-30/polymorphic-billing-cycle-anchor.md) | Billing | Breaking | api |
| [Adds invoicing rules](https://docs.stripe.com/changelog/endive/2026-09-30/invoicing-rules.md) | Billing | Non-breaking | api |

### Payments

| Title | Affected Products | Breaking change? | Category |
| --- | --- | --- | --- |
| [Removes payment_method_types](https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types.md) | Checkout | Breaking | api |
| [Removes payment_method_types](https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types.md) | Elements | Breaking | stripejs |

## 2026-03-25.dahlia

| [Older](https://docs.stripe.com/changelog/dahlia/2026-03-25/older.md) | Billing | Breaking | api |
`;

it("reads only the version's rows marked Breaking, once per page", () => {
  expect(breakingPages(OVERVIEW, '2026-09-30.endive').map((page) => page.slug)).toEqual([
    'polymorphic-billing-cycle-anchor',
    'remove-payment-method-types',
  ]);
  expect(breakingPages(OVERVIEW, '2026-10-28.endive')).toEqual([]);
  expect(breakingPages(OVERVIEW, '2026-03-25.dahlia')).toEqual([
    {
      slug: 'older',
      title: 'Older',
      url: 'https://docs.stripe.com/changelog/dahlia/2026-03-25/older',
    },
  ]);
});

const prediction = (handling: string, family = 'none') => ({
  handling,
  family,
  identifiers: ['invoice.subscription'],
  rationale: 'The page says so.',
});
const AUDIT = {
  instructions: '…',
  pages: [
    {
      slug: 'moves-subscription',
      prediction: {
        category: 'api',
        changes: [
          prediction('rule', 'moved-id'),
          prediction('none'),
          prediction('ai', 'read-review'),
        ],
      },
      error: null,
      evidence: { changes: [{ index: 0, statement: 'invoice.subscription moved' }] },
      costUsd: 0.01,
    },
    {
      slug: 'too-many-identifiers',
      prediction: null,
      error: 'Release classification change 0 does not match the expected schema.',
      costUsd: 0.02,
    },
  ],
};

it('reads a classification audit and lists every rule and ai prediction as pending review', () => {
  const pages = classifiedPages(AUDIT);
  expect(pages[0].changes.map((item) => [item.statement, item.handling])).toEqual([
    ['invoice.subscription moved', 'rule'],
    [null, 'none'],
    [null, 'ai'],
  ]);
  expect(pages[1]).toMatchObject({ category: null, error: expect.stringContaining('schema') });
  const review = reviewEntries(pages);
  expect(review).toEqual([
    {
      slug: 'moves-subscription',
      index: 0,
      handling: 'rule',
      family: 'moved-id',
      identifiers: ['invoice.subscription'],
      decision: 'pending',
    },
    expect.objectContaining({ index: 2, handling: 'ai', decision: 'pending' }),
  ]);
  expect(checkReview(pages, review)).toBe(2);
  expect(checkReview(pages, [{ ...review[0], decision: 'accepted' }, review[1]])).toBe(1);
});

it('refuses a review list that drops a prediction or has no valid decision', () => {
  const pages = classifiedPages(AUDIT);
  const review = reviewEntries(pages);
  expect(() => checkReview(pages, review.slice(1))).toThrow('exactly the rule and ai predictions');
  expect(() => checkReview(pages, [{ ...review[0], decision: 'merged' }, review[1]])).toThrow(
    'no valid decision',
  );
});

it('refuses a classification that does not match the schema', () => {
  const page = AUDIT.pages[0];
  const broken = (change: object) => ({
    pages: [{ ...page, prediction: { category: 'api', changes: [change] } }],
  });
  expect(() => classifiedPages({})).toThrow('no pages list');
  expect(() => classifiedPages(broken(prediction('patch')))).toThrow('change 0 does not match');
  expect(() => classifiedPages(broken(prediction('rule', 'rename')))).toThrow('does not match');
  expect(() =>
    classifiedPages({ pages: [{ ...page, prediction: { ...page.prediction, category: 'v2' } }] }),
  ).toThrow('no valid category');
  expect(() => classifiedPages({ pages: [{ slug: 'x', prediction: null }] })).toThrow(
    'no prediction and no error',
  );
});

it('checks the committed SDK map and refuses one that lost a class the tracer needs', () => {
  // The committed map's tag and counts are pinned by the generated stripe-sdk-release.test.ts.
  expect(checkSdkMap(metadata).classes).toBe(Object.keys(metadata.classes).length);
  const { Customer: _, ...classes } = metadata.classes;
  expect(() => checkSdkMap({ ...metadata, classes })).toThrow('no class Customer');
  expect(() =>
    checkSdkMap({ ...metadata, operations: [...metadata.operations, metadata.operations[0]] }),
  ).toThrow('repeats an operation');
});

const diff = diffSdkMaps(map({}), map({ classes: {}, events: {} }));

it('renders the PR body with the SDK map changes and the classification needing review', () => {
  const body = renderPrBody({
    tag: 'v101',
    previousTag: 'v100',
    version: '2027-03-31.fig',
    newVersion: true,
    diff,
    breaking: [{ slug: 'moves-subscription', title: 'Moves', url: 'https://x' }],
    classification: {
      status: 'classified',
      directory: 'docs/benchmarks/stripe-changelog/classification/2027-03-31.fig',
      pages: classifiedPages(AUDIT),
      costUsd: 0.03,
    },
  });
  expect(body).toContain('| classes | 0 | 1 |');
  expect(body).toContain('<summary>Removed classes (1)</summary>');
  expect(body).toContain(MEASURED_ACCURACY);
  expect(body).toContain(
    '| moves-subscription | api | invoice.subscription moved | rule | moved-id | invoice.subscription | yes |',
  );
  expect(body).toContain(
    '| moves-subscription | api | #1 | none | none | invoice.subscription |  |',
  );
  expect(body).toContain('| too-many-identifiers | | | error: Release classification');
  expect(body).toContain('`review.json` has a decision');
});

it('says why a new release was not classified and lists its saved pages', () => {
  const body = renderPrBody({
    tag: 'v101',
    previousTag: 'v100',
    version: '2027-03-31.fig',
    newVersion: true,
    diff,
    breaking: [{ slug: 'a', title: 'A | B', url: 'https://docs.stripe.com/changelog/fig/a' }],
    classification: { status: 'skipped', reason: 'run with --no-ai' },
  });
  expect(body).toContain('Not classified: run with --no-ai.');
  expect(body).toContain('- [A \\| B](https://docs.stripe.com/changelog/fig/a)');
  expect(body).not.toContain(MEASURED_ACCURACY);
});

it('generates a release test that checks the classification only when there is one', () => {
  const pins = checkSdkMap(metadata);
  const plain = renderReleaseTest({ map: pins, classification: null });
  expect(plain).not.toContain('checkReview');
  const classified = renderReleaseTest({
    map: pins,
    classification: { directory: 'docs/x', pages: 2, changes: 3, review: 2 },
  });
  expect(classified).toContain("readJson('docs/x/audit.json')");
  expect(classified).toContain('{"pages":2,"changes":3,"review":2}');
});
