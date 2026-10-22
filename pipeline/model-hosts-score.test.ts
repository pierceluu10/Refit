import { expect, it } from 'vitest';
import { scoreModelHosts } from './model-hosts-score.ts';

it('scores detections on labelled lines by host, kind and value', () => {
  const score = scoreModelHosts(
    [
      {
        at: 'a.ts:1',
        units: [
          { host: 'bedrock', kind: 'model-id', value: 'meta.llama3-8b-instruct-v1:0', use: 'call' },
        ],
      },
      {
        at: 'b.ts:2',
        units: [{ host: 'openrouter', kind: 'model-id', value: 'openai/gpt-4o', use: 'test' }],
      },
      { at: 'c.ts:3', units: [] },
    ],
    [
      {
        file: 'a.ts',
        line: 1,
        host: 'bedrock',
        kind: 'model-id',
        value: 'meta.llama3-8b-instruct-v1:0',
      },
      { file: 'c.ts', line: 3, host: 'azure-openai', kind: 'deployment', value: 'x' },
      // Not on a labelled line: not scored.
      { file: 'd.ts', line: 9, host: 'bedrock', kind: 'model-id', value: 'amazon.nova-pro-v1:0' },
    ],
  );
  expect(score.overall).toEqual({
    truePositives: 1,
    falsePositives: 1,
    falseNegatives: 1,
    precision: 0.5,
    recall: 0.5,
  });
  expect(score.byHost.openrouter.recall).toBe(0);
  expect(score.byHost['azure-openai'].precision).toBe(0);
  expect(score.truePositivesByUse).toEqual({ call: 1 });
});
