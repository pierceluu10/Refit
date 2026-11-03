import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSmoke, smokeSet, SMOKE_REPOS } from './smoke.ts';

describe('smoke test', () => {
  it('uses one real entry from each of three dev sets', () => {
    const set = smokeSet();
    expect(set.repos).toHaveLength(3);
    expect(new Set(set.repos.map((entry) => entry.fromSet))).toEqual(
      new Set(SMOKE_REPOS.map((pick) => pick.set)),
    );
  });

  it('runs end to end with a fake model and passes its own checks', async () => {
    const outcome = await runSmoke();
    expect(outcome.problems).toEqual([]);
    expect(outcome.score.attemptedRate).toBe(1);
    expect(outcome.score.counts).toMatchObject({
      verified: 1,
      'needs-review': 1,
      'not-affected': 1,
    });
    expect(outcome.report).toContain('SMOKE OK');

    // The reviewer flagged the verified PR, and it stayed verified.
    const verified = outcome.results
      .flatMap((repo) => repo.tasks)
      .find((task) => task.record?.outcome === 'verified');
    expect(verified?.review?.opinion).toBe('has-concerns');

    // One hand-check entry for each PR: the verified one and the needs-review one.
    const reviews = JSON.parse(readFileSync(outcome.reviewsPath, 'utf8')) as { grade: string }[];
    expect(reviews.map((entry) => entry.grade).sort()).toEqual(['needs-review', 'verified']);
    const written = readdirSync(join(outcome.outDir, 'smoke-3'));
    expect(written).toHaveLength(3);
  });

  it('leaves the fixtures untouched', async () => {
    await runSmoke();
    const fixture = readFileSync(
      join(import.meta.dirname, 'fixtures/stripe-billing/src/billing.js'),
      'utf8',
    );
    expect(fixture).toContain("apiVersion: '2023-10-16'");
  });
});
