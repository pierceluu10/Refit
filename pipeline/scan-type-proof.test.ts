import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runPipeline } from './run.ts';

// Founder decision (2026-10-28): at scan time, a removed-field read whose receiver TypeScript's
// checker proves is the change's Stripe type, with no type assertion or `any` on its path, is
// migrated as a traced read. Refit's own stripe-node supplies the types; nothing is installed here.

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scan(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-scan-proof-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  return runPipeline({
    repository: root,
    before: resolve('pipeline/fixtures/stripe-webhooks/before.json'),
    after: resolve('pipeline/fixtures/stripe-webhooks/after.json'),
    apiVersion: '2025-02-24.acacia',
    proposePatch: true,
  });
}

const CLIENT = `import Stripe from 'stripe';
const stripe = new Stripe('sk', { apiVersion: '2025-02-24.acacia' });
`;

it('keeps a JavaScript type cast and a receiver that may be a local type stopped', async () => {
  const report = await scan({
    'billing.js': `import Stripe from 'stripe';
const stripe = new Stripe('sk');
export async function mislabelled(id) {
  const subscription = /** @type {Stripe.Subscription} */ (await stripe.invoices.retrieve(id));
  return subscription.current_period_end;
}
`,
    'local.ts': `${CLIENT}interface Imported { current_period_end: number; metadata: Record<string, string> }
export async function either(id: string, imported: Imported) {
  const subscription = id ? await stripe.subscriptions.retrieve(id) : imported;
  subscription.metadata = {};
  return subscription.current_period_end;
}
`,
  });
  expect(report.findings.filter((finding) => finding.typeProven)).toEqual([]);
  expect(
    report.findings
      .filter((finding) => finding.expression === '.current_period_end')
      .map((finding) => `${finding.file}:${finding.line}`),
  ).toEqual(['billing.js:5', 'local.ts:7']);
});
