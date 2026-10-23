import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

// Scores a Gemini benchmark run (scripts/gemini-benchmark.mjs) against hand labels
// (docs/benchmarks/2026-10-22-gemini-labels.json): how well the matcher's live class separates
// sent pins from the rest, and how many pins sent through a Google SDK the report-only tracers reach.

interface Pin {
  file: string;
  line: number;
  model: string;
  label: 'sent' | 'not-sent' | 'ambiguous';
  via?: 'sdk' | 'other';
}
export interface GeminiLabels {
  repos: { repo: string; commit: string; pins: Pin[] }[];
}
export interface GeminiResult {
  repo: string;
  commit: string;
  error?: string;
  // `file:line model use` for every classified match, and `file:line model` for traced sites.
  matches?: string[];
  traced?: string[];
}

const ratio = (part: number, whole: number) => (whole ? part / whole : null);

export function scoreGeminiLabels(labels: GeminiLabels, results: GeminiResult[]) {
  const byRepo = new Map(results.map((result) => [result.repo, result]));
  const live = { truePositives: 0, falsePositives: 0, sent: 0 };
  const tracer = { traced: 0, sdkSent: 0, wrong: 0 };
  const wrongLive: string[] = [];
  const missedLive: string[] = [];
  const untraced: string[] = [];
  const wrongTraced: string[] = [];
  // Labelled repositories Refit could not scan (scan limits, for example), with the error.
  const notScanned: string[] = [];
  for (const repository of labels.repos) {
    const result = byRepo.get(repository.repo);
    if (!result) throw new Error(`${repository.repo} was not scanned.`);
    if (result.error) {
      notScanned.push(`${repository.repo}: ${result.error}`);
      continue;
    }
    if (result.commit !== repository.commit)
      throw new Error(
        `${repository.repo} was scanned at ${result.commit}, not ${repository.commit}.`,
      );
    const uses = new Map<string, string>();
    for (const match of result.matches ?? []) {
      const [where, model, use] = match.split(' ');
      uses.set(`${where} ${model}`, use);
    }
    const traced = new Set(result.traced ?? []);
    for (const pin of repository.pins) {
      if (pin.label === 'ambiguous') continue;
      const key = `${pin.file}:${pin.line} ${pin.model}`;
      const name = `${repository.repo} ${key}`;
      const isLive = uses.get(key) === 'live';
      if (pin.label === 'sent') {
        live.sent += 1;
        if (isLive) live.truePositives += 1;
        else missedLive.push(name);
        if (pin.via === 'sdk') {
          tracer.sdkSent += 1;
          if (traced.has(key)) tracer.traced += 1;
          else untraced.push(name);
        }
      } else {
        if (isLive) {
          live.falsePositives += 1;
          wrongLive.push(name);
        }
        if (traced.has(key)) {
          tracer.wrong += 1;
          wrongTraced.push(name);
        }
      }
    }
  }
  return {
    livePrecision: ratio(live.truePositives, live.truePositives + live.falsePositives),
    liveRecall: ratio(live.truePositives, live.sent),
    sdkPinsTraced: ratio(tracer.traced, tracer.sdkSent),
    tracedPrecision: ratio(tracer.traced, tracer.traced + tracer.wrong),
    counts: { ...live, ...tracer },
    wrongLive,
    missedLive,
    untraced,
    wrongTraced,
    notScanned,
  };
}

async function main() {
  const { values } = parseArgs({
    options: { labels: { type: 'string' }, results: { type: 'string' } },
  });
  if (!values.labels || !values.results) {
    console.log(
      'Usage: tsx pipeline/gemini-labels.ts --labels <labels.json> --results <results.json>',
    );
    process.exitCode = 1;
    return;
  }
  const labels = JSON.parse(await readFile(values.labels, 'utf8')) as GeminiLabels;
  const run = JSON.parse(await readFile(values.results, 'utf8')) as { results: GeminiResult[] };
  console.log(JSON.stringify(scoreGeminiLabels(labels, run.results), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
