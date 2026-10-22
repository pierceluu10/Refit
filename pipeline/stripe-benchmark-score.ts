import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { splitRows } from '../scripts/benchmark-harness.mjs';
import { assertResults } from '../scripts/benchmark-results.mjs';
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
  label: 'breaking' | 'stripe-unaffected' | 'not-stripe' | 'excluded' | 'unknown';
  disputed?: string;
}
interface LabelledRepository {
  repo: string;
  verdict: 'broken' | 'unaffected' | 'undecided';
  reason: string;
  reads: LabelledRead[];
  // Removed request parameters the code still sends.
  requests: LabelledRead[];
}
interface Workflow {
  status: string;
  reason?: string;
  error?: string;
  patch?: string;
  diff?: string;
}
export type Outcome = 'correct' | 'correct-review' | 'incorrect' | 'undecided';

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
        // Unknown reads, all in repositories broken elsewhere, are not scored.
        .filter((reportedKey) => !['excluded', 'unknown'].includes(labels.get(reportedKey) ?? '')),
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

// Removed (`-`) diff lines by file, from `--- "a/<file>"` headers.
// Lines a diff really changes, by file: removed lines that are not added back unchanged.
function changedLines(diff: string) {
  const files = new Map<string, { removed: string[]; added: Set<string> }>();
  let current: { removed: string[]; added: Set<string> } | undefined;
  for (const line of diff.split('\n')) {
    const header = /^--- "?a\/(.+?)"?$/.exec(line);
    if (header) {
      current = files.get(header[1]) ?? { removed: [], added: new Set() };
      files.set(header[1], current);
    } else if (line.startsWith('+++')) continue;
    else if (line.startsWith('-')) current?.removed.push(line.slice(1).trim());
    else if (line.startsWith('+')) current?.added.add(line.slice(1).trim());
  }
  return new Map(
    [...files].map(([file, { removed, added }]) => [
      file,
      removed.filter((line) => !added.has(line)),
    ]),
  );
}

// A validated fix is correct when its diff changes every breaking line; a stop without a fix is
// a correct review when Refit's findings name every breaking location, so a reviewer can act.
export function repositoryOutcome(
  labelled: LabelledRepository,
  findings: Finding[],
  workflow: Workflow | undefined,
  diff = workflow?.diff ?? '',
): { outcome: Outcome; reason: string } {
  if (labelled.verdict === 'undecided') return { outcome: 'undecided', reason: labelled.reason };
  const changed = workflow?.patch === 'proposed';
  if (labelled.verdict === 'unaffected')
    return changed
      ? {
          outcome: 'incorrect',
          reason: `patch proposed for an unaffected repository (${workflow!.status})`,
        }
      : { outcome: 'correct', reason: 'no change' };
  const breaking = [...labelled.reads, ...labelled.requests].filter(
    (read) => read.label === 'breaking',
  );
  const describe = (reads: LabelledRead[]) =>
    reads
      .slice(0, 3)
      .map((read) => `${read.file}:${read.line} ${read.property}`)
      .join(', ') + (reads.length > 3 ? ` and ${reads.length - 3} more` : '');
  if (workflow?.status === 'validated') {
    const edited = changedLines(diff);
    const missed = breaking.filter(
      (read) => !edited.get(read.file)?.some((line) => line.includes(read.property)),
    );
    return missed.length
      ? { outcome: 'incorrect', reason: `validated fix leaves ${describe(missed)} unchanged` }
      : { outcome: 'correct', reason: 'validated fix' };
  }
  if (workflow && workflow.status !== 'needs-review')
    return {
      outcome: 'incorrect',
      reason: `workflow ${workflow.status}: ${workflow.error ?? workflow.reason ?? 'no reason'}`,
    };
  // Request-parameter findings name the call path: `checkout.sessions.create argument[0].payment_method_types`.
  const unnamed = breaking.filter(
    (read) =>
      !findings.some(
        (finding) =>
          finding.file === read.file &&
          finding.line === read.line &&
          (finding.property === read.property || finding.property.endsWith(`.${read.property}`)),
      ),
  );
  if (unnamed.length)
    return { outcome: 'incorrect', reason: `no fix, and not reported: ${describe(unnamed)}` };
  return {
    outcome: 'correct-review',
    reason: changed ? '[Needs review] patch naming every break' : 'review stop naming every break',
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      results: { type: 'string' },
      labels: { type: 'string' },
      mode: { type: 'string' },
      verbose: { type: 'boolean' },
    },
  });
  if (!values.results || !values.labels)
    throw new PipelineInputError(
      'Usage: npm run benchmark:stripe-score -- --results <results.json> --labels <labels.json> [--mode fullAdapter|shippedAdapter] [--verbose]',
    );
  const mode = values.mode ?? 'fullAdapter';
  const results = (
    JSON.parse(await readFile(values.results, 'utf8')) as Array<
      (Record<string, unknown> & { repo: string; workflow?: Workflow }) | null
    >
  ).filter((entry) => entry !== null);
  // Checked before anything is counted. A labelled repository whose row is an infrastructure
  // error has no result to score, so it is listed instead of counted as missed reads.
  const { predates } = assertResults('stripe-results', results, { allowPredating: true });
  const infrastructure = new Map(
    splitRows('stripe-results', results).infrastructure.map((row) => [
      row.repo,
      row.infrastructure,
    ]),
  );
  const labels = JSON.parse(await readFile(values.labels, 'utf8')) as {
    repos: LabelledRepository[];
  };
  const totals = { breaking: 0, confirmed: { tp: 0, fp: 0, fn: 0 }, any: { tp: 0, fp: 0, fn: 0 } };
  const outcomes: Record<Outcome, number> = {
    correct: 0,
    'correct-review': 0,
    incorrect: 0,
    undecided: 0,
  };
  for (const labelled of labels.repos) {
    if (infrastructure.has(labelled.repo)) continue;
    const result = results.find((entry) => entry.repo === labelled.repo);
    const scan = (result?.[mode] ?? result?.shippedAdapter) as { findings?: Finding[] } | undefined;
    const score = scoreRepository(scan?.findings ?? [], labelled.reads);
    totals.breaking += score.breaking;
    for (const level of ['confirmed', 'any'] as const) {
      totals[level].tp += score[level].truePositives;
      totals[level].fp += score[level].falsePositives;
      totals[level].fn += score[level].falseNegatives;
    }
    // The run's own report keeps the whole diff; results.json truncates it.
    const report = join(
      dirname(values.results),
      'repos',
      labelled.repo.replace('/', '__'),
      'run',
      'report.json',
    );
    const diff = existsSync(report)
      ? (JSON.parse(await readFile(report, 'utf8')) as { patch?: { diff?: string } }).patch?.diff
      : undefined;
    const { outcome, reason } = repositoryOutcome(
      labelled,
      scan?.findings ?? [],
      result?.workflow ?? undefined,
      diff ?? result?.workflow?.diff,
    );
    outcomes[outcome] += 1;
    if (values.verbose)
      console.log(
        `${outcome.padEnd(14)} ${labelled.verdict.padEnd(10)} ${labelled.repo}  ${reason}`,
      );
  }
  const rate = (part: number, whole: number) =>
    whole ? `${Math.round((part / whole) * 100)}%` : 'n/a';
  for (const level of ['confirmed', 'any'] as const) {
    const { tp, fp, fn } = totals[level];
    console.log(
      `${level.padEnd(9)} recall ${rate(tp, tp + fn)} (${tp}/${tp + fn})  precision ${rate(tp, tp + fp)} (${tp}/${tp + fp})`,
    );
  }
  const unscored = labels.repos.filter((labelled) => infrastructure.has(labelled.repo));
  const decided = labels.repos.length - unscored.length - outcomes.undecided;
  console.log(
    `outcomes  strict ${outcomes.correct}/${decided}  lenient ${outcomes.correct + outcomes['correct-review']}/${decided}  (correct ${outcomes.correct}, correct-review ${outcomes['correct-review']}, incorrect ${outcomes.incorrect}, undecided ${outcomes.undecided})`,
  );
  if (unscored.length)
    console.log(
      `not scored ${unscored.length} infrastructure error(s): ${unscored.map((labelled) => `${labelled.repo} (${infrastructure.get(labelled.repo)!.kind})`).join(', ')}`,
    );
  if (predates.length)
    console.log(`results predate ${predates.join(', ')}; rows were classified from their fields`);
}
