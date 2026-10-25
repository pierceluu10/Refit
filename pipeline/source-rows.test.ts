import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { STRIPE } from './providers.ts';
import type { Repository } from './types.ts';

// endive removes `price` from invoice line items; same-named reads Refit cannot trace are review.
const change = { id: 'line-item-price', schema: 'line_item', property: 'price', pointer: '/price' };
function reviewLines(files: Record<string, string>) {
  const repository: Repository = {
    root: '/rows-fixture',
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  return analyzeRepository(repository, [change], STRIPE)
    .findings.filter((finding) => finding.confidence === 'review')
    .map((finding) => `${finding.file}:${finding.line}`);
}

// BrunoZielinski/next13-lms-platform lib/db.ts (the LMS course family).
const lmsClient = `import { PrismaClient } from '@prisma/client'

declare global {
  var prisma: PrismaClient | undefined
}

export const db = globalThis.prisma || new PrismaClient()

if (process.env.NODE_ENV !== 'production') globalThis.prisma = db`;
// app/api/courses/[courseId]/checkout/route.ts, trimmed to the reads.
const lmsCheckout = `import Stripe from 'stripe'
import { NextResponse } from 'next/server'
import { db } from '../lib/db'
const stripe = new Stripe('key', { apiVersion: '2023-10-16' })
export async function POST(req: Request, { params }: { params: { courseId: string } }) {
  const course = await db.course.findUnique({
    where: {
      id: params.courseId,
      isPublished: true,
    },
  })
  if (!course) {
    return new NextResponse('Not Found', { status: 404 })
  }
  const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    {
      quantity: 1,
      price_data: {
        currency: 'usd',
        product_data: { name: course.title, description: course.description! },
        unit_amount: Math.round(course.price! * 100),
      },
    },
  ]
  return stripe.checkout.sessions.create({ mode: 'payment', line_items, success_url: 'x' })
}`;

it('proves reads on a row a Prisma client returns are not Stripe reads (BrunoZielinski/next13-lms-platform)', () => {
  expect(
    reviewLines({
      'lib/db.ts': lmsClient,
      'api/checkout.ts': lmsCheckout,
      // A shorthand of the same name in another scope places a different value.
      'components/course.tsx': `export const props = (course: unknown) => ({ course });`,
    }),
  ).toEqual([]);
});

// gazamba/nextjs-saas-ecommerce-admin lib/prismadb.ts and app/api/[storeId]/checkout/route.ts.
const adminClient = `import { PrismaClient } from "@prisma/client";

declare global {
  var prisma: PrismaClient | undefined;
}

const prismadb = globalThis.prisma || new PrismaClient();
if (process.env.NODE_ENV === "production") globalThis.prisma = prismadb;

export default prismadb;`;
const adminCheckout = `import Stripe from "stripe";
import { NextResponse } from "next/server";
import prismadb from "../lib/prismadb";
const stripe = new Stripe("key", { apiVersion: "2022-11-15" });
export async function POST(req: Request) {
  const { productIds } = await req.json();
  const products = await prismadb.product.findMany({
    where: {
      id: {
        in: productIds,
      },
    },
  });
  const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
  products.forEach((product) => {
    line_items.push({
      quantity: 1,
      price_data: {
        currency: "USD",
        product_data: {
          name: product.name,
        },
        unit_amount: Math.round(product.price.toNumber() * 100),
      },
    });
  });
  for (const product of products) console.log(product.price);
  const first = products.find((product) => product.id === productIds[0]);
  console.log(first?.price, products[0].price, products.length);
  return stripe.checkout.sessions.create({ mode: "payment", line_items, success_url: "x" });
}`;

it('proves reads on the rows of a findMany list are not Stripe reads (gazamba/nextjs-saas-ecommerce-admin)', () => {
  expect(reviewLines({ 'lib/prismadb.ts': adminClient, 'api/checkout.ts': adminCheckout })).toEqual(
    [],
  );
});

// bhaveshchhimwal/PopIn server/prismaClient.js and the reads in its controllers.
it('proves reads on rows from a default-imported client and its transaction client (bhaveshchhimwal/PopIn)', () => {
  expect(
    reviewLines({
      'server/prismaClient.js': `import "dotenv/config";
import pkg from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const { PrismaClient } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({
  adapter,
});

export default prisma;`,
      'server/controllers/payments.js': `import Stripe from "stripe";
import prisma from "../prismaClient.js";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2022-11-15" });
export const createCheckoutSession = async (req, res) => {
  const { eventId } = req.body;
  const event = await prisma.event.findUnique({
    where: { id: eventId },
  });
  if (!event) {
    return res.status(404).json({ message: "Event not found" });
  }
  const unitAmount = Math.round(Number(event.price) * 100);
  return stripe.checkout.sessions.create({ mode: "payment", success_url: "x", line_items: [{ price_data: { currency: "inr", unit_amount: unitAmount, product_data: { name: event.title } }, quantity: 1 }] });
};
export const fulfil = async (eventId, qty) =>
  prisma.$transaction(async (tx) => {
    const ev = await tx.event.findUnique({
      where: { id: eventId },
    });
    return tx.ticket.create({ data: { eventName: ev.title, unitPrice: ev.price, totalPrice: ev.price * qty } });
  });`,
    }),
  ).toEqual([]);
});

// Each shape below can put a Stripe object where the last line reads `.price`, or leaves the client
// unproven: the read stays for review.
it.each([
  ['a row merged with another value', 'Object.assign(course, item);'],
  ['a row passed to a function', 'fill(course);'],
  ['a row placed in another value', 'fill({ course });'],
  ['the client given middleware', 'db.$use(async (params, next) => item);'],
  ['the client passed to a function', 'fill(db);'],
  ['the client cache written with another value', 'globalThis.prisma = item;'],
])('keeps row reads for review when %s', (_name, write) => {
  const source = `import { db } from './db';
declare const item: any;
declare function fill(value: unknown): void;
export async function read(id: string) {
  const course = await db.course.findUnique({ where: { id } });
  ${write}
  return course.price;
}`;
  expect(
    reviewLines({ 'lib/db.ts': lmsClient, 'lib/stripe.ts': `${stripeClient}\n${source}` }),
  ).toContain('lib/stripe.ts:9');
});

const stripeClient = `import Stripe from 'stripe';\nexport const stripe = new Stripe('key', { apiVersion: '2023-08-16' });`;
it('clears the same fixture when nothing else touches the row, its list or the client', () => {
  const source = `import { db } from './db';
export async function read(id: string) {
  const course = await db.course.findUnique({ where: { id } });
  const rows = await db.course.findMany();
  return [course.price, rows[0].price, rows.find((row) => row.id === id)?.price];
}`;
  expect(
    reviewLines({ 'lib/db.ts': lmsClient, 'lib/stripe.ts': `${stripeClient}\n${source}` }),
  ).toEqual([]);
});
it.each([
  [
    'a mutable row',
    'let course = await db.course.findUnique({ where: { id } });\nreturn course.price;',
  ],
  ['a raw query', 'const course = await db.$queryRaw`SELECT 1`;\nreturn course.price;'],
  [
    'a query result that is not awaited',
    'const course = db.course.findUnique({ where: { id } });\nreturn (course as any).price;',
  ],
  [
    'a property of a row (a JSON column can hold a Stripe object)',
    'const order = await db.order.findUnique({ where: { id } });\nreturn order.stripeLine.price;',
  ],
  [
    'a row list filled with another value',
    'const rows = await db.course.findMany();\nrows.push(item);\nreturn rows[0].price;',
  ],
  [
    'a row list copied by filter',
    'const rows = await db.course.findMany();\nconst kept = rows.filter((row) => row.id);\nObject.assign(kept[0], item);\nreturn rows[0].price;',
  ],
  [
    'a callback that returns the row',
    'const rows = await db.course.findMany();\nfill(rows.map((row) => row));\nreturn rows[0].price;',
  ],
  [
    'a row from a list passed on',
    'const rows = await db.course.findMany();\nfill(rows.find((row) => row.id === id));\nreturn rows[0].price;',
  ],
  ['a parameter of the same name', 'return ((course: any) => course.price)(item);'],
  ['a line read from a received invoice', 'return (item as any).lines.data[0].price;'],
])('keeps the read for review on %s', (_name, body) => {
  const source = `import { db } from './db';
declare const item: any;
declare function fill(value: unknown): void;
export async function read(id: string) {
  ${body}
}`;
  expect(
    reviewLines({ 'lib/db.ts': lmsClient, 'lib/stripe.ts': `${stripeClient}\n${source}` }).length,
  ).toBeGreaterThan(0);
});

it.each([
  [
    'a PrismaClient that is not the package',
    lmsClient.replace("from '@prisma/client'", "from './fake-prisma'"),
  ],
  [
    'a client cache another write sets (jenish1559/mediaspotV2)',
    `import { PrismaClient } from "@prisma/client";\n\nglobalThis.prisma = PrismaClient | undefined;\n\nexport const db = globalThis.prisma || new PrismaClient();\n\nif(process.env.NODE_ENV !== "production") globalThis.prisma = db;`,
  ],
  [
    'an extended client',
    `import { PrismaClient } from '@prisma/client'\nexport const db = new PrismaClient().$extends({})`,
  ],
])('keeps row reads for review with %s', (_name, client) => {
  expect(reviewLines({ 'lib/db.ts': client, 'api/checkout.ts': lmsCheckout })).toContain(
    'api/checkout.ts:21',
  );
});

it('keeps row reads for review when an import of the client name does not resolve', () => {
  expect(
    reviewLines({
      'lib/db.ts': lmsClient,
      'api/checkout.ts': lmsCheckout,
      'lib/other.ts': `import { db } from '@/somewhere/db';\ndb.$use(async () => ({}));`,
    }),
  ).toContain('api/checkout.ts:21');
});

// TechWithEmmaYT/Social-X-Clone-Course lib/prismadb.ts and app/api/webhook/route.ts: the model
// accessor `prisma.subscription` was reported as a removed `invoiceitem.subscription` read.
const socialClient = `import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma = globalForPrisma.prisma || new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;`;
const socialWebhook = `import Stripe from "stripe";
import { prisma } from "../lib/prismadb";
const stripe = new Stripe("key", { apiVersion: "2023-10-16" });
export async function POST(session: Stripe.Checkout.Session) {
  const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
  await prisma.subscription.create({
    data: {
      stripeSubscriptionId: subscription.id,
      stripePriceId: subscription.items.data[0].price.id,
    },
  });
}`;
const subscriptionChange = {
  id: 'invoiceitem-subscription',
  schema: 'invoiceitem',
  property: 'subscription',
  pointer: '/subscription',
};
function subscriptionReviews(files: Record<string, string>) {
  const repository: Repository = {
    root: '/rows-fixture',
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  return analyzeRepository(repository, [subscriptionChange], STRIPE)
    .findings.filter((finding) => finding.confidence === 'review')
    .map((finding) => `${finding.file}:${finding.line}`);
}

it('proves a Prisma model accessor is not a Stripe read (TechWithEmmaYT/Social-X-Clone-Course)', () => {
  expect(
    subscriptionReviews({ 'lib/prismadb.ts': socialClient, 'api/webhook.ts': socialWebhook }),
  ).toEqual([]);
});

it('keeps the accessor for review when the client is passed to a library (PrismaAdapter)', () => {
  expect(
    subscriptionReviews({
      'lib/prismadb.ts': socialClient,
      'api/webhook.ts': socialWebhook,
      'lib/auth.ts': `import { PrismaAdapter } from "@next-auth/prisma-adapter";\nimport { prisma } from "./prismadb";\nexport const adapter = PrismaAdapter(prisma);`,
    }),
  ).toContain('api/webhook.ts:6');
});

it('keeps a same-named read on a Stripe value for review beside a proven client', () => {
  expect(
    subscriptionReviews({
      'lib/prismadb.ts': socialClient,
      'api/webhook.ts': `${socialWebhook}\nexport const read = (line: any) => line.subscription;`,
    }),
  ).toEqual(['api/webhook.ts:13']);
});

it('keeps the accessor for review when the global holder caches another value', () => {
  expect(
    subscriptionReviews({
      'lib/prismadb.ts': `${socialClient}\ndeclare const item: any;\nglobalForPrisma.prisma = item;`,
      'api/webhook.ts': socialWebhook,
    }),
  ).toContain('api/webhook.ts:6');
});

// krishvsoni/Scrimble app/lib/db.ts, Prisma's documented Next.js singleton.
it('proves a client made by a singleton factory (krishvsoni/Scrimble)', () => {
  const client = `import { PrismaClient } from "@prisma/client";

const prismaClientSingleton = () => {
  return new PrismaClient();
};

declare global {
  var prisma: undefined | ReturnType<typeof prismaClientSingleton>;
}

const prisma = globalThis.prisma ?? prismaClientSingleton();

export default prisma;

if (process.env.NODE_ENV !== "production") globalThis.prisma = prisma;`;
  const webhook = socialWebhook.replace(
    'import { prisma } from "../lib/prismadb";',
    'import prisma from "../lib/prismadb";',
  );
  expect(subscriptionReviews({ 'lib/prismadb.ts': client, 'api/webhook.ts': webhook })).toEqual([]);
  const extended = client.replace(
    'return new PrismaClient();',
    'return new PrismaClient().$extends({});',
  );
  expect(subscriptionReviews({ 'lib/prismadb.ts': extended, 'api/webhook.ts': webhook })).toContain(
    'api/webhook.ts:6',
  );
});

// kyyril/saas-noteapp lib/db.ts types the global with an ambient declaration.
it('proves a client cached on a global typed by declare const (kyyril/saas-noteapp)', () => {
  const client = `import { PrismaClient } from "@prisma/client";

const prismaClientSingleton = () => {
  return new PrismaClient();
};

declare const globalThis: {
  prismaGlobal: ReturnType<typeof prismaClientSingleton>;
} & typeof global;

const prisma = globalThis.prismaGlobal ?? prismaClientSingleton();

export default prisma;

if (process.env.NODE_ENV !== "production") globalThis.prismaGlobal = prisma;`;
  const webhook = socialWebhook.replace(
    'import { prisma } from "../lib/prismadb";',
    'import prisma from "../lib/prismadb";',
  );
  expect(subscriptionReviews({ 'lib/prismadb.ts': client, 'api/webhook.ts': webhook })).toEqual([]);
  const shadowed = client.replace(
    'declare const globalThis: {',
    'const globalThis: any = {}; type Unused = {',
  );
  expect(subscriptionReviews({ 'lib/prismadb.ts': shadowed, 'api/webhook.ts': webhook })).toContain(
    'api/webhook.ts:6',
  );
});
