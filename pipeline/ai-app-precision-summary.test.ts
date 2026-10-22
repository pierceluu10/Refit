import { describe, expect, it } from 'vitest';
import {
  isProduction,
  modelCandidates,
  reportedSites,
  scoreSet,
  seededOrder,
  talksToProvider,
  validateSiteLabels,
  wilson,
  type DeadlinesRun,
  type SiteLabel,
  type SiteLabels,
} from '../scripts/ai-app-precision-summary.mjs';

function site(
  repo: string,
  file: string,
  line: number,
  model: string,
  extra: Partial<SiteLabel> = {},
) {
  return { repo, file, line, model, provider: 'openai', via: 'sdk', registry: true, ...extra };
}

// 30 negative files per set, as the labels file must hold.
function negatives(set: string, repo: string) {
  return Array.from({ length: 30 }, (_, i) => ({ set, repo, file: `src/negative-${i}.ts` }));
}

function exposure(id: string, evidence: [string, number, string][], more = 0) {
  return {
    deadline: { id, provider: 'openai' },
    more,
    evidence: evidence.map(([file, line, version]) => ({ kind: 'source', file, line, version })),
  };
}

describe('candidate search', () => {
  it('keeps production JS, TS and Python and drops tests, scripts, examples and config', () => {
    expect(isProduction('src/lib/ai.ts')).toBe(true);
    expect(isProduction('app/agent.py')).toBe(true);
    expect(isProduction('src/__tests__/ai.ts')).toBe(false);
    expect(isProduction('src/ai.test.ts')).toBe(false);
    expect(isProduction('pkg/client_test.ts')).toBe(false);
    expect(isProduction('scripts/seed.ts')).toBe(false);
    expect(isProduction('examples/chat.ts')).toBe(false);
    expect(isProduction('next.config.mjs')).toBe(false);
    expect(isProduction('node_modules/openai/index.js')).toBe(false);
    expect(isProduction('README.md')).toBe(false);
  });

  it('lists model-shaped literals and model fields, but not bare product names', () => {
    const text = [
      "const a = 'gpt-4o-mini';",
      'const cli = "claude";',
      "client.messages.create({ model: 'claude-3-5-haiku-latest' })",
      'const model = process.env.MODEL ?? fallback;',
      "const reasoning = 'o3-mini';",
      'const other = 1;',
    ].join('\n');
    expect(modelCandidates(text)).toEqual([
      { line: 1, literals: ['gpt-4o-mini'] },
      { line: 3, literals: ['claude-3-5-haiku-latest'] },
      { line: 4, literals: [] },
      { line: 5, literals: ['o3-mini'] },
    ]);
  });

  it("finds files that import a set's SDK or name its API host", () => {
    expect(talksToProvider('openai', "import OpenAI from 'openai';")).toBe(true);
    expect(talksToProvider('openai', "fetch('https://api.openai.com/v1/chat')")).toBe(true);
    expect(talksToProvider('openai', "import Anthropic from '@anthropic-ai/sdk';")).toBe(false);
    expect(talksToProvider('anthropic', 'from anthropic import Anthropic')).toBe(true);
  });

  it('draws the same order for the same seed, whatever the input order', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f'];
    const order = seededOrder(items, 20261022);
    expect([...order].sort()).toEqual(items);
    expect(seededOrder([...items].reverse(), 20261022)).toEqual(order);
    expect(seededOrder(items, 1)).not.toEqual(order);
  });
});

describe('labels', () => {
  const sample = { openai: ['o/one', 'o/two'], anthropic: ['a/one'] };

  it('accepts a valid labels file', () => {
    const labels = {
      sample,
      sites: [site('o/one', 'src/ai.ts', 3, 'gpt-4o')],
      negatives: [...negatives('openai', 'o/two'), ...negatives('anthropic', 'a/one')],
    };
    expect(validateSiteLabels(labels)).toEqual([]);
  });

  it('reports sites outside the sample, bad fields, duplicates and too few negatives', () => {
    const labels = {
      sample,
      sites: [
        site('x/stranger', 'src/ai.ts', 1, 'gpt-4o'),
        site('o/one', 'src/ai.ts', 2, 'gpt-4o', { provider: 'mistral', via: 'magic' }),
        site('o/one', '../ai.ts', 0, ''),
        site('o/one', 'src/ai.ts', 3, 'gpt-4o'),
        site('o/one', 'src/ai.ts', 3, 'gpt-4o'),
        site('o/two', 'src/negative-0.ts', 1, 'gpt-4o'),
      ],
      negatives: [
        ...negatives('openai', 'o/two'),
        { set: 'anthropic', repo: 'o/one', file: 'a.ts' },
      ],
    };
    expect(validateSiteLabels(labels)).toEqual([
      'x/stranger src/ai.ts:1: repository not in a sample',
      'o/one src/ai.ts:2: provider mistral',
      'o/one src/ai.ts:2: via magic',
      'o/one ../ai.ts:0: model',
      'o/one ../ai.ts:0: line',
      'o/one ../ai.ts:0: file',
      'o/one src/ai.ts:3: duplicate site',
      'o/two src/negative-0.ts: negative file has a labelled site',
      'anthropic: 1 negative files, at least 30 needed',
      'o/one a.ts: negative outside the anthropic sample',
    ]);
  });
});

describe('scoring', () => {
  it('computes Wilson intervals', () => {
    expect(wilson(0, 0)).toEqual({ k: 0, n: 0, rate: null, low: null, high: null });
    expect(wilson(8, 10)).toEqual({ k: 8, n: 10, rate: 80, low: 49, high: 94.3 });
  });

  it('reads live source evidence and the deadlines cut at the evidence limit', () => {
    const result = {
      exposures: [
        {
          ...exposure('openai-a', [['src/ai.ts', 3, 'gpt-4o']], 2),
          evidence: [
            { kind: 'source', file: 'src/ai.ts', line: 3, version: 'gpt-4o' },
            { kind: 'dependency', file: 'package.json', line: 9, version: '4.0.0' },
          ],
        },
      ],
    };
    const { sites, capped } = reportedSites(result);
    expect(sites).toEqual([
      { file: 'src/ai.ts', line: 3, model: 'gpt-4o', provider: 'openai', deadline: 'openai-a' },
    ]);
    expect([...capped]).toEqual(['openai-a']);
    expect(reportedSites(undefined).sites).toEqual([]);
  });

  it('scores true and false positives, misses, the evidence limit and errored repositories', () => {
    const labels: SiteLabels = {
      sample: { openai: ['o/one', 'o/two', 'o/broken'], anthropic: [] },
      sites: [
        site('o/one', 'src/ai.ts', 3, 'gpt-4o'),
        site('o/one', 'src/ai.ts', 9, 'gpt-4o-mini'),
        site('o/one', 'src/new.ts', 1, 'gpt-6', { registry: false }),
        site('o/one', 'src/router.ts', 2, 'llama-3', { provider: 'compatible', registry: false }),
        site('o/two', 'src/big.ts', 5, 'gpt-3.5-turbo'),
        site('o/broken', 'src/ai.ts', 1, 'gpt-4o'),
      ],
      negatives: [{ set: 'openai', repo: 'o/one', file: 'src/quiet.ts' }],
    };
    const results: Record<string, DeadlinesRun> = {
      'o/one': {
        exposures: [
          exposure('openai-4o', [
            ['src/ai.ts', 3, 'gpt-4o'],
            ['src/quiet.ts', 7, 'gpt-4o'],
          ]),
        ],
      },
      'o/two': { exposures: [exposure('openai-35', [['src/other.ts', 1, 'gpt-3.5-turbo']], 4)] },
      'o/broken': { error: 'scan failed' },
    };
    const deadlineOf = new Map([
      ['openai:gpt-4o', 'openai-4o'],
      ['openai:gpt-4o-mini', 'openai-mini'],
      ['openai:gpt-3.5-turbo', 'openai-35'],
    ]);
    const score = scoreSet('openai', labels, results, deadlineOf);
    expect(score.repositories).toBe(2);
    expect(score.errored).toEqual([{ repo: 'o/broken', error: 'scan failed' }]);
    expect(score.labelledSites).toBe(4);
    expect(score.registrySites).toBe(3);
    expect(score.nonRegistrySites).toBe(1);
    expect(score.compatibleSites).toBe(1);
    expect(score.truePositives.map((s) => `${s.file}:${s.line}`)).toEqual(['src/ai.ts:3']);
    expect(score.falsePositives.map((s) => `${s.repo} ${s.file}:${s.line}`)).toEqual([
      'o/one src/quiet.ts:7',
      'o/two src/other.ts:1',
    ]);
    expect(score.negativeFileFalsePositives).toBe(1);
    expect(score.falseNegatives.map((s) => `${s.file}:${s.line}`)).toEqual(['src/ai.ts:9']);
    expect(score.beyondLimit.map((s) => `${s.repo} ${s.file}:${s.line}`)).toEqual([
      'o/two src/big.ts:5',
    ]);
    expect(score.precision).toMatchObject({ k: 1, n: 3 });
    expect(score.recall).toMatchObject({ k: 1, n: 2 });
    expect(score.recallAllSites).toMatchObject({ k: 1, n: 4 });
  });
});
