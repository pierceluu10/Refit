import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { DeadlineRegistry } from './deadline-registry.ts';
import { modelFixBody, modelFixMessage } from './model-fixes.ts';
import { publicationWaiver } from './publication.ts';
import { createReviewArtifacts, MAX_BODY_CHARACTERS } from './review.ts';
import { digest } from './specifications.ts';
import { REFIT_VERSION } from './migration-identity.ts';

// Stored benchmark results, reduced to what the body reads (see each fixture's storedResult).
const fixture = (name: string) =>
  JSON.parse(readFileSync(`pipeline/fixtures/pr-bodies/${name}.json`, 'utf8'));
const registry: DeadlineRegistry = JSON.parse(readFileSync('data/deadlines.json', 'utf8'));

// As publication renders them: with the waiver an allowed review gate earns, if any.
const published = (name: string, integration?: string) => {
  const report = fixture(name);
  const artifacts = createReviewArtifacts(
    report,
    'github',
    integration,
    publicationWaiver(report, true),
  );
  return {
    // Every release bump changes the version in the evidence marker; the snapshot keeps its place.
    body: artifacts.files['pull-request.md'].replace(
      `"refit": "${REFIT_VERSION}"`,
      '"refit": "<release>"',
    ),
    message: artifacts.commitMessage,
    title: artifacts.manifest.title,
  };
};

const shapes: Record<string, () => { body: string; message: string }> = {
  validated: () => published('validated'),
  'needs-review-waiver': () => {
    expect(publicationWaiver(fixture('needs-review-waiver'), true)?.gate).toBe(
      'webhook-api-version',
    );
    return published('needs-review-waiver');
  },
  'untraced-reads': () => published('untraced-reads'),
  'ai-patch': () => published('ai-patch'),
  'model-fix': () => {
    const options = { ...fixture('model-fix'), registry };
    return { body: modelFixBody(options), message: modelFixMessage(options) };
  },
  shopify: () => published('shopify'),
  // One draft of a collection: each integration publishes its own body, marked with its id.
  'multi-integration': () => published('multi-integration', 'stripe'),
};

it.each(Object.keys(shapes))('writes the %s pull request body within budget', async (name) => {
  const { body } = shapes[name]();
  expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARACTERS);
  expect(body).toMatch(/^## Rollback$/m);
  expect(body).toMatch(/^## Reviewer Checklist$/m);
  expect(body).toMatch(/^## Not Verified$/m);
  await expect(body).toMatchFileSnapshot(`__snapshots__/pr-bodies/${name}.md`);
});

it.each(['needs-review-waiver', 'untraced-reads', 'ai-patch'])(
  'titles the %s draft for review',
  (name) => {
    expect(published(name).title).toMatch(/^\[Needs review\] /);
  },
);

it.each(Object.keys(shapes))('writes the %s commit message', async (name) => {
  const { message } = shapes[name]();
  const [subject, blank] = message.split('\n');
  expect(subject).toMatch(/^fix(\([a-z0-9-]+\))?: \S/);
  expect(subject.length).toBeLessThanOrEqual(70);
  expect(blank).toBe('');
  // Only a single word too long to wrap, such as a URL, may pass 72 columns.
  for (const line of message.split('\n'))
    expect(line.length <= 72 || !line.trim().includes(' ') || line.startsWith('Source: ')).toBe(
      true,
    );
  expect(message).not.toMatch(/Co-Authored-By|Generated with/i);
  await expect(message).toMatchFileSnapshot(`__snapshots__/commit-messages/${name}.txt`);
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
