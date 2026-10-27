import { expect, it } from 'vitest';
import { droppedRequestPaths, untracedEdits } from './ai-patch-policies.ts';
import { STRIPE } from './providers.ts';
import type { Repository } from './types.ts';

// Owner decision D2: an AI patch that edits anything but the Stripe sites Refit traced is never
// published as validated. `before` is the rules' code; reads are the traced findings on it.

const ROUTE = 'app/api/billing/route.ts';
const RULES = `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-09-30.endive' });

export async function GET(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id, {
    expand: ['items'],
  });
  const end = subscription.current_period_end;
  console.log('loaded', id);
  return Response.json({ end });
}
`;
// Line 8 reads the removed field on the traced response.
const READ = { file: ROUTE, line: 8, confidence: 'confirmed' as const };

const repository = (files: Record<string, string>): Repository => ({
  root: '/repository',
  files: Object.entries(files).map(([path, content]) => ({ path, content })),
  dependencies: [],
  lockfiles: [],
  warnings: [],
});

function check(after: Record<string, string>, reads = [READ]) {
  const before = repository({ [ROUTE]: RULES });
  // Unchanged files are skipped, so listing the route as changed costs nothing.
  const changed = new Set([...Object.keys(after), ROUTE]);
  const result = untracedEdits(
    before,
    repository({ [ROUTE]: RULES, ...after }),
    changed,
    STRIPE,
    reads,
  );
  console.log(JSON.stringify(result));
  return result;
}

const edit = (original: string, replacement: string) => {
  expect(RULES).toContain(original);
  return RULES.replace(original, replacement);
};

it('accepts an edit of a traced read and of a traced call', () => {
  expect(
    check({
      [ROUTE]: edit(
        'subscription.current_period_end;',
        'subscription.items.data[0]?.current_period_end;',
      ),
    }),
  ).toEqual([]);
  expect(check({ [ROUTE]: edit("expand: ['items'],", "expand: ['items.data'],") })).toEqual([]);
  // A line inserted between two lines of the traced call stays inside it.
  expect(
    check({ [ROUTE]: edit("expand: ['items'],\n", "expand: ['items'],\n    limit: 1,\n") }),
  ).toEqual([]);
});

it('refuses an edit next to a traced site', () => {
  expect(
    check({ [ROUTE]: edit("console.log('loaded', id);", "console.log('done', id);") }),
  ).toEqual([{ file: ROUTE, line: 9 }]);
});

it('refuses a new statement inserted beside a traced read', () => {
  expect(
    check({
      [ROUTE]: edit(
        '  const end = subscription.current_period_end;\n',
        '  const item = subscription.items.data[0];\n  const end = subscription.current_period_end;\n',
      ),
    }),
  ).toEqual([{ file: ROUTE, line: 8 }]);
});

it('refuses an import the AI adds', () => {
  expect(check({ [ROUTE]: `import { periodEnd } from '@/lib/periods';\n${RULES}` })).toEqual([
    { file: ROUTE, line: 1 },
  ]);
});

it('refuses an edit of a read Refit could not trace', () => {
  expect(
    check(
      {
        [ROUTE]: edit(
          'subscription.current_period_end;',
          'subscription.items.data[0]?.current_period_end;',
        ),
      },
      [{ ...READ, untraced: { reason: 'receiver unknown' } } as typeof READ],
    ),
  ).toEqual([{ file: ROUTE, line: 8 }]);
});

it('refuses test files, new files and deleted files', () => {
  const test = 'app/api/billing/route.test.ts';
  const before = repository({ [ROUTE]: RULES, [test]: RULES });
  expect(
    untracedEdits(
      before,
      repository({ [ROUTE]: RULES, [test]: RULES.replace("['items']", "['items.data']") }),
      new Set([test]),
      STRIPE,
      [{ ...READ, file: test }],
    ),
  ).toEqual([{ file: test, line: 0 }]);
  expect(check({ 'lib/periods.ts': 'export const periodEnd = 1;\n' })).toEqual([
    { file: 'lib/periods.ts', line: 0 },
  ]);
  expect(
    untracedEdits(before, repository({ [test]: RULES }), new Set([ROUTE]), STRIPE, [READ]),
  ).toEqual([{ file: ROUTE, line: 0 }]);
});

it('leaves a dropped request parameter inside a traced call to the dropped-parameter policy', () => {
  // The edit is inside the call's lines, so only droppedRequestPaths refuses it; the D2 gate runs both.
  const after = edit("    expand: ['items'],\n", '');
  expect(check({ [ROUTE]: after })).toEqual([]);
  expect(
    droppedRequestPaths(
      repository({ [ROUTE]: RULES }),
      repository({ [ROUTE]: after }),
      new Set([ROUTE]),
      STRIPE,
    ).map((entry) => entry.path),
  ).toContain('argument 2.expand');
});
