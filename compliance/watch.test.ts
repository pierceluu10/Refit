import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RULE_FAMILIES, type RuleFamilyId } from './families.ts';
import { fixtureFetcher, httpFetcher, officialFixtures } from './fetch.ts';
import { fakeModel, scriptedModel, type FakeTurn } from './model.ts';
import { readRegulations } from './watch.ts';
import { findClaims } from './wording.ts';

const pages = officialFixtures();
const fetcher = fixtureFetcher(pages);
const now = () => new Date('2026-11-06T00:00:00Z');
const family = (id: RuleFamilyId) => RULE_FAMILIES.find((f) => f.id === id)!;

type Case = {
  slug: string;
  url: string;
  name: string;
  quote: string;
  effectiveDate?: string;
  appliesTo: string;
};

// What a careful reader would pull from each family's fixture texts. The quotes are copied from the
// fixture files, so the quote check can run against them.
const CASES: Record<RuleFamilyId, Case[]> = {
  accessibility: [
    {
      slug: 'eaa-ecommerce-payment',
      url: 'https://publications.europa.eu/resource/celex/32019L0882',
      name: 'European Accessibility Act, Annex I Section IV(g)',
      quote:
        'ensuring the accessibility of the functionality for identification, security and payment when delivered as part of a service instead of a product by making it perceivable, operable, understandable and robust;',
      effectiveDate: '2025-06-28',
      appliesTo: 'checkout and login flows of e-commerce services',
    },
    {
      slug: 'wcag22-3.3.2-labels',
      url: 'https://www.w3.org/TR/WCAG22/',
      name: 'WCAG 2.2 Success Criterion 3.3.2',
      quote: 'Labels or instructions are provided when content requires user input.',
      appliesTo: 'forms',
    },
  ],
  privacy: [
    {
      slug: 'eprivacy-5.3-consent',
      url: 'https://publications.europa.eu/resource/celex/02002L0058-20091219',
      name: 'ePrivacy Directive Article 5(3)',
      quote:
        'is only allowed on condition that the subscriber or user concerned has given his or her consent',
      appliesTo: 'analytics and cookies',
    },
    {
      slug: 'gdpr-17-erasure',
      url: 'https://publications.europa.eu/resource/celex/32016R0679',
      name: 'GDPR Article 17(1)',
      quote:
        'The data subject shall have the right to obtain from the controller the erasure of personal data concerning him or her without undue delay',
      effectiveDate: '2018-05-25',
      appliesTo: 'accounts and stored personal data',
    },
    {
      slug: 'ccpa-1798.120-opt-out',
      url: 'https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?division=3.&part=4.&lawCode=CIV&title=1.81.5',
      name: 'CCPA 1798.120(a)',
      quote: 'This right may be referred to as the right to opt-out of sale or sharing.',
      appliesTo: 'ad and analytics scripts that share personal information',
    },
  ],
  payments: [
    {
      slug: 'psd2-97-sca',
      url: 'https://publications.europa.eu/resource/celex/32015L2366',
      name: 'PSD2 Article 97(1)',
      quote: '(b) initiates an electronic payment transaction;',
      effectiveDate: '2019-09-14',
      appliesTo: 'card payment flows',
    },
    {
      slug: 'pci-dss-6.4.3-scripts',
      url: 'https://docs-prv.pcisecuritystandards.org/PCI%20DSS/Standard/PCI-DSS-v4_0_1.pdf',
      name: 'PCI DSS v4.0.1 Requirement 6.4.3',
      quote:
        "All payment page scripts that are loaded and executed in the consumer's browser are managed as follows:",
      effectiveDate: '2025-03-31',
      appliesTo: 'checkout pages',
    },
  ],
  'ai-transparency': [
    {
      slug: 'ai-act-50.1-disclosure',
      url: 'https://publications.europa.eu/resource/celex/32024R1689',
      name: 'EU AI Act Article 50(1)',
      quote:
        'the natural persons concerned are informed that they are interacting with an AI system',
      effectiveDate: '2026-08-02',
      appliesTo: 'chat interfaces',
    },
  ],
};

const obligation = (c: Case, overrides: Record<string, unknown> = {}) => ({
  slug: c.slug,
  rule: { name: c.name, jurisdiction: 'EU', url: c.url, quote: c.quote },
  requirement: `What ${c.name} asks for, in plain words.`,
  appliesTo: c.appliesTo,
  inCode: `The code paths for ${c.appliesTo}.`,
  ...(c.effectiveDate ? { effectiveDate: c.effectiveDate } : {}),
  checkable: ['a check a tool can run'],
  needsHuman: ['whether the business is in scope'],
  ...overrides,
});

// A careful reader: opens every source, checks each quote, then submits.
function readerTurns(id: RuleFamilyId): FakeTurn[] {
  const cases = CASES[id];
  return [
    { tools: family(id).sources.map((s) => ({ name: 'read_page', input: { url: s.url } })) },
    { tools: cases.map((c) => ({ name: 'find_in_page', input: { url: c.url, text: c.quote } })) },
    {
      tools: [
        { name: 'submit_obligations', input: { obligations: cases.map((c) => obligation(c)) } },
      ],
    },
  ];
}

describe('watchRegulations on the saved official texts', () => {
  for (const id of Object.keys(CASES) as RuleFamilyId[]) {
    it(`reads the ${id} family and keeps quotes it can find word for word`, async () => {
      const model = scriptedModel(readerTurns(id));
      const read = await readRegulations(undefined, {
        model,
        fetcher,
        families: [family(id)],
        now,
      });
      expect(read.errors).toEqual([]);
      expect(read.obligations.map((o) => o.id)).toEqual(CASES[id].map((c) => `${id}:${c.slug}`));
      for (const o of read.obligations) {
        expect(o.rule.url).toMatch(/^https:\/\//);
        expect(o.needsHuman.join(' ')).not.toMatch(/not found word for word|did not read/);
        expect(findClaims([o.requirement, o.inCode, ...o.needsHuman].join('\n'))).toEqual([]);
      }
      // The quote check tool saw each quote in the fixture.
      const results = JSON.stringify(model.requests.at(-1)!.messages);
      expect(results).toContain('Found word for word');
      expect(model.requests[0].system).toContain('never says code is compliant');
    });
  }

  it('flags a quote it could not find in the fetched text, without dropping it', async () => {
    const c = { ...CASES.accessibility[1], quote: 'A sentence that is not in WCAG at all.' };
    const model = scriptedModel([
      { tools: [{ name: 'read_page', input: { url: c.url } }] },
      { tools: [{ name: 'submit_obligations', input: { obligations: [obligation(c)] } }] },
    ]);
    const read = await readRegulations(undefined, {
      model,
      fetcher,
      families: [family('accessibility')],
      now,
    });
    expect(read.obligations).toHaveLength(1);
    expect(read.obligations[0].needsHuman[0]).toContain('not found word for word');
  });

  it('asks again when a submission arrives cut off with no input', async () => {
    const c = CASES.accessibility[1];
    const model = scriptedModel([
      { tools: [{ name: 'read_page', input: { url: c.url } }] },
      { tools: [{ name: 'submit_obligations', input: {} }] },
      { tools: [{ name: 'submit_obligations', input: { obligations: [obligation(c)] } }] },
    ]);
    const read = await readRegulations(undefined, {
      model,
      fetcher,
      families: [family('accessibility')],
      now,
    });
    expect(read.obligations).toHaveLength(1);
    expect(read.errors.join('\n')).not.toContain('no obligations were written');
  });

  it('flags a quote from a page it never read', async () => {
    const c = CASES['ai-transparency'][0];
    const read = await readRegulations(undefined, {
      model: scriptedModel([
        { tools: [{ name: 'submit_obligations', input: { obligations: [obligation(c)] } }] },
      ]),
      fetcher,
      families: [family('ai-transparency')],
      now,
    });
    expect(read.obligations[0].needsHuman[0]).toContain('did not read');
    expect(read.errors.join('\n')).toContain('the agent did not open this source');
  });

  it('asks the model to rewrite compliance claims, and scrubs them if it insists', async () => {
    const c = CASES['ai-transparency'][0];
    const claim = obligation(c, {
      inCode: 'Once labelled, the chat is compliant with the AI Act.',
    });
    const fixed = obligation(c, { inCode: 'The chat widget shows a label saying it is an AI.' });
    const model = scriptedModel([
      { tools: [{ name: 'read_page', input: { url: c.url } }] },
      { tools: [{ name: 'submit_obligations', input: { obligations: [claim] } }] },
      { tools: [{ name: 'submit_obligations', input: { obligations: [fixed] } }] },
    ]);
    const read = await readRegulations(undefined, {
      model,
      fetcher,
      families: [family('ai-transparency')],
      now,
    });
    expect(JSON.stringify(model.requests[2].messages)).toContain(
      'Rewrite without compliance claims',
    );
    expect(read.obligations[0].inCode).toBe('The chat widget shows a label saying it is an AI.');

    const stubborn = scriptedModel([
      { tools: [{ name: 'read_page', input: { url: c.url } }] },
      ...Array.from({ length: 3 }, () => ({
        tools: [{ name: 'submit_obligations', input: { obligations: [claim] } }],
      })),
    ]);
    const scrubbed = await readRegulations(undefined, {
      model: stubborn,
      fetcher,
      families: [family('ai-transparency')],
      now,
    });
    expect(findClaims(scrubbed.obligations[0].inCode)).toEqual([]);
    expect(scrubbed.obligations[0].inCode).toContain('needs human review');
  });

  it('records sources it could not read instead of inventing them', async () => {
    const c = CASES.accessibility[1];
    const read = await readRegulations(undefined, {
      model: scriptedModel([
        {
          tools: family('accessibility').sources.map((s) => ({
            name: 'read_page',
            input: { url: s.url },
          })),
        },
        { tools: [{ name: 'submit_obligations', input: { obligations: [obligation(c)] } }] },
      ]),
      // Only WCAG is available; the EAA page reads as a dead link.
      fetcher: fixtureFetcher({ [c.url]: pages[c.url] }),
      families: [family('accessibility')],
      now,
    });
    expect(read.obligations).toHaveLength(1);
    expect(read.errors.join('\n')).toContain(
      'could not read https://publications.europa.eu/resource/celex/32019L0882',
    );
  });

  it('keeps what the model last submitted when it never finishes, and says so', async () => {
    const c = { ...CASES.payments[0], effectiveDate: 'September 2019' };
    const model = fakeModel(() => ({
      tools: [{ name: 'submit_obligations', input: { obligations: [obligation(c)] } }],
    }));
    const read = await readRegulations(undefined, {
      model,
      fetcher,
      families: [family('payments')],
      now,
    });
    // The bad date is fed back twice, then the malformed obligation is reported, not kept silently.
    expect(JSON.stringify(model.requests[1].messages)).toContain('is not YYYY-MM-DD');
    expect(read.errors.join('\n')).toMatch(/dropped malformed|no obligations were written/);
  });

  // Skipped where a key is set, so the test suite never spends.
  it.skipIf(Boolean(process.env.ANTHROPIC_API_KEY))(
    'reads nothing and says why when there is no model',
    async () => {
      const read = await readRegulations(undefined, { fetcher, families: [family('privacy')] });
      expect(read.obligations).toEqual([]);
      expect(read.errors[0]).toMatch(
        /No rule sources were read: (ANTHROPIC_API_KEY|Set REFIT_AI_BUDGET_USD)/,
      );
    },
  );

  it('gives every family official sources to start from', () => {
    for (const f of RULE_FAMILIES) {
      expect(f.sources.length).toBeGreaterThan(0);
      for (const s of f.sources) expect(pages[s.url], s.url).toBeDefined();
    }
  });

  it('reports an empty 2xx page as unread, not as an empty text', async () => {
    const bot = httpFetcher({
      cacheDir: mkdtempSync(join(tmpdir(), 'refit-fetch-')),
      fetch: async () =>
        new Response('', { status: 202, headers: { 'content-type': 'text/html' } }),
    });
    const page = await bot.fetch('https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng');
    expect(page.ok).toBe(false);
    expect(page.error).toMatch(/HTTP 202 with an empty page/);
  });
});
