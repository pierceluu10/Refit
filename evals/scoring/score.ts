// Scores a run from its RepoResult files. Grades come only from RunRecord.outcome; the AI
// reviewer's opinion is shown next to them and never counted.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoResult } from '../runner/types.ts';

export type Outcome = 'verified' | 'needs-review' | 'not-affected' | 'failed';

export type Score = {
  repos: number;
  /** Repos the dollar cap stopped before they started. The run is incomplete if this is > 0. */
  unrunRepos: number;
  /**
   * Graded units: every task the agent ran, plus one per repo the match agent called
   * not-affected (it found no task there).
   */
  units: number;
  counts: Record<Outcome, number>;
  rates: Record<Outcome, number>;
  /** Repo-level outcome: verified if every task verified, needs-review if any wasn't. */
  repoCounts: Record<Outcome | 'error' | 'unrun', number>;
  /** Share of started tasks the agent attempted. Must be 1: anything less is a bug. */
  attemptedRate: number;
  attemptBugs: { repo: string; taskId?: string; reason: string }[];
  unrunTasks: number;
  costUsd: number;
  costPerRepoUsd: number;
  costByRepo: { repo: string; costUsd: number }[];
  /** Advisory reviewer opinions, for reading next to the grades. Never part of a rate. */
  reviewerOpinions: Record<string, number>;
  verifiedPrs: { repo: string; taskId: string; pr?: string }[];
};

const zero = (): Record<Outcome, number> => ({
  verified: 0,
  'needs-review': 0,
  'not-affected': 0,
  failed: 0,
});

export function scoreResults(results: RepoResult[]): Score {
  const counts = zero();
  const repoCounts = { ...zero(), error: 0, unrun: 0 };
  const attemptBugs: Score['attemptBugs'] = [];
  const reviewerOpinions: Record<string, number> = {};
  const verifiedPrs: Score['verifiedPrs'] = [];
  let started = 0;
  let attempted = 0;
  let unrunTasks = 0;

  for (const repo of results) {
    if (repo.verdict === 'unrun') {
      repoCounts.unrun += 1;
      continue;
    }
    if (repo.verdict === 'not-affected') {
      counts['not-affected'] += 1;
      repoCounts['not-affected'] += 1;
      continue;
    }
    if (repo.verdict === 'error' || (repo.tasks.length === 0 && repo.verdict === 'tasks')) {
      // The repo ended before any task was attempted (or with no task and no verdict).
      repoCounts.error += 1;
      started += 1;
      attemptBugs.push({ repo: repo.repo, reason: repo.error ?? 'repo ended with no verdict' });
      continue;
    }
    const outcomes: Outcome[] = [];
    for (const task of repo.tasks) {
      if (task.unrun) {
        unrunTasks += 1;
        continue;
      }
      started += 1;
      if (task.attempted) attempted += 1;
      else {
        attemptBugs.push({
          repo: repo.repo,
          taskId: task.taskId,
          reason: task.noAttemptReason ?? 'not attempted',
        });
      }
      const outcome = task.record?.outcome ?? 'failed';
      counts[outcome] += 1;
      outcomes.push(outcome);
      if (outcome === 'verified') {
        verifiedPrs.push({
          repo: repo.repo,
          taskId: task.taskId,
          ...(task.record?.pr ? { pr: task.record.pr } : {}),
        });
      }
      if (task.review) {
        reviewerOpinions[task.review.opinion] = (reviewerOpinions[task.review.opinion] ?? 0) + 1;
      }
    }
    if (outcomes.length === 0) repoCounts.unrun += 1;
    else if (outcomes.every((outcome) => outcome === 'verified')) repoCounts.verified += 1;
    else if (outcomes.every((outcome) => outcome === 'not-affected'))
      repoCounts['not-affected'] += 1;
    else if (outcomes.some((outcome) => outcome === 'failed')) repoCounts.failed += 1;
    else repoCounts['needs-review'] += 1;
  }

  const units = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const rates = zero();
  for (const key of Object.keys(counts) as Outcome[]) {
    rates[key] = units === 0 ? 0 : counts[key] / units;
  }
  const ran = results.filter((repo) => repo.verdict !== 'unrun');
  const costUsd = results.reduce((sum, repo) => sum + repo.costUsd, 0);
  return {
    repos: results.length,
    unrunRepos: repoCounts.unrun,
    units,
    counts,
    rates,
    repoCounts,
    attemptedRate: started === 0 ? 1 : attempted / started,
    attemptBugs,
    unrunTasks,
    costUsd,
    costPerRepoUsd: ran.length === 0 ? 0 : costUsd / ran.length,
    costByRepo: results.map((repo) => ({ repo: repo.repo, costUsd: repo.costUsd })),
    reviewerOpinions,
    verifiedPrs,
  };
}

/** Reads every RepoResult JSON under a directory (shard artifacts can be nested). */
export function readResults(dir: string): RepoResult[] {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.json')) files.push(full);
    }
  };
  walk(dir);
  return files
    .map((file) => JSON.parse(readFileSync(file, 'utf8')) as RepoResult)
    .filter((result) => typeof result.repo === 'string' && Array.isArray(result.tasks))
    .sort((a, b) => a.set.localeCompare(b.set) || a.index - b.index);
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

export function formatReport(score: Score, title = 'Aptitude eval'): string {
  const lines = [
    `# ${title}`,
    '',
    `Repos: ${score.repos} (${score.unrunRepos} not run: dollar cap)`,
    `Graded units: ${score.units} (tasks, plus repos the match agent called not-affected)`,
    '',
    '| Outcome | Units | Rate |',
    '| --- | --- | --- |',
    ...(['verified', 'needs-review', 'not-affected', 'failed'] as const).map(
      (key) => `| ${key} | ${score.counts[key]} | ${pct(score.rates[key])} |`,
    ),
    '',
    `Attempted: ${pct(score.attemptedRate)} (must be 100%)`,
    ...score.attemptBugs.map(
      (bug) => `- BUG: ${bug.repo}${bug.taskId ? ` ${bug.taskId}` : ''}: ${bug.reason}`,
    ),
    score.unrunTasks > 0 ? `Tasks stopped by the dollar cap: ${score.unrunTasks}` : '',
    '',
    `Cost: $${score.costUsd.toFixed(4)} total, $${score.costPerRepoUsd.toFixed(4)} per repo`,
    '',
    `AI reviewer (advisory, not counted): ${
      Object.entries(score.reviewerOpinions)
        .map(([opinion, count]) => `${opinion} ${count}`)
        .join(', ') || 'no reviews'
    }`,
    `Verified PRs (each gets a hand-check in evals/reviews.json): ${score.verifiedPrs.length}`,
  ];
  return `${lines.filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n')}\n`;
}
