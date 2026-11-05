import { describe, expect, it } from 'vitest';
import type { RepoResult } from '../runner/types.ts';
import type { BaselineRecord } from '../runner/screen.ts';
import { scoreRound3 } from './round3.ts';

const result = (repo: string, outcomes: string[], verdict: RepoResult['verdict'] = 'tasks') =>
  ({
    set: 's',
    index: 0,
    repo,
    commit: 'c',
    provider: 'p',
    usages: 1,
    changes: 1,
    verdict,
    tasks: outcomes.map((outcome, i) => ({
      taskId: `${repo}:${i}`,
      changeId: `c${i}`,
      kind: 'k',
      attempted: true,
      record: {
        taskId: `${repo}:${i}`,
        outcome,
        diff: '+x',
        checks: [],
        costUsd: 1,
        transcriptPath: 'x',
      },
    })),
    costUsd: outcomes.length,
    durationMs: 60_000,
  }) as RepoResult;

const baseline = (repo: string, exclusion?: BaselineRecord['exclusion']) =>
  ({ set: 's', repo, commit: 'c', provider: 'p', green: !exclusion, exclusion }) as BaselineRecord;

describe('scoreRound3', () => {
  it('scores verified eligible repos over eligible repos, leaving exclusions out', () => {
    const score = scoreRound3(
      [
        result('a/all-verified', ['verified', 'not-affected']),
        result('a/one-needs-review', ['verified', 'needs-review']),
        result('a/untouched', [], 'not-affected'),
        result('a/agent-says-unaffected', ['not-affected']),
        result('a/crashed', [], 'error'),
      ],
      [
        baseline('a/all-verified'),
        baseline('a/one-needs-review'),
        baseline('a/untouched'),
        baseline('a/agent-says-unaffected'),
        baseline('a/crashed'),
        baseline('a/red', { class: 'red-baseline', reason: 'tsc fails' }),
        baseline('a/creds', { class: 'outside-authority', reason: 'live key' }),
      ],
    );
    expect(score).toMatchObject({
      eligible: 3,
      verified: 1,
      notAffected: 2,
      errors: 1,
      excluded: { 'red-baseline': 1, 'outside-authority': 1 },
    });
    expect(score.score).toBeCloseTo(1 / 3);
    expect(score.outsideAuthorityShare).toBeCloseTo(1 / 4);
  });
});
