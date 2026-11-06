// Illustrative only, shown under an "Example data" label. Dates, checks and pull requests are made up;
// the quotes paraphrase and say so, and none of it describes a real customer or repository.
import type {
  AuditEntry,
  BehindItem,
  DependencyKind,
  ExternalChange,
  Obligation,
  RunView,
} from '../../shared/types.ts';
import type { RepoData } from './api';

const STOREFRONT = 'refit-example-org/storefront';
const BILLING = 'refit-example-org/billing-api';

export const exampleRepos = [STOREFRONT, BILLING];
export const EXAMPLE_NOTE =
  'Example data. Findings, dates, checks and pull requests are illustrative.';

const pull = (repo: string, number: number) => `https://github.com/${repo}/pull/${number}`;

function finding(
  repo: string,
  change: Pick<ExternalChange, 'id' | 'kind' | 'title' | 'dependency' | 'dependencyKind'> & {
    url: string;
    quote: string;
    deadline?: string;
    toVersion?: string;
  },
  dependency: { version?: string; file: string; line?: number; notes?: string },
  status: BehindItem['status'] = 'open',
  pr?: string,
): BehindItem {
  const { url, quote, deadline, ...rest } = change;
  return {
    repo,
    dependency: {
      repo,
      kind: change.dependencyKind satisfies DependencyKind,
      name: change.dependency,
      version: dependency.version,
      declaredIn: [{ file: dependency.file, line: dependency.line }],
      notes: dependency.notes,
    },
    change: {
      ...rest,
      provider: change.dependency,
      effectiveDate: deadline,
      source: { url, quote: `Example paraphrase: ${quote}` },
      affects: {},
    },
    deadline,
    status,
    pr,
  };
}

const obligations: Obligation[] = [
  {
    id: 'example-eaa-forms',
    rule: {
      name: 'European Accessibility Act',
      jurisdiction: 'EU',
      url: 'https://eur-lex.europa.eu/eli/dir/2019/882/oj',
      quote: 'Example paraphrase: online shops must be usable by people with disabilities.',
    },
    requirement: 'Checkout and signup forms must work with assistive technology.',
    appliesTo: 'forms and checkout pages',
    inCode: 'Labelled inputs, announced errors, keyboard access.',
    effectiveDate: '2025-06-28',
    checkable: ['axe accessibility scan'],
    needsHuman: [
      'Whether the business falls under the Act’s small-company exemption.',
      'Whether the accessibility statement on the site is accurate.',
    ],
  },
  {
    id: 'example-pci-scripts',
    rule: {
      name: 'PCI DSS 4.0, requirement 6.4.3',
      url: 'https://www.pcisecuritystandards.org/document_library/',
      quote: 'Example paraphrase: keep an inventory of the scripts on payment pages.',
    },
    requirement: 'Keep a list of every script on the payment page and why it is there.',
    appliesTo: 'payment pages',
    inCode: 'Scripts loaded on checkout routes.',
    checkable: ['scripts on the payment page'],
    needsHuman: ['Who owns the script inventory, and whether each script is approved.'],
  },
  {
    id: 'example-ai-act',
    rule: {
      name: 'EU AI Act, transparency duties',
      jurisdiction: 'EU',
      url: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
      quote: 'Example paraphrase: tell people when they are talking to an AI.',
    },
    requirement: 'Tell users when they are talking to an AI.',
    appliesTo: 'AI features that talk to people',
    inCode: 'Chat interfaces and generated messages.',
    checkable: [],
    needsHuman: ['Whether any AI feature is planned for this product.'],
  },
];

const items: BehindItem[] = [
  finding(
    STOREFRONT,
    {
      id: 'example-play-target-sdk',
      kind: 'platform-policy',
      title: 'Google Play raises the required target SDK',
      dependency: 'google-play',
      dependencyKind: 'platform',
      url: 'https://developer.android.com/google/play/requirements/target-sdk',
      quote: 'new app updates must target a recent Android API level.',
      deadline: '2027-08-31',
      toVersion: 'targetSdk 36',
    },
    { version: 'targetSdk 33', file: 'android/app/build.gradle', line: 12 },
  ),
  finding(
    STOREFRONT,
    {
      id: 'example-mv3',
      kind: 'browser-change',
      title: 'Chrome stops running Manifest V2 extensions',
      dependency: 'chrome-extension',
      dependencyKind: 'platform',
      url: 'https://developer.chrome.com/docs/extensions/develop/migrate',
      quote: 'extensions move to Manifest V3.',
      toVersion: 'Manifest V3',
    },
    { version: 'Manifest V2', file: 'extension/manifest.json', line: 2 },
    'pr-open',
    pull(STOREFRONT, 14),
  ),
  finding(
    STOREFRONT,
    {
      id: 'example-tls-1-1',
      kind: 'tls-crypto',
      title: 'TLS 1.1 is retired by the payment gateway',
      dependency: 'tls',
      dependencyKind: 'security-standard',
      url: 'https://www.rfc-editor.org/rfc/rfc8996',
      quote: 'TLS 1.0 and 1.1 are deprecated.',
      deadline: '2027-01-15',
      toVersion: 'TLS 1.2',
    },
    { version: 'TLSv1.1', file: 'deploy/nginx.conf', line: 31 },
    'merged',
    pull(STOREFRONT, 9),
  ),
  finding(
    STOREFRONT,
    {
      id: 'example-password-login',
      kind: 'auth-standard',
      title: 'Provider switches off password logins',
      dependency: 'oauth-password-grant',
      dependencyKind: 'security-standard',
      url: 'https://developers.google.com/identity/protocols/oauth2',
      quote: 'use the authorization code flow instead of passwords.',
      deadline: '2027-03-01',
      toVersion: 'Authorization code with PKCE',
    },
    { file: 'src/auth/login.ts', line: 48 },
  ),
  finding(
    BILLING,
    {
      id: 'example-ingress-v1beta1',
      kind: 'k8s-version',
      title: 'Ingress extensions/v1beta1 was removed from Kubernetes',
      dependency: 'kubernetes',
      dependencyKind: 'infrastructure',
      url: 'https://kubernetes.io/docs/reference/using-api/deprecation-guide/',
      quote: 'Ingress moves to networking.k8s.io/v1.',
      deadline: '2026-12-01',
      toVersion: 'networking.k8s.io/v1',
    },
    { version: 'extensions/v1beta1', file: 'k8s/ingress.yaml', line: 1 },
    'pr-open',
    pull(BILLING, 21),
  ),
  finding(
    BILLING,
    {
      id: 'example-lambda-node16',
      kind: 'serverless-runtime',
      title: 'AWS Lambda retires the nodejs16.x runtime',
      dependency: 'aws-lambda',
      dependencyKind: 'infrastructure',
      url: 'https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html',
      quote: 'functions on retired runtimes stop getting updates.',
      deadline: '2026-12-20',
      toVersion: 'nodejs22.x',
    },
    { version: 'nodejs16.x', file: 'serverless.yml', line: 6 },
  ),
  finding(
    STOREFRONT,
    {
      id: 'example-eaa-forms-change',
      kind: 'regulation',
      title: 'Accessibility of checkout and signup forms',
      dependency: 'checkout-forms',
      dependencyKind: 'regulated-surface',
      url: 'https://eur-lex.europa.eu/eli/dir/2019/882/oj',
      quote: 'online shops must be usable by people with disabilities.',
      deadline: '2025-06-28',
    },
    { file: 'src/pages/Checkout.tsx', line: 22 },
    'pr-open',
    pull(STOREFRONT, 15),
  ),
  finding(
    STOREFRONT,
    {
      id: 'example-pci-scripts-change',
      kind: 'payment-rule',
      title: 'Inventory of scripts on the payment page',
      dependency: 'payment-page',
      dependencyKind: 'regulated-surface',
      url: 'https://www.pcisecuritystandards.org/document_library/',
      quote: 'keep an inventory of the scripts on payment pages.',
    },
    {
      file: 'src/pages/Checkout.tsx',
      line: 4,
      notes: 'Example: the checkout page loads a payment script and an analytics script.',
    },
  ),
  finding(
    STOREFRONT,
    {
      id: 'example-ai-act-change',
      kind: 'regulation',
      title: 'Telling users they are talking to an AI',
      dependency: 'ai-features',
      dependencyKind: 'regulated-surface',
      url: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
      quote: 'tell people when they are talking to an AI.',
    },
    { file: 'package.json' },
    'not-affected',
  ),
];

const auditOf = (
  at: string,
  repo: string,
  changeId: string,
  action: AuditEntry['action'],
  evidence: string[],
  extra: Partial<AuditEntry> = {},
): AuditEntry => ({ at, repo, changeId, action, evidence, actor: 'refit', ...extra });

const audit: AuditEntry[] = [
  auditOf('2026-10-02T09:00:00Z', STOREFRONT, 'example-eaa-forms-change', 'detected', [
    'https://eur-lex.europa.eu/eli/dir/2019/882/oj',
  ]),
  auditOf(
    '2026-10-02T09:04:00Z',
    STOREFRONT,
    'example-eaa-forms-change',
    'matched',
    ['Example: the repo has a checkout page and a signup form that sell to EU customers.'],
    { obligationId: 'example-eaa-forms' },
  ),
  auditOf(
    '2026-10-02T09:31:00Z',
    STOREFRONT,
    'example-eaa-forms-change',
    'pr-opened',
    ['Example: axe scan, 3 violations before, 1 after.', 'Example: unit tests, unchanged.'],
    { obligationId: 'example-eaa-forms', pr: pull(STOREFRONT, 15) },
  ),
  auditOf(
    '2026-10-04T14:12:00Z',
    STOREFRONT,
    'example-eaa-forms-change',
    'pr-updated',
    ['Example: axe scan after the update, 0 violations on the pages it reached.'],
    { obligationId: 'example-eaa-forms', pr: pull(STOREFRONT, 15) },
  ),
  auditOf(
    '2026-10-02T09:06:00Z',
    STOREFRONT,
    'example-pci-scripts-change',
    'matched',
    ['Example: the checkout page loads a payment script and an analytics script.'],
    { obligationId: 'example-pci-scripts' },
  ),
  auditOf(
    '2026-10-02T09:07:00Z',
    STOREFRONT,
    'example-ai-act-change',
    'not-affected',
    ['Example: the repo has no chat interface and calls no AI model.'],
    { obligationId: 'example-ai-act' },
  ),
  auditOf(
    '2026-10-06T16:40:00Z',
    STOREFRONT,
    'example-tls-1-1',
    'merged',
    ['https://www.rfc-editor.org/rfc/rfc8996'],
    { pr: pull(STOREFRONT, 9), actor: 'example-reviewer' },
  ),
  auditOf(
    '2026-10-07T11:20:00Z',
    STOREFRONT,
    'example-old-browser-api',
    'closed',
    ['Example: a person closed this PR and kept the old flag.'],
    { pr: pull(STOREFRONT, 11), actor: 'example-reviewer' },
  ),
  auditOf(
    '2026-10-03T10:00:00Z',
    BILLING,
    'example-ingress-v1beta1',
    'pr-opened',
    ['Example: manifest validation, 1 removed API before, 0 after.'],
    { pr: pull(BILLING, 21) },
  ),
];

const runs: RunView[] = [
  {
    id: 'example-run-eaa',
    repo: STOREFRONT,
    taskId: 'example-task-eaa',
    provider: 'checkout-forms',
    changeId: 'example-eaa-forms-change',
    outcome: 'needs-review',
    pr: pull(STOREFRONT, 15),
    costUsd: 0,
    summary: 'Example: labelled the checkout inputs and announced form errors to screen readers.',
    finishedAt: '2026-10-04T14:12:00Z',
  },
];

export function exampleData(repo: string): RepoData {
  const repoItems = items.filter((item) => item.repo === repo);
  return {
    report: { repo, scannedAt: '2026-10-02T09:00:00Z', items: repoItems, costUsd: 0, errors: [] },
    runs: runs.filter((run) => run.repo === repo),
    audit: audit.filter((entry) => entry.repo === repo),
    obligations,
  };
}
