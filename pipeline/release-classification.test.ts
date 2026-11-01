import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDocumentationSnapshots } from './documentation-sources.ts';
import { MAX_INPUT_BYTES } from './openai.ts';
import {
  classifyPage,
  pageEvidence,
  instructions,
  pageText,
  parsePrediction,
  type PageClassification,
} from './release-classification.ts';
import { assignChanges, contentWords, readCatalog } from './release-classification-score.ts';

const CHANGELOG = resolve('docs/benchmarks/stripe-changelog');
const BASIL = '2025-03-31.basil';
const PERIODS = 'deprecate-subscription-current-period-start-and-end';
const OPTIONS = { apiKey: 'test-key', model: 'gpt-5.6-luna' };

afterEach(() => vi.unstubAllGlobals());

const releases = readdirSync(join(CHANGELOG, 'catalog')).sort();
const snapshot = async (release: string, slug: string) =>
  (await readDocumentationSnapshots([join(CHANGELOG, 'pages', release, `${slug}.json`)]))[0];

function respond(content: string) {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        id: 'resp_recorded',
        model: 'gpt-5.6-luna-2026-09-12',
        status: 'completed',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] },
        ],
      }),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

// Every prompt and model output of the recorded refit-bench runs (gpt-6.1-sol), and their scores.
const RUNS = [
  { name: '2026-10-26-release-classification', run: '40283655210', statements: 'catalog' },
  { name: '2026-10-26-release-classification-pages', run: '40285557374', statements: 'none' },
] as const;
const read = (path: string) => JSON.parse(readFileSync(`docs/benchmarks/${path}`, 'utf8'));
type Audit = { instructions: string; pages: Array<PageClassification & { release: string }> };
const AUDIT = read(`${RUNS[0].name}-audit.json`) as Audit;
const recorded = (slug: string) => AUDIT.pages.find((page) => page.slug === slug)!;
const PERIODS_OUTPUT = recorded(PERIODS).content!;

describe('changelog pages', () => {
  it('keeps the REST, Node.js and Stripe.js tabs and drops the other server SDKs', () => {
    const text = pageText(
      '## Changes\n#### REST API\nrest\n#### Ruby\nruby\n#### Node.js\nnode\n#### React\nreact\n#### .NET\nnet\n## Upgrade\nsteps',
    );
    expect(text).toBe(
      '## Changes\n#### REST API\nrest\n#### Node.js\nnode\n#### React\nreact\n## Upgrade\nsteps',
    );
  });

  it.each(releases)(
    'has a saved page within the AI input limit for every %s catalog entry',
    async (release) => {
      for (const entry of readCatalog(join(CHANGELOG, 'catalog', release))) {
        const page = await snapshot(release, entry.slug);
        expect(page.url).toBe(
          `https://docs.stripe.com/changelog/${release.split('.')[1]}/${release.split('.')[0]}/${entry.slug}.md`,
        );
        const evidence = JSON.stringify(
          pageEvidence(release, { slug: entry.slug, snapshot: page, changes: entry.changed }),
        );
        expect(Buffer.byteLength(evidence), entry.slug).toBeLessThanOrEqual(MAX_INPUT_BYTES);
      }
    },
  );
});

describe('classifyPage', () => {
  it('sends the page and the change statements, never the catalog handling', async () => {
    const [entry] = readCatalog(join(CHANGELOG, 'catalog', BASIL)).filter(
      (item) => item.slug === PERIODS,
    );
    const fetcher = respond(PERIODS_OUTPUT);
    const result = await classifyPage(
      BASIL,
      { slug: PERIODS, snapshot: await snapshot(BASIL, PERIODS), changes: entry.changed },
      OPTIONS,
    );
    expect(result.error).toBeNull();
    expect(result.prediction?.changes.map((change) => change.handling)).toEqual(['rule', 'none']);
    expect(result).toMatchObject({ responseId: 'resp_recorded', content: PERIODS_OUTPUT });
    const sent = JSON.parse(fetcher.mock.calls[0][1].body);
    const input = sent.input[0].content as string;
    expect(JSON.parse(input).changes).toEqual(
      entry.changed.map((statement, index) => ({ index, statement })),
    );
    for (const part of entry.parts) {
      expect(input).not.toContain(part.how ?? '\u0000');
      expect(input).not.toContain('subscriptionPeriodHelperEdit');
    }
    expect(input).not.toContain('"handling"');
    expect(sent.text.format.strict).toBe(true);
  });

  it('records an unusable response as the page error instead of guessing', async () => {
    respond(JSON.stringify({ category: 'api', changes: [] }));
    const result = await classifyPage(
      BASIL,
      { slug: PERIODS, snapshot: await snapshot(BASIL, PERIODS), changes: ['a', 'b'] },
      OPTIONS,
    );
    expect(result).toMatchObject({
      prediction: null,
      error: 'Release classification has 0 changes; the page has 2.',
    });
    expect(result.content).toBe(JSON.stringify({ category: 'api', changes: [] }));
  });

  it('records a refused request without a prediction', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 403 })));
    const result = await classifyPage(
      BASIL,
      { slug: PERIODS, snapshot: await snapshot(BASIL, PERIODS), changes: ['a'] },
      OPTIONS,
    );
    expect(result).toMatchObject({ prediction: null, content: null, costUsd: 0 });
    expect(result.error).toContain('HTTP 403');
  });

  it('sends only the page when the model lists the statements', async () => {
    const listed = JSON.stringify({
      category: 'api',
      changes: [
        {
          statement: 'Subscription.current_period_end removed',
          handling: 'ai',
          family: 'read-review',
          identifiers: ['subscription.current_period_end'],
          rationale: 'The page removes it.',
        },
      ],
    });
    const fetcher = respond(listed);
    const result = await classifyPage(
      BASIL,
      { slug: PERIODS, snapshot: await snapshot(BASIL, PERIODS), changes: null },
      OPTIONS,
    );
    expect(result.prediction?.changes[0].statement).toBe('Subscription.current_period_end removed');
    const sent = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(Object.keys(JSON.parse(sent.input[0].content))).toEqual(['release', 'page']);
    expect(sent.instructions).toBe(instructions('none'));
    expect(sent.text.format.schema.properties.changes.items.required).toContain('statement');
  });
});

describe('parsePrediction', () => {
  const change = {
    index: 0,
    handling: 'stop',
    family: 'none',
    identifiers: [],
    rationale: 'Removed.',
  };
  it.each([
    ['an index out of order', { category: 'api', changes: [{ ...change, index: 1 }] }],
    ['an unknown handling', { category: 'api', changes: [{ ...change, handling: 'automatic' }] }],
    ['an unknown family', { category: 'api', changes: [{ ...change, family: 'rename' }] }],
    ['an unknown category', { category: 'sdk', changes: [change] }],
    ['an empty rationale', { category: 'api', changes: [{ ...change, rationale: ' ' }] }],
  ])('rejects %s', (_, value) => {
    expect(() => parsePrediction(JSON.stringify(value), 1)).toThrow(
      'does not match the expected schema',
    );
  });

  it('requires a statement for every change the model lists', () => {
    const { index: _, ...listed } = change;
    expect(() =>
      parsePrediction(JSON.stringify({ category: 'api', changes: [listed] }), null),
    ).toThrow('change 0 does not match the expected schema');
    expect(
      parsePrediction(
        JSON.stringify({ category: 'api', changes: [{ ...listed, statement: 'x removed' }] }),
        null,
      ).changes[0].statement,
    ).toBe('x removed');
  });
});

describe('scoring', () => {
  it('reads names out of camelCase, snake_case and dotted statements', () => {
    expect([
      ...contentWords('Checkout.Session.shipping_details removed; use retrieveUpcoming'),
    ]).toEqual([
      'checkout',
      'session',
      'shipping_details',
      'shipping',
      'details',
      'retrieve',
      'upcoming',
    ]);
  });

  it('matches listed changes to the catalog statement sharing the most names', () => {
    const statements = [
      'Invoice.subscription removed (moved to parent.subscription_details.subscription)',
      'InvoiceItem.subscription and subscription_item removed',
    ];
    const change = (statement: string, identifiers: string[] = []) => ({
      statement,
      handling: 'none' as const,
      family: 'none' as const,
      identifiers,
      rationale: 'Recorded.',
    });
    expect(
      assignChanges(statements, [
        change('The subscription field on invoices moves to parent', ['invoice.parent']),
        change('subscription_item is removed from invoice items', [
          'invoiceitem.subscription_item',
        ]),
        change('Payouts settle faster'),
      ]).map(({ index }) => index),
    ).toEqual([0, 1, null]);
  });
});

it('refuses the recorded output that lists more identifiers than allowed', () => {
  const page = recorded('rejected-accounts-v2-capabilities');
  expect(page.error).toBe('Release classification change 0 does not match the expected schema.');
  expect(() => parsePrediction(page.content!, 1)).toThrow('does not match the expected schema');
});
