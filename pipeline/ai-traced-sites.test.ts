import { describe, expect, it } from 'vitest';
import { CONTRACT_CHANGE } from './ai-patches.ts';
import { aiValidationGate } from './validation.ts';
import { droppedRequestPaths, untouchedCalls, untracedEdits } from './ai-patch-policies.ts';
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

it('names the traced calls an AI patch leaves as they were', () => {
  const site = { file: ROUTE, line: 5 };
  const untouched = (after: string) =>
    untouchedCalls(repository({ [ROUTE]: RULES }), repository({ [ROUTE]: after }), STRIPE, [site]);
  expect(untouched(RULES)).toEqual([site]);
  // An edit outside the call does not handle what changed at it.
  expect(untouched(edit("console.log('loaded', id);", "console.log('done', id);"))).toEqual([site]);
  expect(untouched(edit("expand: ['items'],", "expand: ['items.data'],"))).toEqual([]);
  expect(untouched(edit("expand: ['items'],\n", "expand: ['items'],\n    limit: 1,\n"))).toEqual(
    [],
  );
  // A site on no traced call is never handled.
  expect(
    untouchedCalls(repository({ [ROUTE]: RULES }), repository({ [ROUTE]: RULES }), STRIPE, [
      { file: ROUTE, line: 9 },
    ]),
  ).toEqual([{ file: ROUTE, line: 9 }]);
});

describe('aiValidationGate', () => {
  const rules = repository({ [ROUTE]: RULES });
  // The fix adds a request parameter inside the reached call.
  const fixed = repository({
    [ROUTE]: edit("expand: ['items'],\n", "expand: ['items'],\n    limit: 1,\n"),
  });
  const call = {
    file: ROUTE,
    line: 5,
    changeId: CONTRACT_CHANGE,
    expression: 'GET /v1/subscriptions/{subscription_exposed_id}',
    confidence: 'confirmed' as const,
  };
  const change = {
    operation: 'GET',
    path: '/v1/subscriptions/{subscription_exposed_id}',
    text: 'added the required request property `limit`',
  };
  const gate = (overrides: Partial<Parameters<typeof aiValidationGate>[0]> = {}) => {
    const { failures } = aiValidationGate({
      rules,
      patched: fixed,
      provider: STRIPE,
      targets: [call],
      unmapped: [change],
      typeChecked: true,
      testsPassed: true,
      checksPassed: true,
      typeCheckedFiles: new Set([ROUTE]),
      ...overrides,
    });
    return failures;
  };

  it('passes an edit of the reached call when every check holds', () => {
    expect(gate()).toEqual([]);
  });

  it('fails without the type oracle or passing tests', () => {
    expect(gate({ typeChecked: false })).toEqual([expect.stringContaining('type oracle')]);
    expect(gate({ testsPassed: false })).toEqual([expect.stringContaining('own tests')]);
  });

  // Owner decision D2a: a passing type check stands in for missing tests on type-visible changes.
  it('lets the type check stand in for tests only for type-visible changes it covers', () => {
    const removed = { ...change, id: 'request-property-removed' };
    const base = {
      rules,
      patched: fixed,
      provider: STRIPE,
      targets: [call],
      unmapped: [removed],
      typeChecked: true,
      testsPassed: false,
      checksPassed: true,
      typeCheckedFiles: new Set([ROUTE]),
    };
    expect(aiValidationGate(base)).toEqual({ failures: [], typeCheckOnly: true });
    expect(aiValidationGate({ ...base, testsPassed: true }).typeCheckOnly).toBe(false);
    expect(
      aiValidationGate({
        ...base,
        unmapped: [{ ...change, id: 'response-property-became-nullable' }],
      }).failures,
    ).toEqual([expect.stringContaining('is not type-visible')]);
    expect(aiValidationGate({ ...base, typeCheckedFiles: new Set() }).failures).toEqual([
      expect.stringContaining(`does not cover ${ROUTE}`),
    ]);
    expect(aiValidationGate({ ...base, checksPassed: false }).failures).toEqual([
      expect.stringContaining('the checks did not pass'),
    ]);
    expect(aiValidationGate({ ...base, typeChecked: false }).typeCheckOnly).toBe(false);
  });

  it('fails when the reached call is left as it was, or no traced call reaches the change', () => {
    expect(gate({ patched: rules })).toEqual([expect.stringContaining('left the traced call')]);
    expect(gate({ targets: [] })).toEqual([expect.stringContaining('left the traced call')]);
  });

  it('fails an edit outside traced sites and a dropped request parameter', () => {
    const outside = repository({ [ROUTE]: fixed.files[0].content.replace("'loaded'", "'done'") });
    expect(gate({ patched: outside })).toEqual([expect.stringContaining(`${ROUTE}:9`)]);
    const dropped = repository({ [ROUTE]: edit("    expand: ['items'],\n", '') });
    expect(gate({ patched: dropped })).toEqual([expect.stringContaining('no longer sends')]);
  });

  it('fails an edit of a test file', () => {
    const test = 'app/api/billing/route.test.ts';
    expect(
      gate({
        rules: repository({ [ROUTE]: RULES, [test]: RULES }),
        patched: repository({ [ROUTE]: fixed.files[0].content, [test]: fixed.files[0].content }),
      }),
    ).toEqual([expect.stringContaining(test)]);
  });
});
