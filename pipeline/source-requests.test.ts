import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { STRIPE } from './providers.ts';
import type { Repository } from './types.ts';

// endive removes `price` and `type` from invoice line items, `discount` and `subscription` from
// invoices and `unit_amount` from invoice items;
// same-named reads Refit cannot trace are review.
const changes = [
  { id: 'line-item-price', schema: 'line_item', property: 'price', pointer: '/price' },
  { id: 'line-item-type', schema: 'line_item', property: 'type', pointer: '/type' },
  { id: 'invoice-discount', schema: 'invoice', property: 'discount', pointer: '/discount' },
  { id: 'invoice-subscription', schema: 'invoice', property: 'subscription', pointer: '/x' },
  { id: 'invoiceitem-unit-amount', schema: 'invoiceitem', property: 'unit_amount', pointer: '/y' },
];
function reviewLines(files: Record<string, string>) {
  const repository: Repository = {
    root: '/requests-fixture',
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  return analyzeRepository(repository, changes, STRIPE)
    .findings.filter((finding) => finding.confidence === 'review')
    .map((finding) => `${finding.file}:${finding.line}`);
}

// Amansingh0807/GenForm app/api/stripe/checkout-session/route.ts, trimmed to the reads.
const nextRoute = `import Stripe from "stripe";
import { NextResponse } from "next/server";
const stripe = new Stripe("key", { apiVersion: "2023-10-16" });
export async function POST(req: Request) {
  const { price, userId, plan } = await req.json();
  if (!userId) {
    return NextResponse.json({ error: "User not found" }, { status: 400 });
  }
  const session = await stripe.checkout.sessions.create({
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: price * 100,
          product_data: { name: \`You are choosing \${plan} plan\` },
        },
        quantity: 1,
      },
    ],
    mode: "payment",
    success_url: "x",
  });
  return NextResponse.json({ id: session.id });
}`;

it('proves what a Next.js route handler parses from its request is not a Stripe object (Amansingh0807/GenForm)', () => {
  expect(reviewLines({ 'app/api/stripe/checkout-session/route.ts': nextRoute })).toEqual([]);
});

// dalemoncayo/express-stripe app.js and gjlander/backend-lazypress routes/stripeRoutes.js.
it('proves what an Express route handler reads from req.body is not a Stripe object (dalemoncayo/express-stripe, gjlander/backend-lazypress)', () => {
  expect(
    reviewLines({
      'app.js': `const express = require('express');
const stripe = require('stripe')('key');
const app = express();
app.use(express.json());
app.post('/create-checkout-session', async (req, res) => {
  const { productName, price } = req.body;
  const session = await stripe.checkout.sessions.create({
    line_items: [{ price_data: { currency: 'usd', product_data: { name: productName || 'Sample Product' }, unit_amount: price || 1000 }, quantity: 1 }],
    mode: 'payment',
  });
  res.json({ id: session.id });
});`,
      'routes/stripeRoutes.js': `import express from "express";
import stripeModule from "stripe";
const stripe = stripeModule(process.env.SECRET_KEY);
const stripeRouter = express.Router();
stripeRouter.post("/api/create-checkout-session", async (req, res) => {
  const { price } = req.body;
  const session = await stripe.checkout.sessions.create({
    line_items: [{ price_data: { currency: "eur", unit_amount: price * 100 }, quantity: 1 }],
  });
  res.json({ url: session.url });
});
export default stripeRouter;`,
    }),
  ).toEqual([]);
});

// Anuradha-Herath/Pinnacle app/api/orders/route.tsx and abressiddique/AbresStore-Admin
// app/api/checkout/route.ts: properties and elements of the body are the sender's data too.
it('proves properties and elements of a parsed body (Anuradha-Herath/Pinnacle, abressiddique/AbresStore-Admin)', () => {
  expect(
    reviewLines({
      'app/api/orders/route.tsx': `import Stripe from "stripe";
const stripe = new Stripe("key", { apiVersion: "2023-10-16" });
export async function POST(request: Request) {
  const requestBody = await request.json();
  if (!requestBody) return new Response("no body", { status: 400 });
  const subtotal = requestBody.cart.reduce(
    (sum: number, item: any) => sum + item.price * item.quantity,
    0
  );
  if (requestBody.coupon?.code && requestBody.coupon?.discount > 0) {
    const totalDiscount = subtotal * (requestBody.coupon.discount / 100);
    console.log(totalDiscount);
  }
  return stripe.checkout.sessions.create({ mode: "payment", success_url: "x" });
}`,
      'app/api/checkout/route.ts': `import Stripe from "stripe";
const stripe = new Stripe("key", { apiVersion: "2023-10-16" });
export async function POST(req: Request) {
  const { cartItems, customer } = await req.json();
  const session = await stripe.checkout.sessions.create({
    line_items: cartItems.map((cartItem: any) => ({
      price_data: {
        currency: "inr",
        product_data: { name: cartItem.item.title, metadata: { productId: cartItem.item._id } },
        unit_amount: cartItem.item.price * 100,
      },
      quantity: cartItem.quantity,
    })),
    client_reference_id: customer.clerkId,
  });
  return Response.json(session);
}`,
    }),
  ).toEqual([]);
});

// Each shape below can put a Stripe object where the read sits, or is not a request handler's
// body: the read stays for review.
it.each([
  [
    'the handler verifies a Stripe signature',
    `const sig = req.headers.get('stripe-signature');`,
    '',
  ],
  ['the body is assigned into', 'body.cart = invoice.lines.data;', ''],
  ['the list on the way is passed', 'fill(body.cart);', ''],
  ['the list on the way is changed', 'body.cart.push(invoice.lines.data[0]);', ''],
  ['the element on the way is placed in another value', 'const copy = { item: body.cart[0] };', ''],
  ['the body is spread', 'const copy = { ...body };', ''],
  ['the body is held by a mutable binding', 'let other = body;', ''],
])('keeps body reads for review when %s', (_name, write) => {
  const source = `import Stripe from 'stripe';
declare const invoice: Stripe.Invoice;
declare function fill(value: unknown): void;
export async function POST(req: Request) {
  const body = await req.json();
  ${write}
  return body.cart[0].price;
}`;
  expect(reviewLines({ 'app/api/route.ts': source })).toContain('app/api/route.ts:7');
});

it('clears the same fixture when nothing writes, passes or places the values on the way', () => {
  const source = `import Stripe from 'stripe';
declare const invoice: Stripe.Invoice;
declare function fill(value: unknown): void;
export async function POST(req: Request) {
  const body = await req.json();
  fill(body.cart[0].price.id);
  return body.cart[0].price;
}`;
  expect(reviewLines({ 'app/api/route.ts': source })).toEqual([]);
});

it.each([
  [
    'a function that is not a route export',
    'export async function handle(req: Request) {',
    'app/api/route.ts',
  ],
  [
    'a route export outside a route file',
    'export async function POST(req: Request) {',
    'lib/post.ts',
  ],
  [
    'a route export that is not an HTTP method',
    'export async function fetchPrice(req: Request) {',
    'app/api/route.ts',
  ],
])('keeps reads on a parsed JSON value for review in %s', (_name, header, file) => {
  const source = `import Stripe from 'stripe';
${header}
  const { price } = await req.json();
  return price;
}`;
  expect(reviewLines({ [file]: source })).toContain(`${file}:3`);
});

it('keeps a read through `data` for review: an unsigned Stripe event carries its object there', () => {
  const source = `const express = require('express');
const stripe = require('stripe')('key');
const app = express();
app.post('/hook', async (req, res) => {
  const event = req.body;
  const invoice = event.data.object;
  console.log(event.type, invoice.subscription);
});`;
  expect(reviewLines({ 'server.js': source })).toEqual(['server.js:7']);
});

it('keeps Express reads for review when middleware may write req.body or the router is not express', () => {
  const route = `app.post('/checkout', (req, res) => {
  const { price } = req.body;
  res.json({ price });
});`;
  expect(
    reviewLines({
      'server.js': `const express = require('express');
require('stripe');
const app = express();
app.use((req, res, next) => { req.body = globalThis.event; next(); });
${route}`,
    }),
  ).toEqual(['server.js:6']);
  expect(
    reviewLines({
      'server.js': `const app = require('./app');
require('stripe');
${route}`,
    }),
  ).toEqual(['server.js:4']);
});

// bhaveshchhimwal/PopIn server/controllers/payments.js and server/routes: a named controller
// that every reference registers as an Express route.
it('proves req.body in a named controller only registered as a route (bhaveshchhimwal/PopIn)', () => {
  const controller = `import Stripe from "stripe";
export const createCheckoutSession = async (req, res) => {
  const { eventId, price } = req.body;
  res.json({ eventId, price });
};`;
  const routes = (extra: string) => `import express from "express";
import { createCheckoutSession } from "../controllers/payments.js";
const router = express.Router();
router.post("/create-checkout-session", createCheckoutSession);
${extra}
export default router;`;
  expect(
    reviewLines({
      'server/controllers/payments.js': controller,
      'server/routes/payments.js': routes(''),
    }),
  ).toEqual([]);
  expect(
    reviewLines({
      'server/controllers/payments.js': controller,
      'server/routes/payments.js': routes('createCheckoutSession({ body: globalThis.x }, {});'),
    }),
  ).toEqual(['server/controllers/payments.js:3']);
});

// Deepanshu0211/Rocart api/server.js and api/create-payment-intent.js: the list is read in place,
// then handed to Stripe. Handing it on afterwards cannot change what was read.
it('proves reads that every run evaluates before the body is handed on (Deepanshu0211/Rocart)', () => {
  const handler = `const { lineItems, customerEmail } = req.body;
  if (!lineItems || lineItems.length === 0) {
    return res.status(400).json({ error: "Line items are required" });
  }
  const totalAmount = lineItems.reduce((sum, item) => {
    return sum + (item.price_data.unit_amount * item.quantity) / 100;
  }, 0);
  const session = await stripe.checkout.sessions.create({ line_items: lineItems, customer_email: customerEmail });
  res.json({ id: session.id, totalAmount });`;
  expect(
    reviewLines({
      'api/server.js': `import express from "express";
import Stripe from "stripe";
const stripe = new Stripe("key");
const app = express();
app.post("/api/create-payment-intent", async (req, res) => {
  ${handler}
});`,
      'api/create-payment-intent.js': `import Stripe from "stripe";
const stripe = new Stripe("key");
export default async function createCheckoutSessionHandler(req, res) {
  ${handler}
}`,
    }),
  ).toEqual([]);
});

it.each([
  [
    'in a loop that also reads',
    'for (const step of [1, 2]) {\n  total += body.cart[0].price.unit;\n  fill(body.cart);\n}',
  ],
  [
    'in a callback that also reads',
    'body.cart.forEach((item) => {\n  total += item.price.unit;\n  fill(body.cart);\n});',
  ],
  [
    'in a function declaration called first',
    'later();\ntotal += body.cart[0].price.unit;\nfunction later() { fill(body.cart); }',
  ],
  [
    'in a closure run later',
    'const read = () => body.cart[0].price.unit;\nfill(body.cart);\ntotal += read();',
  ],
])('keeps a read for review when the escape after it may run first: %s', (_name, code) => {
  const source = `declare function fill(value: unknown): void;
export async function POST(req: Request) {
  const body = await req.json();
  let total = 0;
  ${code}
  return Response.json({ total });
}`;
  const lines = reviewLines({ 'app/route.ts': `import Stripe from 'stripe';\n${source}` });
  expect(lines.length).toBeGreaterThan(0);
});
