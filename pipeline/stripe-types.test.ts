import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runPipeline } from './run.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const integer = { type: 'integer' };
const string = { type: 'string' };
const ref = (schema: string) => ({ $ref: `#/components/schemas/${schema}` });
const list = (schema: string) => ({
  type: 'object',
  properties: { object: string, data: { type: 'array', items: ref(schema) } },
});

// A reduced Stripe-shaped contract: basil removed subscription periods, invoice.subscription and
// line_item.type.
function contract(after: boolean) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Simulated Stripe contract',
      version: after ? '2025-03-31.basil' : '2024-06-20',
    },
    paths: {
      '/v1/subscriptions/{subscription}': {
        get: {
          operationId: 'GetSubscription',
          responses: {
            '200': { content: { 'application/json': { schema: ref('subscription') } } },
          },
        },
      },
    },
    components: {
      schemas: {
        subscription: {
          type: 'object',
          properties: {
            id: string,
            ...(after ? {} : { current_period_end: integer }),
            items: list('subscription_item'),
          },
        },
        subscription_item: {
          type: 'object',
          properties: { id: string, current_period_end: integer },
        },
        invoice: {
          type: 'object',
          properties: {
            id: string,
            ...(after ? {} : { subscription: string }),
            lines: list('line_item'),
          },
        },
        line_item: {
          type: 'object',
          properties: { id: string, ...(after ? {} : { type: string }) },
        },
        event: { type: 'object', properties: { id: string, type: string } },
        payment_intent: { type: 'object', properties: { id: string } },
      },
    },
  };
}

async function scan(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-stripe-types-'));
  roots.push(root);
  await mkdir(join(root, 'app'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'app', dependencies: { stripe: '16.0.0' } }),
  );
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  await writeFile(join(root, 'before.json'), JSON.stringify(contract(false)));
  await writeFile(join(root, 'after.json'), JSON.stringify(contract(true)));
  const report = await runPipeline({
    repository: root,
    before: join(root, 'before.json'),
    after: join(root, 'after.json'),
    apiVersion: '2024-06-20',
  });
  return report.findings.map(
    (finding) => `${finding.file}:${finding.line} ${finding.expression} ${finding.confidence}`,
  );
}

const header = `import Stripe from 'stripe';\nconst stripe = new Stripe('sk');\n`;

it('confirms reads on values the code types as Stripe objects', async () => {
  const findings = await scan({
    'app/billing.ts': `${header}export function end(sub: Stripe.Subscription | null) {
  return sub?.current_period_end;
}
export function invoiceSub(value: unknown) {
  return (value as Stripe.Invoice).subscription;
}
export async function active(): Promise<Stripe.Subscription> { return {} as Stripe.Subscription; }
export async function later() {
  const current = await active();
  return current.current_period_end;
}
export function ends(subscriptions: Stripe.Subscription[]) {
  return subscriptions.filter((subscription) => subscription.current_period_end > 0);
}
export function types(invoice: Stripe.Invoice) {
  let metered = 0;
  for (const item of invoice.lines?.data ?? []) if (item.type === 'subscription') metered++;
  return metered;
}
`,
  });
  expect(findings).toEqual([
    'app/billing.ts:4 .current_period_end confirmed',
    'app/billing.ts:7 .subscription confirmed',
    'app/billing.ts:12 .current_period_end confirmed',
    'app/billing.ts:15 .current_period_end confirmed',
    'app/billing.ts:19 .type confirmed',
  ]);
});

it('narrows webhook objects by event type and treats the event itself as a Stripe event', async () => {
  const findings = await scan({
    'app/webhook.ts': `${header}export async function POST(body: string, signature: string) {
  let event;
  event = stripe.webhooks.constructEvent(body, signature, 'secret');
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      return subscription.current_period_end;
    }
  }
  if (event.type === 'invoice.paid') return event.data.object.subscription;
  return event.data.object.current_period_end;
}
`,
  });
  // The unnarrowed read stays review-only; event.type is a field Stripe events keep.
  expect(findings).toEqual([
    'app/webhook.ts:10 .current_period_end confirmed',
    'app/webhook.ts:13 .subscription confirmed',
    'app/webhook.ts:14 .current_period_end review',
  ]);
});

it('confirms traced responses passed along, but not ones the code writes to', async () => {
  const findings = await scan({
    'app/sync.ts': `${header}declare const db: { save(value: unknown): Promise<void> };
export async function sync(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id);
  await db.save({ id: subscription.id, end: subscription.current_period_end });
  const patched = await stripe.subscriptions.retrieve(id);
  patched.current_period_end = 0;
  return patched.current_period_end;
}
`,
  });
  expect(findings).toEqual([
    'app/sync.ts:6 .current_period_end confirmed',
    'app/sync.ts:8 .current_period_end review',
    'app/sync.ts:9 .current_period_end review',
  ]);
});

it('does not flag same-named fields in files that never use Stripe', async () => {
  const findings = await scan({
    'app/webhook.ts': `${header}export const client = stripe;\n`,
    'app/toast.ts': `export const kind = (toast: { type: string }) => toast.type;\n`,
  });
  expect(findings).toEqual([]);
});
