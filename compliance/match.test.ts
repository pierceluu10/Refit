import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DependencyUsage, Obligation } from '../shared/types.ts';
import { MemoryAuditStore } from './audit.ts';
import { matchObligations, repoTools } from './match.ts';
import { fakeModel, scriptedModel } from './model.ts';

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const surfaces = JSON.parse(
  readFileSync(fixture('demo-next-web-surfaces.json'), 'utf8'),
) as DependencyUsage[];
const repoDir = fixture('demo-next-web').pathname;
const repo = 'refit-dev/demo-next-web';
const now = () => new Date('2026-11-06T00:00:00Z');

// Example obligations, shaped like watchRegulations' output, with quotes from the fixture texts.
const base = (
  id: string,
  name: string,
  url: string,
  quote: string,
  effectiveDate?: string,
): Obligation => ({
  id,
  rule: { name, url, quote },
  requirement: `What ${name} asks for.`,
  appliesTo: 'example surface',
  inCode: 'example code path',
  effectiveDate,
  checkable: ['example check'],
  needsHuman: ['whether the business is in scope'],
});
const obligations: Obligation[] = [
  base(
    'payments:pci-dss-6.4.3-scripts',
    'PCI DSS v4.0.1 Requirement 6.4.3',
    'https://docs-prv.pcisecuritystandards.org/PCI%20DSS/Standard/PCI-DSS-v4_0_1.pdf',
    "All payment page scripts that are loaded and executed in the consumer's browser are managed as follows:",
    '2025-03-31',
  ),
  base(
    'accessibility:wcag22-3.3.2-labels',
    'WCAG 2.2 Success Criterion 3.3.2',
    'https://www.w3.org/TR/WCAG22/',
    'Labels or instructions are provided when content requires user input.',
  ),
  base(
    'ai-transparency:ai-act-50.1-disclosure',
    'EU AI Act Article 50(1)',
    'https://publications.europa.eu/resource/celex/32024R1689',
    'the natural persons concerned are informed that they are interacting with an AI system',
    '2026-08-02',
  ),
];

const verdicts = [
  {
    obligationId: 'payments:pci-dss-6.4.3-scripts',
    applies: true,
    reasoning: 'The checkout page loads a tag manager next to the card form.',
    surfaces: [0],
    files: [
      { file: 'app/checkout/page.tsx', line: 9, why: 'third-party script on the payment page' },
    ],
    severity: 'security',
  },
  {
    obligationId: 'accessibility:wcag22-3.3.2-labels',
    applies: true,
    reasoning: 'The sign-up email input has a placeholder and no label.',
    surfaces: [2],
    files: [{ file: 'app/signup/page.tsx', line: 6, why: 'input without a label' }],
  },
  {
    obligationId: 'ai-transparency:ai-act-50.1-disclosure',
    applies: false,
    reasoning: 'No chat or AI feature: the repo has no model SDK and no chat surface.',
  },
];

describe('obligationsToChanges', () => {
  it('turns applicable obligations into changes and audits the rest as not affected', async () => {
    const audit = new MemoryAuditStore();
    const model = scriptedModel([
      { tools: [{ name: 'read_file', input: { path: 'app/signup/page.tsx' } }] },
      { tools: [{ name: 'submit_verdicts', input: { verdicts } }] },
    ]);
    const match = await matchObligations(repo, surfaces, obligations, {
      model,
      repoDir,
      audit,
      now,
    });

    expect(match.errors).toEqual([]);
    expect(match.changes.map((c) => [c.id, c.kind, c.dependency, c.severity])).toEqual([
      ['rule:payments:pci-dss-6.4.3-scripts', 'payment-rule', 'checkout-page', 'security'],
      ['rule:accessibility:wcag22-3.3.2-labels', 'regulation', 'signup-form', 'notice'],
    ]);
    const pci = match.changes[0];
    expect(pci.source.quote).toBe(obligations[0].rule.quote);
    expect(pci.effectiveDate).toBe('2025-03-31');
    expect(pci.affects.operations).toEqual([
      'app/checkout/page.tsx:9 third-party script on the payment page',
    ]);
    expect(match.notAffected).toEqual([
      {
        obligationId: 'ai-transparency:ai-act-50.1-disclosure',
        reasoning: 'No chat or AI feature: the repo has no model SDK and no chat surface.',
      },
    ]);

    // The read_file tool returned the fixture file, with line numbers.
    expect(JSON.stringify(model.requests[1].messages)).toContain('6:       <input placeholder=');

    const entries = await audit.list(repo);
    expect(entries.map((e) => [e.obligationId, e.action])).toEqual([
      ['payments:pci-dss-6.4.3-scripts', 'detected'],
      ['accessibility:wcag22-3.3.2-labels', 'detected'],
      ['ai-transparency:ai-act-50.1-disclosure', 'not-affected'],
    ]);
    expect(entries[2].evidence[0]).toContain('No chat or AI feature');
    expect(entries[2].evidence).toContain(
      'source: https://publications.europa.eu/resource/celex/32024R1689',
    );
  });

  it('asks again for missing verdicts, then treats what is still missing as applying', async () => {
    const audit = new MemoryAuditStore();
    const model = fakeModel(() => ({
      tools: [{ name: 'submit_verdicts', input: { verdicts: [verdicts[2]] } }],
    }));
    const match = await matchObligations(repo, surfaces, obligations, { model, audit, now });
    expect(JSON.stringify(model.requests[1].messages)).toContain('Missing verdicts for');
    // Two obligations never got a verdict: they are attempted, not skipped.
    expect(match.changes.map((c) => c.id)).toEqual([
      'rule:payments:pci-dss-6.4.3-scripts',
      'rule:accessibility:wcag22-3.3.2-labels',
    ]);
    expect(match.verdicts.filter((v) => v.judgedBy === 'fallback')).toHaveLength(2);
    expect(match.notAffected).toHaveLength(1);
  });

  it.skipIf(Boolean(process.env.ANTHROPIC_API_KEY))(
    'without a model, treats every obligation as possibly applying and says why',
    async () => {
      const match = await matchObligations(repo, surfaces, obligations, { audit: null });
      expect(match.changes).toHaveLength(3);
      expect(match.errors[0]).toContain('Obligations were not matched by a model');
      expect(match.verdicts[0].reasoning).toContain('treated as possibly applying');
    },
  );

  it('scrubs compliance claims from the matcher’s reasoning', async () => {
    const model = scriptedModel([
      {
        tools: [
          {
            name: 'submit_verdicts',
            input: {
              verdicts: verdicts.map((v) => ({
                ...v,
                reasoning: 'After this fix the page is compliant.',
              })),
            },
          },
        ],
      },
    ]);
    const match = await matchObligations(repo, surfaces, obligations, { model, audit: null });
    for (const v of match.verdicts) expect(v.reasoning).not.toMatch(/\bcompliant\b/);
  });

  it('does nothing and costs nothing with no obligations', async () => {
    const match = await matchObligations(repo, surfaces, [], {
      model: scriptedModel([]),
      audit: null,
    });
    expect(match).toMatchObject({ changes: [], verdicts: [], errors: [], costUsd: 0 });
  });
});

describe('repo tools', () => {
  const tools = Object.fromEntries(repoTools(repoDir).map((t) => [t.name, t]));

  it('lists, reads and searches inside the checkout', async () => {
    expect(await tools.list_files.run({})).toContain('app/signup/page.tsx');
    expect(await tools.search.run({ text: 'placeholder' })).toContain('app/signup/page.tsx:6');
  });

  it('refuses paths outside the checkout', async () => {
    await expect(tools.read_file.run({ path: '../demo-next-web-surfaces.json' })).rejects.toThrow(
      /outside the repository/,
    );
  });
});
