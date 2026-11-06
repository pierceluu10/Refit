// Scores a run from its RepoResult files. Grades come only from RunRecord.outcome; the AI
// reviewer's opinion is shown next to them and never counted.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoResult } from '../runner/types.ts';

export type Outcome = 'verified' | 'needs-review' | 'not-affected' | 'failed';

/** The families scores are split by. A label for reading results, never a gate on a task. */
export type ChangeFamily =
  | 'api'
  | 'runtime'
  | 'framework'
  | 'library'
  | 'security'
  | 'model'
  | 'image'
  | 'ci'
  | 'platform'
  | 'rules'
  | 'other'
  /** Repos the match agent found no task in: graded not-affected, with no change kind. */
  | 'no-task';

export const FAMILY_ORDER: ChangeFamily[] = [
  'api',
  'runtime',
  'framework',
  'library',
  'security',
  'model',
  'image',
  'ci',
  'platform',
  'rules',
  'other',
  'no-task',
];

const FAMILY_OF: Record<string, ChangeFamily> = {
  'api-version': 'api',
  'sdk-major': 'api',
  'field-removed': 'api',
  'field-renamed': 'api',
  'endpoint-removed': 'api',
  'rest-to-graphql': 'api',
  'auth-change': 'api',
  'webhook-payload': 'api',
  'product-shutdown': 'api',
  'pagination-or-limits': 'api',
  'model-retirement': 'model',
  'runtime-eol': 'runtime',
  'serverless-runtime': 'runtime',
  'framework-major': 'framework',
  'dependency-major': 'library',
  'security-fix': 'security',
  'container-image-eol': 'image',
  'ci-deprecation': 'ci',
  'k8s-version': 'platform',
  'cloud-deprecation': 'platform',
  'platform-policy': 'platform',
  'mobile-os': 'platform',
  'browser-change': 'platform',
  'tls-crypto': 'platform',
  'auth-standard': 'platform',
  'payment-rule': 'rules',
  regulation: 'rules',
};

export function familyOf(kind: string): ChangeFamily {
  return FAMILY_OF[kind] ?? 'other';
}

/** One change family's slice of a run. Rates are over that family's graded units. */
export type FamilyScore = {
  units: number;
  counts: Record<Outcome, number>;
  rates: Record<Outcome, number>;
  /** Started tasks of this family the agent attempted. Must be 1. */
  attemptedRate: number;
  /** Repos with at least one graded unit of this family. */
  repos: number;
  /** What this family's tasks spent (RunRecord.costUsd), excluding inventory, watch and match. */
  costUsd: number;
  costPerRepoUsd: number;
};

export type Score = {
  repos: number;
  /** Repos the dollar cap stopped before they started. The run is incomplete if this is > 0. */
  unrunRepos: number;
  /** Repos whose run started (a checkout, an inventory, and usually a match). */
  startedRepos: number;
  /** Started repos whose every task the dollar cap stopped, so nothing in them was graded. */
  capStoppedRepos: number;
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
  costByRepo: { repo: string; costUsd: number; byPart: Record<string, number> }[];
  /** Total cost by part (inventory, watch, match, harness, review), from the meters' labels. */
  costByPart: Record<string, number>;
  /** Advisory reviewer opinions, for reading next to the grades. Never part of a rate. */
  reviewerOpinions: Record<string, number>;
  verifiedPrs: { repo: string; taskId: string; pr?: string }[];
  /** The same rates, attempts and cost split by change family (API, runtime, framework, ...). */
  byFamily: Partial<Record<ChangeFamily, FamilyScore>>;
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
  const families = new Map<
    ChangeFamily,
    {
      counts: Record<Outcome, number>;
      started: number;
      attempted: number;
      repos: Set<string>;
      costUsd: number;
    }
  >();
  const family = (name: ChangeFamily) => {
    let entry = families.get(name);
    if (!entry) {
      entry = { counts: zero(), started: 0, attempted: 0, repos: new Set(), costUsd: 0 };
      families.set(name, entry);
    }
    return entry;
  };

  for (const repo of results) {
    if (repo.verdict === 'unrun') {
      repoCounts.unrun += 1;
      continue;
    }
    if (repo.verdict === 'not-affected') {
      counts['not-affected'] += 1;
      repoCounts['not-affected'] += 1;
      const none = family('no-task');
      none.counts['not-affected'] += 1;
      none.repos.add(repo.repo);
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
      const slice = family(familyOf(task.kind));
      slice.started += 1;
      slice.repos.add(repo.repo);
      slice.costUsd += task.record?.costUsd ?? 0;
      if (task.attempted) {
        attempted += 1;
        slice.attempted += 1;
      } else {
        attemptBugs.push({
          repo: repo.repo,
          taskId: task.taskId,
          reason: task.noAttemptReason ?? 'not attempted',
        });
      }
      const outcome = task.record?.outcome ?? 'failed';
      counts[outcome] += 1;
      slice.counts[outcome] += 1;
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
  const costByPart: Record<string, number> = {};
  for (const repo of results) {
    for (const [part, spent] of Object.entries(repo.costByPart ?? {})) {
      costByPart[part] = (costByPart[part] ?? 0) + spent;
    }
  }
  return {
    repos: results.length,
    unrunRepos: repoCounts.unrun,
    startedRepos: ran.length,
    capStoppedRepos: ran.filter(
      (repo) => repo.tasks.length > 0 && repo.tasks.every((task) => task.unrun),
    ).length,
    units,
    counts,
    rates,
    repoCounts,
    attemptedRate: started === 0 ? 1 : attempted / started,
    attemptBugs,
    unrunTasks,
    costUsd,
    costPerRepoUsd: ran.length === 0 ? 0 : costUsd / ran.length,
    costByRepo: results.map((repo) => ({
      repo: repo.repo,
      costUsd: repo.costUsd,
      byPart: repo.costByPart ?? {},
    })),
    costByPart,
    reviewerOpinions,
    verifiedPrs,
    byFamily: Object.fromEntries(
      FAMILY_ORDER.flatMap((name) => {
        const entry = families.get(name);
        if (!entry) return [];
        const familyUnits = Object.values(entry.counts).reduce((sum, value) => sum + value, 0);
        const familyRates = zero();
        for (const key of Object.keys(entry.counts) as Outcome[]) {
          familyRates[key] = familyUnits === 0 ? 0 : entry.counts[key] / familyUnits;
        }
        const score: FamilyScore = {
          units: familyUnits,
          counts: entry.counts,
          rates: familyRates,
          attemptedRate: entry.started === 0 ? 1 : entry.attempted / entry.started,
          repos: entry.repos.size,
          costUsd: entry.costUsd,
          costPerRepoUsd: entry.repos.size === 0 ? 0 : entry.costUsd / entry.repos.size,
        };
        return [[name, score]];
      }),
    ),
  };
}

/** The by-family table: rates, attempts and task cost per repo for each change family. */
export function formatByFamily(score: Score): string[] {
  const rows = FAMILY_ORDER.flatMap((name) => {
    const slice = score.byFamily[name];
    return slice ? [[name, slice] as const] : [];
  });
  if (rows.length === 0) return [];
  return [
    '',
    'By change family (task cost only; inventory, watch and match are in the cost by part):',
    '',
    '| Family | Units | Verified | Needs review | Not affected | Failed | Attempted | Task cost per repo |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      ([name, slice]) =>
        `| ${name} | ${slice.units} | ${pct(slice.rates.verified)} | ${pct(slice.rates['needs-review'])} | ${pct(slice.rates['not-affected'])} | ${pct(slice.rates.failed)} | ${pct(slice.attemptedRate)} | ${usd(slice.costPerRepoUsd)} |`,
    ),
  ];
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
const usd = (value: number) => `$${value.toFixed(4)}`;
const PART_ORDER = ['inventory', 'watch', 'match', 'harness', 'review', 'other'];

/** Cost by part, total and per repo that spent anything. Empty when no meter recorded parts. */
export function formatCostByPart(score: Score): string[] {
  const parts = PART_ORDER.filter((part) => (score.costByPart[part] ?? 0) > 0);
  if (parts.length === 0) return [];
  const spent = score.costByRepo.filter((repo) => repo.costUsd > 0);
  return [
    '',
    'Cost by part (from the meter labels):',
    '',
    `| Repo | ${parts.join(' | ')} | Total |`,
    `| --- | ${parts.map(() => '---').join(' | ')} | --- |`,
    ...spent.map(
      (repo) =>
        `| ${repo.repo} | ${parts.map((part) => usd(repo.byPart[part] ?? 0)).join(' | ')} | ${usd(repo.costUsd)} |`,
    ),
    `| All repos | ${parts.map((part) => usd(score.costByPart[part] ?? 0)).join(' | ')} | ${usd(score.costUsd)} |`,
  ];
}

export function formatReport(score: Score, title = 'Refit eval'): string {
  const lines = [
    `# ${title}`,
    '',
    `Repos: ${score.repos}: ${score.startedRepos} started, ${score.repos - score.startedRepos} never started (dollar cap)${
      score.capStoppedRepos > 0
        ? `; in ${score.capStoppedRepos} of the started, the cap stopped every task`
        : ''
    }`,
    `Graded units: ${score.units} (tasks, plus repos the match agent called not-affected)`,
    '',
    '| Outcome | Units | Rate |',
    '| --- | --- | --- |',
    ...(['verified', 'needs-review', 'not-affected', 'failed'] as const).map(
      (key) => `| ${key} | ${score.counts[key]} | ${pct(score.rates[key])} |`,
    ),
    '',
    ...formatByFamily(score),
    '',
    `Attempted: ${pct(score.attemptedRate)} (must be 100%)`,
    ...score.attemptBugs.map(
      (bug) => `- BUG: ${bug.repo}${bug.taskId ? ` ${bug.taskId}` : ''}: ${bug.reason}`,
    ),
    score.unrunTasks > 0 ? `Tasks stopped by the dollar cap: ${score.unrunTasks}` : '',
    '',
    `Cost: $${score.costUsd.toFixed(4)} total, $${score.costPerRepoUsd.toFixed(4)} per repo`,
    ...formatCostByPart(score),
    '',
    `AI reviewer (advisory, not counted): ${
      Object.entries(score.reviewerOpinions)
        .map(([opinion, count]) => `${opinion} ${count}`)
        .join(', ') || 'no reviews'
    }`,
    `PRs to hand-check in evals/reviews.json (verified and needs-review): ${score.counts.verified + score.counts['needs-review']}`,
  ];
  return `${lines.filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n')}\n`;
}
