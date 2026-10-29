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

it('names timeouts, memory and native crashes instead of the last stack line', async () => {
  const { errorSummary } = await import('./ai-provider-benchmark-cli.ts');
  expect(errorSummary({ killed: true, signal: 'SIGKILL' })).toBe(
    'timed out (killed after the scan limit)',
  );
  expect(
    errorSummary({
      stderr: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    }),
  ).toBe('Node ran out of memory');
  expect(
    errorSummary({ stderr: ' 1: 0xabc node::Abort\n55: 0x18f932b98 start [/usr/lib/dyld]' }),
  ).toBe('Node crashed (native stack, no message)');
  expect(
    errorSummary({ stderr: 'refit deadlines: a.js: Unterminated template literal.\n    at x' }),
  ).toBe('refit deadlines: a.js: Unterminated template literal.');
});

it('reports an available but not required SDK upgrade, and report-only items, as their own outcomes', async () => {
  const { outcomeOf, migrationLane, rowOutcome } = await import('./ai-provider-benchmark-cli.ts');
  expect(outcomeOf({ language: 'js', findings: 0, lanes: ['optional-upgrade'] })).toBe(
    'optional-upgrade',
  );
  expect(outcomeOf({ language: 'js', findings: 1, lanes: ['optional-upgrade'] })).toBe(
    'needs-review',
  );
  expect(outcomeOf({ language: 'js', findings: 0, lanes: ['optional-upgrade', 'proposed'] })).toBe(
    'proposed',
  );
  expect(outcomeOf({ language: 'js', findings: 0, reports: 2, lanes: [] })).toBe('report-only');
  expect(
    migrationLane({ review: [], proposal: null, validation: { status: 'upgrade-optional' } }),
  ).toBe('optional-upgrade');
  const stop = (category?: string) => ({ blocking: true, category });
  expect(
    migrationLane({
      review: [],
      proposal: { edits: [1], stops: [stop('optional-upgrade')] },
      validation: null,
    }),
  ).toBe('optional-upgrade');
  expect(
    migrationLane({
      review: [],
      proposal: { edits: [1], stops: [stop('optional-upgrade'), stop()] },
      validation: null,
    }),
  ).toBe('needs-review');
  expect(migrationLane({ review: [], proposal: { edits: [1], stops: [] }, validation: null })).toBe(
    'proposed',
  );
  expect(
    rowOutcome({
      language: 'js',
      exposures: [],
      replacements: [],
      stops: [],
      alerts: [],
      validation: null,
      migrations: { review: [{ status: 'report' }], proposal: null, validation: null },
    }),
  ).toBe('report-only');
  expect(
    rowOutcome({
      language: 'js',
      exposures: ['x'],
      replacements: [{}],
      stops: [],
      alerts: [],
      validation: null,
      migrations: {
        review: [],
        proposal: null,
        validation: null,
        ai: { status: 'draft-created', lane: { edits: [1] } },
      },
    }),
  ).toBe('proposed');
});
