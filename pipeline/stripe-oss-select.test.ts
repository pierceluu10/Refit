import { expect, it } from 'vitest';
import { dependencyMoves, diffExclusions } from '../scripts/stripe-oss-history.mjs';
import { diffFiles, reviewFor, scoreRow, summarize } from '../scripts/stripe-oss-score.mjs';
import {
  activeSince,
  lightIneligibility,
  lockedStripeVersion,
  MAX_DISK_KB,
  repoGroups,
  sdkApiVersion,
  serverStripeFile,
  splitStars,
  stripeManifest,
  testScript,
} from '../scripts/stripe-oss-select.mjs';
import { STRIPE_SDK_RELEASES } from './stripe-package-upgrade.ts';

const record = (overrides: Record<string, unknown> = {}) => ({
  name: 'cal.com',
  description: 'Scheduling infrastructure for absolutely everyone.',
  isArchived: false,
  isFork: false,
  isTemplate: false,
  diskUsage: 400_000,
  stargazerCount: 40_000,
  pushedAt: '2026-10-26T10:00:00Z',
  owner: { __typename: 'Organization', login: 'calcom' },
  repositoryTopics: { nodes: [{ topic: { name: 'scheduling' } }] },
  ...overrides,
});

it('counts the one-year activity window back from --frozen-at', () => {
  expect(activeSince('2026-10-27')).toBe('2025-10-27');
  expect(() => activeSince('2026-10')).toThrow('--frozen-at must be a date');
});

it('splits star ranges until a search fits under the result cap', () => {
  expect(splitStars([500])).toEqual([[500, 999], [1000]]);
  expect(splitStars([500, 999])).toEqual([
    [500, 749],
    [750, 999],
  ]);
});

it('groups repo: qualifiers under the 256-character query limit', () => {
  const base = '"\\"stripe\\"" filename:package.json';
  const repos = Array.from({ length: 30 }, (_, index) => `organization-${index}/application`);
  const groups = repoGroups(base, repos);
  expect(groups.flat()).toEqual(repos);
  for (const group of groups)
    expect(`${base} ${group.map((repo) => `repo:${repo}`).join(' ')}`.length).toBeLessThanOrEqual(
      256,
    );
});

it('keeps an organization product and names why others are excluded', () => {
  const since = '2025-10-27';
  expect(lightIneligibility(record(), since)).toBeNull();
  expect(lightIneligibility(record({ isFork: true }), since)).toBe('fork');
  expect(lightIneligibility(record({ isTemplate: true }), since)).toBe('template repository');
  expect(lightIneligibility(record({ diskUsage: MAX_DISK_KB }), since)).toBe('over 1 GiB');
  expect(lightIneligibility(record({ pushedAt: '2025-01-01T00:00:00Z' }), since)).toBe(
    'no push in 365 days',
  );
  expect(lightIneligibility(record({ stargazerCount: 49 }), since)).toBe(
    'organization with under 50 stars',
  );
  expect(
    lightIneligibility(
      record({ stargazerCount: 499, owner: { __typename: 'User', login: 'someone' } }),
      since,
    ),
  ).toBe('user with under 500 stars');
  expect(
    lightIneligibility(record({ owner: { __typename: 'Organization', login: 'stripe' } }), since),
  ).toBe('Stripe-owned sample or SDK');
  for (const wording of [
    { name: 'next-saas-starter' },
    { description: 'A Next.js boilerplate with Stripe' },
    { repositoryTopics: { nodes: [{ topic: { name: 'tutorial' } }] } },
    { name: 'airbnb_clone' },
  ])
    expect(lightIneligibility(record(wording), since)).toBe('template, tutorial or course');
});

it('reads only product manifests and real test scripts', () => {
  expect(stripeManifest('apps/web/package.json')).toBe(true);
  expect(stripeManifest('package.json')).toBe(true);
  expect(stripeManifest('examples/stripe/package.json')).toBe(false);
  expect(stripeManifest('packages/web/tests/fixtures/package.json')).toBe(false);
  expect(testScript({ scripts: { test: 'vitest run' } })).toBe('vitest run');
  expect(testScript({ scripts: { test: 'echo "Error: no test specified" && exit 1' } })).toBeNull();
  expect(testScript({})).toBeNull();
});

it('reads the locked stripe-node release for root and workspace packages', () => {
  expect(
    lockedStripeVersion(
      JSON.stringify({
        packages: {
          '': {},
          'apps/web/node_modules/stripe': { version: '17.4.0' },
          'node_modules/stripe': { version: '14.25.0' },
        },
      }),
      'npm',
    ),
  ).toBe('14.25.0');
  expect(
    lockedStripeVersion(
      [
        'importers:',
        '  apps/web:',
        '    dependencies:',
        '      stripe:',
        '        specifier: ^18.0.0',
        '        version: 18.2.1',
      ].join('\n'),
      'pnpm',
    ),
  ).toBe('18.2.1');
  expect(lockedStripeVersion('stripe@^16.0.0:\n  version "16.12.0"\n', 'yarn')).toBe('16.12.0');
  expect(lockedStripeVersion('"stripe@npm:^17.0.0":\n  version: 17.7.0\n', 'yarn')).toBe('17.7.0');
});

it('maps a locked release to the API version it sends by default', () => {
  expect(sdkApiVersion(STRIPE_SDK_RELEASES, '14.5.0')).toBe('2023-10-16');
  expect(sdkApiVersion(STRIPE_SDK_RELEASES, '18.0.0')).toBe('2025-03-31.basil');
  expect(sdkApiVersion(STRIPE_SDK_RELEASES, '99.0.0')).toBeUndefined();
});

it('counts server SDK clients outside tests and the browser library', () => {
  const server = "import Stripe from 'stripe';\nexport const stripe = new Stripe(key);";
  expect(serverStripeFile('apps/web/lib/stripe.ts', server)).toBe(true);
  expect(serverStripeFile('apps/web/lib/stripe.test.ts', server)).toBe(false);
  expect(serverStripeFile('examples/checkout/server.js', server)).toBe(false);
  expect(
    serverStripeFile(
      'apps/web/lib/client.ts',
      "import { loadStripe } from '@stripe/stripe-js';\nloadStripe(key);",
    ),
  ).toBe(false);
  expect(serverStripeFile('api/stripe.js', "const stripe = require('stripe')(key);")).toBe(true);
});

it('finds every change of the declared stripe range', () => {
  expect(
    dependencyMoves([
      { sha: 'a', range: '^14.0.0' },
      { sha: 'b', range: '^14.0.0' },
      { sha: 'c', range: '^17.4.0' },
      { sha: 'd' },
      { sha: 'e', range: '^18.0.0' },
    ]),
  ).toEqual([{ sha: 'c', from: '^14.0.0', to: '^17.4.0' }]);
});

it('freezes the human diff without lockfiles', () => {
  expect(diffExclusions()).toContain(':(exclude)**/pnpm-lock.yaml');
  expect(diffExclusions()).toContain(':(exclude)package-lock.json');
});

it('scores precision from reviews and coverage over repositories that need a change', () => {
  const row = (repo: string, status: string, baseline: string, affected = true) => ({
    repo,
    commit: 'c',
    production: { status, reason: `${status} reason` },
    workflow: { patch: 'proposed', baseline },
    productionMode: { status: affected ? 'affected' : 'unaffected' },
  });
  const reviews = [
    { repo: 'a/validated', run: 'refit-bench 101 (no AI)', verdict: 'correct' },
    { repo: 'a/review', run: 'refit-bench 101', verdict: 'wrong' },
    { repo: 'a/validated', run: 'refit-bench 99', verdict: 'wrong' },
  ];
  const rows = [
    row('a/validated', 'validated', 'passed'),
    row('a/review', 'needs-review', 'passed'),
    row('a/untested', 'needs-review', 'not-run'),
    row('a/clean', 'unaffected', 'passed', false),
  ].map((entry) =>
    scoreRow(entry, {
      review: reviewFor(reviews, entry.repo, ['101']),
      patchFiles: undefined,
      human: undefined,
    }),
  );
  const summary = summarize(rows);
  expect(summary.verdicts).toEqual({ correct: 1, 'correct-partial': 0, wrong: 1, unsure: 0 });
  expect(summary.wrong).toEqual(['a/review']);
  expect(summary.unreviewed).toEqual(['a/untested']);
  expect(summary.coverage).toEqual({ covered: 1, needsChangeWithChecks: 2 });
  expect(Object.keys(summary.stops).sort()).toEqual(['needs-review', 'unaffected']);
});

it('compares the code files of Refit and the maintainers in historical mode', () => {
  const patch = [
    '--- a/package.json',
    '+++ b/package.json',
    '--- a/lib/stripe.ts',
    '+++ b/lib/stripe.ts',
    '--- a/app/webhook.ts',
    '+++ b/app/webhook.ts',
  ].join('\n');
  expect(diffFiles(patch)).toEqual(['app/webhook.ts', 'lib/stripe.ts', 'package.json']);
  const scored = scoreRow(
    {
      repo: 'a/b',
      commit: 'p',
      production: { status: 'validated' },
      workflow: { patch: 'proposed', baseline: 'passed' },
    },
    {
      review: undefined,
      patchFiles: diffFiles(patch),
      human: { fix: 'f', codeFiles: ['lib/stripe.ts', 'lib/billing.ts'] },
    },
  );
  expect(scored).toMatchObject({
    needsChange: true,
    refitCodeFiles: ['app/webhook.ts', 'lib/stripe.ts'],
    sharedFiles: ['lib/stripe.ts'],
  });
});
