import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDocumentationSnapshots } from './documentation-sources.ts';
import { MAX_INPUT_BYTES } from './openai.ts';
import {
  classifyPage,
  pageEvidence,
  pageText,
  parsePrediction,
  type PageClassification,
} from './release-classification.ts';
import {
  catalogFamily,
  readCatalog,
  scoreRelease,
  summarize,
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

// Every prompt and model output of refit-bench run 40283655210 (gpt-6.1-sol), and its score.
const AUDIT = JSON.parse(
  readFileSync('docs/benchmarks/2026-10-26-release-classification-audit.json', 'utf8'),
) as { pages: Array<PageClassification & { release: string }> };
const RESULTS = JSON.parse(
  readFileSync('docs/benchmarks/2026-10-26-release-classification-results.json', 'utf8'),
);
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
    const { entries, rows } = scoreRelease(BASIL, catalog, results);
    const summary = summarize(entries, rows);
    expect(summary).toMatchObject({
      pages: catalog.length,
      pagesClassified: 3,
      changes: rows.length,
      changesClassified: 4,
      handlingCorrect: 2,
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
});

describe('the recorded run', () => {
  it('sent exactly the evidence the saved pages and catalog statements give today', () => {
    for (const page of AUDIT.pages) {
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
          changes: entry.changed,
        }),
      );
    }
  });

  it('reproduces the committed score from the recorded model outputs', () => {
    const rows = [];
    const entries = [];
    for (const release of RESULTS.releases as string[]) {
      const pages = AUDIT.pages
        .filter((page) => page.release === release)
        .map((page) => {
          const changes = (page.evidence as { changes: unknown[] }).changes.length;
          // A recorded error means the run kept no prediction; the rest are parsed again.
          return {
            ...page,
            prediction: page.error === null ? parsePrediction(page.content!, changes) : null,
          };
        });
      const scored = scoreRelease(release, readCatalog(join(CHANGELOG, 'catalog', release)), pages);
      expect(summarize(scored.entries, scored.rows)).toEqual(RESULTS.byRelease[release]);
      rows.push(...scored.rows);
      entries.push(...scored.entries);
    }
    expect(summarize(entries, rows)).toEqual(RESULTS.summary);
    expect(rows).toEqual(RESULTS.rows);
  });

  it('refuses the recorded output that lists more identifiers than allowed', () => {
    const page = recorded('rejected-accounts-v2-capabilities');
    expect(page.error).toBe('Release classification change 0 does not match the expected schema.');
    expect(() => parsePrediction(page.content!, 1)).toThrow('does not match the expected schema');
  });
});
