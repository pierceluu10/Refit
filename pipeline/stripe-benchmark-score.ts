import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { PipelineInputError } from './types.ts';

// Scores benchmark findings against the hand-checked Stripe ground truth.
interface Finding {
  file: string;
  line: number;
  property: string;
  confidence: 'confirmed' | 'review';
}
interface LabelledRead {
  file: string;
  line: number;
  property: string;
  label: 'breaking' | 'stripe-unaffected' | 'not-stripe' | 'excluded';
}

export function scoreRepository(findings: Finding[], reads: LabelledRead[]) {
  const key = (value: { file: string; line: number; property: string }) =>
    `${value.file}\0${value.line}\0${value.property}`;
  const labels = new Map(reads.map((read) => [key(read), read.label]));
  const breaking = new Set(reads.filter((read) => read.label === 'breaking').map(key));
  const score = (confidence: Finding['confidence'] | 'any') => {
    const reported = new Set(
      findings
        .filter((finding) => confidence === 'any' || finding.confidence === confidence)
        .map(key)
        .filter((reportedKey) => labels.get(reportedKey) !== 'excluded'),
    );
    const truePositives = [...reported].filter((reportedKey) => breaking.has(reportedKey)).length;
    return {
      reported: reported.size,
      truePositives,
      falsePositives: reported.size - truePositives,
      falseNegatives: [...breaking].filter((breakingKey) => !reported.has(breakingKey)).length,
    };
  };
  return { breaking: breaking.size, confirmed: score('confirmed'), any: score('any') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: { results: { type: 'string' }, labels: { type: 'string' }, mode: { type: 'string' } },
  });
  if (!values.results || !values.labels)
    throw new PipelineInputError(
      'Usage: npm run benchmark:stripe-score -- --results <results.json> --labels <labels.json> [--mode fullAdapter|shippedAdapter]',
    );
  const mode = values.mode ?? 'fullAdapter';
  const results = JSON.parse(await readFile(values.results, 'utf8')) as Array<
    Record<string, unknown> & { repo: string }
  >;
  const labels = JSON.parse(await readFile(values.labels, 'utf8')) as {
    repos: Array<{ repo: string; reads: LabelledRead[] }>;
  };
  const totals = { breaking: 0, confirmed: { tp: 0, fp: 0, fn: 0 }, any: { tp: 0, fp: 0, fn: 0 } };
  for (const labelled of labels.repos) {
    const result = results.find((entry) => entry.repo === labelled.repo);
    const scan = (result?.[mode] ?? result?.shippedAdapter) as { findings?: Finding[] } | undefined;
    const score = scoreRepository(scan?.findings ?? [], labelled.reads);
    totals.breaking += score.breaking;
    for (const level of ['confirmed', 'any'] as const) {
      totals[level].tp += score[level].truePositives;
      totals[level].fp += score[level].falsePositives;
      totals[level].fn += score[level].falseNegatives;
    }
  }
  const rate = (part: number, whole: number) =>
    whole ? `${Math.round((part / whole) * 100)}%` : 'n/a';
  for (const level of ['confirmed', 'any'] as const) {
    const { tp, fp, fn } = totals[level];
    console.log(
      `${level.padEnd(9)} recall ${rate(tp, tp + fn)} (${tp}/${tp + fn})  precision ${rate(tp, tp + fp)} (${tp}/${tp + fp})`,
    );
  }
}
