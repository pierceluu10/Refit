import { expect, it } from 'vitest';
import { assessmentConfiguration } from './assessment.ts';

it('reads reasoning effort and the escalation step from the environment', () => {
  const base = { OPENAI_API_KEY: 'key', OPENAI_MODEL: 'gpt-6.1-sol' };
  expect(assessmentConfiguration(true, base)).toMatchObject({
    escalation: { model: 'gpt-6.1-sol', reasoningEffort: 'high' },
  });
  expect(assessmentConfiguration(true, base)).not.toHaveProperty('reasoningEffort');
  expect(
    assessmentConfiguration(true, {
      ...base,
      OPENAI_REASONING_EFFORT: 'xhigh',
      OPENAI_ESCALATION_MODEL: 'gpt-other',
    }),
  ).toMatchObject({
    reasoningEffort: 'xhigh',
    escalation: { model: 'gpt-other', reasoningEffort: 'max' },
  });
  // The strongest effort has no step above it.
  expect(
    assessmentConfiguration(true, { ...base, OPENAI_REASONING_EFFORT: 'max' }),
  ).not.toHaveProperty('escalation');
  expect(
    assessmentConfiguration(true, { ...base, OPENAI_ESCALATION_EFFORT: 'none' }),
  ).not.toHaveProperty('escalation');
  expect(() =>
    assessmentConfiguration(true, { ...base, OPENAI_REASONING_EFFORT: 'extreme' }),
  ).toThrow(/OPENAI_REASONING_EFFORT must be one of low, medium, high, xhigh, max/);
});
