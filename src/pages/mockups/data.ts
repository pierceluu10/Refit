// Content for the homepage mockups at /mockups.

// The coding agent's figures are from the October 21 comparison in main's docs/BENCHMARKS.md:
// 1 of 8 patches that passed validation was correct, and 17 runs cost $6.45. Refit's are the
// owner's launch targets, not measurements; replace them before this ships.
export const BENCHMARK_URL =
  'https://github.com/pierceluu10/Refit/blob/main/docs/BENCHMARKS.md#a-coding-agent-on-the-repositories-refit-did-not-fix-october-21';

export const comparison = {
  correct: {
    title: 'Patches that were right after review',
    headline: '7.9× more often',
    rows: [
      { label: 'A coding agent', value: 12.5, display: '12.5%' },
      { label: 'Refit', value: 98.4, display: '98.4%' },
    ],
    note: 'The agent’s wrong patches all passed their checks. Each one dropped payment_method_types, so Checkout quietly changed what it accepts.',
  },
  cost: {
    title: 'AI spend per repository',
    headline: '2,900× cheaper',
    rows: [
      { label: 'A coding agent', value: 100, display: '$0.38' },
      { label: 'Refit', value: 0.4, display: '$0.00013' },
    ],
    note: 'Refit’s deterministic rules write the patch. A model only drafts the explanation.',
  },
  stats: [
    { value: '0', label: 'silent behaviour changes', detail: 'against 7 of 8 agent patches' },
    { value: '381 / 381', label: 'repeat runs identical', detail: 'same input, same pull request' },
  ],
};

export type ScenarioId = 'payment' | 'period' | 'model';

export const scenarios: {
  id: ScenarioId;
  provider: string;
  change: string;
  field: string;
  version: string;
  context: string;
  removed: string;
  added: string;
  agent: { added: string | null; correct: boolean; verdict: string };
}[] = [
  {
    id: 'payment',
    provider: 'stripe',
    change: 'payment_method_types removed',
    field: 'payment_method_types',
    version: 'Stripe 2026-09-30',
    context: 'const session = await stripe.checkout.sessions.create({',
    removed: "  payment_method_types: ['card'],",
    added: "  allowed_payment_method_types: ['card'],",
    agent: {
      added: null,
      correct: false,
      verdict: 'Deleted the parameter. Checks pass, but Checkout now offers every payment method.',
    },
  },
  {
    id: 'period',
    provider: 'stripe',
    change: 'current_period_end moved to items',
    field: 'current_period_end',
    version: 'Stripe 2026-09-30',
    context: 'export function renewsAt(subscription: Stripe.Subscription) {',
    removed: '  return subscription.current_period_end;',
    added: '  return subscription.items.data[0].current_period_end;',
    agent: {
      added: '  return subscription.items.data[0].current_period_end;',
      correct: true,
      verdict: 'Same edit. Field moves are where agents do well.',
    },
  },
  {
    id: 'model',
    provider: 'openai',
    change: 'gpt-4.5-preview retired',
    field: 'gpt-4.5-preview',
    version: 'OpenAI deprecations',
    context: 'const reply = await openai.chat.completions.create({',
    removed: "  model: 'gpt-4.5-preview',",
    added: "  model: 'gpt-4.1',",
    agent: {
      added: "  model: 'gpt-5',",
      correct: false,
      verdict: 'Picked a different model on its own. Pricing and output format changed with it.',
    },
  },
];

export const codebases: {
  id: string;
  name: string;
  stack: string;
  files: string[];
  hits: Partial<Record<ScenarioId, { file: string; sites: number }>>;
}[] = [
  {
    id: 'storefront',
    name: 'storefront',
    stack: 'Next.js',
    files: [
      'app/checkout/route.ts',
      'app/account/billing.tsx',
      'lib/stripe.ts',
      'lib/ai/describe.ts',
    ],
    hits: {
      payment: { file: 'app/checkout/route.ts', sites: 2 },
      period: { file: 'app/account/billing.tsx', sites: 1 },
      model: { file: 'lib/ai/describe.ts', sites: 1 },
    },
  },
  {
    id: 'billing-api',
    name: 'billing-api',
    stack: 'Express',
    files: ['src/routes/checkout.ts', 'src/services/renewals.ts', 'src/stripe.ts', 'src/server.ts'],
    hits: {
      payment: { file: 'src/routes/checkout.ts', sites: 1 },
      period: { file: 'src/services/renewals.ts', sites: 3 },
    },
  },
  {
    id: 'support-bot',
    name: 'support-bot',
    stack: 'Node worker',
    files: ['src/llm.ts', 'src/reply.ts', 'src/queue.ts', 'src/index.ts'],
    hits: {
      model: { file: 'src/llm.ts', sites: 1 },
    },
  },
];

export const CHECKS = ['typecheck', 'lint', 'test'];
