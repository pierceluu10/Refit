import { describe, expect, it } from 'vitest';
import type { ExternalChange, Obligation } from '../shared/types.ts';
import { RULE_FAMILIES } from './families.ts';
import {
  NO_LEGAL_ADVICE,
  RULE_PLAYBOOKS,
  RULE_TASK_GUIDANCE,
  rulePlaybook,
  rulePrBody,
  ruleOutcome,
} from './playbooks.ts';
import { findClaims } from './wording.ts';

// Example data: a change and obligation shaped like the matcher's output.
const obligation: Obligation = {
  id: 'payments:pci-dss-6.4.3-scripts',
  rule: {
    name: 'PCI DSS v4.0.1 Requirement 6.4.3',
    url: 'https://docs-prv.pcisecuritystandards.org/PCI%20DSS/Standard/PCI-DSS-v4_0_1.pdf',
    quote:
      "All payment page scripts that are loaded and executed in the consumer's browser are managed as follows:",
  },
  requirement:
    'Keep an inventory of payment page scripts and assure each one is authorized and intact.',
  appliesTo: 'checkout pages',
  inCode: 'Scripts loaded on app/checkout/page.tsx',
  effectiveDate: '2025-03-31',
  checkable: ['scripts loaded on the checkout page'],
  needsHuman: ['the business justification for each script'],
};
const change: ExternalChange = {
  provider: 'rules',
  id: `rule:${obligation.id}`,
  kind: 'payment-rule',
  title: `${obligation.rule.name}: ${obligation.requirement}`,
  effectiveDate: obligation.effectiveDate,
  source: { url: obligation.rule.url, quote: obligation.rule.quote },
  affects: { operations: ['app/checkout/page.tsx:9'] },
  dependencyKind: 'regulated-surface',
  dependency: 'checkout-page',
  severity: 'security',
};
const passing = {
  check: 'payment-page-scripts',
  passed: true as const,
  evidence: ['before: 3 scripts', 'after: 1 script'],
};

describe('rule playbooks', () => {
  it('has one per family, each saying Refit gives no legal advice and making no claims', () => {
    for (const family of RULE_FAMILIES) {
      const playbook = RULE_PLAYBOOKS[family.id];
      expect(playbook).toContain(NO_LEGAL_ADVICE);
      expect(playbook).toMatch(/## What a person must confirm/);
      expect(findClaims(playbook), family.id).toEqual([]);
    }
  });

  it('finds the playbook for a change or obligation id', () => {
    expect(rulePlaybook(change)).toBe(RULE_PLAYBOOKS.payments);
    expect(rulePlaybook('accessibility:wcag22-3.3.2-labels')).toBe(RULE_PLAYBOOKS.accessibility);
    // Unknown families get every playbook rather than none.
    expect(rulePlaybook('other:thing')).toContain('AI transparency');
  });

  it('gives the harness guidance that rule PRs are needs-review', () => {
    expect(RULE_TASK_GUIDANCE).toContain('needs-review unless every item is proven by a check');
  });
});

describe('rule PR bodies', () => {
  it('is needs-review while anything is left for a person', () => {
    expect(ruleOutcome({ change, obligation, changed: ['x'], checks: [passing] })).toBe(
      'needs-review',
    );
    expect(ruleOutcome({ change, changed: ['x'], checks: [] })).toBe('needs-review');
    expect(
      ruleOutcome({ change, changed: ['x'], checks: [{ ...passing, passed: 'unknown' }] }),
    ).toBe('needs-review');
    expect(ruleOutcome({ change, changed: ['x'], checks: [passing] })).toBe('verified');
  });

  it('lists the change, the checks and what to confirm, with the legal-advice note', () => {
    const { title, body, outcome } = rulePrBody({
      change,
      obligation,
      changed: ['Removed the tag manager from the checkout page.'],
      checks: [passing, { check: 'tests', passed: false, evidence: ['1 failing'] }],
      filesTouched: ['app/checkout/page.tsx'],
    });
    expect(outcome).toBe('needs-review');
    expect(title).toContain('PCI DSS v4.0.1 Requirement 6.4.3');
    expect(body).toContain(NO_LEGAL_ADVICE);
    expect(body).toContain('**needs review**');
    expect(body).toContain(`> ${obligation.rule.quote}`);
    expect(body).toContain('- payment-page-scripts: passed');
    expect(body).toContain('- tests: failed');
    expect(body).toContain('- [ ] the business justification for each script');
    expect(body).toContain('Effective: 2025-03-31');
  });

  it('never ships a compliance claim, whatever it is given', () => {
    const { title, body } = rulePrBody({
      change: { ...change, title: 'Checkout is now compliant' },
      changed: ['Made the checkout page compliant with PCI DSS.', 'Meets PCI DSS 6.4.3 now.'],
      checks: [{ check: 'scan', passed: true, evidence: ['page is fully compliant'] }],
      notes: 'This satisfies GDPR too.',
    });
    expect(findClaims(`${title}\n${body}`)).toEqual([]);
  });
});
