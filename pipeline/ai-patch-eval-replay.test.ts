import { createTwoFilesPatch } from 'diff';
import { expect, it } from 'vitest';
import { guardRefusals, lineEdits, withDiff } from './ai-patch-eval-replay.ts';
import { STRIPE } from './providers.ts';
import { PipelineInputError, type Repository, type SourceEdit } from './types.ts';

// The checkout call from Kanba-co/kanba, whose recorded coding-agent diff deleted the card
// restriction (docs/benchmarks/2026-10-21-agent-comparison-results.json).
const CHECKOUT = `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' });

export async function POST(customerId: string, price_id: string) {
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ['card'],
    allow_promotion_codes: true,
    line_items: [{ price: price_id, quantity: 1 }],
    mode: 'subscription',
  });
  return session.url;
}
`;
const PATH = 'app/api/stripe/checkout/route.ts';
const DELETED = CHECKOUT.replace("    payment_method_types: ['card'],\n", '');
const RENAMED = CHECKOUT.replace('payment_method_types', 'allowed_payment_method_types');

const repository = (files: Record<string, string>): Repository => ({
  root: '/repository',
  files: Object.entries(files).map(([path, content]) => ({ path, content })),
  dependencies: [],
  lockfiles: [],
  warnings: [],
});
const gitDiff = (path: string, before: string, after: string) =>
  createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after);
const applied = (content: string, edits: SourceEdit[]) =>
  [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce(
      (text, edit) => text.slice(0, edit.start) + edit.replacement + text.slice(edit.end),
      content,
    );
const contentOf = (repository: Repository, path: string) =>
  repository.files.find((file) => file.path === path)?.content;

it('turns a file change into line edits that reproduce it', () => {
  const before = 'one\ntwo\nthree\nfour\n';
  for (const after of [
    'one\ntwo\nthree\nfour\nfive\n',
    'zero\none\ntwo\nthree\nfour\n',
    'one\nthree\n',
    'one\nTWO\nthree\nFOUR\n',
    'one\ntwo\nthree\nfour',
    '',
  ]) {
    const edits = lineEdits(PATH, before, after);
    expect(applied(before, edits), JSON.stringify(after)).toBe(after);
    // A replaced line is one edit, not a deletion next to an insertion.
    expect(edits.every((edit, index) => index === 0 || edits[index - 1].end < edit.start)).toBe(
      true,
    );
  }
  expect(lineEdits(PATH, before, before)).toEqual([]);
});

it('applies a recorded diff on the rules, or on the original where the rules changed its lines', () => {
  const original = repository({ [PATH]: CHECKOUT, 'lib/other.ts': 'export {};\n' });
  const untouched = withDiff(original, gitDiff(PATH, CHECKOUT, DELETED));
  expect(contentOf(untouched.repository, PATH)).toBe(DELETED);
  expect(untouched.fromFallback).toEqual([]);

  // The card rule already renamed the parameter, so the agent's deletion no longer applies there.
  const rules = repository({ [PATH]: RENAMED, 'lib/other.ts': 'export {};\n' });
  const onRules = withDiff(rules, gitDiff(PATH, CHECKOUT, DELETED), original);
  expect(contentOf(onRules.repository, PATH)).toBe(DELETED);
  expect(onRules.fromFallback).toEqual([PATH]);
  expect(contentOf(onRules.repository, 'lib/other.ts')).toBe('export {};\n');

  expect(() => withDiff(rules, gitDiff(PATH, CHECKOUT, DELETED))).toThrow(PipelineInputError);
});

it('lists changed files outside the scanned sources and leaves them out', () => {
  const original = repository({ [PATH]: CHECKOUT });
  const diff =
    gitDiff('package.json', '{ "stripe": "^14.15.0" }\n', '{ "stripe": "23.0.0" }\n') +
    gitDiff(PATH, CHECKOUT, DELETED);
  const result = withDiff(original, diff);
  expect(result.unscanned).toEqual(['package.json']);
  expect(result.repository.files.map((file) => file.path)).toEqual([PATH]);
  expect(contentOf(result.repository, PATH)).toBe(DELETED);
});

it('charges a recorded patch only with what it changed from its base', () => {
  const original = repository({ [PATH]: CHECKOUT });
  const guard = (base: Repository, modified: Repository) =>
    guardRefusals(base, modified, [], STRIPE, {}, {});

  const deleted = guard(original, repository({ [PATH]: DELETED }));
  expect(deleted.files).toEqual([PATH]);
  expect(deleted.refusals.droppedRequestPaths).toEqual([
    { call: 'checkout.sessions.create', path: 'payment_method_types', line: 7, file: PATH },
  ]);
  expect(
    Object.entries(deleted.refusals)
      .filter(([, list]) => list.length)
      .map(([guard]) => guard),
  ).toEqual(['droppedRequestPaths']);

  // The same card rename as the rules is no change on the rules' code, but against the original
  // it is a changed request parameter, which only the reviewed rule may make.
  const rules = repository({ [PATH]: RENAMED });
  expect(guard(rules, repository({ [PATH]: RENAMED })).files).toEqual([]);
  expect(
    guard(original, repository({ [PATH]: RENAMED })).refusals.droppedRequestPaths.map(
      (entry) => entry.path,
    ),
  ).toEqual(['payment_method_types']);
});
