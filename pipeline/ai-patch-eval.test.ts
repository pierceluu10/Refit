import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { bundleId, comparisonTable, scoreBundle, scoreRun, summarizeRun } from './ai-patch-eval.ts';

const validated = { status: 'validated', stage: 'validation', error: null };
const failed = { status: 'validation-failed', stage: 'validation', error: null };
const deterministic = { number: 1, responseId: null, costUsd: null };
const ai = (number: number, costUsd: number | null = 0.002) => ({
  number,
  responseId: `resp_${number}`,
  costUsd,
});
const report = (
  generator: string,
  status: string,
  attempts: object[],
  repair: { requested: number; stopReason: string; error?: string | null },
) => ({ patch: { generator }, validation: { status, attempts, repair } });
const guardMessage =
  'AI replacement substitutes pre-existing field invoice.id for removed invoice.subscription in src/a.ts:4. Pre-existing fields may only be passed as arguments to SDK calls.';

it('does not count a deterministic patch that passed without a repair as an AI case', () => {
  const result = scoreBundle(
    'a/b',
    validated,
    report('deterministic', 'passed', [deterministic], {
      requested: 0,
      stopReason: 'not-needed-or-disabled',
    }),
  );
  expect(result).toMatchObject({ outcome: 'not-reached', aiAttempts: 0, costUsd: 0 });
});

it('scores an AI repair that passed, with its attempts and recorded cost', () => {
  const result = scoreBundle(
    'a/b',
    validated,
    report('openai', 'passed', [deterministic, ai(2, 0.0031)], {
      requested: 1,
      stopReason: 'checks-passed',
    }),
  );
  expect(result).toMatchObject({
    outcome: 'pass',
    validation: 'passed',
    aiAttempts: 1,
    repairs: 1,
    repairStop: 'checks-passed',
    costUsd: 0.0031,
    costComplete: true,
  });
});

it('scores a first AI proposal that passed with no repair', () => {
  const result = scoreBundle(
    'demo',
    validated,
    report('openai', 'passed', [ai(1, 0.0016)], {
      requested: 0,
      stopReason: 'not-needed-or-disabled',
    }),
  );
  expect(result).toMatchObject({ outcome: 'pass', aiAttempts: 1, repairs: 0, costUsd: 0.0016 });
});

it('scores a repair the substitution guard rejected, and marks its cost as incomplete', () => {
  const result = scoreBundle(
    'a/b',
    failed,
    report('deterministic', 'regression', [deterministic], {
      requested: 1,
      stopReason: 'repair-error',
      error: `PipelineInputError: ${guardMessage}`,
    }),
  );
  expect(result).toMatchObject({ outcome: 'guard-rejected', costComplete: false, repairs: 1 });
  expect(result.detail).toContain('substitutes pre-existing field');
});

it('separates guard rejections from the input checks on the model output', () => {
  const repairError = (error: string) =>
    scoreBundle(
      'a/b',
      failed,
      report('deterministic', 'regression', [deterministic], {
        requested: 1,
        stopReason: 'repair-error',
        error,
      }),
    ).outcome;
  expect(repairError('PipelineInputError: AI replacements overlap.')).toBe('input-rejected');
  expect(
    repairError('PipelineInputError: AI replacement must match exactly one source occurrence.'),
  ).toBe('input-rejected');
  expect(
    repairError(
      'PipelineInputError: AI evidence exceeds the 64 KiB input limit; narrow the repository scope.',
    ),
  ).toBe('evidence-limit');
  expect(
    repairError(
      'PipelineInputError: OpenAI response request failed with HTTP 500. No retry was made.',
    ),
  ).toBe('error');
});

it('scores a first AI proposal the guard rejected, which ends the workflow with an error', () => {
  const result = scoreBundle(
    'a/b',
    {
      status: 'error',
      stage: 'validation',
      error: { name: 'PipelineInputError', message: guardMessage },
    },
    undefined,
  );
  expect(result).toMatchObject({ outcome: 'guard-rejected', costComplete: false, aiAttempts: 0 });
});

it('scores an AI proposal with zero edits as declined', () => {
  expect(
    scoreBundle(
      'a/b',
      {
        status: 'error',
        stage: 'validation',
        error: {
          name: 'PipelineInputError',
          message: 'No supported patch proposal is available for this committed revision.',
        },
      },
      undefined,
    ).outcome,
  ).toBe('declined');
  expect(
    scoreBundle(
      'a/b',
      failed,
      report('deterministic', 'regression', [deterministic], {
        requested: 1,
        stopReason: 'no-proposal',
      }),
    ).outcome,
  ).toBe('declined');
});

it('scores a repair whose checks still fail as a regression', () => {
  const result = scoreBundle(
    'a/b',
    failed,
    report('openai', 'regression', [deterministic, ai(2)], {
      requested: 1,
      stopReason: 'attempt-limit',
    }),
  );
  expect(result).toMatchObject({ outcome: 'regression', aiAttempts: 1, costUsd: 0.002 });
});

it('keeps stops outside the AI step out of the AI counts', () => {
  expect(
    scoreBundle(
      'a/b',
      { status: 'needs-review', stage: 'scan', reason: 'A traced SDK request sends a parameter' },
      undefined,
    ),
  ).toMatchObject({ outcome: 'not-reached', detail: 'A traced SDK request sends a parameter' });
  expect(
    scoreBundle(
      'a/b',
      {
        status: 'error',
        stage: 'validation',
        error: { name: 'PipelineInputError', message: 'Dependency archive exceeds 1024 MiB.' },
      },
      undefined,
    ).outcome,
  ).toBe('not-reached');
  expect(
    scoreBundle(
      'a/b',
      failed,
      report('deterministic', 'baseline-failed', [], {
        requested: 0,
        stopReason: 'baseline-failed',
      }),
    ).outcome,
  ).toBe('not-reached');
  expect(scoreBundle('a/b', undefined, undefined).outcome).toBe('missing');
});

it('names Stripe benchmark bundles by repository and other bundles by directory', () => {
  expect(bundleId('/out/3/repos/kpirabaharan__Spotify-Clone/run')).toBe(
    'kpirabaharan/Spotify-Clone',
  );
  expect(bundleId('/out/billing-demo')).toBe('billing-demo');
});

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it('scores a run directory against the frozen case ids, including cases without a bundle', async () => {
  root = await mkdtemp(join(tmpdir(), 'refit-ai-patch-eval-'));
  const bundle = async (directory: string, manifest: object, value?: object) => {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({ kind: 'refit-workflow', ...manifest }),
    );
    if (value) await writeFile(join(directory, 'report.json'), JSON.stringify(value));
  };
  await bundle(
    join(root, '0', 'repos', 'a__b', 'run'),
    validated,
    report('openai', 'passed', [deterministic, ai(2, 0.004)], {
      requested: 1,
      stopReason: 'checks-passed',
    }),
  );
  await bundle(
    join(root, 'billing-demo'),
    failed,
    report('openai', 'regression', [ai(1), ai(2)], {
      requested: 1,
      stopReason: 'attempt-limit',
    }),
  );
  const results = await scoreRun(root, ['a/b', 'c/d', 'billing-demo']);
  expect(results.map((result) => result.outcome)).toEqual(['pass', 'missing', 'regression']);
  const summary = summarizeRun(results);
  expect(summary).toMatchObject({ cases: 3, reached: 2, repairsRequested: 2 });
  expect(summary.recordedCostUsd).toBeCloseTo(0.008);
  expect(summary.counts.pass).toBe(1);
  const table = comparisonTable([{ label: 'before', results }]);
  expect(table).toContain('| a/b | pass, 1 repair (checks-passed), $0.0040 |');
  expect(table).toContain('| c/d | missing, $0.0000 |');
});
