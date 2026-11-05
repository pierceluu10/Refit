// Illustrative fixtures for unit tests. Not real customers, repos or runs.
import type { MigrationTask, RunRecord } from '../../shared/types.ts';
import type { MemoryRecipe } from '../types.ts';

export function makeTask(overrides: Partial<MigrationTask> = {}): MigrationTask {
  return {
    id: 'task-stripe-charges',
    repo: 'example-org/shop',
    priority: 1,
    change: {
      provider: 'stripe',
      id: 'stripe-charges-to-payment-intents',
      kind: 'endpoint-removed',
      title: 'Charges API calls should move to PaymentIntents',
      source: {
        url: 'https://docs.stripe.com/payments/payment-intents/migration',
        quote: 'Example quote: migrate from the Charges API to PaymentIntents.',
      },
      affects: { operations: ['charges.create'], fields: ['source'] },
    },
    usages: [
      {
        repo: 'example-org/shop',
        provider: 'stripe',
        via: 'sdk',
        sdk: { name: 'stripe', version: '12.0.0' },
        callSites: [{ file: 'src/checkout.ts', line: 42, operation: 'charges.create' }],
      },
    ],
    ...overrides,
  };
}

export function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  const rescan = { findings: [], unlistedProviders: [], clean: true };
  return {
    ...{ rescan },
    taskId: 'task-stripe-charges',
    outcome: 'verified',
    diff: '- stripe.charges.create({ amount, source })\n+ stripe.paymentIntents.create({ amount, payment_method, confirm: true })',
    checks: [{ name: 'tsc', before: 'pass', after: 'pass' }],
    costUsd: 0.42,
    transcriptPath: '',
    ...overrides,
  };
}

export function makeRecipe(overrides: Partial<MemoryRecipe> = {}): MemoryRecipe {
  return {
    id: 'recipe-stripe-charges',
    provider: 'stripe',
    kind: 'endpoint-removed',
    preconditions: 'Code calls stripe.charges.create with a card source.',
    steps:
      '1. Replace charges.create with paymentIntents.create.\n2. Pass payment_method and confirm: true.',
    pitfalls: 'PaymentIntents can need 3DS confirmation; handle requires_action.',
    diffSketch:
      '- charges.create({ source })\n+ paymentIntents.create({ payment_method, confirm: true })',
    sourceRuns: ['run-1'],
    verifiedRepos: 1,
    repos: ['example-org/shop'],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}
