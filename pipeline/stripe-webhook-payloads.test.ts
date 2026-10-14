import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { compareApiVersion } from './api-version.ts';
import { proposeAiPatch } from './ai-patches.ts';
import { readRepository } from './repository.ts';
import { runPipeline } from './run.ts';
import { runWorkflow } from './workflow.ts';
import { renderWorkflowResult } from './workflow-presentation.ts';
import { STRIPE } from './providers.ts';
import type { Repository } from './types.ts';

const VERSION = '2025-02-24.acacia';
const schemas = {
  payment_intent: { type: 'object', properties: { id: { type: 'string' } } },
  subscription: {
    type: 'object',
    properties: {
      current_period_end: { type: 'integer' },
      current_period_start: { type: 'integer' },
      items: { $ref: '#/components/schemas/subscription_item_list' },
    },
  },
  subscription_item_list: {
    type: 'object',
    properties: {
      data: { type: 'array', items: { $ref: '#/components/schemas/subscription_item' } },
    },
  },
  subscription_item: { type: 'object', properties: { id: { type: 'string' } } },
  invoice: { type: 'object', properties: { subscription: { type: 'string' } } },
  'checkout.session': { type: 'object', properties: { subscription: { type: 'string' } } },
};
const removals = [
  {
    id: 'period',
    schema: 'subscription',
    property: 'current_period_end',
    pointer: '/subscription/current_period_end',
  },
];
const client = `import Stripe from 'stripe'; const stripe = new Stripe('local-fixture', {apiVersion: '${VERSION}'});`;
const initialize = `const event = stripe.webhooks.constructEvent(body, signature, secret);`;
const payloadRead =
  'const subscription = event.data.object as Stripe.Subscription; return subscription.current_period_end;';
function analyze(handler: string, extra: Record<string, string> = {}, changes = removals) {
  const repository: Repository = {
    root: '/webhook-fixture',
    files: [
      {
        path: 'handler.ts',
        content: `${client} async function handle(body, signature, secret) {${handler}}`,
      },
      ...Object.entries(extra).map(([path, content]) => ({ path, content })),
    ],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  return { ...analyzeRepository(repository, changes, STRIPE, schemas), repository };
}
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each([
  `${initialize} if (event.type === 'customer.subscription.updated') {${payloadRead}}`,
  `${initialize} if ('customer.subscription.updated' === event.type) {${payloadRead}}`,
  `${initialize} if (event.type !== 'customer.subscription.updated') {return;} ${payloadRead}`,
  `${initialize} if (event.type !== 'customer.subscription.updated') {} else {${payloadRead}}`,
  `${initialize} if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.created') {${payloadRead}}`,
  `${initialize} if (event.type === 'customer.subscription.updated' && enabled) {${payloadRead}}`,
  `${initialize} switch (event.type) {case 'customer.subscription.created': case 'customer.subscription.updated': {${payloadRead}} default: return;}`,
  `let event: Stripe.Event; try {event = stripe.webhooks.constructEvent(body, signature, secret);} catch {return;} switch(event.type) {case 'customer.subscription.updated': {${payloadRead}}}`,
  `const event = await stripe.webhooks.constructEventAsync(body, signature, secret); if (event.type === 'customer.subscription.updated') {${payloadRead}}`,
])(
  'traces a snapshot payload through a real constructor and positive type branch: %s',
  (handler) => {
    const result = analyze(handler);
    expect(result.findings).toMatchObject([
      {
        confidence: 'confirmed',
        webhook: {
          schema: 'subscription',
          eventTypes: expect.arrayContaining(['customer.subscription.updated']),
          apiVersion: 'unverified',
        },
      },
    ]);
    expect(result.edits).toEqual([]);
    expect(result.apiVersionDeclarations).toHaveLength(1);
    expect(
      compareApiVersion(
        VERSION,
        { info: { version: VERSION } },
        { info: { version: '2025-03-31.basil' } },
        { configured: true, declarations: result.apiVersionDeclarations },
        'source-verified',
      ).source.status,
    ).toBe('verified');
  },
);

it('narrows an immutable payload alias captured before the branch at its actual read location', () => {
  const result = analyze(
    `${initialize} const snapshot = event.data.object; const alias = snapshot; if (event.type === 'customer.subscription.updated') return alias.current_period_end;`,
  );
  expect(result.findings).toMatchObject([
    { confidence: 'confirmed', webhook: { schema: 'subscription' } },
  ]);
});

it('supports immutable event aliases and literal payload indexes', () => {
  const result = analyze(
    `${initialize} const alias = event; if (alias.type === 'customer.subscription.updated') return alias['data']['object'].current_period_end;`,
  );
  expect(result.findings).toMatchObject([
    { confidence: 'confirmed', webhook: { schema: 'subscription' } },
  ]);
});

it.each([
  `const kind = event.type; const data = event.data; const snapshot = data.object; if(kind === 'customer.subscription.updated') return snapshot.current_period_end;`,
  `const {type: kind, data: {object: snapshot}} = event; if(kind === 'customer.subscription.updated') return snapshot.current_period_end;`,
  `const {data} = event; const {object: snapshot} = data; switch(event.type) {case 'customer.subscription.updated': return snapshot.current_period_end;}`,
  `const {'type': kind, data: {'object': snapshot}} = event; if(kind === 'customer.subscription.updated') return snapshot['current_period_end'];`,
])(
  'follows immutable discriminant and payload projections without trusting casts: %s',
  (handler) => {
    const result = analyze(`${initialize} ${handler}`);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      confidence: 'confirmed',
      webhook: { schema: 'subscription', eventTypes: ['customer.subscription.updated'] },
    });
    expect(result.edits).toEqual([]);
  },
);

it.each([
  `let kind = event.type; if(kind === 'customer.subscription.updated') {${payloadRead}}`,
  `const {type: kind = 'customer.subscription.updated'} = event; if(kind === 'customer.subscription.updated') {${payloadRead}}`,
  `const {data: {object: snapshot = supplied}} = event; if(event.type === 'customer.subscription.updated') return snapshot.current_period_end;`,
  `const {[key]: snapshot} = event.data; if(event.type === 'customer.subscription.updated') return snapshot.current_period_end;`,
  `const {...snapshot} = event.data.object; if(event.type === 'customer.subscription.updated') return snapshot.current_period_end;`,
  `if(event.type === '__proto__') {${payloadRead}}`,
  `if(event.type === 'constructor') {${payloadRead}}`,
])('does not confirm defaults, dynamic projections or unknown event names: %s', (handler) => {
  const result = analyze(`${initialize} ${handler}`);
  expect(result.findings).toHaveLength(1);
  expect(result.findings[0].confidence).toBe('review');
  expect(result.edits).toEqual([]);
});

it('keeps a returned destructured field under the existing conservative escape boundary', () => {
  const result = analyze(
    `${initialize} if(event.type === 'customer.subscription.updated') {const {current_period_end: endsAt} = event.data.object; return endsAt;}`,
  );
  expect(result.findings).toMatchObject([
    { confidence: 'review', webhook: { schema: 'subscription' } },
  ]);
  expect(result.edits).toEqual([]);
});

it.each([
  `${initialize} ${payloadRead}`,
  `const event = JSON.parse(body); if (event.type === 'customer.subscription.updated') {${payloadRead}}`,
  `const event = stripe.webhooks.constructEventAsync(body, signature, secret); if (event.type === 'customer.subscription.updated') {${payloadRead}}`,
  `${initialize} if (event.type === 'customer.subscription.invented') {${payloadRead}}`,
  `${initialize} if (event.type.startsWith('customer.subscription.')) {${payloadRead}}`,
  `${initialize} if (event.type === 'customer.subscription.updated' || enabled) {${payloadRead}}`,
  `${initialize} switch(event.type) {case 'payment_intent.succeeded': case 'customer.subscription.updated': {${payloadRead}}}`,
  `${initialize} switch(event.type) {case 'payment_intent.succeeded': log(); case 'customer.subscription.updated': {${payloadRead}}}`,
  `${initialize} switch(event.type) {default: {${payloadRead}}}`,
  `${initialize} if (event.type === 'customer.subscription.updated') {function nested() {${payloadRead}} return nested();}`,
  `${initialize} if (event.type === 'customer.subscription.updated') {} ${payloadRead}`,
  `${initialize} if (other.type === 'customer.subscription.updated') {${payloadRead}}`,
])(
  'does not confirm a payload without positive signature-origin and type-flow evidence: %s',
  (handler) => {
    expect(analyze(handler).findings.every((finding) => finding.confidence !== 'confirmed')).toBe(
      true,
    );
  },
);

it.each([
  `event.data.object.current_period_end = 0;`,
  `const alias = event; mutate(alias);`,
  `const subscription = event.data.object; mutate(subscription);`,
  `event.type = 'customer.subscription.updated';`,
  `stripe.webhooks.constructEvent = substitute;`,
  `event = otherEvent;`,
])('downgrades mutation or escape of event, payload or client: %s', (mutation) => {
  const result = analyze(
    `${initialize} ${mutation} if (event.type === 'customer.subscription.updated') {${payloadRead}}`,
  );
  expect(result.findings.every((finding) => finding.confidence === 'review')).toBe(true);
  expect(result.edits).toEqual([]);
  expect(result.findings.length).toBeGreaterThan(0);
  expect(result.findings.every((finding) => finding.webhook !== undefined)).toBe(true);
});

it.each([
  `${initialize} ${payloadRead}`,
  `${initialize} if(enabled) {${payloadRead}}`,
  `const event = stripe.webhooks.constructEventAsync(body, signature, secret); if(event.type === 'customer.subscription.updated') {${payloadRead}}`,
  `const event = stripe.webhooks?.constructEvent(body, signature, secret); if(event.type === 'customer.subscription.updated') {${payloadRead}}`,
  `const event = stripe.webhooks.constructEvent(body, signature); if(event.type === 'customer.subscription.updated') {${payloadRead}}`,
  `const event = stripe.webhooks.constructEvent(...args); if(event.type === 'customer.subscription.updated') {${payloadRead}}`,
  `${initialize} if(event.type === 'customer.subscription.updated') return event.data.previous_attributes.current_period_end;`,
])(
  'retains incoming-event review evidence when payload confirmation is incomplete: %s',
  (handler) => {
    const result = analyze(handler);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      confidence: 'review',
      webhook: { apiVersion: 'unverified' },
    });
    expect(result.edits).toEqual([]);
  },
);

it('does not treat a cast to Stripe.Subscription as proof in a payment-intent branch', () => {
  expect(
    analyze(`${initialize} if (event.type === 'payment_intent.succeeded') {${payloadRead}}`)
      .findings,
  ).toEqual([]);
});

it('uses the real dotted OpenAPI name for Checkout Session events', () => {
  const result = analyze(
    `${initialize} if (event.type === 'checkout.session.completed') return event.data.object.subscription;`,
    {},
    [
      {
        id: 'session-subscription',
        schema: 'checkout.session',
        property: 'subscription',
        pointer: '/session/subscription',
      },
    ],
  );
  expect(result.findings).toMatchObject([
    { confidence: 'confirmed', webhook: { schema: 'checkout.session' } },
  ]);
});

it('does not confuse a missing Checkout schema with an Invoice field of the same name', () => {
  const repository = analyze(
    `${initialize} if(event.type === 'checkout.session.completed') return event.data.object.subscription;`,
  ).repository;
  const { 'checkout.session': _session, ...incomplete } = schemas;
  const result = analyzeRepository(
    repository,
    [
      {
        id: 'invoice-subscription',
        schema: 'invoice',
        property: 'subscription',
        pointer: '/invoice/subscription',
      },
    ],
    STRIPE,
    incomplete,
  );
  expect(result.findings).toEqual([]);
});

it.each([
  `return event.data.object.items.data[0].id;`,
  `const item = event.data.object.items.data[0]; return item.id;`,
  `for(const item of event.data.object.items.data) {if(item.id === wanted) return true;}`,
  `return event.data.object.items.data.some(item => item.id === wanted);`,
])('preserves webhook provenance through supported nested list reads: %s', (read) => {
  const result = analyze(
    `${initialize} if(event.type === 'customer.subscription.updated') {${read}}`,
    {},
    [
      {
        id: 'item-id',
        schema: 'subscription_item',
        property: 'id',
        pointer: '/subscription_item/id',
      },
    ],
  );
  expect(result.findings).toHaveLength(1);
  expect(result.findings[0]).toMatchObject({
    confidence: 'confirmed',
    webhook: {
      schema: 'subscription',
      eventTypes: ['customer.subscription.updated'],
      apiVersion: 'unverified',
    },
  });
  expect(result.edits).toEqual([]);
});

it('keeps supplied unresolved-schema removals under review even with a known event type', () => {
  const repository = analyze(
    `${initialize} if(event.type === 'checkout.session.completed') return event.data.object.subscription;`,
  ).repository;
  const { 'checkout.session': _session, ...incomplete } = schemas;
  const result = analyzeRepository(
    repository,
    [
      {
        id: 'session-subscription',
        schema: 'checkout.session',
        property: 'subscription',
        pointer: '/session/subscription',
      },
    ],
    STRIPE,
    incomplete,
  );
  expect(result.findings).toMatchObject([
    { confidence: 'review', webhook: { apiVersion: 'unverified' } },
  ]);
  expect(result.edits).toEqual([]);
});

it('retains incoming-event review provenance in an unsupported multi-parameter array callback', () => {
  const result = analyze(
    `${initialize} if(event.type === 'customer.subscription.updated') return event.data.object.items.data.some((item, index) => item.id === wanted[index]);`,
    {},
    [
      {
        id: 'item-id',
        schema: 'subscription_item',
        property: 'id',
        pointer: '/subscription_item/id',
      },
    ],
  );
  expect(result.findings).toMatchObject([
    { confidence: 'review', webhook: { schema: 'subscription', apiVersion: 'unverified' } },
  ]);
  expect(result.edits).toEqual([]);
});

it('does not trace previous_attributes as the current snapshot object', () => {
  const result = analyze(
    `${initialize} if (event.type === 'customer.subscription.updated') return event.data.previous_attributes.current_period_end;`,
  );
  expect(result.findings.every((finding) => finding.confidence === 'review')).toBe(true);
});

it('preserves shared-client mutation evidence across modules', () => {
  const repository: Repository = {
    root: '/webhook-fixture',
    files: [
      { path: 'client.ts', content: client.replace('const stripe', 'export const stripe') },
      {
        path: 'handler.ts',
        content: `import {stripe} from './client'; async function handle(body, signature, secret) {${initialize} if(event.type === 'customer.subscription.updated') {${payloadRead}}}`,
      },
      { path: 'mutator.ts', content: `import {stripe} from './client'; mutate(stripe);` },
    ],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  const result = analyzeRepository(repository, removals, STRIPE, schemas);
  expect(result.findings).toMatchObject([
    { confidence: 'review', webhook: { schema: 'subscription' } },
  ]);
});

it('stops AI generation, advisory assessment and the workflow before networked or executable work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-webhook-gate-'));
  roots.push(root);
  const repository = join(root, 'repository');
  await mkdir(repository);
  const result = analyze(
    `${initialize} if (event.type === 'customer.subscription.updated') {${payloadRead}}`,
  );
  await writeFile(join(repository, 'handler.ts'), result.repository.files[0].content);
  const before = {
    openapi: '3.0.3',
    info: { title: 'Reviewed Stripe webhook projection', version: VERSION },
    paths: {},
    components: { schemas },
  };
  const after = structuredClone(before);
  after.info.version = '2025-03-31.basil';
  delete (after.components.schemas.subscription.properties as Record<string, unknown>)
    .current_period_end;
  const beforePath = join(root, 'before.json'),
    afterPath = join(root, 'after.json');
  await writeFile(beforePath, JSON.stringify(before));
  await writeFile(afterPath, JSON.stringify(after));
  const fetch = vi.fn(() => {
    throw new Error('Webhook review must not request AI or GitHub.');
  });
  vi.stubGlobal('fetch', fetch);
  const ai = { apiKey: 'local-fixture', model: 'fixture-model' };
  const report = await runPipeline({
    repository,
    before: beforePath,
    after: afterPath,
    apiVersion: VERSION,
    apiVersionPolicy: 'source-verified',
    aiPatch: ai,
    assessment: ai,
  });
  expect(report.status).toBe('affected');
  expect(report.patch).toMatchObject({
    status: 'not-generated',
    reason: expect.stringContaining('migration-policy'),
  });
  expect(report.assessment).toMatchObject({ status: 'blocked' });
  await expect(
    proposeAiPatch(await readRepository(repository), report.changes, report.findings, ai),
  ).rejects.toThrow(/migration-policy/);
  const workflow = await runWorkflow({
    repository,
    before: beforePath,
    after: afterPath,
    apiVersion: VERSION,
    apiVersionPolicy: 'source-verified',
    aiPatch: ai,
    image: 'must-not-inspect',
    command: ['must-not-execute'],
    output: join(root, 'run'),
  });
  expect(workflow.manifest).toMatchObject({ status: 'needs-review', stage: 'scan' });
  expect(await renderWorkflowResult(workflow)).toContain('incoming API version requires review');
  expect(fetch).not.toHaveBeenCalled();
});
