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
import {
  assignChanges,
  catalogFamily,
  contentWords,
  readCatalog,
  scoreRelease,
  summarize,
  type ExtraChange,
  type ScoredEntry,
  type ScoredRow,
} from './release-classification-score.ts';

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
  it('names a pack family for every catalog rule', () => {
    const families = releases.flatMap((release) =>
      readCatalog(join(CHANGELOG, 'catalog', release)).flatMap((entry) =>
        entry.parts.filter((part) => part.handling === 'rule').map(catalogFamily),
      ),
    );
    expect(families.sort()).toEqual([
      'moved-id',
      'moved-id',
      'moved-id',
      'moved-value',
      'moved-value',
      'none',
      'period-helper',
      'request-rename',
      'request-rename',
      'request-wrap',
    ]);
  });

  it('counts automatic handling where the catalog stops or has no signal as dangerous', () => {
    const catalog = readCatalog(join(CHANGELOG, 'catalog', BASIL));
    const prediction = (handlings: string[]) => ({
      category: 'api' as const,
      changes: handlings.map((handling) => ({
        handling: handling as 'rule',
        family: 'none' as const,
        identifiers: [],
        rationale: 'Recorded.',
      })),
    });
    const classified = (slug: string, handlings: string[]): PageClassification => ({
      slug,
      prediction: prediction(handlings),
      error: null,
      evidence: null,
      content: null,
      model: null,
      responseId: null,
      costUsd: 0,
    });
    // Catalog: rule then none; vault: none; naver: stop.
    const results = [
      classified(PERIODS, ['rule', 'ai']),
      classified('vault-forward-api-returns-402', ['none']),
      classified('naver-pay-payment-method', ['rule']),
    ];
    const { entries, rows, extras } = scoreRelease(BASIL, catalog, results);
    const summary = summarize(entries, rows, extras);
    expect(summary).toMatchObject({
      pages: catalog.length,
      pagesClassified: 3,
      changes: rows.length,
      changesClassified: 4,
      handlingCorrect: 2,
      modelStatements: 4,
      extraStatements: 0,
      dangerous: 2,
      ruleNotInCatalog: 1,
      familyImplied: rows.filter((row) => row.catalog.family !== 'none').length,
    });
    expect(summary.handlingConfusion.none.ai).toBe(1);
    expect(summary.handlingConfusion.stop.rule).toBe(1);
    expect(summary.handlingConfusion.rule.rule).toBe(1);
    expect(summary.handlingConfusion.none.unclassified).toBe(
      rows.filter((row) => row.catalog.handling === 'none').length - 2,
    );
    const periods = entries.find((entry) => entry.slug === PERIODS)!;
    expect(periods).toMatchObject({
      catalog: { handling: 'none' },
      predicted: { handling: 'ai' },
      error: null,
    });
    expect(entries.find((entry) => entry.slug === 'restrict-coupon-duration')).toMatchObject({
      predicted: null,
      error: 'not classified',
    });
  });

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

  it('counts a listed change matching nothing as extra, and as dangerous when it edits code', () => {
    const catalog = readCatalog(join(CHANGELOG, 'catalog', BASIL));
    const listed = (statement: string, handling: 'rule' | 'none') => ({
      statement,
      handling,
      family: 'none' as const,
      identifiers: [],
      rationale: 'Recorded.',
    });
    const { entries, rows, extras } = scoreRelease(BASIL, catalog, [
      {
        slug: PERIODS,
        prediction: {
          category: 'api',
          changes: [
            listed('Subscription current_period_start and current_period_end removed', 'rule'),
            listed('current_period_end reads move to items', 'none'),
            listed('Payouts settle faster', 'rule'),
          ],
        },
        error: null,
        evidence: null,
        content: null,
        model: null,
        responseId: null,
        costUsd: 0,
      },
    ]);
    const [periods, previous] = rows.filter((row) => row.slug === PERIODS);
    expect(periods).toMatchObject({ handling: 'mixed', handlingCorrect: false, dangerous: false });
    expect(periods.predicted).toHaveLength(2);
    expect(previous).toMatchObject({ predicted: [], handling: null, handlingCorrect: false });
    expect(extras).toMatchObject([{ statement: 'Payouts settle faster', automatic: true }]);
    expect(summarize(entries, rows, extras)).toMatchObject({
      modelStatements: 3,
      extraStatements: 1,
      extraAutomatic: 1,
      dangerous: 1,
      ruleNotInCatalog: 1,
    });
  });
});

describe.each(RUNS)('recorded run $run ($statements statements)', ({ name, statements }) => {
  const audit = read(`${name}-audit.json`) as Audit;
  const results = read(`${name}-results.json`);

  it('used the current instructions and sent exactly the evidence the saved pages give today', () => {
    expect(audit.instructions).toBe(instructions(statements));
    for (const page of audit.pages) {
      const [entry] = readCatalog(join(CHANGELOG, 'catalog', page.release)).filter(
        (item) => item.slug === page.slug,
      );
      const saved = readFileSync(
        join(CHANGELOG, 'pages', page.release, `${page.slug}.json`),
        'utf8',
      );
      expect(page.evidence).toEqual(
        pageEvidence(page.release, {
          slug: page.slug,
          snapshot: JSON.parse(saved),
          changes: statements === 'catalog' ? entry.changed : null,
        }),
      );
    }
  });

  it('reproduces the committed score from the recorded model outputs', () => {
    const rows: ScoredRow[] = [];
    const entries: ScoredEntry[] = [];
    const extras: ExtraChange[] = [];
    for (const release of results.releases as string[]) {
      const pages = audit.pages
        .filter((page) => page.release === release)
        .map((page) => {
          const sent = (page.evidence as { changes?: unknown[] }).changes;
          // A recorded error means the run kept no prediction; the rest are parsed again.
          return {
            ...page,
            prediction:
              page.error === null ? parsePrediction(page.content!, sent?.length ?? null) : null,
          };
        });
      const scored = scoreRelease(release, readCatalog(join(CHANGELOG, 'catalog', release)), pages);
      expect(summarize(scored.entries, scored.rows, scored.extras)).toEqual(
        results.byRelease[release],
      );
      rows.push(...scored.rows);
      entries.push(...scored.entries);
      extras.push(...scored.extras);
    }
    expect(summarize(entries, rows, extras)).toEqual(results.summary);
    expect(rows).toEqual(results.rows);
    expect(extras).toEqual(results.extras);
  });
});

it('refuses the recorded output that lists more identifiers than allowed', () => {
  const page = recorded('rejected-accounts-v2-capabilities');
  expect(page.error).toBe('Release classification change 0 does not match the expected schema.');
  expect(() => parsePrediction(page.content!, 1)).toThrow('does not match the expected schema');
});
