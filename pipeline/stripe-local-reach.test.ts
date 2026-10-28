import { expect, it } from 'vitest';
import type { BreakingOperationImpact } from './provider-operations.ts';
import { localReach } from './stripe-type-evidence.ts';
import type { Finding } from './types.ts';

// Owner decision D2b for contract changes: a response change that only untraced reads of its name
// reach stops blocking when every one of those reads is of the repository's own object.

const before = {
  paths: {
    '/v1/payment_intents': {
      post: {
        responses: {
          '200': {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/payment_intent' } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: { payment_intent: { type: 'object', properties: { amount: { type: 'integer' } } } },
  },
};

const change = () => ({
  id: 'response-property-became-optional',
  level: 2,
  operation: 'POST',
  path: '/v1/payment_intents',
  text: 'the response property `amount` became optional for the status `200`',
  reach: 'unknown',
  reachReason: 'app/cart.ts:4 reads `amount` on an object Refit cannot trace.',
});

const impact = (text: string): BreakingOperationImpact => ({
  operationId: 'PostPaymentIntents',
  path: '/v1/payment_intents',
  httpMethod: 'post',
  text: '',
  changes: [{ id: 'response-property-became-optional', level: 2, text }],
  usages: [],
});

const read = (line: number, extra: Partial<Finding> = {}): Finding => ({
  file: 'app/cart.ts',
  line,
  column: 3,
  changeId: 'reach:payment_intent.amount',
  expression: '.amount',
  confidence: 'review',
  reason: 'untraced',
  untraced: true,
  ...extra,
});

function run(reads: Finding[], local: (found: Finding[]) => Finding[]) {
  const changes = [change()];
  const result = localReach({
    changes,
    impacts: [impact(changes[0].text)],
    before,
    reads: (removals) => {
      expect(removals.map((removal) => removal.id)).toEqual(['reach:payment_intent.amount']);
      return reads;
    },
    local,
  });
  return { ...result, change: changes[0] };
}

it('clears a change whose every read is of the repository’s own object', () => {
  const { cleared, impacts, change: updated } = run([read(4), read(9)], (found) => found);
  expect(cleared).toHaveLength(1);
  expect(impacts).toEqual([]);
  expect(updated.reach).toBe('unused');
  expect(updated.reachReason).toContain('Owner decision D2b');
  expect(updated.reachReason).toContain('app/cart.ts:4, app/cart.ts:9');
});

it('keeps a change when one read is not shown to be the repository’s own', () => {
  const {
    cleared,
    impacts,
    change: updated,
  } = run([read(4), read(9)], (found) => found.filter((entry) => entry.line === 4));
  expect(cleared).toEqual([]);
  expect(impacts).toHaveLength(1);
  expect(updated.reach).toBe('unknown');
});

it('keeps a change with a traced or confirmed read, and one with no read at all', () => {
  const traced = { untraced: undefined, confidence: 'review' as const };
  expect(run([read(4), read(9, traced)], (found) => found).cleared).toEqual([]);
  expect(
    run([read(4, { confidence: 'confirmed', untraced: undefined })], (found) => found).cleared,
  ).toEqual([]);
  expect(run([], (found) => found).cleared).toEqual([]);
});

it('ignores reads in test files and leaves changes that are not unknown', () => {
  expect(
    run([read(4), read(2, { file: 'app/cart.test.ts' })], (found) => found).cleared,
  ).toHaveLength(1);
  const reached = { ...change(), reach: 'reached' };
  const result = localReach({
    changes: [reached],
    impacts: [impact(reached.text)],
    before,
    reads: () => [read(4)],
    local: (found) => found,
  });
  expect(result.cleared).toEqual([]);
  expect(reached.reach).toBe('reached');
});
