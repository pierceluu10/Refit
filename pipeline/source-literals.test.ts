import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { STRIPE } from './providers.ts';
import type { Repository } from './types.ts';

// endive removes `price` from invoice line items; same-named reads Refit cannot trace are review.
const change = { id: 'line-item-price', schema: 'line_item', property: 'price', pointer: '/price' };
function reviewLines(files: Record<string, string>) {
  const repository: Repository = {
    root: '/literal-fixture',
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  return analyzeRepository(repository, [change], STRIPE)
    .findings.filter((finding) => finding.confidence === 'review')
    .map((finding) => `${finding.file}:${finding.line}`);
}

// manu14357/smartdoc src/config/stripe.ts, the plan table of the quill PDF-chat starter family.
const plans = `export const PLANS = [
  {
    name: "Free",
    slug: "free",
    quota: 10,
    pagesPerPdf: 5,
    price: {
      amount: 0,
      priceIds: {
        test: "",
        production: "",
      },
    },
  },
  {
    name: "Pro",
    slug: "pro",
    quota: 50,
    pagesPerPdf: 25,
    price: {
      amount: 2,
      priceIds: {
        test: "price_1NuEwTA19umTXGu8MeS3hN8L",
        production: "",
      },
    },
  },
];`;
const client = `import Stripe from 'stripe';\nexport const stripe = new Stripe('key', { apiVersion: '2023-08-16' });`;

it('proves reads of a constant plan table are not Stripe reads (manu14357/smartdoc)', () => {
  expect(
    reviewLines({
      'config/stripe.ts': plans,
      'lib/stripe.ts': `${client}
import { PLANS } from '../config/stripe';
export function plan(dbUser: { stripePriceId: string }, isSubscribed: boolean) {
  return {
    ...PLANS[0],
    current: isSubscribed
      ? PLANS.find((plan) => plan.price.priceIds.test === dbUser.stripePriceId)
      : null,
  };
}
export async function checkout() {
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: PLANS.find((plan) => plan.name === "Pro")?.price.priceIds.test, quantity: 1 }],
  });
}`,
    }),
  ).toEqual([]);
});

it('proves reads through properties, indexes and for-of of constant objects (kondax-com/Bocker)', () => {
  expect(
    reviewLines({
      'constants.ts': `export const PLAN_MONTHLY_PRICES = { MICRO: 980, LITE: 1980 };
export const PLAN_DURATION_MONTHS = { YEARLY: 10 };
export const PLAN_YEARLY_PRICES = {
  MICRO: {
    price: PLAN_MONTHLY_PRICES.MICRO * PLAN_DURATION_MONTHS.YEARLY,
  },
  LITE: {
    price: PLAN_MONTHLY_PRICES.LITE * PLAN_DURATION_MONTHS.YEARLY,
  },
};
export const TIERS = [{ price: 1 }, { price: 2 }];`,
      'utils.ts': `${client}
import { PLAN_YEARLY_PRICES, TIERS } from './constants';
export const micro = { price: PLAN_YEARLY_PRICES.MICRO.price };
export const lite = PLAN_YEARLY_PRICES['LITE'].price;
export const first = TIERS[0].price;
export function total() {
  let sum = 0;
  for (const tier of TIERS) sum += tier.price;
  return sum + TIERS.filter((tier) => tier.price > 1).length;
}
const plan = { price: 3 };
export const own = plan.price;`,
    }),
  ).toEqual([]);
});

it.each([
  ['an element pushed into the table', 'PLANS.push(item);'],
  ['an element replaced by index', 'PLANS[0] = item;'],
  ['the table passed to a function', 'register(PLANS);'],
  ['the table placed in another value', 'export const all = [PLANS];'],
  ['a property of an element replaced', 'PLANS[0].price = item.price;'],
])('keeps plan reads for review when %s', (_name, write) => {
  expect(
    reviewLines({
      'config/stripe.ts': plans,
      'lib/stripe.ts': `${client}
import { PLANS } from '../config/stripe';
declare const item: any;
declare function register(value: unknown): void;
${write}
export const current = PLANS.find((plan) => plan.name === "Pro")?.price;`,
    }),
  ).toContain('lib/stripe.ts:7');
});

it.each([
  ['a mutable table', 'let'],
  ['a table with a spread element', 'const', '...extra, '],
])('keeps plan reads for review with %s', (_name, keyword, spread = '') => {
  expect(
    reviewLines({
      'lib/stripe.ts': `${client}
declare const extra: any[];
${keyword} TIERS = [${spread}{ price: 1 }];
export const first = TIERS.find((tier) => tier.price > 0)?.price;`,
    }),
  ).toEqual(['lib/stripe.ts:5', 'lib/stripe.ts:5']);
});

it.each([
  ['an object with a spread', 'const plan = { ...item };\nexport const read = plan.price;'],
  [
    'a parameter of an unknown array',
    'export const read = (items: any[]) => items.map((plan) => plan.price);',
  ],
  [
    'a mapped copy',
    'const TIERS = [{ price: 1 }];\nexport const read = TIERS.map(() => item)[0].price;',
  ],
  [
    'a reassigned callback parameter',
    'const TIERS = [{ price: 1 }];\nexport const read = TIERS.map((plan) => { plan = item; return plan.price; });',
  ],
  [
    'a property that is not an object literal',
    'const TABLE = { pro: item };\nexport const read = TABLE.pro.price;',
  ],
  [
    'a nested object changed through an alias',
    'const TABLE = { pro: { inner: { price: 1 } } };\nconst alias = TABLE.pro;\nalias.inner = item;\nexport const read = TABLE.pro.inner.price;',
  ],
  [
    'a received value',
    'export async function read(event: any) { return event.data.object.lines.data[0].price; }',
  ],
])('keeps reads for review on %s', (_name, source) => {
  expect(
    reviewLines({ 'lib/stripe.ts': `${client}\ndeclare const item: any;\n${source}` }).length,
  ).toBeGreaterThan(0);
});

// P5's review probes: each shape can put a Stripe object into the literal before the last line reads it.
it.each([
  [
    'an object filled by Object.assign',
    'const plan = {};\nObject.assign(plan, item);\nexport const read = plan.price;',
  ],
  [
    'an object passed to a function',
    'const plan = { price: 1 };\nfill(plan);\nexport const read = plan.price;',
  ],
  [
    'an object placed in another value',
    'const plan = { price: 1 };\nfill({ data: { plan } });\nexport const read = plan.price;',
  ],
  [
    'an element bound from find and filled',
    'const TIERS = [{ price: 1 }];\nconst picked = TIERS.find((tier) => tier.price > 0)!;\nObject.assign(picked, item);\nexport const read = TIERS.find((tier) => tier.price > 0)?.price;',
  ],
  [
    'an element from find passed to a function',
    'const TIERS = [{ price: 1 }];\nfill(TIERS.find((tier) => tier.price > 0));\nexport const read = TIERS.find((tier) => tier.price > 0)?.price;',
  ],
  [
    'a for-of element filled',
    'const TIERS = [{ price: 1 }];\nfor (const tier of TIERS) Object.assign(tier, item);\nexport const read = TIERS[0].price;',
  ],
  [
    'a forEach element filled',
    'const TIERS = [{ price: 1 }];\nTIERS.forEach((tier) => Object.assign(tier, item));\nexport const read = TIERS[0].price;',
  ],
  [
    'a copy of the elements bound and filled',
    'const TIERS = [{ price: 1 }];\nconst active = TIERS.filter((tier) => tier.price > 0);\nObject.assign(active[0], item);\nexport const read = TIERS[0].price;',
  ],
])('keeps the read for review on %s', (_name, source) => {
  const prefix = `${client}\ndeclare const item: any;\ndeclare function fill(value: unknown): void;\n`;
  const line = `${prefix}${source}`.split('\n').length;
  expect(reviewLines({ 'lib/stripe.ts': `${prefix}${source}` })).toContain(`lib/stripe.ts:${line}`);
});

it('keeps plan reads for review when an import of the same name cannot be resolved', () => {
  expect(
    reviewLines({
      'config/stripe.ts': `${client}\n${plans}\nexport const current = PLANS.find((plan) => plan.name === "Pro")?.price;`,
      'lib/sync.ts': `import { PLANS } from '@/config/stripe';\ndeclare const item: any;\nPLANS.push(item);`,
    }),
  ).toContain('config/stripe.ts:31');
});

// robharding/Quill src/lib/stripe.ts: the current plan is bound from `find` and spread into the result.
it('proves reads of a plan bound from find and spread into a copy (robharding/Quill)', () => {
  expect(
    reviewLines({
      'config/stripe.ts': plans,
      'lib/stripe.ts': `${client}
import { PLANS } from '../config/stripe';
export async function getUserSubscriptionPlan(dbUser: { stripePriceId: string }, isSubscribed: boolean) {
  const plan = isSubscribed
    ? PLANS.find((plan) => plan.price.priceIds.test === dbUser.stripePriceId)
    : null;
  return {
    ...plan,
    isSubscribed,
  };
}
export const price = PLANS.find((plan) => plan.name === "Pro")?.price.priceIds.test;`,
    }),
  ).toEqual([]);
});

it.each([
  ['passed to a function', 'fill(plan);'],
  ['placed in another value', 'fill([plan]);'],
  ['filled through Object.assign', 'Object.assign(plan!, item);'],
  ['written through a property', 'plan!.price = item.price;'],
])('keeps plan reads for review when the bound plan is %s', (_name, write) => {
  expect(
    reviewLines({
      'config/stripe.ts': plans,
      'lib/stripe.ts': `${client}
import { PLANS } from '../config/stripe';
declare const item: any;
declare function fill(value: unknown): void;
const plan = Math.random() > 0.5 ? PLANS.find((plan) => plan.slug === "pro") : null;
${write}
export const price = PLANS.find((plan) => plan.name === "Pro")?.price;`,
    }),
  ).toContain('lib/stripe.ts:8');
});

it('clears the bound-plan fixture when nothing else touches the plan', () => {
  expect(
    reviewLines({
      'config/stripe.ts': plans,
      'lib/stripe.ts': `${client}
import { PLANS } from '../config/stripe';
const plan = Math.random() > 0.5 ? PLANS.find((plan) => plan.slug === "pro") : null;
export const slug = plan?.slug;
export const price = PLANS.find((plan) => plan.name === "Pro")?.price;`,
    }),
  ).toEqual([]);
});
