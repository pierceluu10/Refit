import { describe, expect, it } from 'vitest';
import {
  applicationReason,
  namesLiteral,
  reportedLines,
  scoreFresh,
  wilson,
} from '../scripts/deadline-fresh-helpers.mjs';

describe('application check', () => {
  it('keeps private packages, app frameworks and packages without entry points', () => {
    expect(applicationReason({ private: true, main: 'index.js' })).toBeNull();
    expect(applicationReason({ main: 'index.js', dependencies: { next: '15' } })).toBeNull();
    expect(applicationReason({ devDependencies: { vite: '6' }, exports: './x.js' })).toBeNull();
    expect(applicationReason({ name: 'bot', scripts: { start: 'node .' } })).toBeNull();
  });

  it('rejects a published library', () => {
    expect(
      applicationReason({ name: 'lib', main: 'dist/index.js', dependencies: { zod: '3' } }),
    ).toBe('library package.json');
  });
});

// A deadline group as `refit deadlines --json` prints it, with only the fields the scorer reads.
function group(
  id: string,
  evidence: [string, number, string, string][],
  more = 0,
  nonLiveMore = 0,
) {
  const items = evidence.map(([file, line, version, use]) => ({ file, line, version, use }));
  return {
    deadline: { id },
    more,
    nonLiveMore,
    evidence: items.filter((i) => i.use === 'live'),
    nonLive: items.filter((i) => i.use !== 'live'),
  };
}

const label = (repo: string, file: string, line: number, version: string, kind: string) => ({
  repo,
  file,
  line,
  version,
  provider: version.startsWith('claude') ? 'anthropic' : 'openai',
  label: kind,
  note: '',
});

describe('scoring', () => {
  it('reads listed lines, their uses and the deadlines cut at the limit', () => {
    const result = {
      exposures: [group('gpt-4', [['a.ts', 1, 'gpt-4', 'live']], 3)],
      mentions: [group('haiku', [['t.test.ts', 2, 'claude-3-haiku-20240307', 'tokenizer']], 0, 5)],
    };
    const { lines, cappedLive, cappedNonLive } = reportedLines(result);
    expect([...lines.values()].map((l) => `${l.file}:${l.use}`)).toEqual([
      'a.ts:live',
      't.test.ts:other',
    ]);
    expect([...cappedLive]).toEqual(['gpt-4']);
    expect([...cappedNonLive]).toEqual(['haiku']);
  });

  it('scores live exposure, use classification, misses and the evidence limit', () => {
    const deadlineOf = new Map([
      ['openai:gpt-4', { id: 'gpt-4' }],
      ['anthropic:claude-3-haiku-20240307', { id: 'haiku' }],
    ]);
    const labels = [
      label('o/a', 'src/chat.ts', 3, 'gpt-4', 'live'),
      label('o/a', 'src/models.ts', 9, 'gpt-4', 'catalog'),
      label('o/a', 'test/chat.test.ts', 4, 'gpt-4', 'test'),
      label('o/a', 'src/old.ts', 1, 'gpt-4', 'comment'),
      label('o/b', 'src/ai.ts', 7, 'claude-3-haiku-20240307', 'live'),
      label('o/c', 'src/list.ts', 2, 'gpt-4', 'catalog'),
      label('o/c', 'src/x.ts', 5, 'not-in-registry', 'live'),
    ];
    const results = {
      'o/a': {
        exposures: [
          group('gpt-4', [
            ['src/chat.ts', 3, 'gpt-4', 'live'],
            ['src/models.ts', 9, 'gpt-4', 'catalog'],
            ['test/chat.test.ts', 4, 'gpt-4', 'live'],
            ['src/extra.ts', 8, 'gpt-4', 'live'],
          ]),
        ],
      },
      'o/b': {
        exposures: [],
        mentions: [group('haiku', [['src/ai.ts', 7, 'claude-3-haiku-20240307', 'catalog']])],
      },
      'o/c': { exposures: [group('gpt-4', [['src/list.ts', 2, 'gpt-4', 'live']])] },
      'o/d': { error: 'scan limits' },
    };
    const score = scoreFresh(['o/a', 'o/b', 'o/c', 'o/d'], labels, results, deadlineOf);
    expect(score.errored).toEqual(['o/d']);
    expect(score.exposed).toBe(2);
    expect(score.repoPrecision).toMatchObject({ k: 1, n: 2 });
    expect(score.repoRecall).toMatchObject({ k: 1, n: 2 });
    expect(score.pairPrecision).toMatchObject({ k: 1, n: 2 });
    expect(score.falseNegativePairs).toEqual([['o/b', 'haiku']]);
    expect(score.live.precision).toMatchObject({ k: 1, n: 3 });
    expect(score.live.recall).toMatchObject({ k: 1, n: 2 });
    expect(score.test.recall).toMatchObject({ k: 0, n: 1 });
    expect(score.comment.recall).toMatchObject({ k: 0, n: 1 });
    expect(score.catalog.precision).toMatchObject({ k: 1, n: 2 });
    expect(score.lineFalsePositives.map((l) => `${l.repo} ${l.file}`)).toEqual([
      'o/a test/chat.test.ts',
      'o/c src/list.ts',
    ]);
    expect(score.lineFalseNegatives.map((l) => `${l.repo} ${l.file} ${l.reported}`)).toEqual([
      'o/b src/ai.ts catalog',
    ]);
    expect(score.unlabelledReported.map((l) => l.file)).toEqual(['src/extra.ts']);
  });

  it('tells a quoted model ID from a mention in prose', () => {
    expect(namesLiteral("model: 'gpt-4',", 'gpt-4')).toBe(true);
    expect(namesLiteral('"@google/generative-ai": "^0.24.1"', '@google/generative-ai')).toBe(true);
    expect(namesLiteral("it('parses o1 output', () => {", 'o1')).toBe(false);
  });

  it('leaves unlisted prose out of recall', () => {
    const deadlineOf = new Map([['openai:o1', { id: 'o1' }]]);
    const labels = [
      label('o/a', 'test/a.test.ts', 2, 'o1', 'test'),
      label('o/a', 'src/b.ts', 3, 'o1', 'test'),
    ];
    const results = { 'o/a': { exposures: [], mentions: [] } };
    const prose = (l: { file: string }) => l.file !== 'test/a.test.ts';
    const score = scoreFresh(['o/a'], labels, results, deadlineOf, prose);
    expect(score.prose.test).toBe(1);
    expect(score.test.recall).toMatchObject({ k: 0, n: 1 });
  });

  it('computes Wilson intervals', () => {
    expect(wilson(0, 0).rate).toBeNull();
    expect(wilson(9, 10)).toMatchObject({ rate: 90, low: 59.6, high: 98.2 });
  });
});
