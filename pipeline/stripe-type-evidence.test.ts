import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runPipeline } from './run.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const TYPES = `declare module 'stripe' {
  namespace Stripe {
    interface Subscription { id: string; created: number; current_period_end: number }
  }
  class Stripe { constructor(key: string, options?: { apiVersion?: string }); }
  export default Stripe;
}
`;

async function scan(source: string, installTypes: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'refit-type-evidence-'));
  roots.push(root);
  await writeFile(join(root, 'billing.ts'), source);
  if (installTypes) {
    await mkdir(join(root, 'node_modules', 'stripe', 'types'), { recursive: true });
    await writeFile(
      join(root, 'node_modules', 'stripe', 'package.json'),
      JSON.stringify({ name: 'stripe', types: 'types/index.d.ts' }),
    );
    await writeFile(join(root, 'node_modules', 'stripe', 'types', 'index.d.ts'), TYPES);
  }
  return runPipeline({
    repository: root,
    before: resolve('pipeline/fixtures/stripe-webhooks/before.json'),
    after: resolve('pipeline/fixtures/stripe-webhooks/after.json'),
    apiVersion: '2025-02-24.acacia',
    proposePatch: true,
  });
}

const SOURCE = `import Stripe from 'stripe';
export function latest(subscriptions: Stripe.Subscription[], fallback: Stripe.Subscription[]) {
  const subscription = subscriptions[0] ?? fallback.sort((a, b) => b.created - a.created)[0];
  return subscription.current_period_end;
}
export function cast(payload: { object: unknown }) {
  const subscription = payload.object as Stripe.Subscription;
  subscription.id = 'changed';
  return subscription.current_period_end;
}
`;

it('confirms type-resolved reads of removed Stripe fields and stops automation for review', async () => {
  const untyped = await scan(SOURCE, false);
  expect(untyped.findings.filter((finding) => finding.confidence === 'confirmed')).toEqual([]);

  const typed = await scan(SOURCE, true);
  const reads = typed.findings.filter((finding) => finding.expression === '.current_period_end');
  expect(reads).toMatchObject([
    {
      line: 4,
      confidence: 'confirmed',
      typeEvidence: { receiverTypes: ['Stripe.Subscription'] },
    },
    {
      line: 9,
      confidence: 'confirmed',
      typeEvidence: { receiverTypes: ['Stripe.Subscription'], asserted: true },
    },
  ]);
  expect(reads[0].typeEvidence).not.toHaveProperty('asserted');
  expect(reads[1].reason).toContain('type assertion');
  expect(typed.status).toBe('affected');
  expect(typed.patch).toMatchObject({
    status: 'not-generated',
    reason: expect.stringContaining('TypeScript types confirm reads'),
  });
});
