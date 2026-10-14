import { expect, it } from 'vitest';
import { migrationIdentity } from './migration-identity.ts';
import { STRIPE } from './providers.ts';
import { digest } from './specifications.ts';

const revision = 'a'.repeat(40);
const findings = [
  {
    file: 'billing.ts',
    line: 3,
    column: 1,
    confidence: 'confirmed' as const,
    changeId: 'stripe-history',
    expression: '.charges',
    reason: 'Test migration evidence.',
  },
];

it('preserves the historical PR identity when adding or changing version-option metadata', () => {
  const historicalAdapter = { ...STRIPE };
  delete historicalAdapter.apiVersion;
  delete historicalAdapter.constructorCalls;
  const historical = digest(
    JSON.stringify({ revision, adapter: historicalAdapter, changes: ['stripe-history'] }),
  );
  expect(migrationIdentity({ adapter: STRIPE, findings }, revision)).toBe(historical);
  expect(
    migrationIdentity(
      {
        adapter: {
          ...STRIPE,
          apiVersion: { constructorArgument: 0, property: 'headers.version', requestArguments: [] },
        },
        findings,
      },
      revision,
    ),
  ).toBe(historical);
});

it('still distinguishes changed migration mappings and application revisions', () => {
  const current = migrationIdentity({ adapter: STRIPE, findings }, revision);
  expect(
    migrationIdentity({ adapter: { ...STRIPE, operations: [] }, findings }, revision),
  ).not.toBe(current);
  expect(migrationIdentity({ adapter: STRIPE, findings }, 'b'.repeat(40))).not.toBe(current);
});
