import { expect, it } from 'vitest';
import { scoreWrapperSites } from '../scripts/model-wrapper-score.mjs';

const site = (line: number, model: string, provider = 'openai', wrapper = 'ai-sdk') => ({
  file: 'src/ai.ts',
  line,
  model,
  provider,
  wrapper,
});

it('scores detected wrapper sites against labels by file, line, model and provider', () => {
  const score = scoreWrapperSites(
    [
      {
        repo: 'a/one',
        sites: [site(1, 'gpt-4'), site(2, 'claude-3-opus', 'anthropic', 'langchain')],
      },
      { repo: 'b/two', sites: [site(5, 'gpt-4o', 'openai', 'llamaindex')] },
      // Labelled with no sites: anything found there is a false positive.
      { repo: 'c/none', sites: [] },
    ],
    {
      'a/one': [site(1, 'gpt-4'), site(3, 'gpt-4o')],
      // Right place, wrong provider: one false negative and one false positive.
      'b/two': [site(5, 'gpt-4o', 'anthropic', 'llamaindex')],
      'c/none': [site(9, 'gpt-4')],
      // Not labelled: not scored.
      'd/other': [site(1, 'gpt-4')],
    },
  );
  expect(score).toMatchObject({
    repositories: 3,
    truePositives: 1,
    falsePositives: 3,
    falseNegatives: 2,
    precision: 25,
    recall: 33.3,
    byWrapper: {
      'ai-sdk': {
        truePositives: 1,
        falsePositives: 2,
        falseNegatives: 0,
        precision: 33.3,
        recall: 100,
      },
      langchain: {
        truePositives: 0,
        falsePositives: 0,
        falseNegatives: 1,
        precision: null,
        recall: 0,
      },
      llamaindex: {
        truePositives: 0,
        falsePositives: 1,
        falseNegatives: 1,
        precision: 0,
        recall: 0,
      },
    },
  });
  expect(score.falseNegativeSites.map((item) => `${item.repo} ${item.line}`)).toEqual([
    'a/one 2',
    'b/two 5',
  ]);
  expect(score.falsePositiveSites.map((item) => `${item.repo} ${item.line}`)).toEqual([
    'a/one 3',
    'b/two 5',
    'c/none 9',
  ]);
  expect(scoreWrapperSites([], {})).toMatchObject({ precision: null, recall: null });
});
