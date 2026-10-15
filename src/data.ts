import { createConfiguration, MAX_REPAIR_ATTEMPTS, validationChecks } from './configuration';

export const PROJECT_URL = 'https://github.com/pierceluu10/Refit';
export const STEP_DURATION = 2200;
export const COPY_FEEDBACK_DURATION = 2000;

export const stages = [
  {
    id: 'detect',
    title: 'Detect the change',
    short: 'Detect',
    description:
      'Start with the source. Compare versioned API specifications to see exactly what changed.',
    artifact: 'stripe / openapi',
    detail:
      'A response field changes shape. Refit starts with the specification diff, not a guess from a changelog.',
  },
  {
    id: 'understand',
    title: 'Find what matters',
    short: 'Understand',
    description:
      'Trace the change to the places your code actually uses. Leave unaffected repositories alone.',
    artifact: 'src / billing / payments.ts',
    detail:
      'Follow the provider call into your payment wrapper and identify the affected property access.',
  },
  {
    id: 'validate',
    title: 'Make it pass',
    short: 'Validate',
    description: 'Generate a focused patch in isolation, then run your project’s own checks.',
    artifact: 'refit.yml / validation',
    detail:
      'Typecheck, lint, and test using your configuration. Failed checks trigger a bounded repair attempt.',
  },
  {
    id: 'review',
    title: 'Your review. Your merge.',
    short: 'Review',
    description:
      'Get a draft pull request with the context, code changes, and validation results together.',
    artifact: 'GitHub / draft pull request',
    detail: 'Review the evidence and the diff before you merge. Refit never auto-merges your code.',
  },
] as const;

export type Scenario = 'affected' | 'unaffected' | 'failed';
export const scenarios: Record<Scenario, { label: string; summary: string }> = {
  affected: {
    label: 'Affected code',
    summary: 'An illustrative migration from an expanded charge list to a latest-charge reference.',
  },
  unaffected: {
    label: 'Unaffected code',
    summary:
      'This repository uses the provider, but does not read the changed field. No patch is needed.',
  },
  failed: {
    label: 'Checks fail',
    summary:
      'The patch does not pass the example project’s tests. Validation blocks draft-PR publication.',
  },
};

export const configuration = createConfiguration('npm', validationChecks, MAX_REPAIR_ATTEMPTS);

export const sampleRepositories = [
  {
    id: 'acme-api',
    name: 'acme / api',
    language: 'TypeScript',
    provider: 'Stripe',
    status: 'Affected',
    file: 'src/billing/payments.ts',
    description: 'Payment processing and customer billing.',
  },
  {
    id: 'acme-web',
    name: 'acme / web',
    language: 'TypeScript',
    provider: 'Stripe',
    status: 'Unaffected',
    file: 'src/checkout/create-session.ts',
    description: 'Checkout sessions without the affected property access.',
  },
  {
    id: 'acme-worker',
    name: 'acme / worker',
    language: 'JavaScript',
    provider: 'Stripe',
    status: 'Needs review',
    file: 'jobs/reconcile-payments.js',
    description: 'A dynamic access pattern needs a closer look.',
  },
] as const;
