import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import {
  behaviourTestRequest,
  behaviourTestSkip,
  INSTRUCTIONS,
  parseBehaviourTests,
  STUB_INSTRUCTIONS,
  stripeCodeFiles,
  writeBehaviourTests,
  type BehaviourTestFile,
} from './behaviour-test-writer.ts';
import {
  changedStripeLines,
  compareBehaviourRuns,
  writeBehaviourHarness,
} from './behaviour-tests.ts';
import { CHAT_NEST, CHAT_NEST_STUBS, CHAT_NEST_TEST } from './fixtures/behaviour-stubs.ts';
import { typescriptDirectory } from './generated-checks.ts';
import { MAX_INPUT_BYTES } from './openai.ts';
import { readRepository } from './repository.ts';
import { removedRequestParameters } from './request-removals.ts';
import { runPipeline } from './run.ts';
import { digest, readSpecification } from './specifications.ts';
import type { Finding } from './types.ts';
import type { CheckResult } from './validation.ts';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// Emmah-oo/spotify-clone at 23f84d4d703ea005c12f60bc9ae42148158cc0f8 (dev-30): libs/stripe.ts and
// libs/helpers.ts' toDateTime as committed, libs/supabaseAdmin.ts cut to the Supabase client and
// manageSubscriptionStatusChange's Stripe path.
const SPOTIFY = {
  'libs/stripe.ts': `import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", {
  apiVersion: "2023-10-16",
  appInfo: {
    name: "Spotify Clone",
    version: "0.1.0",
  },
});
`,
  'libs/helpers.ts': `// Define a function named toDateTime to convert seconds to a Date object
export const toDateTime = (secs: number) => {
  // Create a new Date object with a base date of "1970-01-01T00:30:00Z"
  var t = new Date("1970-01-01T00:30:00Z");

  // Set the seconds of the Date object to the provided value
  t.setSeconds(secs);

  // Return the updated Date object
  return t;
};
`,
  'libs/supabaseAdmin.ts': `import { createClient } from "@supabase/supabase-js";

import { stripe } from "./stripe";
import { toDateTime } from "./helpers";

export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

const manageSubscriptionStatusChange = async (
  subscriptionId: string,
  customerId: string,
  createAction = false
) => {
  // Get customer's UUID from mapping table.
  const { data: customerData, error: noCustomerError } = await supabaseAdmin
    .from("customers")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .single();
  if (noCustomerError) throw noCustomerError;

  const { id: uuid } = customerData!;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["default_payment_method"],
  });
  const subscriptionData = {
    id: subscription.id,
    user_id: uuid,
    current_period_start: toDateTime(
      subscription.current_period_start
    ).toISOString(),
    current_period_end: toDateTime(
      subscription.current_period_end
    ).toISOString(),
  };

  const { error } = await supabaseAdmin
    .from("subscriptions")
    .upsert([subscriptionData]);
  if (error) throw error;
};

export { manageSubscriptionStatusChange };
`,
};

// nicuk/docsflow at 3e6fd7136b36f30fe6ef70ff4a2ebf3b3de4343a (dev-30): lib/stripe-client.ts' client
// and createCheckoutSession as committed.
const DOCSFLOW_CLIENT = `import Stripe from 'stripe';

// Make Stripe optional during build time
const stripeKey = process.env.STRIPE_SECRET_KEY;

export const stripe = stripeKey ? new Stripe(stripeKey, {
  apiVersion: '2025-08-27.basil',
  appInfo: {
    name: 'DocsFlow',
    version: '1.0.0',
  },
}) : null;

// Create checkout session
export async function createCheckoutSession({
  priceId,
  tenantId,
  userEmail,
  successUrl,
  cancelUrl,
}: {
  priceId: string;
  tenantId: string;
  userEmail: string;
  successUrl: string;
  cancelUrl: string;
}) {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: userEmail,
      metadata: {
        tenantId,
      },
      subscription_data: {
        metadata: {
          tenantId,
        },
      },
    });

    return { session, error: null };
  } catch (error) {
    return { session: null, error: error as Error };
  }
}
`;
const DOCSFLOW = { 'lib/stripe-client.ts': DOCSFLOW_CLIENT };
const CHECKOUT_FIELDS = [
  'mode',
  'line_items',
  'success_url',
  'cancel_url',
  'customer_email',
  'metadata',
  'subscription_data',
];

const ADAPTER = {
  packageName: 'stripe',
  defaultImport: true,
  namedExport: 'Stripe',
  constructorCalls: true,
  apiVersion: { constructorArgument: 1, property: 'apiVersion', requestArguments: [1, 2] },
};

// Shaped like Stripe's basil and endive Checkout Session create bodies.
function checkoutContract(version: string, fields: string[]) {
  return {
    openapi: '3.0.0',
    info: { version },
    paths: {
      '/v1/checkout/sessions': {
        post: {
          operationId: 'PostCheckoutSessions',
          requestBody: {
            content: {
              'application/x-www-form-urlencoded': {
                schema: {
                  type: 'object',
                  properties: Object.fromEntries(
                    fields.map((name) => [
                      name,
                      name.endsWith('payment_method_types')
                        ? {
                            type: 'array',
                            description: `A list of the types of payment methods (${name}).`,
                          }
                        : {},
                    ]),
                  ),
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: { 'checkout.session': { type: 'object', properties: { id: { type: 'string' } } } },
    },
  };
}

async function scenario(name: 'spotify' | 'docsflow', extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'refit-behaviour-'));
  roots.push(root);
  const directory = join(root, 'repository');
  const files = { ...(name === 'spotify' ? SPOTIFY : DOCSFLOW), ...extra };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ dependencies: { stripe: name === 'spotify' ? '14.5.0' : '18.5.0' } }),
  );
  const before = join(root, 'before.json');
  const after = join(root, 'after.json');
  const providerConfig = join(root, 'provider.json');
  if (name === 'spotify') {
    // The reviewed subscription-period projection, at the versions the repository moves between.
    const fixture = 'pipeline/fixtures/stripe-webhooks';
    for (const [path, version] of [
      [before, '2023-10-16'],
      [after, '2025-03-31.basil'],
    ]) {
      const document = JSON.parse(
        await readFile(join(fixture, path.slice(root.length + 1)), 'utf8'),
      );
      await writeFile(path, JSON.stringify({ ...document, info: { ...document.info, version } }));
    }
    await writeFile(
      providerConfig,
      JSON.stringify({
        ...ADAPTER,
        id: 'stripe-subscriptions',
        operations: [{ resource: 'subscriptions', method: 'retrieve', schema: 'subscription' }],
      }),
    );
  } else {
    await writeFile(
      before,
      JSON.stringify(
        checkoutContract('2025-08-27.basil', [...CHECKOUT_FIELDS, 'payment_method_types']),
      ),
    );
    await writeFile(
      after,
      JSON.stringify(
        checkoutContract('2026-09-30.endive', [...CHECKOUT_FIELDS, 'allowed_payment_method_types']),
      ),
    );
    await writeFile(
      providerConfig,
      JSON.stringify({
        ...ADAPTER,
        id: 'stripe-checkout',
        operations: [
          {
            resource: 'checkout.sessions',
            method: 'create',
            schema: 'checkout.session',
            operationId: 'PostCheckoutSessions',
          },
        ],
      }),
    );
  }
  const report = await runPipeline({
    repository: directory,
    before,
    after,
    providerConfig,
    apiVersion: name === 'spotify' ? '2023-10-16' : '2025-08-27.basil',
    proposePatch: true,
  });
  const specifications = {
    before: await readSpecification(before),
    after: await readSpecification(after),
  };
  return {
    root,
    directory,
    report,
    inputs: {
      repository: await readRepository(directory),
      findings: report.findings,
      changes: report.changes,
      // As validation computes them for the writer.
      removals: removedRequestParameters(
        report.adapter,
        specifications.before.document,
        specifications.after.document,
      ),
      ...specifications,
    },
  };
}

const ai = (directory: string, limitUsd = 1) => ({
  apiKey: 'test-key',
  model: 'gpt-6.1-sol',
  budget: { directory, limitUsd },
});

// A recorded Responses API answer carrying `answer` as the model's JSON output.
function respond(answer: unknown, usage = { input_tokens: 9000, output_tokens: 7000 }) {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) =>
    url.endsWith('/input_tokens')
      ? new Response(JSON.stringify({ input_tokens: usage.input_tokens }))
      : new Response(
          JSON.stringify({
            id: 'resp_behaviour',
            model: 'gpt-6.1-sol-2026-10-01',
            status: 'completed',
            usage,
            output: [
              { type: 'reasoning' },
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: JSON.stringify(answer) }],
              },
            ],
          }),
        ),
  );
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

// The test a model would write for docsflow's checkout: it holds on both versions, and fails when a
// migration drops the card restriction or keeps sending the removed parameter.
const CHECKOUT_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createCheckoutSession } = await import('../lib/stripe-client.ts');

test('creates a card-only subscription checkout session for the tenant', async () => {
  globalThis.__refitStripe.reset();
  const result = await createCheckoutSession({
    priceId: 'price_123',
    tenantId: 'tenant_1',
    userEmail: 'buyer@example.com',
    successUrl: 'https://example.com/success',
    cancelUrl: 'https://example.com/cancel',
  });
  assert.equal(result.error, null);
  assert.equal(result.session.object, 'checkout.session');
  const [request] = globalThis.__refitStripe.requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/v1/checkout/sessions');
  assert.equal(request.body.mode, 'subscription');
  assert.equal(request.body.customer_email, 'buyer@example.com');
  assert.equal(request.body.metadata.tenantId, 'tenant_1');
  assert.deepEqual(request.body.payment_method_types ?? request.body.allowed_payment_method_types, ['card']);
});
`;
const CHECKOUT_ANSWER = {
  summary: 'One test runs createCheckoutSession and checks the session and the request it sends.',
  files: [
    {
      path: 'refit-behaviour/create-checkout-session.test.mjs',
      content: CHECKOUT_TEST,
      findingIds: ['f1'],
    },
  ],
  uncertainties: [],
};

it('sends the original modules, their imports and the contract change, never the patch (Emmah-oo/spotify-clone at 23f84d4)', async () => {
  const sample = await scenario('spotify');
  expect(sample.report.patch).toMatchObject({ status: 'proposed', generator: 'deterministic' });
  const diff = (sample.report.patch as { diff: string }).diff;
  expect(diff).toContain('getSubscriptionPeriodEnd');
  const fetcher = respond({
    summary: 'No test can run offline.',
    files: [],
    uncertainties: [
      'manageSubscriptionStatusChange reads the customer from Supabase before it calls Stripe; the sandbox has no database.',
    ],
  });
  const { record } = await writeBehaviourTests({ ...sample.inputs, ai: ai(sample.root) });
  const sent = fetcher.mock.calls.find(([url]) => !url.endsWith('/input_tokens'))!;
  const body = JSON.parse(String(sent[1]!.body));
  const prompt = `${body.instructions}\n${body.input[0].content}`;
  // Nothing the patch writes reaches the model: not the helpers, the pin it moves to, or the diff.
  for (const written of ['getSubscriptionPeriod', 'stripe-subscription-period', diff])
    expect(prompt).not.toContain(written);
  const evidence = JSON.parse(body.input[0].content);
  expect(evidence.files).toEqual([
    { path: 'libs/supabaseAdmin.ts', content: SPOTIFY['libs/supabaseAdmin.ts'] },
  ]);
  expect(evidence.contextFiles.map((file: { path: string }) => file.path)).toEqual([
    'libs/stripe.ts',
    'libs/helpers.ts',
  ]);
  expect(evidence.versions).toEqual({ before: '2023-10-16', after: '2025-03-31.basil' });
  expect(evidence.findings).toEqual([
    expect.objectContaining({
      id: 'f1',
      file: 'libs/supabaseAdmin.ts',
      line: 33,
      change: {
        kind: 'removed-response-field',
        schema: 'subscription',
        property: 'current_period_start',
      },
    }),
    expect.objectContaining({
      id: 'f2',
      line: 36,
      change: expect.objectContaining({ property: 'current_period_end' }),
    }),
  ]);
  expect(evidence.contract.removedResponseFields).toContainEqual({
    schema: 'subscription',
    property: 'current_period_end',
    before: { type: 'integer' },
    after: 'removed',
  });
  // The owner policies the tests must respect are part of every request.
  expect(body.instructions).toBe(INSTRUCTIONS);
  expect(INSTRUCTIONS).toContain('never assert that it is absent');
  expect(INSTRUCTIONS).toContain("webhook endpoint's own API version");
  expect(record).toMatchObject({
    status: 'declined',
    findings: 2,
    files: [],
    uncertainties: [expect.stringContaining('Supabase')],
    context: { files: ['libs/stripe.ts', 'libs/helpers.ts'], omitted: [] },
  });
});

it('names a removed request parameter and its contract replacement, from the original code only (nicuk/docsflow at 3e6fd71)', async () => {
  const sample = await scenario('docsflow');
  // The kept rename covers the finding, so run.ts dropped its requestParameter; the writer still
  // names the removed parameter from the removal the finding cites.
  expect(sample.report.findings).toEqual([
    expect.objectContaining({
      changeId: 'request-parameter:PostCheckoutSessions.payment_method_types',
    }),
  ]);
  expect(sample.report.findings[0].requestParameter).toBeUndefined();
  const request = behaviourTestRequest(sample.inputs);
  expect(request.evidence.files).toEqual([
    { path: 'lib/stripe-client.ts', content: DOCSFLOW_CLIENT },
  ]);
  expect(request.evidence.findings).toEqual([
    expect.objectContaining({
      id: 'f1',
      line: 31,
      change: {
        kind: 'removed-request-parameter',
        operationId: 'PostCheckoutSessions',
        parameter: 'payment_method_types',
      },
    }),
  ]);
  expect(request.evidence.contract.removedRequestParameters).toEqual([
    {
      operationId: 'PostCheckoutSessions',
      parameter: 'payment_method_types',
      before: {
        type: 'array',
        description: 'A list of the types of payment methods (payment_method_types).',
      },
      after: 'removed',
      addedParameters: ['allowed_payment_method_types'],
    },
  ]);
  const patch = sample.report.patch as { diff?: string };
  if (patch.diff) expect(JSON.stringify(request)).not.toContain(patch.diff);
  expect(JSON.stringify(request.evidence)).not.toContain("'2026-09-30.endive'");
});

it('trims imported context to its cap and refuses modules over the input limit without a request', async () => {
  // A generated database types file larger than the context cap, as spotify-clone's types_db.ts grows.
  const types = `export type Json = string | number | boolean | null;\n${'export interface Row { id: string; created_at: string }\n'.repeat(700)}`;
  const sample = await scenario('spotify', {
    'types_db.ts': types,
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }),
    'libs/supabaseAdmin.ts': `import { Database } from "@/types_db";\n${SPOTIFY['libs/supabaseAdmin.ts']}`,
  });
  const request = behaviourTestRequest(sample.inputs);
  expect(request.context.omitted).toEqual([
    { path: 'types_db.ts', bytes: Buffer.byteLength(types) },
  ]);
  expect(request.context.files).toEqual(['libs/stripe.ts', 'libs/helpers.ts']);
  expect(Buffer.byteLength(JSON.stringify(request.evidence))).toBeLessThanOrEqual(MAX_INPUT_BYTES);

  const huge = `${SPOTIFY['libs/supabaseAdmin.ts']}\n${'// padding\n'.repeat(7000)}`;
  const large = await scenario('spotify', { 'libs/supabaseAdmin.ts': huge });
  const fetcher = respond(CHECKOUT_ANSWER);
  const { record, files } = await writeBehaviourTests({ ...large.inputs, ai: ai(large.root) });
  expect(record).toMatchObject({
    status: 'refused',
    reason: expect.stringContaining('64 KiB'),
    promptHash: null,
  });
  expect(files).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
});

it('refuses before sending when the request could exceed the budget, and sends nothing to generate', async () => {
  const sample = await scenario('docsflow');
  const fetcher = respond(CHECKOUT_ANSWER);
  // gpt-6.1-sol reserves 9,000 input tokens and 25,000 output tokens: about $0.27, above $0.10.
  const { record, files } = await writeBehaviourTests({
    ...sample.inputs,
    ai: ai(sample.root, 0.1),
  });
  expect(record).toMatchObject({
    status: 'refused',
    reason: expect.stringContaining('AI budget exhausted'),
    costUsd: null,
    responseId: null,
  });
  expect(record.promptHash).toMatch(/^[a-f0-9]{64}$/);
  expect(files).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toMatch(/\/input_tokens$/);
});

it('records the model, prompt hash, tokens, cost and file hashes of one request, and never asks again', async () => {
  const sample = await scenario('docsflow');
  const fetcher = respond(CHECKOUT_ANSWER);
  const { record, files } = await writeBehaviourTests({ ...sample.inputs, ai: ai(sample.root) });
  const request = behaviourTestRequest(sample.inputs);
  expect(record).toMatchObject({
    status: 'generated',
    model: 'gpt-6.1-sol-2026-10-01',
    responseId: 'resp_behaviour',
    promptHash: digest(JSON.stringify({ instructions: INSTRUCTIONS, evidence: request.evidence })),
    usage: { inputTokens: 9000, outputTokens: 7000 },
    findings: 1,
    uncoveredFindings: [],
    refusals: [],
    files: [
      {
        path: 'refit-behaviour/create-checkout-session.test.mjs',
        sha256: digest(CHECKOUT_TEST),
        bytes: Buffer.byteLength(CHECKOUT_TEST),
        findingIds: ['f1'],
      },
    ],
  });
  // gpt-6.1-sol: $2 per million input tokens and $10 per million output tokens.
  expect(record.costUsd).toBeCloseTo(0.018 + 0.07, 9);
  expect(files.map((file) => file.content)).toEqual([CHECKOUT_TEST]);
  expect(fetcher.mock.calls.filter(([url]) => !url.endsWith('/input_tokens'))).toHaveLength(1);

  // A refused answer is recorded, not regenerated.
  const refused = respond({
    ...CHECKOUT_ANSWER,
    files: [{ ...CHECKOUT_ANSWER.files[0], path: 'test/x.test.mjs' }],
  });
  const second = await writeBehaviourTests({ ...sample.inputs, ai: ai(sample.root) });
  expect(second.record).toMatchObject({
    status: 'refused',
    files: [],
    costUsd: expect.any(Number),
  });
  expect(refused.mock.calls.filter(([url]) => !url.endsWith('/input_tokens'))).toHaveLength(1);
});

it('builds the same request in a dry run and estimates its tokens and cost without sending it (nicuk/docsflow at 3e6fd71)', async () => {
  const sample = await scenario('docsflow');
  // Built before fetch is stubbed: the pipeline looks up stripe-node releases on npm.
  const huge = `${SPOTIFY['libs/supabaseAdmin.ts']}\n${'// padding\n'.repeat(7000)}`;
  const large = await scenario('spotify', { 'libs/supabaseAdmin.ts': huge });
  const fetcher = respond(CHECKOUT_ANSWER);
  const { record, files } = await writeBehaviourTests({
    ...sample.inputs,
    ai: { model: 'gpt-6.1-sol', dryRun: true },
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(files).toEqual([]);
  const request = behaviourTestRequest(sample.inputs);
  const inputTokens = Math.ceil(
    (Buffer.byteLength(INSTRUCTIONS) +
      Buffer.byteLength(JSON.stringify(request.evidence)) +
      Buffer.byteLength(JSON.stringify(request.schema))) /
      3.5,
  );
  expect(record).toMatchObject({
    status: 'dry-run',
    wouldRun: true,
    model: 'gpt-6.1-sol',
    // The real run's request, byte for byte.
    promptHash: digest(JSON.stringify({ instructions: INSTRUCTIONS, evidence: request.evidence })),
    findings: 1,
    estimate: { inputTokens },
  });
  // gpt-6.1-sol: $2 per million input tokens, $10 per million output tokens; a typical answer of
  // 8,000 output tokens and the 25,000 every request reserves.
  expect(record.estimate!.inputUsd).toBeCloseTo(inputTokens * 2e-6, 9);
  expect(record.estimate!.typicalUsd).toBeCloseTo(inputTokens * 2e-6 + 0.08, 9);
  expect(record.estimate!.maximumUsd).toBeCloseTo(inputTokens * 2e-6 + 0.25, 9);

  const refused = await writeBehaviourTests({
    ...large.inputs,
    ai: { model: 'gpt-6.1-sol', dryRun: true },
  });
  expect(refused.record).toMatchObject({
    status: 'dry-run',
    wouldRun: false,
    reason: expect.stringContaining('64 KiB'),
  });
  // The scan may look up stripe-node releases; nothing reaches OpenAI.
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes('api.openai.com'))).toEqual([]);
  expect(behaviourTestSkip({ model: 'gpt-6.1-sol', dryRun: true }, 'why')).toEqual({
    status: 'dry-run',
    wouldRun: false,
    reason: 'why',
  });
  expect(behaviourTestSkip(ai(sample.root), 'why')).toEqual({ status: 'skipped', reason: 'why' });
});

const REPOSITORY = {
  root: '/repository',
  files: [{ path: 'lib/stripe-client.ts', content: DOCSFLOW_CLIENT }],
  dependencies: [],
  lockfiles: [],
  warnings: [],
};
const parse = (files: { path: string; content: string; findingIds?: string[] }[], extra = {}) =>
  parseBehaviourTests(
    JSON.stringify({
      summary: 'Tests.',
      uncertainties: [],
      files: files.map((file) => ({ findingIds: ['f1'], ...file })),
      ...extra,
    }),
    { repository: REPOSITORY, findingIds: ['f1'] },
  );
const testFile = (body: string, imports = '') => `import { test } from 'node:test';
import assert from 'node:assert/strict';
${imports}
test('behaviour', async () => {
${body}
});
`;

it('accepts version-neutral tests that stub other services, read env and write only under mkdtemp', () => {
  const content = testFile(
    `  const dir = await mkdtemp(join(tmpdir(), 'refit-'));
  await writeFile(join(dir, 'payload.json'), '{}');
  globalThis.fetch = async () => new Response('{}');
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  const { createCheckoutSession } = await import('../lib/stripe-client.ts');
  assert.equal(typeof createCheckoutSession, 'function');
  await rm(dir, { recursive: true, force: true });`,
    `import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Stripe from 'stripe';`,
  );
  const parsed = parse([{ path: 'refit-behaviour/checkout.test.mjs', content }]);
  expect(parsed.refusals).toEqual([]);
  expect(parsed.files).toEqual([
    {
      path: 'refit-behaviour/checkout.test.mjs',
      content,
      sha256: digest(content),
      findingIds: ['f1'],
    },
  ]);
  expect(
    parse([{ path: 'refit-behaviour/checkout.test.mjs', content: CHECKOUT_TEST }]).refusals,
  ).toEqual([]);
  // Stripe fields and parameters that share a name with an fs function are not file writes.
  const stripeFields = testFile(
    `  const link = { link: { persistent_token: 'tok' } };
  const { open } = { open: true };
  assert.equal(link.link.persistent_token, 'tok');
  assert.equal(open, true);
  assert.equal({ status: 'open' }.status, 'open');`,
  );
  expect(
    parse([{ path: 'refit-behaviour/fields.test.mjs', content: stripeFields }]).refusals,
  ).toEqual([]);
});

it.each([
  [
    'a path outside refit-behaviour/',
    { path: 'test/checkout.test.mjs' },
    'is not a refit-behaviour/<name>.test.mjs path',
  ],
  [
    'an absolute path',
    { path: '/tmp/refit-behaviour/checkout.test.mjs' },
    'is not a refit-behaviour',
  ],
  [
    'a path that climbs out',
    { path: 'refit-behaviour/../checkout.test.mjs' },
    'is not a refit-behaviour',
  ],
  ['a subdirectory', { path: 'refit-behaviour/a/checkout.test.mjs' }, 'is not a refit-behaviour'],
  [
    'a file that is not .test.mjs',
    { path: 'refit-behaviour/checkout.mjs' },
    'is not a refit-behaviour',
  ],
  ['a .test.js file', { path: 'refit-behaviour/checkout.test.js' }, 'is not a refit-behaviour'],
  [
    'an http import',
    { content: testFile('', "import http from 'node:http';") },
    "imports 'node:http', which is not an allowed module",
  ],
  [
    'a fetch call',
    { content: testFile("  await fetch('https://api.stripe.com/v1/customers');") },
    'calls fetch',
  ],
  [
    'a globalThis.fetch call',
    { content: testFile("  await globalThis.fetch('https://example.com');") },
    'calls fetch',
  ],
  [
    'a WebSocket',
    { content: testFile("  new WebSocket('wss://example.com');") },
    'opens a WebSocket',
  ],
  [
    'child_process',
    { content: testFile("  execSync('ls');", "import { execSync } from 'node:child_process';") },
    "imports 'node:child_process'",
  ],
  [
    'child_process through import()',
    { content: testFile("  await import('child_process');") },
    "imports 'child_process'",
  ],
  [
    'a computed import()',
    { content: testFile("  const name = 'child_process';\n  await import(name);") },
    'imports a computed module specifier',
  ],
  ['require', { content: testFile("  require('node:child_process');") }, 'calls require'],
  [
    'a write outside a temporary directory',
    {
      content: testFile(
        "  writeFileSync('/etc/hosts', '');",
        "import { writeFileSync } from 'node:fs';",
      ),
    },
    'writeFileSync writes outside a temporary directory',
  ],
  [
    'a write into the repository',
    {
      content: testFile(
        "  await fs.rm(join(process.cwd(), 'lib'), { recursive: true });",
        "import fs from 'node:fs/promises';\nimport { join } from 'node:path';",
      ),
    },
    'rm writes outside a temporary directory',
  ],
  [
    'mkdtemp outside os.tmpdir()',
    {
      content: testFile(
        "  await mkdtemp('lib/x-');",
        "import { mkdtemp } from 'node:fs/promises';",
      ),
    },
    'creates a directory outside os.tmpdir()',
  ],
  [
    'a renamed writer',
    {
      content: testFile(
        "  save('/etc/hosts', '');",
        "import { writeFileSync as save } from 'node:fs';",
      ),
    },
    'save writes outside a temporary directory',
  ],
  [
    'a destructured writer',
    {
      content: testFile(
        "  const { writeFileSync: save } = fs;\n  save('x', '');",
        "import fs from 'node:fs';",
      ),
    },
    'save writes outside a temporary directory',
  ],
  [
    'a writer passed on',
    {
      content: testFile(
        "  const save = promisify(fs.writeFile);\n  await save('x', '');",
        "import fs from 'node:fs';\nimport { promisify } from 'node:util';",
      ),
    },
    'passes writeFile on instead of calling it on a temporary path',
  ],
  [
    'a write through fs.promises',
    {
      content: testFile(
        "  await fsp.writeFile('/etc/hosts', '');",
        "import { promises as fsp } from 'node:fs';",
      ),
    },
    'writeFile writes outside a temporary directory',
  ],
  [
    'a write through a dynamically imported fs',
    {
      content: testFile(
        "  const fs = await import('node:fs/promises');\n  await fs.rm('lib', { recursive: true });",
      ),
    },
    'rm writes outside a temporary directory',
  ],
  [
    'test.skip',
    { content: `import { test } from 'node:test';\ntest.skip('later', () => {});\n` },
    'skips or narrows tests with .skip',
  ],
  [
    'the skip option',
    { content: `import { test } from 'node:test';\ntest('later', { skip: true }, () => {});\n` },
    'skips or narrows tests with the skip option',
  ],
  [
    'it.only',
    { content: `import { it } from 'node:test';\nit.only('one', () => {});\n` },
    'skips or narrows tests with .only',
  ],
  ['process.exit', { content: testFile('  process.exit(0);') }, 'uses process.exit'],
  ['eval', { content: testFile("  eval('1');") }, 'calls eval'],
  [
    'an npm package',
    { content: testFile('', "import axios from 'axios';") },
    "imports 'axios', which is not an allowed module",
  ],
  [
    'a missing repository file',
    { content: testFile("  await import('../lib/missing.ts');") },
    "imports '../lib/missing.ts', which is not a repository file",
  ],
  [
    'a file outside the repository',
    { content: testFile("  await import('../../secrets.ts');") },
    'which is not a repository file',
  ],
  [
    'a replaced request log',
    { content: testFile('  globalThis.__refitStripe = { requests: [] };') },
    "replaces the harness's request log",
  ],
  [
    'no tests',
    { content: "import assert from 'node:assert/strict';\nassert.ok(true);\n" },
    'defines no node:test tests',
  ],
  ['a syntax error', { content: testFile('  const = 1;') }, 'does not parse'],
  ['an unknown finding', { findingIds: ['f9'] }, 'cites findings that were not supplied'],
])('refuses %s', (_name, change, reason) => {
  const parsed = parse([
    { path: 'refit-behaviour/checkout.test.mjs', content: CHECKOUT_TEST, ...change },
  ]);
  expect(parsed.files).toEqual([]);
  expect(parsed.refusals.join('\n')).toContain(reason);
});

it('refuses every file when one breaks the contract, and answers that do not match the schema', () => {
  const parsed = parse([
    { path: 'refit-behaviour/checkout.test.mjs', content: CHECKOUT_TEST },
    {
      path: 'refit-behaviour/network.test.mjs',
      content: testFile("  await fetch('https://example.com');"),
    },
  ]);
  expect(parsed.files).toEqual([]);
  expect(parsed.refusals).toEqual([
    expect.stringContaining('refit-behaviour/network.test.mjs:5 calls fetch'),
  ]);
  expect(
    parse([
      { path: 'refit-behaviour/checkout.test.mjs', content: CHECKOUT_TEST },
      { path: 'refit-behaviour/checkout.test.mjs', content: CHECKOUT_TEST },
    ]).refusals,
  ).toEqual(['File "refit-behaviour/checkout.test.mjs" appears twice.']);
  expect(parse([], { extra: true }).refusals).toEqual([
    'The answer does not match the behaviour-test schema.',
  ]);
  expect(() =>
    parseBehaviourTests('not json', { repository: REPOSITORY, findingIds: ['f1'] }),
  ).toThrow();
});

// SIMULATED stripe-mock and SDK, real harness: the harness's own runner, reporter, V8 coverage and
// grading (behaviour-tests.ts) run outside Docker against a loopback stand-in that, like stripe-mock,
// rejects a parameter its API version does not define, with stripe-node's request shape (an HTTPS
// request to api.stripe.com, the form body written after secureConnect). The two-version
// stripe-mock harness runs the same files in offline Docker on refit-bench.
const SDK = `import https from 'node:https';
const form = (value, prefix) => Array.isArray(value)
  ? value.flatMap((item, index) => form(item, prefix + '[' + index + ']'))
  : value && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, item]) => form(item, prefix ? prefix + '[' + key + ']' : key))
    : [encodeURIComponent(prefix) + '=' + encodeURIComponent(value)];
export default class Stripe {
  constructor(key, config = {}) {
    const request = (method, path, params) => new Promise((resolve, reject) => {
      const body = form(params, '').join('&');
      const req = https.request({ host: 'api.stripe.com', port: 443, path, method, agent: new https.Agent(),
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body), 'Stripe-Version': config.apiVersion } });
      req.on('response', (res) => { let data = ''; res.on('data', (chunk) => (data += chunk));
        res.on('end', () => res.statusCode < 400 ? resolve(JSON.parse(data))
          : reject(Object.assign(new Error(JSON.parse(data).error.message), { statusCode: res.statusCode }))); });
      req.on('error', reject);
      req.once('socket', (socket) => socket.once('secureConnect', () => req.end(body)));
    });
    this.checkout = { sessions: { create: (params) => request('POST', '/v1/checkout/sessions', params) } };
  }
}
`;
const PACKAGE = {
  'node_modules/stripe/package.json': JSON.stringify({
    name: 'stripe',
    type: 'module',
    main: 'index.js',
  }),
  'node_modules/stripe/index.js': SDK,
};
const PARAMETERS = {
  before: [...CHECKOUT_FIELDS, 'payment_method_types'],
  after: [...CHECKOUT_FIELDS, 'allowed_payment_method_types'],
};

async function harness(
  tests: BehaviourTestFile[],
  findings: Finding[],
  patchedClient: string,
  sides = { original: 'before', patched: 'after' } as const,
) {
  const root = await mkdtemp(join(tmpdir(), 'refit-behaviour-run-'));
  roots.push(root);
  const app = async (name: string, client: string) => {
    for (const [path, content] of Object.entries({ ...PACKAGE, 'lib/stripe-client.ts': client })) {
      await mkdir(dirname(join(root, name, path)), { recursive: true });
      await writeFile(join(root, name, path), content);
    }
    return readRepository(join(root, name), 'stripe');
  };
  const sources = {
    original: await app('original', DOCSFLOW_CLIENT),
    patched: await app('patched', patchedClient),
  };
  const changed = changedStripeLines(sources.original, sources.patched, findings);
  const tools = join(root, 'tools');
  await mkdir(tools);
  await writeBehaviourHarness(tools, tests, changed, sources);
  let parameters = PARAMETERS.before;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const sent = new Set(
        body.split('&').map((pair) => decodeURIComponent(pair.split('=')[0]).split('[')[0]),
      );
      const unknown = [...sent].filter((name) => !parameters.includes(name));
      response.statusCode = unknown.length ? 400 : 200;
      response.end(
        JSON.stringify(
          unknown.length
            ? {
                error: {
                  type: 'invalid_request_error',
                  message: `Received unknown parameter: ${unknown[0]}`,
                },
              }
            : {
                id: 'cs_test_123',
                object: 'checkout.session',
                url: 'https://checkout.stripe.com/c/pay/cs_test_123',
              },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // One side as the sandbox runs it: the tests copied in, then the harness's runner.
  const run = async (side: 'original' | 'patched'): Promise<CheckResult> => {
    const directory = sources[side].root;
    parameters = PARAMETERS[sides[side]];
    await mkdir(join(directory, 'refit-behaviour'), { recursive: true });
    for (const test of tests) await writeFile(join(directory, test.path), test.content);
    const { stdout, stderr } = await execute(process.execPath, [join(tools, 'behaviour.mjs')], {
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        REFIT_STRIPE_MOCK_PORT: String((server.address() as { port: number }).port),
        REFIT_GENERATED_ROOT: `${directory}/`,
        REFIT_GENERATED_SIDE: side === 'original' ? 'before' : 'after',
        REFIT_TYPESCRIPT: join(typescriptDirectory(), 'lib', 'typescript.js'),
        STRIPE_SECRET_KEY: 'sk_test_123',
      },
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { status: 'passed', exitCode: 0, stdout, stderr };
  };
  try {
    const original = await run('original');
    const patched = await run('patched');
    return compareBehaviourRuns({ tests, changed, sources, original, patched });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

it("SIMULATED stripe-mock: the generated test gives grade A to the card rule's patch and counts known-wrong patches as regressions (nicuk/docsflow at 3e6fd71)", async () => {
  const sample = await scenario('docsflow');
  respond(CHECKOUT_ANSWER);
  const { record, files } = await writeBehaviourTests({ ...sample.inputs, ai: ai(sample.root) });
  expect(record.status).toBe('generated');
  // The card rule's migration (docs/STRIPE-PAYMENT-METHOD-TYPES.md) with the endive pin.
  const correct = DOCSFLOW_CLIENT.replace('2025-08-27.basil', '2026-09-30.endive').replace(
    "payment_method_types: ['card']",
    "allowed_payment_method_types: ['card']",
  );
  // Deleting the removed parameter, which owner policy forbids, and not migrating at all.
  const dropped = correct.replace("      allowed_payment_method_types: ['card'],\n", '');
  const unmigrated = DOCSFLOW_CLIENT.replace('2025-08-27.basil', '2026-09-30.endive');
  expect(dropped).not.toContain('payment_method_types');
  const findings = sample.report.findings;
  const passed = await harness(files, findings, correct);
  expect(passed).toMatchObject({ status: 'passed', grade: 'A', missing: [], regressions: [] });
  // Both changed lines (the pin and the parameter) ran on both sides.
  expect(passed.coverage!.covered).toEqual({
    original: { 'lib/stripe-client.ts': [7, 31] },
    patched: { 'lib/stripe-client.ts': [7, 31] },
  });
  const deleted = await harness(files, findings, dropped);
  expect(deleted).toMatchObject({ status: 'regression', grade: null });
  expect(deleted.regressions[0].error).toContain('Expected values to be strictly deep-equal');
  const kept = await harness(files, findings, unmigrated);
  expect(kept).toMatchObject({ status: 'regression', grade: null });
  expect(kept.regressions[0].error).toContain('Expected values to be strictly equal');
  // The unchanged code against the after version fails the same test: it sees the API change.
  const unchanged = await harness(files, findings, DOCSFLOW_CLIENT);
  expect(unchanged).toMatchObject({ status: 'regression' });
}, 120_000);

// --behaviour-test-stubs (off by default). Anassarwar14/Chat-Nest-AI at 38dd23e (dev-30), one of the
// 12 repositories whose request in refit-bench run 40276445481 returned no tests: its checkout sits
// behind Clerk and a Prisma client (pipeline/fixtures/behaviour-stubs.ts).
async function chatNest() {
  const root = await mkdtemp(join(tmpdir(), 'refit-behaviour-stubs-'));
  roots.push(root);
  const directory = join(root, 'repository');
  for (const [path, content] of Object.entries({
    ...CHAT_NEST,
    'package.json': JSON.stringify({ dependencies: { stripe: '17.5.0' } }),
  })) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  const before = join(root, 'before.json');
  const after = join(root, 'after.json');
  const providerConfig = join(root, 'provider.json');
  await writeFile(
    before,
    JSON.stringify(
      checkoutContract('2024-12-18.acacia', [...CHECKOUT_FIELDS, 'payment_method_types']),
    ),
  );
  await writeFile(
    after,
    JSON.stringify(
      checkoutContract('2026-09-30.endive', [...CHECKOUT_FIELDS, 'allowed_payment_method_types']),
    ),
  );
  await writeFile(
    providerConfig,
    JSON.stringify({
      ...ADAPTER,
      id: 'stripe-checkout',
      operations: [
        {
          resource: 'checkout.sessions',
          method: 'create',
          schema: 'checkout.session',
          operationId: 'PostCheckoutSessions',
        },
      ],
    }),
  );
  // As validation's preflight scan runs, before any patch exists.
  const report = await runPipeline({
    repository: directory,
    before,
    after,
    providerConfig,
    apiVersion: '2024-12-18.acacia',
    proposePatch: false,
  });
  const specifications = {
    before: await readSpecification(before),
    after: await readSpecification(after),
  };
  return {
    root,
    report,
    scanned: [...report.imports, ...report.sdkCalls, ...report.calls],
    inputs: {
      repository: await readRepository(directory),
      findings: report.findings,
      changes: report.changes,
      removals: removedRequestParameters(
        report.adapter,
        specifications.before.document,
        specifications.after.document,
      ),
      ...specifications,
    },
  };
}

const STUBBED_ANSWER = {
  summary: 'Stubs sign a user in and find no subscription, so GET creates a Checkout Session.',
  files: [{ ...CHAT_NEST_TEST, findingIds: ['f1'] }],
  stubs: CHAT_NEST_STUBS,
  uncertainties: [],
};

it('keeps the default request byte-identical: no stub rules, schema or evidence without --behaviour-test-stubs', async () => {
  // SHA-256 of the instructions, the schema and a whole request as main fad75f55 builds them.
  expect(digest(INSTRUCTIONS)).toBe(
    'ed4d4e972604ca4be1c19d98a3cf03e0649b3132244046f3df37960bf4b5a06a',
  );
  const request = behaviourTestRequest({
    repository: {
      root: '/r',
      files: [{ path: 'a.ts', content: "import Stripe from 'stripe';\n" }],
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    findings: [
      {
        file: 'a.ts',
        line: 1,
        column: 1,
        confidence: 'confirmed',
        expression: 'x',
        changeId: 'c',
      } as Finding,
    ],
    changes: [],
    removals: [],
    before: { document: { info: { version: 'b' } }, schemas: {} },
    after: { document: { info: { version: 'a' } }, schemas: {} },
  });
  expect(digest(JSON.stringify(request.schema))).toBe(
    'a487e4ede2dbfb40793fd5bbf7cfeb12f75396da7224aaf939a9ebe7becbed2e',
  );
  expect(digest(JSON.stringify(request))).toBe(
    '9df8f0c02b2a4274ce913a9dc4ce44d30b51b5f6f2cb3fe8650306a90da6d753',
  );
  const sample = await chatNest();
  const { record } = await writeBehaviourTests({
    ...sample.inputs,
    scanned: sample.scanned,
    ai: { model: 'gpt-6.1-sol', dryRun: true },
  });
  expect(record).not.toHaveProperty('stubs');
  expect(record.promptHash).toBe(
    digest(
      JSON.stringify({
        instructions: INSTRUCTIONS,
        evidence: behaviourTestRequest(sample.inputs).evidence,
      }),
    ),
  );
  // An answer with stubs does not match the default schema.
  expect(
    parseBehaviourTests(JSON.stringify(STUBBED_ANSWER), {
      repository: sample.inputs.repository,
      findingIds: ['f1'],
    }).refusals,
  ).toEqual(['The answer does not match the behaviour-test schema.']);
});

it('adds the stub rules, the stubs schema and the files no stub may replace only with --behaviour-test-stubs (Anassarwar14/Chat-Nest-AI at 38dd23e)', async () => {
  const sample = await chatNest();
  expect(sample.report.findings).toEqual([
    expect.objectContaining({ file: 'app/api/stripe/route.ts', line: 38 }),
  ]);
  const neverStub = stripeCodeFiles(
    sample.inputs.repository,
    sample.inputs.findings,
    sample.scanned,
  );
  // Files that import stripe, and the route the scan traced the call in, which does not.
  expect([...neverStub].sort()).toEqual([
    'app/api/stripe/route.ts',
    'app/api/webhook/route.ts',
    'lib/stripe.ts',
  ]);
  const plain = behaviourTestRequest(sample.inputs);
  const stubbed = behaviourTestRequest({ ...sample.inputs, stubs: neverStub });
  expect(stubbed.instructions).toBe(`${INSTRUCTIONS}\n\n${STUB_INSTRUCTIONS}`);
  expect(STUB_INSTRUCTIONS).toContain('Never stub stripe');
  expect(STUB_INSTRUCTIONS).toContain('the SAME stub files run on both runs');
  expect(stubbed.schema.required).toEqual(['summary', 'files', 'stubs', 'uncertainties']);
  expect(stubbed.schema.properties.files).toEqual(plain.schema.properties.files);
  // The reachable files a stub may not replace: the route and the client, not Prisma or utils.
  const { stubs, ...evidence } = stubbed.evidence as typeof stubbed.evidence & {
    stubs: { neverStub: string[] };
  };
  expect(stubs).toEqual({ neverStub: ['app/api/stripe/route.ts', 'lib/stripe.ts'] });
  expect(evidence).toEqual(plain.evidence);
});

const stubAnswer = (
  stub: Partial<(typeof CHAT_NEST_STUBS)[number]>,
  extra: Record<string, unknown> = {},
) => ({
  ...STUBBED_ANSWER,
  stubs: [CHAT_NEST_STUBS[0], { ...CHAT_NEST_STUBS[1], ...stub }],
  ...extra,
});

it('accepts stubs that hold to every rule, and refuses every file and stub when one breaks a rule (Anassarwar14/Chat-Nest-AI at 38dd23e)', async () => {
  const sample = await chatNest();
  const neverStub = stripeCodeFiles(
    sample.inputs.repository,
    sample.inputs.findings,
    sample.scanned,
  );
  const parse = (answer: unknown) =>
    parseBehaviourTests(JSON.stringify(answer), {
      repository: sample.inputs.repository,
      findingIds: ['f1'],
      stubs: neverStub,
    });
  const accepted = parse(
    stubAnswer({
      content: `import { absoluteURL } from '../../lib/utils.ts';\nimport { mock } from 'node:test';\nexport const url = absoluteURL('/x');\nexport const findUnique = mock.fn(async () => null);\nexport default { userSubscription: { findUnique } };\n`,
    }),
  );
  expect(accepted.refusals).toEqual([]);
  expect(accepted.stubs.map((stub) => stub.module)).toEqual([
    '@clerk/nextjs/server',
    'lib/prismaDB.ts',
  ]);
  expect(parse(STUBBED_ANSWER)).toMatchObject({
    refusals: [],
    files: [expect.objectContaining({ path: CHAT_NEST_TEST.path })],
    stubs: CHAT_NEST_STUBS,
  });
  const refused = (answer: unknown) => {
    const parsed = parse(answer);
    expect(parsed).toMatchObject({ files: [], stubs: [] });
    return parsed.refusals.join('\n');
  };
  for (const [module, rule] of [
    ['stripe', 'stripe-and-http'],
    ['stripe/esm/stripe.esm.node.js', 'stripe-and-http'],
    ['node:https', 'stripe-and-http'],
    ['undici', 'stripe-and-http'],
    ['lib/stripe.ts', 'stripe-code'],
    ['app/api/webhook/route.ts', 'stripe-code'],
    ['app/api/stripe/route.ts', 'stripe-code'],
    ['@/lib/prismaDB', 'module'],
    ['./lib/prismaDB', 'module'],
  ])
    expect(refused(stubAnswer({ module }))).toContain(
      `Stub "refit-behaviour/stubs/prisma-db.mjs" for ${JSON.stringify(module)} breaks stub rule ${rule}: `,
    );
  for (const [content, problem] of [
    [
      "import axios from 'axios';\nexport default axios;\n",
      "1 imports 'axios', which breaks stub rule imports",
    ],
    [
      "import Stripe from 'stripe';\nexport default Stripe;\n",
      "1 imports 'stripe', which breaks stub rule imports",
    ],
    [
      "import { stripe } from '../../lib/stripe.ts';\nexport default stripe;\n",
      "1 imports '../../lib/stripe.ts', which breaks stub rule imports",
    ],
    [
      "import https from 'node:https';\nexport default https;\n",
      "1 imports 'node:https', which breaks stub rule imports",
    ],
    [
      'globalThis.prisma = {};\nexport default {};\n',
      '1 uses globalThis, which breaks stub rule isolation',
    ],
    ['export const get = (url) => fetch(url);\n', '1 uses fetch, which breaks stub rule isolation'],
    [
      "export const https = process.getBuiltinModule('node:https');\n",
      '1 uses getBuiltinModule, which breaks stub rule isolation',
    ],
    [
      'export const log = __refitStripe;\n',
      '1 uses __refitStripe, which breaks stub rule isolation',
    ],
    [
      "import { writeFileSync } from 'node:fs';\nwriteFileSync('/etc/hosts', '');\n",
      '2 writeFileSync writes outside a temporary directory',
    ],
  ])
    expect(refused(stubAnswer({ content }))).toContain(
      `refit-behaviour/stubs/prisma-db.mjs:${problem}`,
    );
  expect(refused(stubAnswer({ path: 'refit-behaviour/prisma-db.mjs' }))).toContain(
    'is not a refit-behaviour/stubs/<name>.mjs path',
  );
  expect(refused(stubAnswer({ module: '@clerk/nextjs/server' }))).toContain(
    'repeats the path or module of another stub',
  );
  // A test may import only the stubs the answer defines.
  expect(refused({ ...STUBBED_ANSWER, stubs: [CHAT_NEST_STUBS[1]] })).toContain(
    "imports './stubs/clerk-server.mjs', which is not a repository file",
  );
  const { stubs: _stubs, ...withoutStubs } = STUBBED_ANSWER;
  expect(refused(withoutStubs)).toBe('The answer does not match the behaviour-test schema.');
});

it('sends the stub rules, records the stubs it accepted and hands them to the harness (Anassarwar14/Chat-Nest-AI at 38dd23e)', async () => {
  const sample = await chatNest();
  const fetcher = respond(STUBBED_ANSWER);
  const { record, files, stubs } = await writeBehaviourTests({
    ...sample.inputs,
    scanned: sample.scanned,
    ai: { ...ai(sample.root), stubs: true },
  });
  const sent = fetcher.mock.calls.find(([url]) => !url.endsWith('/input_tokens'))!;
  const body = JSON.parse(String(sent[1]!.body));
  expect(body.instructions).toBe(`${INSTRUCTIONS}\n\n${STUB_INSTRUCTIONS}`);
  expect(body.text.format.schema.required).toContain('stubs');
  expect(JSON.parse(body.input[0].content).stubs).toEqual({
    neverStub: ['app/api/stripe/route.ts', 'lib/stripe.ts'],
  });
  expect(record).toMatchObject({
    status: 'generated',
    refusals: [],
    stubs: CHAT_NEST_STUBS.map((stub) => ({
      module: stub.module,
      path: stub.path,
      sha256: digest(stub.content),
      bytes: Buffer.byteLength(stub.content),
    })),
  });
  expect(files.map((file) => file.path)).toEqual([CHAT_NEST_TEST.path]);
  expect(stubs).toEqual(CHAT_NEST_STUBS);
  // A dry run builds the same request, records that stubs were allowed and prices the longer prompt.
  const dry = await writeBehaviourTests({
    ...sample.inputs,
    scanned: sample.scanned,
    ai: { model: 'gpt-6.1-sol', dryRun: true, stubs: true },
  });
  const plain = await writeBehaviourTests({
    ...sample.inputs,
    scanned: sample.scanned,
    ai: { model: 'gpt-6.1-sol', dryRun: true },
  });
  expect(dry.record).toMatchObject({ status: 'dry-run', wouldRun: true, stubs: [] });
  expect(dry.record.promptHash).toBe(record.promptHash);
  expect(dry.record.estimate!.inputTokens).toBeGreaterThan(plain.record.estimate!.inputTokens);
});

it('needs a writer for --behaviour-test-stubs on refit run, before anything runs', async () => {
  await expect(
    execute(process.execPath, [resolve('bin/refit.mjs'), 'run', '--behaviour-test-stubs']),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining(
      '--behaviour-test-stubs needs --write-behaviour-tests or --write-behaviour-tests-dry-run.',
    ),
  });
});
