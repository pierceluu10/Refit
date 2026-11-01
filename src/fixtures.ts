// Example data for the dashboard preview. Nothing here comes from a real organization,
// repository, provider page or run.
import type { ApiUsage, MigrationTask, ProviderChange, RunRecord } from '../shared/types.ts';

export type Repository = { id: string; name: string; language: string; description: string };
export type Outcome = Exclude<RunRecord['outcome'], 'failed'>;
export type TaskResult = Pick<RunRecord, 'taskId' | 'checks' | 'pr'> & {
  outcome: Outcome;
  summary: string;
  unproven: string[];
};

export const outcomeLabels: Record<Outcome, string> = {
  verified: 'Verified',
  'needs-review': 'Needs review',
  'not-affected': 'Not affected',
};

const providerNames: Record<string, string> = {
  stripe: 'Stripe',
  shopify: 'Shopify',
  openai: 'OpenAI',
  'example-sms': 'Example SMS',
};

export const organization = { name: 'example-org' };

export const repositories: Repository[] = [
  {
    id: 'billing-api',
    name: 'example-org/billing-api',
    language: 'TypeScript',
    description: 'Payments, refunds and invoices.',
  },
  {
    id: 'storefront',
    name: 'example-org/storefront',
    language: 'TypeScript',
    description: 'Product catalogue and checkout.',
  },
  {
    id: 'support-bot',
    name: 'example-org/support-bot',
    language: 'Python',
    description: 'Drafts replies to support tickets.',
  },
  {
    id: 'notifications',
    name: 'example-org/notifications',
    language: 'Go',
    description: 'Order and delivery text messages.',
  },
];

export const usages: ApiUsage[] = [
  {
    repo: 'example-org/billing-api',
    provider: 'stripe',
    via: 'sdk',
    sdk: { name: 'stripe', version: '14.25.0', lockfile: 'package-lock.json' },
    pinnedVersion: { value: '2023-10-16', file: 'src/lib/stripe.ts', line: 6 },
    callSites: [
      {
        file: 'src/billing/payments.ts',
        line: 42,
        operation: 'paymentIntents.retrieve',
        fields: ['charges.data[0].id', 'charges.data[0].receipt_url'],
        notes: 'Stores the receipt link on the invoice.',
      },
      {
        file: 'src/billing/refunds.ts',
        line: 19,
        operation: 'refunds.create',
        fields: ['payment_intent', 'amount'],
      },
    ],
  },
  {
    repo: 'example-org/billing-api',
    provider: 'stripe',
    via: 'webhook',
    callSites: [
      {
        file: 'src/webhooks/stripe.ts',
        line: 27,
        operation: 'charge.refunded',
        fields: ['data.object.amount_refunded'],
        notes: 'Marks the invoice as refunded.',
      },
    ],
  },
  {
    repo: 'example-org/storefront',
    provider: 'shopify',
    via: 'graphql',
    pinnedVersion: { value: '2024-01', file: 'src/shopify/client.ts', line: 9 },
    callSites: [
      {
        file: 'src/catalogue/products.ts',
        line: 14,
        operation: 'query products',
        fields: ['title', 'variants.price', 'images.url'],
      },
      {
        file: 'src/cart/checkout.ts',
        line: 58,
        operation: 'mutation cartCreate',
        fields: ['lines', 'buyerIdentity.email'],
        notes: 'Hands the cart to the checkout page.',
      },
    ],
  },
  {
    repo: 'example-org/storefront',
    provider: 'stripe',
    via: 'sdk',
    sdk: { name: 'stripe', version: '14.25.0', lockfile: 'pnpm-lock.yaml' },
    callSites: [
      {
        file: 'src/cart/deposit.ts',
        line: 33,
        operation: 'checkout.sessions.create',
        fields: ['line_items', 'success_url'],
      },
    ],
  },
  {
    repo: 'example-org/support-bot',
    provider: 'openai',
    via: 'sdk',
    sdk: { name: 'openai', version: '1.12.0', lockfile: 'poetry.lock' },
    pinnedVersion: { value: 'example-chat-model', file: 'bot/settings.py', line: 12 },
    callSites: [
      {
        file: 'bot/reply.py',
        line: 48,
        operation: 'chat.completions.create',
        fields: ['model', 'messages', 'temperature'],
        notes: 'Reads choices[0].message.content as the draft reply.',
      },
    ],
  },
  {
    repo: 'example-org/notifications',
    provider: 'example-sms',
    via: 'http',
    pinnedVersion: { value: 'v2', file: 'internal/sms/client.go', line: 18 },
    callSites: [
      {
        file: 'internal/sms/client.go',
        line: 31,
        operation: 'POST /v2/messages',
        fields: ['to', 'body', 'sender_id'],
        notes: 'Sends the API key as a query parameter.',
      },
    ],
  },
];

const changes: ProviderChange[] = [
  {
    provider: 'stripe',
    id: 'stripe-charges-list',
    kind: 'field-removed',
    title: 'PaymentIntent drops the expanded charges list',
    effectiveDate: '2026-12-01',
    source: {
      url: 'https://example.com/changelog/stripe-charges-list',
      quote: 'The charges property is removed from PaymentIntent. Use latest_charge instead.',
    },
    affects: { operations: ['paymentIntents.retrieve'], fields: ['charges'] },
  },
  {
    provider: 'openai',
    id: 'openai-model-retirement',
    kind: 'model-retirement',
    title: 'Example chat model is retired',
    effectiveDate: '2027-01-15',
    source: {
      url: 'https://example.com/changelog/openai-model-retirement',
      quote: 'example-chat-model will stop serving requests. Move to example-chat-model-2.',
    },
    affects: { operations: ['chat.completions.create'], fields: ['model'] },
  },
  {
    provider: 'example-sms',
    id: 'example-sms-auth-header',
    kind: 'auth-change',
    title: 'API keys move from the query string to a header',
    effectiveDate: '2026-12-15',
    source: {
      url: 'https://example.com/changelog/example-sms-auth-header',
      quote:
        'Keys passed as a query parameter will be rejected. Send them in the Authorization header.',
    },
    affects: { operations: ['POST /v2/messages'] },
  },
  {
    provider: 'stripe',
    id: 'stripe-refund-webhook',
    kind: 'webhook-payload',
    title: 'Refund events carry a new reason field',
    source: {
      url: 'https://example.com/changelog/stripe-refund-webhook',
      quote: 'charge.refund.updated events now include refund.reason_detail.',
    },
    affects: { operations: ['charge.refund.updated'], fields: ['reason_detail'] },
  },
];

function usagesOf(repo: string, provider: string) {
  return usages.filter((usage) => usage.repo === repo && usage.provider === provider);
}

function changeOf(id: string) {
  const change = changes.find((item) => item.id === id);
  if (!change) throw new Error(`Unknown example change: ${id}`);
  return change;
}

// Priority 1 is the most urgent.
export const tasks: MigrationTask[] = [
  {
    id: 'billing-latest-charge',
    repo: 'example-org/billing-api',
    change: changeOf('stripe-charges-list'),
    usages: usagesOf('example-org/billing-api', 'stripe').filter((usage) => usage.via === 'sdk'),
    deadline: '2026-12-01',
    priority: 1,
  },
  {
    id: 'notifications-auth-header',
    repo: 'example-org/notifications',
    change: changeOf('example-sms-auth-header'),
    usages: usagesOf('example-org/notifications', 'example-sms'),
    deadline: '2026-12-15',
    priority: 2,
  },
  {
    id: 'support-bot-model',
    repo: 'example-org/support-bot',
    change: changeOf('openai-model-retirement'),
    usages: usagesOf('example-org/support-bot', 'openai'),
    deadline: '2027-01-15',
    priority: 3,
  },
  {
    id: 'billing-refund-webhook',
    repo: 'example-org/billing-api',
    change: changeOf('stripe-refund-webhook'),
    usages: usagesOf('example-org/billing-api', 'stripe').filter(
      (usage) => usage.via === 'webhook',
    ),
    priority: 4,
  },
];

export const results: TaskResult[] = [
  {
    taskId: 'billing-latest-charge',
    outcome: 'verified',
    summary:
      'Reads latest_charge instead of charges.data[0] and retrieves the charge for the receipt link.',
    checks: [
      { name: 'Type check', before: 'Passed', after: 'Passed' },
      { name: 'Build', before: 'Passed', after: 'Passed' },
      { name: 'Tests', before: 'Passed', after: 'Passed, plus one new test' },
    ],
    pr: 'https://example.com/example-org/billing-api/pull/1',
    unproven: [],
  },
  {
    taskId: 'notifications-auth-header',
    outcome: 'needs-review',
    summary: 'Moves the API key into the Authorization header.',
    checks: [
      { name: 'Build', before: 'Passed', after: 'Passed' },
      { name: 'Tests', before: 'Passed', after: 'Passed' },
    ],
    pr: 'https://example.com/example-org/notifications/pull/1',
    unproven: [
      'No test covers the outgoing request headers.',
      'No live call was made to the provider’s sandbox.',
    ],
  },
  {
    taskId: 'support-bot-model',
    outcome: 'needs-review',
    summary: 'Switches the pinned model in bot/settings.py to the replacement model.',
    checks: [
      { name: 'Type check', before: 'Passed', after: 'Passed' },
      { name: 'Tests', before: '1 failure', after: '1 failure (unchanged)' },
    ],
    pr: 'https://example.com/example-org/support-bot/pull/1',
    unproven: [
      'Reply quality from the replacement model was not compared.',
      'One existing test failed before and after the change.',
    ],
  },
  {
    taskId: 'billing-refund-webhook',
    outcome: 'not-affected',
    summary:
      'The webhook handler subscribes only to charge.refunded and reads amount_refunded. The change touches charge.refund.updated, which this code never receives.',
    checks: [],
    unproven: [],
  },
];

export function resultOf(taskId: string) {
  return results.find((result) => result.taskId === taskId);
}

export function providersOf(repo: string) {
  return [...new Set(usages.filter((usage) => usage.repo === repo).map((usage) => usage.provider))];
}

export function providerName(provider: string) {
  return providerNames[provider] ?? provider;
}
