import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRecipe } from './fixtures/tasks.ts';
import type { LadderEntry } from './ladder.ts';
import { scrubText, shareLearning, sharedRecipe, sharedStore } from './shared.ts';
import { SqliteMemoryStore } from './sqlite-store.ts';

const scrub = {
  names: ['acme-corp', 'billing-portal'],
  keep: ['claude-sonnet-5-5', 'gemini-3.6-flash', 'subscription.current_period_end'],
};

// Illustrative customer content, not a real customer.
const LEAKY = [
  'In acme-corp/billing-portal the file src/server/invoices/chargeCustomer.ts calls',
  '`createInvoiceForTenant(tenantId)` with client_secret_abc and sk-ant-api03-abcdefghijklmnopqrstuvwx.',
  'Ask jane.doe@acme-corp.com or see https://acme-corp.internal/wiki/billing for AcmeBillingService.run.',
  '```ts\nconst price = await stripe.prices.retrieve(ACME_PRICE_ID);\n```',
  'The "Enterprise Gold" plan in config.yaml reads ACME_PRICE_ID and my_custom_flag.',
  'Move the model to claude-sonnet-5-5 and read subscription.current_period_end from the first item.',
].join('\n');

describe('scrubText', () => {
  const out = scrubText(LEAKY, scrub);

  it('removes customer names, paths, code, identifiers, emails, URLs and secrets', () => {
    for (const leak of [
      'acme',
      'Acme',
      'billing-portal',
      'chargeCustomer',
      'src/server',
      'createInvoiceForTenant',
      'tenantId',
      'client_secret',
      'sk-ant',
      'jane.doe',
      'wiki/billing',
      'AcmeBillingService',
      'stripe.prices',
      'ACME_PRICE_ID',
      'Enterprise Gold',
      'config.yaml',
      'my_custom_flag',
    ]) {
      expect(out, leak).not.toContain(leak);
    }
  });

  it('keeps the prose and the provider names the list holds', () => {
    expect(out).toContain('Move the model to claude-sonnet-5-5');
    expect(out).toContain('subscription.current_period_end');
  });
});

describe('sharing', () => {
  const merged = makeRecipe({
    steps: LEAKY,
    pitfalls: LEAKY,
    preconditions: LEAKY,
    diffSketch: '- acme secret code',
    repos: ['acme-corp/billing-portal'],
    sourceRuns: ['acme-corp/billing-portal:dead-apis-1'],
    verifiedRepos: 1,
    confidence: 'merged',
  });

  it('sends nothing that names the customer, not even in a field nobody reads', () => {
    const pattern = JSON.stringify(sharedRecipe(merged, scrub));
    expect(pattern).not.toContain('acme');
    expect(pattern).not.toContain('sk-ant');
    expect(pattern).toContain('claude-sonnet-5-5');
  });

  it('never shares a low-confidence or benchmark-only recipe', () => {
    expect(sharedRecipe({ ...merged, confidence: 'low' }, scrub)).toBeUndefined();
    expect(sharedRecipe({ ...merged, benchmarkOnly: true }, scrub)).toBeUndefined();
  });

  const stores = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aptitude-shared-'));
    const store = SqliteMemoryStore.forOwner(dir, 'acme-corp');
    await store.saveRecipe(merged);
    const at = '2026-11-05T00:00:00.000Z';
    const entry: LadderEntry = {
      entryId: 'AN-1',
      level: 'recipe',
      benchmarkLevel: 'recipe',
      updatedAt: at,
      evidence: [{ kind: 'merged', repo: 'acme-corp/billing-portal', runId: 'run-1', at }],
    };
    await store.saveLadder(entry);
    return { store, shared: sharedStore(dir) };
  };

  it('leaves everything at home without consent, which is the default', async () => {
    const { store, shared } = await stores();
    const sent = await shareLearning({ store, shared, consented: false, scrub });
    expect(sent).toEqual({ recipes: 0, ladder: 0 });
    expect(await shared.listRecipes()).toEqual([]);
    expect(await shared.listLadder()).toEqual([]);
  });

  it('shares scrubbed patterns and hashed evidence with consent', async () => {
    const { store, shared } = await stores();
    await shareLearning({ store, shared, consented: true, scrub });
    await shareLearning({ store, shared, consented: true, scrub });
    const text = JSON.stringify([await shared.listRecipes(), await shared.listLadder()]);
    expect(text).not.toContain('acme');
    expect(text).not.toContain('run-1');
    const [entry] = await shared.listLadder();
    expect(entry.evidence).toHaveLength(1);
  });
});
