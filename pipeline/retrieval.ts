import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PASSAGE_TEXT_CAP, type DocPassage, type PassageIndex } from './passages.ts';
import { isObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

const K1 = 1.2;
const B = 0.75;
const LABELED_PATH = fileURLToPath(new URL('./fixtures/docs/labeled.json', import.meta.url));

export type RetrievalQuery = {
  provider: string;
  operation?: string;
  fields: string[];
  extraTerms?: string[];
};

export type RankedPassage = {
  passage: DocPassage;
  score: number;
};

export type LabeledChange = {
  provider: string;
  operation: string;
  fields: string[];
  sourceUrl: string;
  heading: string;
};

function tokens(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

function roundScore(score: number) {
  return Math.round(score * 1_000_000) / 1_000_000;
}

function frequencies(terms: string[]) {
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}

function termWeights(query: RetrievalQuery) {
  const weights = new Map<string, number>();
  const add = (value: string, weight: number) => {
    for (const term of tokens(value)) weights.set(term, Math.max(weights.get(term) ?? 0, weight));
  };
  for (const field of query.fields) add(field, 8);
  if (query.operation) add(query.operation, 5);
  for (const term of query.extraTerms ?? []) add(term, 1);
  return weights;
}

export function retrieve(query: RetrievalQuery, index: PassageIndex, k = 4): RankedPassage[] {
  const weights = termWeights(query);
  const documents = index.passages.filter((passage) => passage.provider === query.provider);
  if (!documents.length || !weights.size || k <= 0) return [];
  const tokenized = documents.map((passage) =>
    tokens(`${passage.headingPath.join(' ')} ${passage.text}`),
  );
  const averageLength =
    tokenized.reduce((total, terms) => total + terms.length, 0) / tokenized.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const term of weights.keys())
    documentFrequency.set(term, tokenized.filter((terms) => terms.includes(term)).length);
  const ranked = documents
    .map((passage, index) => {
      const terms = tokenized[index];
      const counts = frequencies(terms);
      let score = 0;
      for (const [term, weight] of weights) {
        const frequency = counts.get(term) ?? 0;
        if (!frequency) continue;
        const containing = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (documents.length - containing + 0.5) / (containing + 0.5));
        const denominator = frequency + K1 * (1 - B + (B * terms.length) / averageLength);
        score += weight * idf * ((frequency * (K1 + 1)) / denominator);
      }
      return { passage, score: roundScore(score) };
    })
    .filter((item) => item.score > 0)
    .sort(
      (left, right) => right.score - left.score || left.passage.id.localeCompare(right.passage.id),
    );
  const selected: RankedPassage[] = [];
  let used = 0;
  for (const item of ranked) {
    if (selected.length >= k) break;
    if (used + item.passage.text.length > PASSAGE_TEXT_CAP) continue;
    selected.push(item);
    used += item.passage.text.length;
  }
  return selected;
}

export async function labeledChanges(): Promise<LabeledChange[]> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(LABELED_PATH, 'utf8'));
  } catch (cause) {
    throw new PipelineInputError('Labeled changes are not valid JSON.', { cause });
  }
  if (!Array.isArray(value)) throw new PipelineInputError('Labeled changes must be an array.');
  return value.map((item) => {
    if (
      !isObject(item) ||
      typeof item.provider !== 'string' ||
      typeof item.operation !== 'string' ||
      typeof item.sourceUrl !== 'string' ||
      typeof item.heading !== 'string' ||
      !Array.isArray(item.fields) ||
      !item.fields.every((field) => typeof field === 'string')
    )
      throw new PipelineInputError(
        'Labeled change is missing provider, operation, fields, or source.',
      );
    return {
      provider: item.provider,
      operation: item.operation,
      fields: item.fields,
      sourceUrl: item.sourceUrl,
      heading: item.heading,
    };
  });
}

export function topHitRates(index: PassageIndex, cases: LabeledChange[]) {
  const rates = new Map<string, { hits: number; total: number }>();
  for (const item of cases) {
    const ranked = retrieve(
      { provider: item.provider, operation: item.operation, fields: item.fields },
      index,
    );
    const hit = ranked.some(
      (entry) =>
        entry.passage.sourceUrl === item.sourceUrl &&
        entry.passage.headingPath.some((heading) =>
          heading.toLowerCase().includes(item.heading.toLowerCase()),
        ),
    );
    const bucket = rates.get(item.provider) ?? { hits: 0, total: 0 };
    bucket.total += 1;
    if (hit) bucket.hits += 1;
    rates.set(item.provider, bucket);
  }
  return [...rates.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, bucket]) => ({
      provider,
      hits: bucket.hits,
      total: bucket.total,
      rate: bucket.total ? bucket.hits / bucket.total : 0,
    }));
}

export function formatHitRates(rates: ReturnType<typeof topHitRates>) {
  return rates
    .map(
      (item) =>
        `top-4 hit rate ${item.provider} ${item.hits}/${item.total} (${item.rate.toFixed(3)})`,
    )
    .join('\n');
}
