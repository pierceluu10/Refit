// The rule families Refit reads tonight, with the official texts to start from. The sources are
// starting points for the agent, not a whitelist: it may follow links to other official pages.
// EU acts come from the EU Publications Office by CELEX number: EUR-Lex answers anything but a
// browser with an empty bot check.

export type RuleFamilyId = 'accessibility' | 'privacy' | 'payments' | 'ai-transparency';

export type RuleSource = { url: string; title: string; note?: string };

export type RuleFamily = {
  id: RuleFamilyId;
  name: string;
  kind: 'regulation' | 'payment-rule';
  sources: RuleSource[];
  // What the agent should look for, in plain words. Guidance, not a checklist.
  focus: string;
};

export const RULE_FAMILIES: RuleFamily[] = [
  {
    id: 'accessibility',
    name: 'Accessibility: European Accessibility Act and WCAG 2.2',
    kind: 'regulation',
    sources: [
      {
        url: 'https://publications.europa.eu/resource/celex/32019L0882',
        title: 'Directive (EU) 2019/882 (European Accessibility Act)',
      },
      {
        url: 'https://www.w3.org/TR/WCAG22/',
        title: 'Web Content Accessibility Guidelines (WCAG) 2.2, W3C Recommendation',
        note: 'The technical standard most often used to test web accessibility.',
      },
    ],
    focus:
      'Which products and services the Act covers (e-commerce, consumer banking, e-books and others), when it applies, and the WCAG 2.2 success criteria that most often touch web code: text alternatives, form labels, structure, contrast, keyboard focus, accessible authentication.',
  },
  {
    id: 'privacy',
    name: 'Privacy: GDPR, ePrivacy cookie consent and CCPA',
    kind: 'regulation',
    sources: [
      {
        url: 'https://publications.europa.eu/resource/celex/32016R0679',
        title: 'Regulation (EU) 2016/679 (GDPR)',
      },
      {
        url: 'https://publications.europa.eu/resource/celex/02002L0058-20091219',
        title: 'Directive 2002/58/EC (ePrivacy), Article 5(3) as amended by 2009/136/EC',
        note: 'The consent-before-cookies rule lives here, not in the GDPR. This is the consolidated text, with the 2009 amendment.',
      },
      {
        url: 'https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?division=3.&part=4.&lawCode=CIV&title=1.81.5',
        title: 'California Consumer Privacy Act, Civil Code 1798.100 and following',
      },
      {
        url: 'https://cppa.ca.gov/regulations/',
        title: 'California Privacy Protection Agency regulations',
      },
    ],
    focus:
      'Rules that touch code: consent before non-essential cookies or tracking, withdrawing consent, data access and deletion requests, opt-out of sale or sharing and opt-out preference signals, privacy by default.',
  },
  {
    id: 'payments',
    name: 'Payments: PSD2 Strong Customer Authentication and PCI DSS 4.0',
    kind: 'payment-rule',
    sources: [
      {
        url: 'https://publications.europa.eu/resource/celex/32015L2366',
        title: 'Directive (EU) 2015/2366 (PSD2), Article 97',
      },
      {
        url: 'https://publications.europa.eu/resource/celex/32018R0389',
        title: 'Delegated Regulation (EU) 2018/389, RTS on strong customer authentication',
      },
      {
        url: 'https://docs-prv.pcisecuritystandards.org/PCI%20DSS/Standard/PCI-DSS-v4_0_1.pdf',
        title: 'PCI DSS v4.0.1 (PCI Security Standards Council)',
        note: 'Published as a PDF. If it cannot be read, say so; the document library is https://www.pcisecuritystandards.org/document_library/.',
      },
    ],
    focus:
      'Strong Customer Authentication for online card payments in Europe (what triggers it, what the authentication must be, when it applied) and PCI DSS 4.0 requirements for payment pages, especially 6.4.3 (inventory, authorization and integrity of payment page scripts) and 11.6.1 (change and tamper detection on payment pages), with their future-dated effective dates.',
  },
  {
    id: 'ai-transparency',
    name: 'AI transparency: EU AI Act Article 50',
    kind: 'regulation',
    sources: [
      {
        url: 'https://publications.europa.eu/resource/celex/32024R1689',
        title: 'Regulation (EU) 2024/1689 (Artificial Intelligence Act)',
      },
    ],
    focus:
      'Transparency duties that touch code: telling people they are interacting with an AI system, marking AI-generated content in a machine-readable way, disclosing deep fakes, and when those duties apply (Article 113).',
  },
];

export function familyOf(id: string): RuleFamily | undefined {
  const prefix = id.split(':')[0];
  return RULE_FAMILIES.find((family) => family.id === prefix);
}
