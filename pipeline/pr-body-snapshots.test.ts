import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { DeadlineRegistry } from './deadline-registry.ts';
import { modelFixBody } from './model-fixes.ts';
import { publicationWaiver } from './publication.ts';
import { createReviewArtifacts, MAX_BODY_CHARACTERS } from './review.ts';
import { digest } from './specifications.ts';

// Stored benchmark results, reduced to what the body reads (see each fixture's storedResult).
const fixture = (name: string) =>
  JSON.parse(readFileSync(`pipeline/fixtures/pr-bodies/${name}.json`, 'utf8'));
const registry: DeadlineRegistry = JSON.parse(readFileSync('data/deadlines.json', 'utf8'));

// As publication renders them: with the waiver an allowed review gate earns, if any.
const published = (name: string, integration?: string) => {
  const report = fixture(name);
  return createReviewArtifacts(report, 'github', integration, publicationWaiver(report, true))
    .files['pull-request.md'];
};

const bodies: Record<string, () => string> = {
  validated: () => published('validated'),
  'needs-review-waiver': () => {
    expect(publicationWaiver(fixture('needs-review-waiver'), true)?.gate).toBe(
      'webhook-api-version',
    );
    return published('needs-review-waiver');
  },
  'untraced-reads': () => published('untraced-reads'),
  'ai-patch': () => published('ai-patch'),
  'model-fix': () => modelFixBody({ ...fixture('model-fix'), registry }),
  shopify: () => published('shopify'),
  // One draft of a collection: each integration publishes its own body, marked with its id.
  'multi-integration': () => published('multi-integration', 'stripe'),
};

it.each(Object.keys(bodies))('writes the %s pull request body within budget', async (name) => {
  const body = bodies[name]();
  expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARACTERS);
  expect(body).toMatch(/^## Rollback$/m);
  expect(body).toMatch(/^## Reviewer Checklist$/m);
  expect(body).toMatch(/^## Not Verified$/m);
  await expect(body).toMatchFileSnapshot(`__snapshots__/pr-bodies/${name}.md`);
});

it('shortens a body that would exceed the budget and says so', () => {
  const report = fixture('multi-integration');
  // Separate hunks of 400-character lines, more than 80 lines in all.
  const long = Array.from(
    { length: 120 },
    (_, index) => `const value${index} = '${'x'.repeat(400)}';`,
  );
  const diff = `${report.patch.diff}diff --git "a/convex/long.ts" "b/convex/long.ts"
--- "a/convex/long.ts"
+++ "b/convex/long.ts"
@@ -1,120 +1,120 @@
${long.map((line) => `-${line}`).join('\n')}
${long.map((line, index) => `+${index % 6 ? line : line.replace('x', 'y')}`).join('\n')}
`;
  const sites = Array.from({ length: 400 }, (_, index) => ({
    ...report.findings[0],
    line: index + 1,
    untraced: true,
  }));
  const body = createReviewArtifacts(
    {
      ...report,
      findings: [...report.findings, ...sites],
      patch: { ...report.patch, diff },
      validation: { ...report.validation, patchHash: digest(diff) },
    },
    'github',
  ).files['pull-request.md'];
  expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARACTERS);
  expect(body).toContain(
    'This description is shortened to stay under 16,000 characters (code changes cut to 40 lines)',
  );
  expect(body).toContain('- and 375 more; every location is in report.json.');
});
