// Round 3's repo-level score: verified eligible repos over eligible repos. A repo is eligible when
// its baseline is green (the screen) and a watched change really affects it; it is verified when
// every task that affects it is verified. Excluded repos are left out of every number but counted.
import type { RepoResult } from '../runner/types.ts';
import type { BaselineRecord } from '../runner/screen.ts';

export type RepoStatus =
  'verified' | 'not-verified' | 'not-affected' | 'excluded' | 'unscreened' | 'error';

export type Round3Repo = {
  set: string;
  repo: string;
  status: RepoStatus;
  /** Task outcomes, for reading every failure. */
  outcomes: string[];
  costUsd: number;
  durationMs: number;
  why?: string;
};

export type Round3Score = {
  eligible: number;
  verified: number;
  score: number;
  notAffected: number;
  excluded: { 'red-baseline': number; 'outside-authority': number };
  /** Outside-authority over affected repos; at 20% the README says stop and write a blocker. */
  outsideAuthorityShare: number;
  errors: number;
  costUsd: number;
  rows: Round3Repo[];
};

const key = (set: string, repo: string) => `${set}/${repo}`;

export function repoStatus(result: RepoResult): { status: RepoStatus; why?: string } {
  if (result.verdict === 'not-affected') return { status: 'not-affected' };
  if (result.verdict === 'error' || result.verdict === 'unrun') {
    return { status: 'error', why: result.error ?? result.verdict };
  }
  const outcomes = result.tasks.map((task) => task.record?.outcome ?? 'unrun');
  const affecting = outcomes.filter((outcome) => outcome !== 'not-affected');
  if (affecting.length === 0) return { status: 'not-affected' };
  const failing = result.tasks.filter(
    (task) => !['verified', 'not-affected'].includes(task.record?.outcome ?? 'unrun'),
  );
  return failing.length === 0
    ? { status: 'verified' }
    : {
        status: 'not-verified',
        why: failing
          .map((task) => `${task.taskId}: ${task.record?.outcome ?? task.unrunReason ?? 'unrun'}`)
          .join('; '),
      };
}

export function scoreRound3(results: RepoResult[], screen: BaselineRecord[]): Round3Score {
  const baselines = new Map(screen.map((record) => [key(record.set, record.repo), record]));
  const repos: Round3Repo[] = [];
  const excluded = { 'red-baseline': 0, 'outside-authority': 0 };
  for (const record of screen) if (record.exclusion) excluded[record.exclusion.class] += 1;
  for (const result of results) {
    const baseline = baselines.get(key(result.set, result.repo));
    const outcomes = result.tasks.map((task) => task.record?.outcome ?? 'unrun');
    const base = {
      set: result.set,
      repo: result.repo,
      outcomes,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
    };
    if (!baseline) repos.push({ ...base, status: 'unscreened' });
    else if (baseline.exclusion) {
      repos.push({ ...base, status: 'excluded', why: baseline.exclusion.reason });
    } else repos.push({ ...base, ...repoStatus(result) });
  }
  const count = (status: RepoStatus) => repos.filter((repo) => repo.status === status).length;
  // A repo that errored before its verdict counts against the score: nothing proved it unaffected.
  const eligible = count('verified') + count('not-verified') + count('error');
  const affected = eligible + excluded['outside-authority'];
  return {
    eligible,
    verified: count('verified'),
    score: eligible === 0 ? 0 : count('verified') / eligible,
    notAffected: count('not-affected'),
    excluded,
    outsideAuthorityShare: affected === 0 ? 0 : excluded['outside-authority'] / affected,
    errors: count('error'),
    costUsd: repos.reduce((sum, repo) => sum + repo.costUsd, 0),
    rows: repos,
  };
}

export function formatRound3(score: Round3Score, title: string): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const rows = score.rows
    .filter((repo) => repo.status !== 'excluded')
    .map(
      (repo) =>
        `| ${repo.set} | ${repo.repo} | ${repo.status} | ${repo.outcomes.join(', ') || '-'} | $${repo.costUsd.toFixed(2)} | ${Math.round(repo.durationMs / 60_000)} min | ${(repo.why ?? '').replace(/\|/g, '\\|').slice(0, 200)} |`,
    );
  return [
    `# ${title}`,
    '',
    `Score: ${score.verified} of ${score.eligible} eligible repos verified (${pct(score.score)}).`,
    `Not affected: ${score.notAffected}. Errors (counted as not verified): ${score.errors}.`,
    `Excluded: ${score.excluded['red-baseline']} red baseline, ${score.excluded['outside-authority']} outside our authority (${pct(score.outsideAuthorityShare)} of affected repos).`,
    `Cost: $${score.costUsd.toFixed(2)}.`,
    '',
    '| Set | Repo | Status | Tasks | Cost | Wall | Why |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}
