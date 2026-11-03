// One-command local smoke test: three dev-set repos, a fake model, $0 spent.
//
//   npm run smoke -w evals
//
// Each repo is stood in for by a local fixture (no clone, no install, no network). The run goes
// through the real runner, scoring, hand-check log and advisory reviewer, then checks the
// invariants: every task attempted, every verified and needs-review PR logged, grades untouched
// by the reviewer.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadDevSet, type DevSet, type RepoEntry } from '../sets/index.ts';
import { runSet } from '../runner/run.ts';
import type { RepoResult } from '../runner/types.ts';
import { formatReport, scoreResults, type Score } from '../scoring/score.ts';
import { missingHandChecks, readReviews, syncReviews, writeReviews } from '../scoring/reviews.ts';
import { createFakePipeline } from './fake.ts';

/** The three dev repos the smoke run uses, and the fixture standing in for each. */
export const SMOKE_REPOS = [
  { set: 'stripe-dev-30', index: 0, provider: 'stripe', fixture: 'stripe-billing' },
  { set: 'shopify-dev-60', index: 0, provider: 'shopify', fixture: 'shopify-admin' },
  { set: 'meta-dev-60', index: 0, provider: 'meta-graph', fixture: 'meta-whatsapp' },
] as const;

/** Simulated cap for the smoke run. The fake model costs nothing real. */
export const SMOKE_BUDGET_USD = 1;

export function smokeSet(): DevSet {
  const repos: RepoEntry[] = SMOKE_REPOS.map((pick) => {
    const entry = loadDevSet(pick.set).repos[pick.index];
    if (!entry) throw new Error(`${pick.set} has no repo at ${pick.index}`);
    return { repo: entry.repo, commit: entry.commit, provider: pick.provider, fromSet: pick.set };
  });
  return {
    name: 'smoke-3',
    provider: 'mixed',
    kind: 'dev',
    source: { path: 'evals/smoke/smoke.ts', commit: '', blob: '' },
    purpose: 'Smoke test: one repo from each of three dev sets, run with a fake model.',
    repos,
  };
}

export type SmokeOutcome = {
  results: RepoResult[];
  score: Score;
  report: string;
  problems: string[];
  outDir: string;
  reviewsPath: string;
};

export async function runSmoke(outDir = mkdtempSync(join(tmpdir(), 'aptitude-smoke-out-'))) {
  const set = smokeSet();
  const fixturesDir = join(import.meta.dirname, 'fixtures');
  const fixtureFor = new Map<string, string>(
    set.repos.map((entry, index) => [entry.repo, SMOKE_REPOS[index]?.fixture ?? '']),
  );
  const { factory } = createFakePipeline(fixturesDir, (repo) => fixtureFor.get(repo) ?? '');
  const { results, ledger } = await runSet(
    { set: set.name, budgetUsd: SMOKE_BUDGET_USD, concurrency: 2, outDir },
    set,
    factory,
  );
  const score = scoreResults(results);
  // The smoke run keeps its own hand-check log; evals/reviews.json is for real runs only.
  const reviewsPath = join(outDir, 'reviews.json');
  const { reviews } = syncReviews(readReviews(reviewsPath), results);
  writeReviews(reviews, reviewsPath);

  const problems: string[] = [];
  if (score.attemptedRate !== 1) problems.push(`attempted rate ${score.attemptedRate}, want 1`);
  for (const bug of score.attemptBugs) problems.push(`no attempt: ${bug.repo} ${bug.reason}`);
  const missing = missingHandChecks(readReviews(reviewsPath), results);
  if (missing.length > 0) problems.push(`PRs without a hand-check: ${missing.join(', ')}`);
  for (const outcome of ['verified', 'needs-review', 'not-affected'] as const) {
    if (score.counts[outcome] === 0) problems.push(`expected at least one ${outcome} unit`);
  }
  if (ledger.spentUsd > SMOKE_BUDGET_USD) problems.push('simulated spend went over the cap');
  const reviewed = results.flatMap((repo) => repo.tasks).filter((task) => task.review);
  if (reviewed.length === 0) problems.push('the advisory reviewer never ran');

  const report = `${formatReport(score, 'Aptitude smoke test (fake model, $0 real spend)')}
Simulated spend: $${ledger.spentUsd.toFixed(4)} of a $${SMOKE_BUDGET_USD} simulated cap
Results: ${outDir}
${problems.length === 0 ? 'SMOKE OK' : `SMOKE FAILED\n${problems.map((p) => `- ${p}`).join('\n')}`}
`;
  return { results, score, report, problems, outDir, reviewsPath } satisfies SmokeOutcome;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const outcome = await runSmoke();
  console.log(outcome.report);
  process.exitCode = outcome.problems.length === 0 ? 0 : 1;
}
