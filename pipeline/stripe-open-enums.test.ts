import { expect, it } from 'vitest';
import {
  crossesOpenEnums,
  keepsPartialRestore,
  openEnumRepair,
  restorableOpenEnumErrors,
} from './stripe-open-enums.ts';

// Shapes from the Supabase subscription starter that stripe-node 23 stops compiling.
const types = `import Stripe from 'stripe';
export interface UserDetails {
  payment_method?: Stripe.PaymentMethod[Stripe.PaymentMethod.Type];
}
export interface Price {
  id: string;
  type?: Stripe.Price.Type;
  interval?: Stripe.Price.Recurring.Interval;
}
`;
const admin = `import Stripe from 'stripe';
import { Price } from './types';
const upsertPriceRecord = async (price: Stripe.Price) => {
  const priceData: Price = {
    id: price.id,
    type: price.type,
    interval: price.recurring?.interval,
  };
  const { error } = await supabaseAdmin.from('prices').upsert([priceData]);
};
const copyBillingDetails = async (payment_method: Stripe.PaymentMethod) => {
  await save({ payment_method: { ...payment_method[payment_method.type] } });
};
const insert = (price: Stripe.Price) => ({
  type: price.type,
  interval: price.recurring?.interval ?? null,
});
`;
function at(content: string, file: string, search: string, code: string, offset = 0) {
  const index = content.indexOf(search) + offset;
  const before = content.slice(0, index).split('\n');
  return { file, line: before.length, column: before.at(-1)!.length + 1, code };
}
const files = [
  { path: 'types.ts', content: types },
  { path: 'libs/admin.ts', content: admin },
];

it('restores the known literals at each reported open-enum error', () => {
  const repaired = openEnumRepair(files, [
    at(types, 'types.ts', 'Stripe.PaymentMethod.Type]', 'TS2538'),
    at(admin, 'libs/admin.ts', "supabaseAdmin.from('prices')", 'TS2769'),
    at(admin, 'libs/admin.ts', 'payment_method[payment_method.type]', 'TS7053'),
    at(
      admin,
      'libs/admin.ts',
      'type: price.type,\n  interval: price.recurring?.interval ??',
      'TS2322',
    ),
    at(admin, 'libs/admin.ts', 'interval: price.recurring?.interval ??', 'TS2322'),
  ]);
  const result = Object.fromEntries(repaired!.map((file) => [file.path, file.content]));
  expect(result['types.ts']).toContain(
    'payment_method?: Stripe.PaymentMethod[Extract<Stripe.PaymentMethod.Type, keyof Stripe.PaymentMethod>];',
  );
  expect(result['types.ts']).toContain(
    "type?: Extract<Stripe.Price.Type, 'one_time' | 'recurring'>;",
  );
  expect(result['types.ts']).toContain(
    "interval?: Extract<Stripe.Price.Recurring.Interval, 'day' | 'month' | 'week' | 'year'>;",
  );
  expect(result['libs/admin.ts']).toContain(
    "    type: (price.type as Extract<Stripe.Price.Type, 'one_time' | 'recurring'>),\n    interval: (price.recurring?.interval as Extract<Stripe.Price.Recurring.Interval, 'day' | 'month' | 'week' | 'year'> | undefined),\n  };",
  );
  expect(result['libs/admin.ts']).toContain(
    '...payment_method[payment_method.type as Extract<Stripe.PaymentMethod.Type, keyof Stripe.PaymentMethod>]',
  );
  expect(result['libs/admin.ts']).toContain(
    "  interval: (price.recurring?.interval as Extract<Stripe.Price.Recurring.Interval, 'day' | 'month' | 'week' | 'year'> | undefined) ?? null,\n});",
  );
});

it('repairs nothing when any introduced error is outside the open-enum shapes', () => {
  expect(
    openEnumRepair(files, [
      at(types, 'types.ts', 'Stripe.PaymentMethod.Type]', 'TS2538'),
      at(admin, 'libs/admin.ts', 'id: price.id', 'TS2551'),
    ]),
  ).toBeUndefined();
  expect(openEnumRepair(files, [at(admin, 'libs/admin.ts', 'id: price.id', 'TS2322')])).toBe(
    undefined,
  );
  expect(openEnumRepair(files, [])).toBeUndefined();
});

it('picks the open-enum errors out of a mix, so an AI repair gets only the rest', () => {
  const index = at(types, 'types.ts', 'Stripe.PaymentMethod.Type]', 'TS2538');
  const element = at(admin, 'libs/admin.ts', 'payment_method[payment_method.type]', 'TS7053');
  // Errors of any other shape stay with the model.
  const other = at(admin, 'libs/admin.ts', 'id: price.id', 'TS2551');
  const unrelated = at(admin, 'libs/admin.ts', 'id: price.id', 'TS2322');
  const restorable = restorableOpenEnumErrors(files, [index, other, element, unrelated]);
  expect(restorable).toEqual([index, element]);
  const repaired = Object.fromEntries(
    openEnumRepair(files, restorable)!.map((file) => [file.path, file.content]),
  );
  expect(repaired['types.ts']).toContain(
    'Stripe.PaymentMethod[Extract<Stripe.PaymentMethod.Type, keyof Stripe.PaymentMethod>]',
  );
  expect(repaired['libs/admin.ts']).toContain('    id: price.id,');
  expect(restorableOpenEnumErrors(files, [other])).toEqual([]);
});

it('keeps a partial restore only when the checks fail on nothing but the errors it left', () => {
  const error = (key: string) => ({ key });
  const introduced = [error('types.ts TS2538'), error('route.ts TS2353'), error('a.ts TS2551')];
  const restored = [error('types.ts TS2538')];
  expect(keepsPartialRestore(introduced, restored, [error('route.ts TS2353')])).toBe(true);
  expect(
    keepsPartialRestore(introduced, restored, [error('route.ts TS2353'), error('a.ts TS2551')]),
  ).toBe(true);
  // A restored error that stays, or a new one, means the restore did not do what it claims.
  expect(
    keepsPartialRestore(introduced, restored, [error('types.ts TS2538'), error('a.ts TS2551')]),
  ).toBe(false);
  expect(keepsPartialRestore(introduced, restored, [error('b.ts TS2322')])).toBe(false);
  // A failure with no type errors is something else; a full restore is kept only if it passes.
  expect(keepsPartialRestore(introduced, restored, [])).toBe(false);
  expect(keepsPartialRestore(restored, restored, [error('types.ts TS2538')])).toBe(false);
});

it('applies only to an upgrade across stripe-node 22.4.0', () => {
  expect(crossesOpenEnums('18.5.0', '23.0.0')).toBe(true);
  expect(crossesOpenEnums('22.3.9', '22.4.0')).toBe(true);
  expect(crossesOpenEnums('22.4.0', '23.0.0')).toBe(false);
  expect(crossesOpenEnums('18.5.0', '22.3.0')).toBe(false);
});
