import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPassageIndex, type DocPassage } from '../pipeline/passages.ts';
import { retrieve, type RankedPassage } from '../pipeline/retrieval.ts';
import { isObject } from '../pipeline/specifications.ts';
import { writeResult } from './write-result.ts';

type Label = {
  id: string;
  provider: string;
  operation: string;
  field: string;
  changeKind: string;
  expectedPassageIds: string[];
  confirmed: { url: string; heading: string };
  note?: string;
};

const LABELS = join(dirname(fileURLToPath(import.meta.url)), 'retrieval-labels.json');

function label(value: unknown): Label {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.provider !== 'string' ||
    typeof value.operation !== 'string' ||
    typeof value.field !== 'string' ||
    typeof value.changeKind !== 'string' ||
    !Array.isArray(value.expectedPassageIds) ||
    !value.expectedPassageIds.every((id) => typeof id === 'string') ||
    !isObject(value.confirmed) ||
    typeof value.confirmed.url !== 'string' ||
    typeof value.confirmed.heading !== 'string'
  ) {
    throw new Error('A retrieval label is missing id, provider, operation, field, or source.');
  }
  return {
    id: value.id,
    provider: value.provider,
    operation: value.operation,
    field: value.field,
    changeKind: value.changeKind,
    expectedPassageIds: value.expectedPassageIds,
    confirmed: { url: value.confirmed.url, heading: value.confirmed.heading },
    ...(typeof value.note === 'string' ? { note: value.note } : {}),
  };
}

function rate(hits: number, total: number) {
  return total ? hits / total : 0;
}

function summarize(rows: { hit1: boolean; hit4: boolean; reciprocal: number; zero: boolean }[]) {
  const total = rows.length;
  return {
    labels: total,
    hit1: rows.filter((row) => row.hit1).length,
    hit4: rows.filter((row) => row.hit4).length,
    hitAt1: rate(rows.filter((row) => row.hit1).length, total),
    hitAt4: rate(rows.filter((row) => row.hit4).length, total),
    mrr: total === 0 ? 0 : rows.reduce((sum, row) => sum + row.reciprocal, 0) / total,
    zeroResults: rows.filter((row) => row.zero).length,
  };
}

function passageView(entry: RankedPassage) {
  return {
    rank: 0,
    id: entry.passage.id,
    score: entry.score,
    provider: entry.passage.provider,
    headingPath: entry.passage.headingPath,
    sourceUrl: entry.passage.sourceUrl,
  };
}

const parsed = JSON.parse(await readFile(LABELS, 'utf8')) as unknown;
if (!Array.isArray(parsed)) throw new Error('retrieval-labels.json must be an array.');
const labels = parsed.map(label);
const counts = new Map<string, number>();
for (const item of labels) counts.set(item.provider, (counts.get(item.provider) ?? 0) + 1);
if (labels.length < 20 || labels.length > 30)
  throw new Error(`Expected 20 to 30 labels, found ${labels.length}.`);
for (const [provider, minimum] of [
  ['stripe', 8],
  ['openai', 8],
  ['anthropic', 4],
] as const) {
  if ((counts.get(provider) ?? 0) < minimum)
    throw new Error(
      `${provider} has ${counts.get(provider) ?? 0} labels; expected at least ${minimum}.`,
    );
}

const index = await createPassageIndex({ provider: 'stripe' });
const known = new Map<string, DocPassage>(index.passages.map((passage) => [passage.id, passage]));
const scored = labels.map((item) => {
  const ranked = retrieve(
    { provider: item.provider, operation: item.operation, fields: [item.field] },
    index,
    50,
  );
  const missingIds = item.expectedPassageIds.filter((id) => !known.has(id));
  const positions = item.expectedPassageIds
    .map((id) => ranked.findIndex((entry) => entry.passage.id === id))
    .filter((position) => position >= 0);
  const rank = positions.length ? Math.min(...positions) + 1 : null;
  return {
    item,
    ranked,
    missingIds,
    rank,
    hit1: rank === 1,
    hit4: rank !== null && rank <= 4,
    reciprocal: rank ? 1 / rank : 0,
    zero: ranked.length === 0,
  };
});

const providers = [...new Set(labels.map((item) => item.provider))].sort();
const byProvider = Object.fromEntries(
  providers.map((provider) => [
    provider,
    summarize(scored.filter((row) => row.item.provider === provider)),
  ]),
);
const overall = summarize(scored);
const misses = scored
  .filter((row) => !row.hit4)
  .map((row) => ({
    id: row.item.id,
    provider: row.item.provider,
    query: {
      provider: row.item.provider,
      operation: row.item.operation,
      field: row.item.field,
    },
    expectedPassageIds: row.item.expectedPassageIds,
    missingFromIndex: row.missingIds,
    confirmed: row.item.confirmed,
    note: row.item.note ?? '',
    reason: row.item.expectedPassageIds.length
      ? 'Expected passage was not in the top 4.'
      : 'No pinned passage id was labeled for this confirmed source.',
    top: row.ranked.slice(0, 4).map((entry, position) => ({
      ...passageView(entry),
      rank: position + 1,
    })),
  }));

for (const miss of misses) {
  console.log(`MISS ${miss.id}`);
  console.log(
    `query provider=${miss.query.provider} operation=${miss.query.operation} field=${miss.query.field}`,
  );
  console.log(
    `expected ${miss.expectedPassageIds.join(', ') || '(none in index)'} confirmed ${miss.confirmed.url} heading ${JSON.stringify(miss.confirmed.heading)}`,
  );
  if (!miss.top.length) console.log('top (no results)');
  for (const passage of miss.top) {
    console.log(
      `top ${passage.rank} ${passage.id} score=${passage.score} ${passage.headingPath.join(' / ')} ${passage.sourceUrl}`,
    );
  }
}

const result = {
  measuredAt: new Date().toISOString(),
  index: {
    sha256: index.sha256,
    passages: index.passages.length,
    providers: [...new Set(index.passages.map((passage) => passage.provider))].sort(),
  },
  labels: labels.length,
  byProvider,
  overall,
  hits: scored
    .filter((row) => row.hit4)
    .map((row) => ({ id: row.item.id, rank: row.rank, reciprocal: row.reciprocal })),
  misses,
};
const file = await writeResult('retrieval-quality', result);
console.log(
  `overall hit@1 ${overall.hit1}/${overall.labels} (${overall.hitAt1.toFixed(3)}) hit@4 ${overall.hit4}/${overall.labels} (${overall.hitAt4.toFixed(3)}) MRR ${overall.mrr.toFixed(3)} zero ${overall.zeroResults}`,
);
console.log(file);
