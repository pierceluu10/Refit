import { expect, it } from 'vitest';
import { scoreGeminiLabels } from './gemini-labels.ts';

const labels = {
  repos: [
    {
      repo: 'a/one',
      commit: 'c1',
      pins: [
        {
          file: 'src/a.ts',
          line: 1,
          model: 'gemini-2.0-flash',
          label: 'sent' as const,
          via: 'sdk' as const,
        },
        {
          file: 'src/a.ts',
          line: 2,
          model: 'gemini-2.5-pro',
          label: 'sent' as const,
          via: 'other' as const,
        },
        { file: 'src/models.ts', line: 3, model: 'gemini-1.5-pro', label: 'not-sent' as const },
        { file: 'src/b.ts', line: 4, model: 'gemini-pro', label: 'ambiguous' as const },
        {
          file: 'src/c.ts',
          line: 5,
          model: 'gemini-2.5-flash',
          label: 'sent' as const,
          via: 'sdk' as const,
        },
      ],
    },
  ],
};

it('scores the live class and the tracer against the labels, ignoring ambiguous pins', () => {
  const score = scoreGeminiLabels(labels, [
    {
      repo: 'a/one',
      commit: 'c1',
      matches: [
        'src/a.ts:1 gemini-2.0-flash live',
        'src/a.ts:2 gemini-2.5-pro live',
        'src/models.ts:3 gemini-1.5-pro live',
        'src/b.ts:4 gemini-pro live',
        'src/c.ts:5 gemini-2.5-flash catalog',
      ],
      traced: ['src/a.ts:1 gemini-2.0-flash', 'src/models.ts:3 gemini-1.5-pro'],
    },
  ]);
  expect(score.counts).toEqual({
    truePositives: 2,
    falsePositives: 1,
    sent: 3,
    traced: 1,
    sdkSent: 2,
    wrong: 1,
  });
  expect(score.livePrecision).toBeCloseTo(2 / 3);
  expect(score.liveRecall).toBeCloseTo(2 / 3);
  expect(score.sdkPinsTraced).toBe(0.5);
  expect(score.tracedPrecision).toBe(0.5);
  expect(score.missedLive).toEqual(['a/one src/c.ts:5 gemini-2.5-flash']);
  expect(score.untraced).toEqual(['a/one src/c.ts:5 gemini-2.5-flash']);
  expect(score.wrongLive).toEqual(['a/one src/models.ts:3 gemini-1.5-pro']);
  expect(score.wrongTraced).toEqual(['a/one src/models.ts:3 gemini-1.5-pro']);
});

it('refuses missing or mismatched results', () => {
  expect(() => scoreGeminiLabels(labels, [])).toThrow('a/one was not scanned.');
  expect(() => scoreGeminiLabels(labels, [{ repo: 'a/one', commit: 'c2' }])).toThrow(
    'a/one was scanned at c2, not c1.',
  );
});
