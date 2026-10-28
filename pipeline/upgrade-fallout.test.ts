import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { falloutShape } from './upgrade-fallout.ts';

// Messages are the type oracle's records on l2-push-249 (refit-bench 40591181316), each from the
// repository named beside it.
describe('falloutShape', () => {
  it.each([
    // kondax-com/Bocker
    [
      "Property 'subscription' does not exist on type 'Invoice'.",
      'TS2339',
      'removed-field',
      'Invoice.subscription',
    ],
    // 4NDR3S-01/TuSuerteEC (local reproduction)
    [
      "Property 'current_period_end' does not exist on type 'Response<Subscription>'.",
      'TS2339',
      'removed-field',
      'Subscription.current_period_end',
    ],
    [
      "Property 'discount' does not exist on type 'Subscription'. Did you mean 'discounts'?",
      'TS2551',
      'removed-field',
      'Subscription.discount',
    ],
    // ReeceHarding/firebase-next.js-boilerplate
    [
      "Property 'retrieveUpcoming' does not exist on type 'InvoiceResource'.",
      'TS2339',
      'removed-method',
      'InvoiceResource.retrieveUpcoming',
    ],
    [
      `Namespace '"/workspace/node_modules/stripe/esm/stripe.esm.node".Stripe' has no exported member 'UpcomingInvoice'.`,
      'TS2694',
      'removed-type',
      'UpcomingInvoice',
    ],
    // dubbl-org/dubbl
    [
      "Object literal may only specify known properties, and 'stripeAccount' does not exist in type 'ChargeRetrieveParams'.",
      'TS2353',
      'request-options-in-params',
      'ChargeRetrieveParams.stripeAccount',
    ],
  ])('%s is %s', (message, code, shape, member) => {
    expect(falloutShape({ code, message })).toEqual({ shape, lane: 'behaviour', member });
  });

  it('leaves removed request parameters to the request rules, never the AI', () => {
    for (const message of [
      "Object literal may only specify known properties, but 'payment_method_types' does not exist in type 'SessionCreateParams'. Did you mean to write 'payment_method_data'?",
      "Object literal may only specify known properties, and 'coupon' does not exist in type 'SubscriptionUpdateParams'.",
      "Object literal may only specify known properties, and 'trial_from_plan' does not exist in type 'SubscriptionData'.",
    ])
      expect(
        falloutShape({ code: message.includes('Did you') ? 'TS2561' : 'TS2353', message }).lane,
      ).toBe('request-rule');
  });

  it('gives widened enums to the type-only repair and API-version literals to the version rules', () => {
    expect(
      falloutShape({
        code: 'TS2322',
        message: `Type '"past_due" | "unpaid" | OtherString' is not assignable to type '"active" | "past_due"'.`,
      }),
    ).toEqual({ shape: 'widened-enum', lane: 'type-only' });
    expect(
      falloutShape({
        code: 'TS2322',
        message: `Type 'Status' is not assignable to type '"active" | "trialing"'.`,
      }).lane,
    ).toBe('type-only');
    expect(
      falloutShape({
        code: 'TS2322',
        message: `Type '"2024-06-20"' is not assignable to type '"2026-09-30.endive"'.`,
      }),
    ).toEqual({ shape: 'api-version-literal', lane: 'api-version' });
    // brendansudol/punchlines-ai (local reproduction): Price.Recurring.Interval is now open.
    expect(
      falloutShape({
        code: 'TS2322',
        message: `Type 'Interval | null' is not assignable to type '"day" | "week" | "month" | "year" | null'.`,
      }).lane,
    ).toBe('type-only');
  });

  it('tells a widened null and an expandable field from a changed type', () => {
    expect(
      falloutShape({
        code: 'TS2345',
        message:
          "Argument of type 'string | Customer | DeletedCustomer' is not assignable to parameter of type 'string'.",
      }).shape,
    ).toBe('expandable-field');
    expect(
      falloutShape({
        code: 'TS2345',
        message:
          "Argument of type 'string | undefined' is not assignable to parameter of type 'string'.",
      }).shape,
    ).toBe('widened-null');
    expect(
      falloutShape({ code: 'TS18047', message: "'price.unit_amount' is possibly 'null'." }).shape,
    ).toBe('widened-null');
    // Drago-03/Neural-Nexus: nullable members inside, but the target is optional too.
    expect(
      falloutShape({
        code: 'TS2322',
        message:
          "Type '{ id: string; name: string | null; amount: number; quantity: number | null; }[] | undefined' is not assignable to type 'LineItem[] | undefined'.",
      }).shape,
    ).toBe('changed-type');
  });

  it('counts errors that follow from another as cascades', () => {
    for (const [code, message] of [
      ['TS2339', "Property 'data' does not exist on type 'never'."],
      ['TS2345', "Argument of type 'unknown' is not assignable to parameter of type 'object'."],
      ['TS7006', "Parameter 'invoice' implicitly has an 'any' type."],
      ['TS2339', "Property 'id' does not exist on type '{}'."],
    ])
      expect(falloutShape({ code, message }).lane).toBe('cascade');
  });
});

const run = promisify(execFile);

it('ranks shapes by rows from the oracle, or from a regressed patch that upgraded stripe-node', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'upgrade-fallout-'));
  const subscription = "Property 'subscription' does not exist on type 'Invoice'.";
  const rows = [
    {
      repo: 'a/one',
      workflow: {
        validation: 'passed',
        typeOracle: {
          patched: {
            status: 'compared',
            introduced: [
              { file: 'a.ts', line: 1, column: 1, code: 'TS2339', message: subscription },
            ],
          },
        },
      },
    },
    {
      repo: 'b/two',
      workflow: {
        validation: 'regression',
        sdkUpgrade: { from: '14.25.0', to: '23.0.0' },
        typeErrors: { introduced: [`b.js TS2339 ${subscription}`] },
      },
    },
    // A pin moved without the stripe-node upgrade is another lane's failure.
    {
      repo: 'c/three',
      workflow: {
        validation: 'regression',
        sdkUpgrade: { skipped: 'Only single-project pnpm lockfile version 6 files are upgraded.' },
        typeErrors: { introduced: [`c.ts TS2339 ${subscription}`] },
      },
    },
  ];
  await writeFile(join(dir, 'results.json'), JSON.stringify(rows));
  try {
    const { stdout } = await run(process.execPath, [
      'scripts/upgrade-fallout.mjs',
      join(dir, 'results.json'),
      '--json',
    ]);
    expect(JSON.parse(stdout)).toEqual([
      {
        lane: 'behaviour',
        shape: 'removed-field',
        member: 'Invoice.subscription',
        errors: 2,
        javascript: 1,
        repos: ['a/one', 'b/two'],
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The repair itself waits for lane T (docs/UPGRADE-FALLOUT.md, "Build order"). Each case below is
// part of its acceptance and is written out there.
describe('upgrade-fallout repair (after lane T)', () => {
  it.todo('edits only statements that hold an error the type oracle attributes to the upgrade');
  it.todo('refuses an edit that does not follow the documented replacement for its shape');
  it.todo('never targets a removed request parameter, an API-version literal or a widened enum');
  it.todo(
    'validates only with zero new oracle errors, passing checks and grade A from Stripe test mode',
  );
  it.todo('keeps a behaviour repair that passes its checks without Stripe proof as [Needs review]');
  it.todo('keeps a repair as [Needs review] when a behaviour test fails on the original code');
  it.todo('keeps a repair as [Needs review] when Stripe returns an error on the patched side only');
  it.todo('stops when a changed line is in a webhook handler that no behaviour test reaches');
  it.todo('records the first attempt type errors on an api-version-kept report');
});
