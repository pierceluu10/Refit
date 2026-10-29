import { expect, it } from 'vitest';
import { outcomeOf, parseEnvFile } from './ai-provider-benchmark-cli.ts';

it('gives each row one outcome across the model-fix and migration lanes', () => {
  const none = { findings: 0, lanes: [] };
  expect(outcomeOf({ ...none, infrastructure: { kind: 'clone' } })).toBe('infrastructure');
  expect(outcomeOf({ ...none, error: 'boom' })).toBe('error');
  expect(outcomeOf(none)).toBe('unaffected');
  expect(outcomeOf({ findings: 0, lanes: ['no-change'] })).toBe('unaffected');
  expect(outcomeOf({ language: 'py', findings: 2, lanes: ['needs-review'] })).toBe(
    'detection-only',
  );
  expect(outcomeOf({ language: 'js', findings: 1, lanes: [] })).toBe('needs-review');
  expect(outcomeOf({ language: 'js', findings: 0, lanes: ['needs-review'] })).toBe('needs-review');
  expect(outcomeOf({ language: 'js', findings: 1, lanes: ['proposed'] })).toBe('proposed');
  expect(outcomeOf({ language: 'js', findings: 1, lanes: ['validated', 'no-change'] })).toBe(
    'validated',
  );
  expect(outcomeOf({ language: 'js', findings: 1, lanes: ['validated', 'validated'] })).toBe(
    'validated',
  );
  expect(
    outcomeOf({ language: 'js', findings: 1, lanes: ['validated', 'validation-failed'] }),
  ).toBe('validation-failed');
  expect(outcomeOf({ language: 'js', findings: 1, lanes: ['no-checks'] })).toBe('no-checks');
  expect(outcomeOf({ language: 'js', findings: 1, lanes: ['validated', 'no-checks'] })).toBe(
    'no-checks',
  );
});

it('reads KEY=value lines from the AI env file and ignores the rest', () => {
  expect(parseEnvFile('OPENAI_API_KEY=a=b\n# note\nlower=x\nREFIT_AI_BUDGET_USD=1\n')).toEqual({
    OPENAI_API_KEY: 'a=b',
    REFIT_AI_BUDGET_USD: '1',
  });
});
