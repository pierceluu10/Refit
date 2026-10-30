import { expect, it } from 'vitest';
import { behaviourTestWriter } from './workflow.ts';

const AI = { apiKey: 'key', model: 'gpt-6.1-sol' };
const MOCK = {
  stripeMockImage: 'stripe/stripe-mock:latest',
  beforeFixtures: 'a',
  afterFixtures: 'b',
};

it('writes behaviour tests with the AI patch options wherever stripe-mock can run them', () => {
  expect(behaviourTestWriter({ aiPatch: AI, generatedChecks: MOCK })).toBe(AI);
  // Without stripe-mock settings the tests cannot run, so nothing is spent writing them.
  expect(behaviourTestWriter({ aiPatch: AI })).toBeUndefined();
  expect(behaviourTestWriter({ generatedChecks: MOCK })).toBeUndefined();
  expect(
    behaviourTestWriter({ aiPatch: AI, generatedChecks: MOCK, behaviourTestWriter: false }),
  ).toBeUndefined();
  const dry = { model: 'gpt-6.1-sol', dryRun: true as const };
  expect(
    behaviourTestWriter({ aiPatch: AI, generatedChecks: MOCK, behaviourTestWriter: dry }),
  ).toBe(dry);
});
