import { expect, it, vi } from 'vitest';
import {
  createPassageIndex,
  PASSAGE_TEXT_CAP,
  type DocPassage,
  type PassageIndex,
} from './passages.ts';
import { formatHitRates, labeledChanges, retrieve, topHitRates } from './retrieval.ts';
import { runPipeline } from './run.ts';

function passage(id: string, text: string, provider = 'example'): DocPassage {
  return {
    id,
    provider,
    sourceUrl: `https://docs.example.test/${id}`,
    pageSha256: 'c'.repeat(64),
    headingPath: [id],
    kind: 'doc',
    text,
  };
}

function index(passages: DocPassage[]): PassageIndex {
  return { formatVersion: 1, kind: 'refit-passage-index', sha256: 'd'.repeat(64), passages };
}

it('returns the same ranked passages and enforces the character cap', () => {
  const documents = [1, 2, 3, 4, 5].map((number) =>
    passage(number.toString(16).padStart(16, '0'), `${'fieldname '.repeat(150)}match-${number}`),
  );
  const corpus = index(documents);
  const query = { provider: 'example', fields: ['fieldname'] };
  const first = retrieve(query, corpus, 5);
  expect(retrieve(query, corpus, 5)).toEqual(first);
  expect(retrieve(query, corpus, 5)).toEqual(first);
  const capped = retrieve(query, corpus, 5);
  expect(capped.reduce((total, item) => total + item.passage.text.length, 0)).toBeLessThanOrEqual(
    PASSAGE_TEXT_CAP,
  );
  expect(capped.length).toBeLessThan(5);
  expect(retrieve({ provider: 'example', fields: ['zzzznotpresent'] }, corpus)).toEqual([]);
  expect(retrieve({ provider: 'other', fields: ['fieldname'] }, corpus)).toEqual([]);
});

it('returns the same pinned passages for one query across 3 runs', async () => {
  const corpus = await createPassageIndex({ provider: 'stripe' });
  const query = {
    provider: 'stripe',
    operation: 'paymentIntents.retrieve',
    fields: ['charges'],
  };
  const first = retrieve(query, corpus);
  expect(retrieve(query, corpus)).toEqual(first);
  expect(retrieve(query, corpus)).toEqual(first);
  expect(first.length).toBeGreaterThan(0);
});

it('prints a top-4 hit for every labeled provider change', async () => {
  const corpus = await createPassageIndex({ provider: 'stripe' });
  const cases = await labeledChanges();
  const rates = topHitRates(corpus, cases);
  const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  console.info(formatHitRates(rates));
  expect(log).toHaveBeenCalledWith(expect.stringContaining('top-4 hit rate openai 1/1'));
  expect(log).toHaveBeenCalledWith(expect.stringContaining('top-4 hit rate stripe 1/1'));
  expect(log).toHaveBeenCalledWith(expect.stringContaining('top-4 hit rate anthropic 1/1'));
  log.mockRestore();
  expect(rates.every((item) => item.rate === 1)).toBe(true);
});

it('retrieves the Anthropic max_tokens passage for the fixture finding', async () => {
  const report = await runPipeline({
    repository: 'pipeline/fixtures/anthropic/repository',
    before: 'pipeline/fixtures/anthropic/before.json',
    after: 'pipeline/fixtures/anthropic/after.json',
    providerConfig: 'pipeline/fixtures/anthropic/provider.json',
  });
  expect(report.findings).toEqual([
    expect.objectContaining({ expression: '.max_tokens', confidence: 'confirmed' }),
  ]);
  const corpus = await createPassageIndex({
    provider: 'anthropic',
    document: { openapi: '3.0.3' },
    pageSha256: 'e'.repeat(64),
  });
  const ranked = retrieve(
    { provider: 'anthropic', operation: 'messages.create', fields: ['max_tokens'] },
    corpus,
  );
  expect(ranked.some((item) => item.passage.headingPath.includes('max_tokens'))).toBe(true);
});
