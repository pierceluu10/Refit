import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { draw, group, labelRepository, lockedStripe } from '../scripts/stripe-fresh-labels.mjs';

it('splits outcomes into affected, not affected and unscanned', () => {
  expect(group('not-affected')).toBe('not-affected');
  expect(group('no-mapped-methods')).toBe('not-affected');
  expect(group('no-sdk-calls')).toBe('not-affected');
  expect(group('stopped-removed-request-parameter')).toBe('affected');
  expect(group('validated')).toBe('affected');
  expect(group('exceeds-scan-limits')).toBeNull();
});

it('draws the same seeded sample every time, half from each group', () => {
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => ({ repo: `a/${i}`, outcome: 'not-affected' })),
    ...Array.from({ length: 5 }, (_, i) => ({ repo: `b/${i}`, outcome: 'stopped-x' })),
    { repo: 'c/0', outcome: 'validated' },
    { repo: 'd/0', outcome: 'exceeds-scan-limits' },
  ];
  const first = draw(rows, 7, 3);
  expect(draw([...rows].reverse(), 7, 3)).toEqual(first);
  expect(first.notAffected).toHaveLength(3);
  expect(first.notAffected.every((repo) => repo.startsWith('a/'))).toBe(true);
  expect(first.affected).toHaveLength(3);
  expect(first.affected.some((repo) => repo === 'd/0')).toBe(false);
  // The extension is every stopped repository not already sampled.
  expect(first.stopped.every((repo) => repo.startsWith('b/'))).toBe(true);
  expect([...first.stopped, ...first.affected.filter((r) => r.startsWith('b/'))].sort()).toEqual(
    rows.filter((row) => row.outcome === 'stopped-x').map((row) => row.repo),
  );
  expect(draw(rows, 8, 3)).not.toEqual(first);
});

it('reproduces the committed fresh-set sample', () => {
  const { rows } = JSON.parse(
    readFileSync('docs/benchmarks/2026-10-16-stripe-fresh-results.json', 'utf8'),
  ) as { rows: { repo: string; outcome: string }[] };
  const labels = JSON.parse(
    readFileSync('docs/benchmarks/2026-10-22-stripe-fresh-labels.json', 'utf8'),
  ) as { sample: { seed: number; affected: string[]; notAffected: string[] } };
  const { affected, notAffected } = draw(rows, labels.sample.seed);
  expect(affected).toEqual(labels.sample.affected);
  expect(notAffected).toEqual(labels.sample.notAffected);
});

it('reads the locked stripe version from each lockfile format, else the declared minimum', () => {
  expect(
    lockedStripe(
      {
        'package-lock.json': JSON.stringify({
          packages: { 'node_modules/stripe': { version: '14.25.0' } },
        }),
      },
      '^14.1.0',
    ),
  ).toEqual({ version: '14.25.0', source: 'package-lock.json' });
  expect(
    lockedStripe(
      { 'package-lock.json': JSON.stringify({ dependencies: { stripe: { version: '8.1.0' } } }) },
      '^8',
    ),
  ).toEqual({ version: '8.1.0', source: 'package-lock.json' });
  const pnpm9 = [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    '      stripe:',
    '        specifier: ^17.0.0',
    '        version: 17.7.0',
    '  packages/web:',
    '    dependencies:',
    '      stripe:',
    '        specifier: ^12.0.0',
    '        version: 12.1.0',
    'packages:',
  ].join('\n');
  expect(lockedStripe({ 'pnpm-lock.yaml': pnpm9 }, '^17.0.0')?.version).toBe('17.7.0');
  const pnpm6 = [
    "lockfileVersion: '6.0'",
    'dependencies:',
    '  stripe:',
    '    specifier: ^13.8.0',
    '    version: 13.11.0',
  ].join('\n');
  expect(lockedStripe({ 'pnpm-lock.yaml': pnpm6 }, '^13.8.0')?.version).toBe('13.11.0');
  const pnpm5 = ['lockfileVersion: 5.4', 'dependencies:', '  stripe: 11.2.0'].join('\n');
  expect(lockedStripe({ 'pnpm-lock.yaml': pnpm5 }, '^11.1.0')?.version).toBe('11.2.0');
  const yarn = ['stripe@^14.22.0:', '  version "14.25.0"', '  resolved "…"'].join('\n');
  expect(lockedStripe({ 'yarn.lock': yarn }, '^14.22.0')).toEqual({
    version: '14.25.0',
    source: 'yarn.lock',
  });
  const berry = ['"stripe@npm:^17.0.0":', '  version: 17.4.0'].join('\n');
  expect(lockedStripe({ 'yarn.lock': berry }, '^17.0.0')?.version).toBe('17.4.0');
  const bun = '{\n  "packages": {\n    "stripe": ["stripe@20.4.1", "", {}],\n  }\n}';
  expect(lockedStripe({ 'bun.lock': bun }, '^20.0.0')).toEqual({
    version: '20.4.1',
    source: 'bun.lock',
  });
  expect(lockedStripe({}, '^18.5.0')).toEqual({ version: '18.5.0', source: 'declared minimum' });
  expect(lockedStripe({}, '~17')).toEqual({ version: '17.0.0', source: 'declared minimum' });
  expect(lockedStripe({}, 'latest')).toBeNull();
});

it('combines oracle labels, the documented rules and hand decisions, and refuses gaps', () => {
  const entry = {
    repo: 'o/r',
    before: '2024-06-20',
    version: '16.0.0',
    source: 'package-lock.json',
  };
  const read = (file: string, line: number, property: string, label: string, extra = {}) => ({
    file,
    line,
    column: 5,
    property,
    label,
    schemas: label === 'breaking' ? ['subscription'] : [],
    ...extra,
  });
  const files: Record<string, string> = {
    'webhook.js':
      "import Stripe from 'stripe';\nconst id = invoice.subscription;\nif (event.type) {}",
    'ui.tsx': 'export const name = user.subscription;',
  };
  const oracle = {
    reads: [
      read('billing.ts', 3, 'current_period_end', 'breaking'),
      read('billing.ts', 4, 'payment_method_types', 'breaking', {
        request: 'POST /v1/checkout/sessions payment_method_types',
      }),
      read('webhook.js', 2, 'subscription', 'unknown'),
      { ...read('webhook.js', 3, 'type', 'unknown'), column: 11 },
      read('ui.tsx', 1, 'subscription', 'unknown'),
    ],
  };
  const decisions = {
    reads: [
      {
        repo: 'o/r',
        file: 'webhook.js',
        line: 2,
        column: 5,
        property: 'subscription',
        label: 'breaking',
        field: 'invoice.subscription',
        note: 'Stripe Invoice in invoice.paid',
      },
    ],
    requests: [],
  };
  const labelled = labelRepository({ entry, oracle, decisions, source: (file) => files[file] });
  expect(labelled.verdict).toBe('broken');
  expect(labelled.breaking).toBe(2);
  expect(labelled.reads.map((r) => [r.file, r.label, r.source, r.field])).toEqual([
    ['billing.ts', 'breaking', 'oracle', 'subscription.current_period_end'],
    ['webhook.js', 'breaking', 'manual', 'invoice.subscription'],
    ['webhook.js', 'stripe-unaffected', 'rule-event-type', undefined],
    ['ui.tsx', 'not-stripe', 'rule-no-stripe-in-file', undefined],
  ]);
  expect(labelled.requests).toEqual([
    expect.objectContaining({ file: 'billing.ts', label: 'breaking', source: 'oracle' }),
  ]);
  // An unknown read in a Stripe file needs a decision, and a decision must match a read.
  const undecided = { reads: [read('webhook.js', 2, 'subscription', 'unknown')] };
  expect(() =>
    labelRepository({
      entry,
      oracle: undecided,
      decisions: { reads: [], requests: [] },
      source: (f) => files[f],
    }),
  ).toThrow(/no decision/);
  const stale = { ...decisions, reads: [{ ...decisions.reads[0], line: 9 }] };
  expect(() =>
    labelRepository({ entry, oracle: undecided, decisions: stale, source: (f) => files[f] }),
  ).toThrow(/no decision/);
  expect(() =>
    labelRepository({ entry, oracle: { reads: [] }, decisions, source: (f) => files[f] }),
  ).toThrow(/match no read/);
});
